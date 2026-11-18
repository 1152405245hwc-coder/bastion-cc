# Web Client

Zero-dependency static Workbench served directly by `server/http` (at `/`) under a strict Content-Security-Policy (`default-src 'self'`).

Features include:

- Project-grouped session sidebar with instant search, inline rename, fork, Markdown export, and idle history compaction.
- Live token & prompt-cache hit-rate pill (`GET /v1/metrics`), `Claude` session continuity badge, and isolated `accountProfile` slot selector.
- Approval Mode (`manual` / `auto-edit` / `plan-only`) & Reasoning Effort (`low` / `medium` / `high` / `max`) controls.
- Adaptive Light/Dark system theme (`color-scheme: light dark`), auto-growing textarea (`field-sizing: content`), per-session draft persistence, and IME-safe `Enter`-to-submit.
- Multi-device scoped token enrollment and 6-digit pairing code generation.
