# Changelog

## v0.1.0

- Added a loopback-first HTTP control server with bounded JSON requests and bearer authentication for public binding, serving Web UI static assets cleanly while gating `/health` and `/v1/*` routes.
- Added SQLite event storage with cursor reads, idempotency, persistent `devices` and `idempotency_keys` tables, encrypted/bounded `run_bodies` (AES-256-GCM via `CCRF_BODY_KEY`), chunked transcript pagination, and idle body compaction.
- Added real async provider execution (`async: true`, periodic lease renewal, single active run lock per session) with `AbortController` subprocess cancellation and non-deadlocking bounded `stderr` drainage in `ClaudeCliProviderAdapter`.
- Added native `claude` CLI `--resume` continuity, cache hit-rate telemetry, `--permission-mode` mapping (`plan-only` -> `plan`, `auto-edit` -> `acceptEdits`), and multi-account `CLAUDE_CONFIG_DIR` isolation (`CCRF_ACCOUNTS_ROOT`).
- Added `DeviceRegistry` scoped tokens (`control`, `read`, `runner`), single-use 6-digit pairing codes with brute-force lockout protection, SQLite persistence, and optional RFC 6238 TOTP 2FA.
- Upgraded `clients/web`, `clients/desktop` (with native `link-router.mjs`, 6-digit pairing login, live SSE bridge, and `start:desktop`), and `clients/cli` (`bastioncc` / `ccrf` bin wrapper, human-readable `chat` output, and interactive `repl`).
- Added `OutboundRunnerDaemon`, real TCP socket E2E tests (`tests/integration/e2e-socket.test.ts`), Python VPS script unit tests (`tests/python/test_vps_scripts.py`), Docker healthchecks, GitHub issue/PR templates, and release-gate privacy/identity checks.
