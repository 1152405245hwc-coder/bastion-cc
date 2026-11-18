# Server (`BastionCC` / `@cc-relay-forge`)

The server packages own the single-user control plane running inside the operator's trusted bastion host:

- `control`: session/run lifecycle, project grouping, session fork & Markdown/JSON export, `--resume` provider thread continuity (`providerSessionId`), leases, approval gates, cursor resume, and live prompt-cache hit-rate telemetry (`getUsageMetrics`).
- `storage`: in-memory and `node:sqlite` event stores (`events` metadata log + AES-256-GCM encrypted `run_bodies` store with chunked pagination and idle compaction).
- `auth`: `DeviceRegistry` supporting scoped tokens (`control`, `read`, `runner`), expiry/revocation, single-use 6-digit pairing codes, and optional RFC 6238 TOTP 2FA.
- `scheduler`: run status transition state machine and lease expiry tracking.
- `adapters`: `ClaudeCliProviderAdapter` (`CCRF_PROVIDER=claude-cli`, native `--resume` & isolated `CLAUDE_CONFIG_DIR` / US locale fingerprint), optional dynamic `ClaudeAgentSdkProviderAdapter` (`CCRF_PROVIDER=claude-agent-sdk`), deterministic `MockProviderAdapter`, and fail-closed `UnconfiguredProviderAdapter`.
- `execution`: bridges runs to provider execution while keeping prompt/output bodies out of metadata events and forwarding `providerSessionId` + cache usage telemetry.
- `http`: loopback-first HTTP + SSE (`/v1/sessions/:id/stream`) gateway serving REST APIs, `/v1/cage/status`, `/v1/devices/redeem-pair`, and static Web Workbench assets.
- `migration`: optional read-only v26 `sessions.sqlite` importer (`importLegacyV26Database`) and session-scoped shadow verification helpers.
