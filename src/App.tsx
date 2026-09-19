import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  Eye,
  Gauge,
  Info,
  LoaderCircle,
  LogOut,
  Minus,
  Palette,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Timer,
  TimerReset,
  X,
} from "lucide-react";
import type {
  DashboardSnapshot,
  LoginStart,
  UsageSample,
  WidgetSettings,
} from "./types";

const SETTINGS_KEY = "codex-weekly-widget.settings.v2";
const SAMPLES_KEY = "codex-weekly-widget.samples.v1";
const POSITION_KEY = "codex-weekly-widget.position.v2";
const SNAPSHOT_KEY = "codex-usage-dashboard.last-good-snapshot.v1";
const REFRESH_SECONDS = 90;

const BACKGROUND_PRESETS = [
  { color: "#111524", label: "Midnight" },
  { color: "#19132b", label: "Violet" },
  { color: "#0e2324", label: "Teal" },
  { color: "#251718", label: "Ember" },
  { color: "#17191d", label: "Graphite" },
] as const;

const defaultSettings: WidgetSettings = {
  opacity: 100,
  backgroundColor: "#111524",
  startWithWindows: false,
  desktopMode: false,
};

const isTauriRuntime = () => "__TAURI_INTERNALS__" in window;

const previewSnapshot: DashboardSnapshot = {
  account: { connected: true, email: "alex@example.com", plan: "pro" },
  fiveHour: {
    usedPercent: 22,
    remainingPercent: 78,
    resetAt: Math.floor(Date.now() / 1000) + 2 * 3_600 + 17 * 60,
    windowDurationMins: 300,
    limitId: "codex",
    limitName: "Codex",
  },
  weekly: {
    usedPercent: 37,
    remainingPercent: 63,
    resetAt: Math.floor(Date.now() / 1000) + 3 * 86_400 + 11 * 3_600,
    windowDurationMins: 10_080,
    limitId: "codex",
    limitName: "Codex",
  },
  tokensToday: 241_300,
  tokenBucketDate: new Date().toISOString().slice(0, 10),
  lifetimeTokens: 8_921_300,
  creditsBalance: null,
  creditsUnlimited: false,
  fetchedAt: Date.now(),
};

function loadSettings(): WidgetSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<WidgetSettings>;
    const backgroundColor = typeof saved.backgroundColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.backgroundColor)
      ? saved.backgroundColor.toLowerCase()
      : defaultSettings.backgroundColor;
    return {
      opacity: typeof saved.opacity === "number" ? Math.max(30, Math.min(100, saved.opacity)) : defaultSettings.opacity,
      backgroundColor,
      startWithWindows: saved.startWithWindows === true,
      desktopMode: saved.desktopMode === true,
    };
  } catch {
    return defaultSettings;
  }
}

function colorChannelStops(hex: string): { highlight: string; base: string; shadow: string } {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  const value = match?.[1] ?? "111524";
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const mix = (target: number, amount: number) => channels
    .map((channel) => Math.round(channel + (target - channel) * amount))
    .join(", ");
  return {
    highlight: mix(255, 0.08),
    base: channels.join(", "),
    shadow: mix(0, 0.48),
  };
}

function loadSamples(): UsageSample[] {
  try {
    const value = JSON.parse(localStorage.getItem(SAMPLES_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function loadLastGoodSnapshot(): DashboardSnapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "null") as DashboardSnapshot | null;
    if (!value?.account?.connected || (!value.weekly && !value.fiveHour)) return null;
    return value;
  } catch {
    return null;
  }
}

function canReuseWindow(window: DashboardSnapshot["weekly"], fetchedAt: number): boolean {
  if (!window) return false;
  if (window.resetAt) return window.resetAt * 1_000 > Date.now();
  return Date.now() - fetchedAt < 10 * 60_000;
}

function retainLastKnownWindows(next: DashboardSnapshot, current: DashboardSnapshot | null): DashboardSnapshot {
  const previous = current?.account.connected ? current : loadLastGoodSnapshot();
  if (!previous) return next;
  return {
    ...next,
    fiveHour: next.fiveHour ?? (canReuseWindow(previous.fiveHour, previous.fetchedAt) ? previous.fiveHour : null),
    weekly: next.weekly ?? (canReuseWindow(previous.weekly, previous.fetchedAt) ? previous.weekly : null),
  };
}

function formatTokens(value?: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function formatReset(timestamp?: number | null): string {
  if (!timestamp) return "Reset time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatCountdown(timestamp?: number | null, now = Date.now()): string {
  if (!timestamp) return "Waiting for Codex";
  const seconds = Math.max(0, Math.floor(timestamp - now / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function getStatusTone(remaining: number): "good" | "warn" | "critical" {
  if (remaining <= 10) return "critical";
  if (remaining <= 25) return "warn";
  return "good";
}

type QuotaProjection = {
  minutesLeft: number;
  observationMinutes: number;
  percentUsed: number;
  windowLabel: "5-hour" | "weekly";
};

type QuotaProjectionState = {
  projection: QuotaProjection | null;
  hasEnoughHistory: boolean;
};

const RATE_LOOKBACK_MS = 15 * 60_000;
const MIN_RATE_SPAN_MS = 4 * 60_000;
const MIN_MEASURABLE_CHANGE = 0.05;

function calculateWindowProjection(
  samples: UsageSample[],
  window: DashboardSnapshot["weekly"],
  windowKind: "fiveHour" | "weekly",
): QuotaProjectionState {
  if (!window?.resetAt) return { projection: null, hasEnoughHistory: false };
  const relevant = samples
    .filter((sample) => (
      sample.resetAt === window.resetAt
      && (sample.windowKind === windowKind || (windowKind === "weekly" && sample.windowKind == null))
    ))
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .slice(-120);
  const newest = relevant.at(-1);
  if (!newest) return { projection: null, hasEnoughHistory: false };

  const recent = relevant.filter((sample) => sample.capturedAt >= newest.capturedAt - RATE_LOOKBACK_MS);
  const oldest = recent[0];
  const elapsedMs = newest.capturedAt - oldest.capturedAt;
  if (recent.length < 2 || elapsedMs < MIN_RATE_SPAN_MS) {
    return { projection: null, hasEnoughHistory: false };
  }

  // Measuring across the whole interval intentionally includes idle time between
  // Codex percentage updates. Counting only the intervals with a change makes a
  // brief reported jump look like a sustained burn rate.
  const percentUsed = newest.usedPercent - oldest.usedPercent;
  if (percentUsed < MIN_MEASURABLE_CHANGE) {
    return { projection: null, hasEnoughHistory: true };
  }

  const percentPerMinute = percentUsed / (elapsedMs / 60_000);
  return {
    hasEnoughHistory: true,
    projection: {
      minutesLeft: window.remainingPercent / percentPerMinute,
      observationMinutes: elapsedMs / 60_000,
      percentUsed,
      windowLabel: windowKind === "fiveHour" ? "5-hour" : "weekly",
    },
  };
}

function calculateQuotaProjection(samples: UsageSample[], current?: DashboardSnapshot | null): QuotaProjectionState {
  const fiveHour = calculateWindowProjection(samples, current?.fiveHour, "fiveHour");
  const weekly = calculateWindowProjection(samples, current?.weekly, "weekly");
  const projections = [fiveHour.projection, weekly.projection]
    .filter((value): value is QuotaProjection => value != null)
    .sort((a, b) => a.minutesLeft - b.minutesLeft);
  return {
    projection: projections[0] ?? null,
    hasEnoughHistory: fiveHour.hasEnoughHistory || weekly.hasEnoughHistory,
  };
}

function formatProjectedTime(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Under 1m";
  if (minutes >= 7 * 24 * 60) return "168h+";
  const roundedMinutes = Math.max(1, Math.round(minutes));
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function calculateDailyQuotaPercent(snapshot?: DashboardSnapshot | null): number | null {
  const weekly = snapshot?.weekly;
  if (!weekly?.resetAt) return null;
  const nowMs = Date.now();
  const resetMs = weekly.resetAt * 1000;
  const totalRemainingMs = resetMs - nowMs;
  if (totalRemainingMs <= 0) return 0;
  const exactDaysRemaining = totalRemainingMs / 86_400_000;
  return Math.min(weekly.remainingPercent, weekly.remainingPercent / exactDaysRemaining);
}

function MetricInfo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="metric-info">
      <button type="button" aria-label={label} className="metric-info-button">
        <Info size={11} aria-hidden="true" />
      </button>
      <span className="metric-tooltip" role="tooltip">{children}</span>
    </span>
  );
}

function UsageRing({ remaining }: { remaining: number }) {
  const value = Math.max(0, Math.min(100, remaining));
  const circumference = 2 * Math.PI * 74;
  const dashOffset = circumference * (1 - value / 100);
  return (
    <div className="usage-ring" aria-label={`${Math.round(value)} percent remaining`}>
      <svg viewBox="0 0 176 176" role="img">
        <defs>
          <linearGradient id="ringGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="52%" stopColor="#6d8dff" />
            <stop offset="100%" stopColor="#42d7bd" />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx="88" cy="88" r="74" />
        <circle
          className="ring-value"
          cx="88"
          cy="88"
          r="74"
          style={{ strokeDasharray: circumference, strokeDashoffset: dashOffset }}
        />
      </svg>
      <div className="ring-label">
        <span>{Math.round(value)}</span>
        <small>%</small>
        <em>remaining</em>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [settings, setSettings] = useState<WidgetSettings>(loadSettings);
  const [samples, setSamples] = useState<UsageSample[]>(loadSamples);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    setLoading((current) => current || !snapshot);
    try {
      if (!isTauriRuntime()) {
        setSnapshot({ ...previewSnapshot, fetchedAt: Date.now() });
        setError(null);
        return;
      }
      const next = await invoke<DashboardSnapshot>("get_dashboard");
      const displaySnapshot = retainLastKnownWindows(next, snapshot);
      const responseWasIncomplete = next.account.connected && (!next.weekly || !next.fiveHour);
      setSnapshot(displaySnapshot);
      setError(responseWasIncomplete && (displaySnapshot.weekly || displaySnapshot.fiveHour)
        ? "Codex temporarily omitted a usage window; showing the last valid value."
        : null);
      if (displaySnapshot.weekly || displaySnapshot.fiveHour) {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(displaySnapshot));
        setSamples((current) => {
          const capturedAt = Date.now();
          const newSamples: UsageSample[] = [];
          if (next.weekly) newSamples.push({
            capturedAt,
            usedPercent: next.weekly.usedPercent,
            resetAt: next.weekly.resetAt ?? null,
            windowKind: "weekly",
          });
          if (next.fiveHour) newSamples.push({
            capturedAt,
            usedPercent: next.fiveHour.usedPercent,
            resetAt: next.fiveHour.resetAt ?? null,
            windowKind: "fiveHour",
          });
          const cutoff = Date.now() - 30 * 86_400_000;
          const compacted = [...current.filter((item) => item.capturedAt >= cutoff), ...newSamples].slice(-1_000);
          localStorage.setItem(SAMPLES_KEY, JSON.stringify(compacted));
          return compacted;
        });
      }
    } catch (cause) {
      const message = String(cause);
      setError(message.includes("not found") ? "Codex is not installed or could not be found." : message);
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, [snapshot]);

  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), REFRESH_SECONDS * 1_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisteners = [
      listen("codex://rate-limits-updated", () => void refresh()),
      listen("codex://login-completed", () => {
        setLoggingIn(false);
        window.setTimeout(() => void refresh(), 500);
      }),
      listen("widget://refresh", () => void refresh()),
    ];
    return () => {
      void Promise.all(unlisteners).then((callbacks) => callbacks.forEach((unlisten) => unlisten()));
    };
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    document.documentElement.style.setProperty("--panel-opacity", String(settings.opacity / 100));
    const colors = colorChannelStops(settings.backgroundColor);
    document.documentElement.style.setProperty("--panel-highlight-rgb", colors.highlight);
    document.documentElement.style.setProperty("--panel-color-rgb", colors.base);
    document.documentElement.style.setProperty("--panel-shadow-rgb", colors.shadow);
  }, [settings]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const windowHandle = getCurrentWindow();
    void windowHandle.setAlwaysOnBottom(settings.desktopMode);
    void isEnabled().then((value) => {
      setSettings((current) => (current.startWithWindows === value ? current : { ...current, startWithWindows: value }));
    });
    try {
      const position = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        void windowHandle.setPosition(new PhysicalPosition(position.x, position.y));
      }
    } catch {
      // Ignore an invalid saved window position.
    }
    const positionListener = windowHandle.onMoved(({ payload }) => {
      localStorage.setItem(POSITION_KEY, JSON.stringify(payload));
    });
    return () => {
      void positionListener.then((unlisten) => unlisten());
    };
  }, []);

  const updateSettings = (patch: Partial<WidgetSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const toggleAutostart = async (next: boolean) => {
    if (!isTauriRuntime()) {
      updateSettings({ startWithWindows: next });
      return;
    }
    try {
      if (next) await enable();
      else await disable();
      updateSettings({ startWithWindows: next });
    } catch (cause) {
      setError(`Could not update startup preference: ${String(cause)}`);
    }
  };

  const toggleDesktopMode = async (next: boolean) => {
    if (isTauriRuntime()) await getCurrentWindow().setAlwaysOnBottom(next);
    updateSettings({ desktopMode: next });
  };

  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (!isTauriRuntime() || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, input, select")) return;
    void getCurrentWindow().startDragging();
  };

  const beginLogin = async () => {
    if (!isTauriRuntime()) return;
    setLoggingIn(true);
    setError(null);
    try {
      const login = await invoke<LoginStart>("begin_login");
      await openUrl(login.authUrl);
    } catch (cause) {
      setLoggingIn(false);
      setError(String(cause));
    }
  };

  const logout = async () => {
    if (!isTauriRuntime()) {
      setSnapshot(null);
      setSettingsOpen(false);
      return;
    }
    await invoke("logout");
    setSnapshot(null);
    setSettingsOpen(false);
    await refresh();
  };

  const quotaProjection = useMemo(() => calculateQuotaProjection(samples, snapshot), [samples, snapshot]);
  const dailyQuotaPercent = useMemo(
    () => calculateDailyQuotaPercent(snapshot),
    [snapshot, now],
  );
  const remaining = snapshot?.weekly?.remainingPercent ?? 0;
  const fiveHourRemaining = snapshot?.fiveHour?.remainingPercent ?? null;
  const statusTone = getStatusTone(Math.min(remaining, fiveHourRemaining ?? 100));
  const fiveHourTone = getStatusTone(fiveHourRemaining ?? 100);
  const isConnected = snapshot?.account.connected ?? false;

  return (
    <main className="widget-shell">
      <section className={`glass-panel ${settingsOpen ? "settings-visible" : ""}`}>
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />

        <header className="titlebar" data-tauri-drag-region onMouseDown={startWindowDrag}>
          <div className="brand" data-tauri-drag-region>
            <div className="brand-mark"><Sparkles size={15} /></div>
            <div data-tauri-drag-region>
              <strong>CODEX</strong>
              <span>usage dashboard</span>
            </div>
          </div>
          <div className="window-actions">
            <button className="icon-button" title="Settings" onClick={() => setSettingsOpen((open) => !open)}>
              <Settings2 size={16} />
            </button>
            <button className="icon-button" title="Hide to tray" onClick={() => isTauriRuntime() && void getCurrentWindow().hide()}>
              <Minus size={17} />
            </button>
          </div>
        </header>

        {!isConnected ? (
          <div className="connect-view">
            <div className="connect-orbit">
              <div className="connect-core"><Sparkles size={29} /></div>
            </div>
            <div className="eyebrow">Your usage, at a glance</div>
            <h1>Connect your Codex account</h1>
            <p>A secure browser window will open. Your sign-in stays managed by Codex.</p>
            <button className="primary-button" onClick={() => void beginLogin()} disabled={loggingIn || loading}>
              {loggingIn || loading ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
              {loggingIn ? "Waiting for browser…" : loading ? "Checking Codex…" : "Connect with Codex"}
              {!loggingIn && !loading && <ArrowUpRight size={16} />}
            </button>
            {loggingIn && <button className="text-button" onClick={() => void refresh()}>I finished signing in</button>}
            {error && <div className="inline-error"><CircleAlert size={15} /><span>{error}</span></div>}
          </div>
        ) : settingsOpen ? (
          <div className="settings-view">
            <div className="settings-heading">
              <div>
                <span className="eyebrow">Appearance & behavior</span>
                <h2>Widget settings</h2>
              </div>
              <button className="icon-button" onClick={() => setSettingsOpen(false)}><X size={17} /></button>
            </div>

            <div className="setting-card featured-setting">
              <div className="setting-title">
                <span><Eye size={16} /> Transparency</span>
                <b>{settings.opacity}%</b>
              </div>
              <input
                aria-label="Widget transparency"
                type="range"
                min="30"
                max="100"
                value={settings.opacity}
                onChange={(event) => updateSettings({ opacity: Number(event.target.value) })}
              />
              <div className="range-hints"><span>Airy</span><span>Solid</span></div>
            </div>

            <div className="setting-card">
              <div className="setting-title">
                <span><Palette size={16} /> Background color</span>
                <b>{settings.backgroundColor.toUpperCase()}</b>
              </div>
              <div className="color-options">
                {BACKGROUND_PRESETS.map((preset) => (
                  <button
                    key={preset.color}
                    type="button"
                    className={`color-swatch ${settings.backgroundColor.toLowerCase() === preset.color ? "selected" : ""}`}
                    style={{ backgroundColor: preset.color }}
                    aria-label={`Use ${preset.label} background`}
                    title={preset.label}
                    onClick={() => updateSettings({ backgroundColor: preset.color })}
                  />
                ))}
                <label className="custom-color" title="Choose a custom background color">
                  <input
                    aria-label="Custom background color"
                    type="color"
                    value={settings.backgroundColor}
                    onChange={(event) => updateSettings({ backgroundColor: event.target.value })}
                  />
                  <span>Custom</span>
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div><strong>Desktop mode</strong><span>Optional: stay behind windows</span></div>
              <Toggle checked={settings.desktopMode} onChange={(next) => void toggleDesktopMode(next)} />
            </div>
            <div className="setting-row">
              <div><strong>Start with Windows</strong><span>Keep your pulse ready</span></div>
              <Toggle checked={settings.startWithWindows} onChange={(next) => void toggleAutostart(next)} />
            </div>
            <div className="account-strip">
              <div className="avatar">{snapshot?.account.email?.[0]?.toUpperCase() ?? "C"}</div>
              <div><strong>{snapshot?.account.email ?? "Codex account"}</strong><span>{snapshot?.account.plan ?? "Connected"} plan</span></div>
              <button title="Disconnect" onClick={() => void logout()}><LogOut size={16} /></button>
            </div>
          </div>
        ) : (
          <div className="dashboard-view">
            <div className="status-line">
              <span className={`live-dot ${statusTone}`} />
              <span>{snapshot?.account.plan ?? "Codex"} plan</span>
              <span className="status-spacer" />
              <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw className={loading ? "spin" : ""} size={13} />
                {loading ? "Syncing" : "Live"}
              </button>
            </div>

            {snapshot?.weekly ? (
              <>
                <div className="hero-usage">
                  <UsageRing remaining={remaining} />
                  <div className="usage-copy">
                    <span className="eyebrow">Weekly allowance</span>
                    <h1>{statusTone === "critical" ? "Running low" : statusTone === "warn" ? "Use thoughtfully" : "You’re in good shape"}</h1>
                    <p><TimerReset size={14} /> {formatCountdown(snapshot.weekly.resetAt, now)}</p>
                  </div>
                </div>

                {snapshot.fiveHour ? (
                  <div className={`short-window-card ${fiveHourTone}`}>
                    <div className="short-window-heading">
                      <span><Timer size={16} /> 5-hour window</span>
                      <strong>{Math.round(snapshot.fiveHour.remainingPercent)}% left</strong>
                    </div>
                    <div className="allowance-bar" aria-label={`${Math.round(snapshot.fiveHour.remainingPercent)} percent of five-hour allowance remaining`}>
                      <span style={{ width: `${snapshot.fiveHour.remainingPercent}%` }} />
                    </div>
                    <div className="short-window-meta">
                      <span>{formatCountdown(snapshot.fiveHour.resetAt, now)}</span>
                      <span>resets {formatReset(snapshot.fiveHour.resetAt)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="reset-banner">
                    <CalendarClock size={17} />
                    <div><span>Weekly reset</span><strong>{formatReset(snapshot.weekly.resetAt)}</strong></div>
                    <ChevronRight size={15} />
                  </div>
                )}

                <div className="metric-grid">
                  <article>
                    <div className="metric-icon violet"><Activity size={17} /></div>
                    <div className="metric-label"><span>Today</span></div>
                    <strong>{formatTokens(snapshot.tokensToday)}</strong>
                    <small>tokens {snapshot.tokenBucketDate ? `· ${snapshot.tokenBucketDate}` : ""}</small>
                  </article>
                  <article>
                    <div className="metric-icon blue"><Gauge size={17} /></div>
                    <div className="metric-label">
                      <span>Daily budget</span>
                      <MetricInfo label="Explain daily budget">
                        {dailyQuotaPercent == null ? (
                          <>Codex has not provided the weekly reset time, so a daily budget cannot be calculated.</>
                        ) : (
                          <>You have {remaining.toFixed(1)}% of your weekly quota left with {formatCountdown(snapshot.weekly?.resetAt, now)}. Dividing it evenly across the exact time remaining gives a daily budget of {dailyQuotaPercent.toFixed(1)}% of the total weekly quota per 24 hours.</>
                        )}
                      </MetricInfo>
                    </div>
                    <strong>{dailyQuotaPercent == null ? "Unavailable" : `${dailyQuotaPercent.toFixed(1)}%`}</strong>
                    <small>{dailyQuotaPercent == null ? "reset time needed" : "weekly quota / 24h"}</small>
                  </article>
                  <article>
                    <div className="metric-icon mint"><TimerReset size={17} /></div>
                    <div className="metric-label">
                      <span>Quota lasts</span>
                      <MetricInfo label="Explain how long the quota lasts">
                        {quotaProjection.projection ? (
                          <>Based on {quotaProjection.projection.percentUsed.toFixed(1)}% used over the last {Math.round(quotaProjection.projection.observationMinutes)} minutes, your {quotaProjection.projection.windowLabel} quota would run out in about {formatProjectedTime(quotaProjection.projection.minutesLeft)} if that rate continues. Idle time is included.</>
                        ) : quotaProjection.hasEnoughHistory ? (
                          <>No measurable quota use was detected in the last 15 minutes, so there is no active burn rate to project.</>
                        ) : (
                          <>The dashboard is collecting percentage samples. It needs at least 4 minutes of history before estimating how long your quota will last.</>
                        )}
                      </MetricInfo>
                    </div>
                    <strong>{quotaProjection.projection ? formatProjectedTime(quotaProjection.projection.minutesLeft) : quotaProjection.hasEnoughHistory ? "Idle" : "Collecting"}</strong>
                    <small>{quotaProjection.projection ? `${quotaProjection.projection.windowLabel} · recent rate` : quotaProjection.hasEnoughHistory ? "no recent quota use" : "needs 4+ min"}</small>
                  </article>
                </div>

                <footer>
                  <span>Updated {Math.max(0, Math.floor((now - snapshot.fetchedAt) / 1000))}s ago</span>
                  <span>{snapshot.creditsUnlimited ? "Unlimited credits" : snapshot.creditsBalance ? `${snapshot.creditsBalance} credits` : snapshot.fiveHour ? "5-hour + weekly" : "Weekly-only mode"}</span>
                </footer>
              </>
            ) : snapshot?.fiveHour ? (
              <div className="no-usage-view">
                <div className="metric-icon blue large"><Timer size={22} /></div>
                <h2>Weekly usage is syncing</h2>
                <p>Your five-hour allowance is still available while Codex refreshes the longer-term window.</p>
                <div className={`short-window-card ${fiveHourTone}`}>
                  <div className="short-window-heading">
                    <span><Timer size={16} /> 5-hour window</span>
                    <strong>{Math.round(snapshot.fiveHour.remainingPercent)}% left</strong>
                  </div>
                  <div className="allowance-bar" aria-label={`${Math.round(snapshot.fiveHour.remainingPercent)} percent of five-hour allowance remaining`}>
                    <span style={{ width: `${snapshot.fiveHour.remainingPercent}%` }} />
                  </div>
                  <div className="short-window-meta">
                    <span>{formatCountdown(snapshot.fiveHour.resetAt, now)}</span>
                    <span>resets {formatReset(snapshot.fiveHour.resetAt)}</span>
                  </div>
                </div>
                <button className="secondary-button" onClick={() => void refresh()} disabled={loading}>
                  <RefreshCw className={loading ? "spin" : ""} size={16} /> {loading ? "Syncing" : "Try again"}
                </button>
              </div>
            ) : (
              <div className="no-usage-view">
                <div className="metric-icon violet large"><Activity size={22} /></div>
                <h2>Usage is syncing</h2>
                <p>Codex is connected but has not returned a usable allowance window yet. The dashboard will keep retrying.</p>
                <button className="secondary-button" onClick={() => void refresh()} disabled={loading}>
                  <RefreshCw className={loading ? "spin" : ""} size={16} /> {loading ? "Syncing" : "Try again"}
                </button>
              </div>
            )}
            {error && <div className="toast-error"><CircleAlert size={14} /> Data may be stale</div>}
          </div>
        )}
      </section>
    </main>
  );
}
