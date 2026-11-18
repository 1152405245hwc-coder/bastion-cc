# Changelog

## Unreleased

- Added a loopback-first HTTP control server with bounded JSON requests and bearer authentication for public binding.
- Added SQLite event storage with cursor reads, idempotency and transactional state import.
- Added a metadata-safe HTTP CLI client and an explicit provider adapter boundary.
- Integrated public-safe deployment profiles for OAuth isolation, fail-closed DNS, VPS NAT protection, least-privilege notifications, safe reboot and rollback.
- Added privacy, product-boundary and similar-project audit records.
- Hydrated `ControlPlane` session, run, lease and output sequence state from `EventStoreLike` on startup.
- Added `/v1/sessions/:sessionId/runs/approve`, module-relative static web asset resolution, and full `HttpCliClient`/desktop preload lifecycle methods.
- Synced hardened `deploy/` scripts (`bbr.conf`, `claude-us-browser`, `safe-scheduled-reboot.py`, `ccrf-tg-notify.py`) and release-gate identity/dirty-flag checks.
- Added `ClaudeCliProviderAdapter` (`CCRF_PROVIDER=claude-cli`) supporting headless `claude` `stream-json` execution with token redaction.
- Added encrypted/bounded `run_bodies` storage (AES-256-GCM via `CCRF_BODY_KEY`), chunked transcript pagination, session listing/deletion, and idle body compaction.
- Added `DeviceRegistry` multi-device scoped token enrollment (`control`, `read`, `runner`), expiry, and revocation.
- Added SSE `/v1/sessions/:id/stream`, outbound runner lease/heartbeat/output/approval/complete HTTP endpoints, and `OutboundRunnerDaemon`.
- Added read-only `importLegacyV26Database` importer and dual-schema (`events` + `sessions`) support in reboot/notification VPS scripts.
- Upgraded `clients/web`, `clients/desktop` (with native `link-router.mjs` Claude OAuth URL isolation eliminating `app.asar` patching), `clients/cli` (`runCliRemote`), `Dockerfile`, `docker-compose.yml`, and `deploy/server/cc-relay-forge.service`.
