# Codex Weekly

A lightweight Windows desktop widget for the current Codex usage allowances.

## What it shows

- Five-hour allowance remaining and its rolling reset time, when returned by Codex
- Weekly allowance remaining and the next reset time
- Tokens used today (when Codex returns daily usage buckets)
- A suggested allowance budget through midnight
- Estimated runway after enough local samples have accumulated
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

The release installer includes the Codex CLI runtime used for account login and usage
queries. Development mode uses the matching runtime installed in this project's
`node_modules` directory.

To test a different Codex build, set `CODEX_WIDGET_CODEX_PATH` to the full path of its
executable before launching the widget. This override takes priority over the bundled
runtime.

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
