# Capability matrix

The repository uses three status words everywhere: `verified` means covered by the local contract/integration suite; `optional` means a versioned deployment or adapter template that must be tested in its target environment; `unsupported` means the project deliberately does not claim the capability yet.

| Area | Status | Evidence / boundary |
| --- | --- | --- |
| Versioned protocol and capability negotiation | verified | `core/protocol`, contract tests |
| Session/run state, generation and cursor recovery | verified | `server/control`, integration tests |
| Event idempotency, encrypted body store, and SQLite persistence | verified | `server/storage`, SQLite `events` + AES-256-GCM `run_bodies` + compaction tests |
| HTTP/SSE control entry point | verified in handler tests | Loopback-first; public binding requires bearer token; supports SSE `/stream`, transcripts, and runner endpoints |
| Multi-device scoped token enrollment | verified | `DeviceRegistry` (`control`, `read`, `runner`), SHA-256 hashed credentials, expiry and revocation |
| Optional TOTP 2FA boundary | verified in RFC-compatible contract tests | Enable with `CCRF_TOTP_SECRET`; clients send `X-CCRF-TOTP` |
| Remote/local CLI and HTTP client | verified | `clients/cli`, `runCliRemote`, `HttpCliClient` |
| Mock provider, mock runner, and outbound runner daemon | verified | Deterministic fault-injection and `OutboundRunnerDaemon` tests |
| Provider-to-run lifecycle bridge | verified with mock/provider seams | `server/execution`; output bodies stay in private `run_bodies`, not in `events` |
| Official `claude` CLI provider | verified with stream-json stub; optional host login | `ClaudeCliProviderAdapter` (`CCRF_PROVIDER=claude-cli`); requires host `claude` OAuth login |
| Local runner | verified for dry-run/capability checks | Real process execution is intentionally constrained |
| v26 conversion and read-only SQLite import | verified in contract tests; optional for production | `compat/legacy-v26-gateway` and `importLegacyV26Database`; no legacy database double-write |
| Native Electron OAuth URL isolation | verified in router tests | `clients/desktop/src/link-router.mjs` routes Claude URLs to isolated browser without `app.asar` patching |
| VPS firewall/NAT/reboot/notification templates | optional / host-bound | `deploy/vps`, `Dockerfile`, `docker-compose.yml`; dual-schema `events` + `sessions` scripts |
| Real Claude/Agent SDK | optional | `server/adapters` dynamically loads `@anthropic-ai/claude-agent-sdk` only when `CCRF_PROVIDER=claude-agent-sdk`; the dependency and provider credentials remain deployment-owned |
| Web workbench | verified static client | `clients/web`; sessions, chunked transcripts, approvals, device enrollment, SSE stream, strict CSP |
| Electron desktop workbench | optional / hardened shell | `clients/desktop`; context isolation, sandbox, native OAuth routing, full `window.relay` bridge |
| Rootless container runner | optional / host-bound | `runner/container`; argv and capability tests, Linux host acceptance still required |
| Session-scoped shadow migration | optional / compatibility | `server/migration`; no double-write and rollback decision only |
| VM runner | unsupported | Add only after image signing, snapshot and rollback review |

The matrix is part of the release contract. A feature cannot be described as stable in the README while it is marked unsupported here.
