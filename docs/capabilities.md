# Capability matrix

The repository uses three status words everywhere: `verified` means covered by the local contract/integration suite; `optional` means a versioned deployment or adapter template that must be tested in its target environment; `unsupported` means the project deliberately does not claim the capability yet.

| Area | Status | Evidence / boundary |
| --- | --- | --- |
| Versioned protocol and capability negotiation | verified | `core/protocol`, contract tests |
| Session/run state, generation and cursor recovery | verified | `server/control`, integration tests |
| Event idempotency, encrypted body store, and SQLite persistence | verified | `server/storage`, SQLite `events`, `devices`, `idempotency_keys`, AES-256-GCM `run_bodies` + compaction tests |
| HTTP/SSE control entry point | verified in handler and live socket E2E tests | Loopback-first; unauthenticated static Web UI + authenticated `/health`/`/v1/*`; async execution, live SSE `/stream`, real `AbortSignal` cancel, and concurrent active-run lock |
| Multi-device scoped token enrollment & 6-digit pairing | verified | `DeviceRegistry` (`control`, `read`, `runner`), SQLite persistence, SHA-256 hashed credentials, expiry/revocation, and brute-force lockout protection |
| Optional TOTP 2FA boundary | verified in RFC-compatible contract tests | Enable with `CCRF_TOTP_SECRET`; clients send `X-CCRF-TOTP` |
| Remote/local CLI (`bastioncc` / `ccrf`) and HTTP client | verified | `clients/cli`, `scripts/bastioncc.mjs`, `runCliRemote`, interactive `repl`, `HttpCliClient` |
| Mock provider, mock runner, and outbound runner daemon | verified | Deterministic fault-injection and `OutboundRunnerDaemon` tests |
| Provider-to-run lifecycle bridge | verified with mock/provider seams | `server/execution`; output bodies stay in private `run_bodies`, not in `events` |
| Official `claude` CLI provider | verified with real child-process stderr-drain & abort tests; optional host login | `ClaudeCliProviderAdapter` (`CCRF_PROVIDER=claude-cli`); maps `approvalMode` to `--permission-mode`, drains stderr cleanly, requires host `claude` OAuth login |
| Local runner | verified for dry-run/capability checks | Real process execution is intentionally constrained |
| v26 conversion and read-only SQLite import | verified in contract tests; optional for production | `compat/legacy-v26-gateway` and `importLegacyV26Database`; no legacy database double-write |
| Native Electron OAuth URL isolation | verified in router tests | `clients/desktop/src/link-router.mjs` routes Claude URLs to isolated browser without `app.asar` patching |
| VPS firewall/NAT/reboot/notification templates | verified logic in Python unit tests; host systemd/nftables acceptance host-bound | `deploy/vps`, `tests/python/test_vps_scripts.py`, `Dockerfile`, `docker-compose.yml`; dual-schema `events` + `sessions` scripts |
| Real Claude/Agent SDK | optional | `server/adapters` dynamically loads `@anthropic-ai/claude-agent-sdk` only when `CCRF_PROVIDER=claude-agent-sdk`; the dependency and provider credentials remain deployment-owned |
| Web workbench | verified static client | `clients/web`; auto-SSE transcript streaming, 6-digit pairing login, approvals, device enrollment, strict CSP |
| Electron desktop workbench | optional / hardened shell | `clients/desktop`; context isolation, sandbox, native OAuth routing, live SSE push bridge, 6-digit pairing login, `window.relay` bridge |
| Rootless container runner | optional / host-bound | `runner/container`; argv and capability tests, Linux host acceptance still required |
| Session-scoped shadow migration | optional / compatibility | `server/migration`; no double-write and rollback decision only |
| VM runner | unsupported | Add only after image signing, snapshot and rollback review |

The matrix is part of the release contract. A feature cannot be described as stable in the README while it is marked unsupported here.
