use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone)]
struct CodexClient {
    inner: Arc<CodexClientInner>,
}

struct CodexClientInner {
    app: AppHandle,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    next_id: AtomicI64,
    connected: AtomicBool,
    start_lock: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountState {
    connected: bool,
    email: Option<String>,
    plan: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WeeklyUsage {
    used_percent: f64,
    remaining_percent: f64,
    reset_at: Option<i64>,
    window_duration_mins: Option<i64>,
    limit_id: Option<String>,
    limit_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardSnapshot {
    account: AccountState,
    five_hour: Option<WeeklyUsage>,
    weekly: Option<WeeklyUsage>,
    tokens_today: Option<i64>,
    token_bucket_date: Option<String>,
    lifetime_tokens: Option<i64>,
    credits_balance: Option<String>,
    credits_unlimited: bool,
    fetched_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginStart {
    login_id: String,
    auth_url: String,
}

impl CodexClient {
    fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(CodexClientInner {
                app,
                stdin: Mutex::new(None),
                child: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicI64::new(1),
                connected: AtomicBool::new(false),
                start_lock: Mutex::new(()),
            }),
        }
    }

    async fn ensure_started(&self) -> Result<()> {
        if self.inner.connected.load(Ordering::SeqCst) {
            return Ok(());
        }
        let _guard = self.inner.start_lock.lock().await;
        if self.inner.connected.load(Ordering::SeqCst) {
            return Ok(());
        }

        let mut candidates = Vec::new();
        if let Some(override_path) = std::env::var_os("CODEX_WIDGET_CODEX_PATH") {
            candidates.push(std::path::PathBuf::from(override_path));
        }
        if let Ok(path) = self
            .inner
            .app
            .path()
            .resolve("codex-runtime/codex.exe", BaseDirectory::Resource)
        {
            candidates.push(path);
        }
        #[cfg(debug_assertions)]
        candidates.push(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("node_modules")
                .join("@openai")
                .join("codex-win32-x64")
                .join("vendor")
                .join("x86_64-pc-windows-msvc")
                .join("bin")
                .join("codex.exe"),
        );
        candidates.push(std::path::PathBuf::from("codex.exe"));

        let mut spawned = None;
        let mut failures = Vec::new();
        for executable in candidates {
            let mut command = Command::new(&executable);
            command
                .args(["app-server", "--stdio"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.as_std_mut().creation_flags(0x0800_0000);
            match command.spawn() {
                Ok(child) => {
                    spawned = Some(child);
                    break;
                }
                Err(error) => failures.push(format!("{}: {error}", executable.display())),
            }
        }

        let mut child = spawned.ok_or_else(|| anyhow!(
            "Codex could not be started. Update the Codex desktop app, or set CODEX_WIDGET_CODEX_PATH to codex.exe. Tried: {}",
            failures.join("; ")
        ))?;
        let stdin = child.stdin.take().context("Codex app-server did not open stdin")?;
        let stdout = child.stdout.take().context("Codex app-server did not open stdout")?;
        let stderr = child.stderr.take().context("Codex app-server did not open stderr")?;

        *self.inner.stdin.lock().await = Some(stdin);
        *self.inner.child.lock().await = Some(child);
        self.inner.connected.store(true, Ordering::SeqCst);

        let reader_inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = message.get("id").and_then(Value::as_i64) {
                    if let Some(sender) = reader_inner.pending.lock().await.remove(&id) {
                        let _ = sender.send(message);
                    }
                    continue;
                }
                let Some(method) = message.get("method").and_then(Value::as_str) else { continue };
                match method {
                    "account/rateLimits/updated" => {
                        let _ = reader_inner.app.emit("codex://rate-limits-updated", message.get("params").cloned());
                    }
                    "account/login/completed" => {
                        let _ = reader_inner.app.emit("codex://login-completed", message.get("params").cloned());
                    }
                    "account/updated" => {
                        let _ = reader_inner.app.emit("codex://account-updated", message.get("params").cloned());
                    }
                    _ => {}
                }
            }
            reader_inner.connected.store(false, Ordering::SeqCst);
            *reader_inner.stdin.lock().await = None;
            *reader_inner.child.lock().await = None;
        });

        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_line)) = lines.next_line().await {
                // Drain stderr so the child never blocks. Avoid persisting account-related logs.
            }
        });

        let initialize = self
            .request_raw(
                "initialize",
                Some(json!({
                    "clientInfo": {
                        "name": "codex_usage_dashboard",
                        "title": "Codex Usage Dashboard",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                })),
            )
            .await;
        if let Err(error) = initialize {
            self.inner.connected.store(false, Ordering::SeqCst);
            return Err(error);
        }
        self.notify("initialized", None).await?;
        Ok(())
    }

    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        self.ensure_started().await?;
        self.request_raw(method, params).await
    }

    async fn request_raw(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({ "method": method, "id": id });
        if let Some(params) = params {
            message["params"] = params;
        }
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, sender);
        self.write_message(&message).await?;
        let response = tokio::time::timeout(Duration::from_secs(25), receiver)
            .await
            .context("Codex did not respond in time")?
            .context("Codex stopped before responding")?;
        if let Some(error) = response.get("error") {
            return Err(anyhow!(error.to_string()));
        }
        response.get("result").cloned().ok_or_else(|| anyhow!("Codex returned an empty response"))
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        let mut message = json!({ "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message).await
    }

    async fn write_message(&self, message: &Value) -> Result<()> {
        let mut guard = self.inner.stdin.lock().await;
        let stdin = guard.as_mut().context("Codex is not connected")?;
        let mut encoded = serde_json::to_vec(message)?;
        encoded.push(b'\n');
        stdin.write_all(&encoded).await?;
        stdin.flush().await?;
        Ok(())
    }
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn number_at(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(|number| number.as_f64().or_else(|| number.as_str()?.parse().ok()))
}

fn integer_at(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|number| {
        number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| number.as_f64().map(|value| value.round() as i64))
            .or_else(|| number.as_str()?.parse().ok())
    })
}

fn find_usage_windows(rate_limits: &Value) -> (Option<WeeklyUsage>, Option<WeeklyUsage>, Option<String>, bool) {
    let mut snapshots: Vec<(&Value, Option<String>)> = Vec::new();
    if let Some(by_id) = rate_limits.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for (limit_id, value) in by_id {
            snapshots.push((value, Some(limit_id.clone())));
        }
    }
    if let Some(value) = rate_limits.get("rateLimits") {
        if let Some(values) = value.as_array() {
            for snapshot in values {
                snapshots.push((snapshot, string_at(snapshot, "limitId")));
            }
        } else {
            snapshots.push((value, string_at(value, "limitId")));
        }
    }

    let mut best_five_hour: Option<(i64, WeeklyUsage)> = None;
    let mut best_weekly: Option<(i64, WeeklyUsage)> = None;
    let mut credits_balance = None;
    let mut credits_unlimited = false;
    for (snapshot, fallback_id) in snapshots {
        let limit_id = string_at(snapshot, "limitId").or(fallback_id);
        let limit_name = string_at(snapshot, "limitName");
        if let Some(credits) = snapshot.get("credits") {
            credits_balance = credits_balance.or_else(|| string_at(credits, "balance"));
            credits_unlimited |= credits.get("unlimited").and_then(Value::as_bool).unwrap_or(false);
        }
        let Some(fields) = snapshot.as_object() else { continue };
        for (key, window) in fields {
            let Some(used_percent) = number_at(window, "usedPercent") else { continue };
            let duration = integer_at(window, "windowDurationMins");
            let candidate = WeeklyUsage {
                used_percent,
                remaining_percent: (100.0 - used_percent).clamp(0.0, 100.0),
                reset_at: integer_at(window, "resetsAt"),
                window_duration_mins: duration,
                limit_id: limit_id.clone(),
                limit_name: limit_name.clone(),
            };
            let codex_bonus = if limit_id.as_deref() == Some("codex") { 10_000 } else { 0 };
            let normalized_key = key.to_ascii_lowercase();
            let weekly_hint = normalized_key.contains("weekly")
                || normalized_key.contains("secondary")
                || normalized_key.contains("long");
            let short_hint = normalized_key.contains("primary")
                || normalized_key.contains("five")
                || normalized_key.contains("short");
            match duration {
                // Treat any multi-day window as the long-term allowance. This
                // remains correct if Codex changes the exact seven-day duration.
                Some(minutes) if minutes > 2 * 24 * 60 => {
                    let distance = (minutes - 10_080).abs().min(90_000);
                    let score = codex_bonus + 100_000 - distance;
                    if best_weekly.as_ref().is_none_or(|(current, _)| score > *current) {
                        best_weekly = Some((score, candidate));
                    }
                }
                Some(minutes) => {
                    let distance = (minutes - 300).abs().min(90_000);
                    let score = codex_bonus + 100_000 - distance;
                    if best_five_hour.as_ref().is_none_or(|(current, _)| score > *current) {
                        best_five_hour = Some((score, candidate));
                    }
                }
                None if weekly_hint => {
                    let score = codex_bonus + 50_000;
                    if best_weekly.as_ref().is_none_or(|(current, _)| score > *current) {
                        best_weekly = Some((score, candidate));
                    }
                }
                None if short_hint => {
                    let score = codex_bonus + 50_000;
                    if best_five_hour.as_ref().is_none_or(|(current, _)| score > *current) {
                        best_five_hour = Some((score, candidate));
                    }
                }
                _ => {}
            }
        }
    }
    (
        best_five_hour.map(|(_, usage)| usage),
        best_weekly.map(|(_, usage)| usage),
        credits_balance,
        credits_unlimited,
    )
}

async fn read_usage_windows(client: &CodexClient) -> (Option<WeeklyUsage>, Option<WeeklyUsage>, Option<String>, bool) {
    let mut last_result = (None, None, None, false);
    for attempt in 0..3 {
        if let Ok(value) = client.request("account/rateLimits/read", None).await {
            last_result = find_usage_windows(&value);
            if last_result.0.is_some() || last_result.1.is_some() {
                return last_result;
            }
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
        }
    }
    last_result
}

#[tauri::command]
async fn get_dashboard(client: State<'_, CodexClient>) -> std::result::Result<DashboardSnapshot, String> {
    let account_result = client
        .request("account/read", Some(json!({ "refreshToken": false })))
        .await
        .map_err(|error| error.to_string())?;
    let account_value = account_result.get("account").filter(|value| !value.is_null());
    let connected = account_value
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|kind| matches!(kind, "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | "personalAccessToken"));
    let email = account_value.and_then(|value| string_at(value, "email"));
    let plan = account_value.and_then(|value| string_at(value, "planType"));

    if !connected {
        return Ok(DashboardSnapshot {
            account: AccountState { connected, email, plan },
            five_hour: None,
            weekly: None,
            tokens_today: None,
            token_bucket_date: None,
            lifetime_tokens: None,
            credits_balance: None,
            credits_unlimited: false,
            fetched_at: Utc::now().timestamp_millis(),
        });
    }

    let (rate_result, usage_result) = tokio::join!(
        read_usage_windows(&client),
        client.request("account/usage/read", None)
    );

    let (five_hour, weekly, credits_balance, credits_unlimited) = rate_result;
    let usage = usage_result.ok();
    let lifetime_tokens = usage
        .as_ref()
        .and_then(|value| value.get("summary"))
        .and_then(|value| value.get("lifetimeTokens"))
        .and_then(Value::as_i64);
    let latest_bucket = usage
        .as_ref()
        .and_then(|value| value.get("dailyUsageBuckets"))
        .and_then(Value::as_array)
        .and_then(|buckets| {
            buckets.iter().max_by_key(|bucket| {
                bucket.get("startDate").and_then(Value::as_str).unwrap_or_default()
            })
        });
    let tokens_today = latest_bucket
        .and_then(|value| value.get("tokens"))
        .and_then(Value::as_i64);
    let token_bucket_date = latest_bucket.and_then(|value| string_at(value, "startDate"));

    Ok(DashboardSnapshot {
        account: AccountState { connected, email, plan },
        five_hour,
        weekly,
        tokens_today,
        token_bucket_date,
        lifetime_tokens,
        credits_balance,
        credits_unlimited,
        fetched_at: Utc::now().timestamp_millis(),
    })
}

#[tauri::command]
async fn begin_login(client: State<'_, CodexClient>) -> std::result::Result<LoginStart, String> {
    let result = client
        .request(
            "account/login/start",
            Some(json!({
                "type": "chatgpt",
                "useHostedLoginSuccessPage": true,
                "appBrand": "codex"
            })),
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(LoginStart {
        login_id: string_at(&result, "loginId").ok_or_else(|| "Codex did not return a login ID".to_string())?,
        auth_url: string_at(&result, "authUrl").ok_or_else(|| "Codex did not return a browser login URL".to_string())?,
    })
}

#[tauri::command]
async fn logout(client: State<'_, CodexClient>) -> std::result::Result<(), String> {
    client.request("account/logout", None).await.map_err(|error| error.to_string())?;
    Ok(())
}

fn build_tray(app: &tauri::App) -> Result<()> {
    let show = MenuItemBuilder::with_id("show", "Show widget").build(app)?;
    let refresh = MenuItemBuilder::with_id("refresh", "Refresh usage").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &refresh, &quit]).build()?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("Codex Usage Dashboard")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_bottom(false);
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "refresh" => {
                let _ = app.emit("widget://refresh", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_bottom(false);
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Codex Usage Dashboard")
                .build(),
        )
        .setup(|app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("Codex Usage Dashboard")
            .inner_size(400.0, 550.0)
            .min_inner_size(400.0, 550.0)
            .max_inner_size(400.0, 550.0)
            .resizable(false)
            .fullscreen(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .always_on_bottom(false)
            .visible(true)
            .center()
            .build()?;
            app.manage(CodexClient::new(app.handle().clone()));
            build_tray(app)?;
            // Always launch visibly. Desktop mode is opt-in after the UI loads.
            window.set_always_on_bottom(false)?;
            window.show()?;
            window.set_focus()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_dashboard, begin_login, logout])
        .run(tauri::generate_context!())
        .expect("error while running Codex Usage Dashboard");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_five_hour_and_weekly_buckets_by_duration() {
        let limits = json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": {
                        "usedPercent": 81.0,
                        "windowDurationMins": 300,
                        "resetsAt": 100
                    },
                    "secondary": {
                        "usedPercent": 37.0,
                        "windowDurationMins": 10080,
                        "resetsAt": 200
                    }
                }
            }
        });
        let (five_hour, weekly, _, _) = find_usage_windows(&limits);
        let five_hour = five_hour.expect("five-hour bucket should be selected");
        let weekly = weekly.expect("weekly bucket should be selected");
        assert_eq!(five_hour.window_duration_mins, Some(300));
        assert_eq!(five_hour.remaining_percent, 19.0);
        assert_eq!(weekly.window_duration_mins, Some(10_080));
        assert_eq!(weekly.used_percent, 37.0);
        assert_eq!(weekly.remaining_percent, 63.0);
    }

    #[test]
    fn five_hour_can_be_present_when_weekly_is_temporarily_absent() {
        let limits = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {
                    "usedPercent": 12.0,
                    "windowDurationMins": 300,
                    "resetsAt": 100
                },
                "secondary": null
            }
        });
        let (five_hour, weekly, _, _) = find_usage_windows(&limits);
        assert_eq!(five_hour.expect("five-hour bucket should be selected").window_duration_mins, Some(300));
        assert!(weekly.is_none());
    }

    #[test]
    fn weekly_can_be_present_when_five_hour_is_temporarily_absent() {
        let limits = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {
                    "usedPercent": 12.0,
                    "windowDurationMins": 10080,
                    "resetsAt": 100
                },
                "secondary": null
            }
        });
        let (five_hour, weekly, _, _) = find_usage_windows(&limits);
        assert!(five_hour.is_none());
        assert_eq!(weekly.expect("weekly bucket should be selected").remaining_percent, 88.0);
    }

    #[test]
    fn accepts_string_encoded_usage_fields_from_newer_servers() {
        let limits = json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": {
                        "usedPercent": "14.5",
                        "windowDurationMins": "300",
                        "resetsAt": "200"
                    },
                    "secondary": {
                        "usedPercent": "41",
                        "windowDurationMins": "10020",
                        "resetsAt": "300"
                    }
                }
            }
        });
        let (five_hour, weekly, _, _) = find_usage_windows(&limits);
        assert_eq!(five_hour.expect("short window should be selected").remaining_percent, 85.5);
        let weekly = weekly.expect("changed multi-day window should be selected");
        assert_eq!(weekly.window_duration_mins, Some(10_020));
        assert_eq!(weekly.remaining_percent, 59.0);
    }

    #[test]
    fn uses_window_name_when_duration_is_temporarily_missing() {
        let limits = json!({
            "rateLimits": {
                "primary": { "usedPercent": 9, "resetsAt": 200 },
                "secondary": { "usedPercent": 27, "resetsAt": 300 }
            }
        });
        let (five_hour, weekly, _, _) = find_usage_windows(&limits);
        assert_eq!(five_hour.expect("primary should be selected").remaining_percent, 91.0);
        assert_eq!(weekly.expect("secondary should be selected").remaining_percent, 73.0);
    }
}
