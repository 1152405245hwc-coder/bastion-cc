# Clients

All user-facing clients are thin authenticated consumers of the server's HTTP + SSE API and share the same session state and `--resume` continuity:

- `cli`: `runCli` (in-process test mode) and `runCliRemote` (`HttpCliClient`), including one-shot `chat <sessionId> <prompt>` and `pair <code>`.
- `web`: zero-dependency static Web Workbench (`index.html`, `style.css`, `app.js`) served under strict CSP with adaptive Light/Dark theme, project grouping, SSE event stream, cache hit rate badge, 6-digit pairing generator, auto-growing IME-safe composer, and Markdown export.
- `desktop`: hardened Electron Workbench (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, native OAuth URL isolation in `link-router.mjs`) featuring one-click local server/runner toggles, native folder picker, 6-digit pairing codes, and auto-saved config (`0600`).
