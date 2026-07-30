# Codex Usage Dashboard

A lightweight Windows desktop widget for the current Codex usage allowances.

## What it shows

- Five-hour allowance remaining and its rolling reset time, when returned by Codex
- Weekly allowance remaining and the next reset time
- Tokens used today (when Codex returns daily usage buckets)
- A plain-language suggestion for how much weekly allowance to use today
- Estimated time until the weekly limit is exhausted, after enough local samples accumulate
- Connected plan and optional credit balance

Allowance windows are classified by their reported duration, rather than assuming that
`primary` or `secondary` always means a particular limit. This keeps the display correct
if Codex temporarily returns only weekly usage or switches the order of the two buckets.

## Sign-in and privacy

Choose **Connect with Codex** to open the Codex-managed ChatGPT login page in your
browser. The widget talks to the locally installed `codex app-server` process and does
not read, copy, or store account tokens itself. Preferences and anonymous usage samples
used for the runway estimate stay in the widget's local WebView storage.

## Appearance and desktop behavior

Open the sliders icon to adjust:

- Transparency from 30% to 100%
- Background glass blur from 0 to 36 px
- Desktop mode (keeps the widget behind ordinary windows)
- Start with Windows
- Refresh interval

Drag the title bar to place the widget. Its position and appearance settings persist.
The minimize button hides it to the system tray; click the tray icon to bring it back.

## Requirements

- Windows 10 or Windows 11 with WebView2

The installer places the OpenAI-signed Codex CLI runtime beside the widget as an
application resource. Development mode uses the matching runtime installed in this
project's `node_modules`.

To test a different Codex build, set `CODEX_WIDGET_CODEX_PATH` to the full path of its
executable before launching the widget. This override takes priority over the bundled
runtime.

Use the **Start with Windows** toggle in Widget settings. It registers the installed
executable directly. Do not copy the raw `.exe` into the Startup folder: portable builds
must remain beside their `codex-runtime` directory.

The interactive Windows installer also asks whether the widget should start when you
sign in. It does not enable startup silently, and the choice can be changed later in
Widget settings.

## Development

```powershell
npm install
npm run tauri:dev
```

Checks and packaging:

```powershell
npm run check
cargo test --manifest-path src-tauri\Cargo.toml
npm run tauri:build
```
