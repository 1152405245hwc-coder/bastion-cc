# BastionCC

[中文说明](README.md) · [Launch Copy](docs/launch-kit.md) · [Architecture](docs/architecture.md) · [Threat Model](docs/threat-model.md) · [Capability Matrix](docs/capabilities.md)

**Keep the official Claude Code CLI anchored inside a trusted server bastion—preserving native `--resume` prompt caching and Pro/Max quota durability—while controlling sessions effortlessly from Desktop, Web, CLI, and Mobile.**

---

## Why BastionCC?

| Setup | Tradeoff |
| :--- | :--- |
| **Server CLI + API Reverse Proxy -> 3rd-Party API Client** | Rebuilding prompts and message arrays through a generic API proxy frequently breaks Anthropic prefix alignment, collapses `cache_read_input_tokens`, and exhausts Pro/Max subscription quotas fast. |
| **Raw SSH Terminal CLI** | High prompt cache hit rate, but lacks a multi-project UI, instant search, session forking, Markdown export, mobile approval banners, and multi-device pairing. |
| **BastionCC** | **Runs native `claude --resume` directly on your server bastion to protect prompt cache hit rates, wrapped with a clean HTTP/SSE control plane, isolated account slots, an outbound local runner, and turnkey Desktop/Web/CLI clients.** |

---

## Key Capabilities

1. **Native `--resume` Cache Preservation & Telemetry**
   - `ClaudeCliProviderAdapter` (`CCRF_PROVIDER=claude-cli`) parses `session_id` and token/cache usage (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) from `stream-json` events.
   - Follow-up runs in the same session automatically pass `--resume <session_id>` and update live **`cacheHitRate`** telemetry on `GET /v1/metrics`.
2. **Multi-Account Cage Slots & Fingerprint Consistency**
   - Per-session `accountProfile` maps to isolated `CLAUDE_CONFIG_DIR` folders under `CCRF_ACCOUNTS_ROOT` with consistent timezone/locale defaults (`America/Los_Angeles`, `en_US.UTF-8`).
   - Hardened Electron shell routes Claude login links via `link-router.mjs` to an isolated browser profile without patching third-party binaries.
3. **Unified Clients (Desktop, Web, CLI)**
   - **Desktop (`clients/desktop`)**: Electron shell with `sandbox: true`, `contextIsolation: true`, adaptive Light/Dark UI, one-click local server/runner toggles, and native folder picker.
   - **Web Workbench (`clients/web`)**: Dependency-free static UI under strict CSP featuring project grouping, live cache hit badge, SSE streaming, fork/export, per-session draft persistence, and IME-safe Enter-to-submit.
   - **Remote CLI (`clients/cli`)**: One-shot `chat <sessionId> <prompt>` and `pair <code>` workflows.
4. **HAPI-Style 6-Digit Pairing & Scoped Device Tokens**
   - Generate single-use 5-minute pairing codes (`POST /v1/devices/pair-code`), redeem via `POST /v1/devices/redeem-pair`, and enforce least-privilege scopes (`control`, `read`, `runner`) plus optional RFC 6238 TOTP.
5. **Control / Encrypted Body / Outbound Execution Separation**
   - Metadata-only SQLite `events` log separated from optional AES-256-GCM encrypted `run_bodies` (`CCRF_BODY_KEY`) with chunked pagination and idle compaction.
   - `OutboundRunnerDaemon` polls outbound from your workstation with zero inbound firewall ports required.

---

## 60-Second Quickstart

Requirements: **Node.js 24+** (Node.js 26 recommended for built-in `node:sqlite`).

```sh
# 1. Start locally with deterministic mock provider
install -d -m 700 .local
CCRF_EVENT_DB="$PWD/.local/events.sqlite" CCRF_PROVIDER=mock npm run start:server
# Open http://127.0.0.1:8787/
```

To run against an authenticated `claude` CLI on a server bastion:

```sh
export CCRF_EVENT_DB="/var/lib/bastion-cc/events.sqlite"
export CCRF_BODY_KEY="REPLACE_WITH_LONG_RANDOM_PASSPHRASE"
export CCRF_AUTH_TOKEN="REPLACE_WITH_STRONG_BEARER_TOKEN"
export CCRF_PROVIDER="claude-cli"
node scripts/start-server.mjs
```

---

## Repository Layout

```text
core/                 Protocol envelopes, version negotiation, events, capabilities
server/               Control plane, SQLite + AES-256-GCM store, device auth, CLI/SDK adapters, HTTP/SSE
runner/               Outbound polling daemon, scoped local runner, rootless container plan, mock, VM contract
clients/              Remote CLI, static Web Workbench, and hardened Electron Desktop Workbench
compat/               Pure legacy v26 translation gateway (no listener, no dual-write)
deploy/               Container/systemd definitions, VPS hardening, Docker-safe nftables, read-only notifier
security/             Public privacy scanner, Git/artifact release gate, and fail-closed network verifier
tests/                Contract, integration, recovery, desktop hardening, and Git history privacy tests
docs/                 Architecture, threat model, capability matrix, runbooks, and launch copy
```

## Verification & Privacy Gate

```sh
npm run check
python3 -B security/verification/public_scan.py
python3 -B security/verification/release_gate.py
```

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and [SECURITY.md](SECURITY.md).
