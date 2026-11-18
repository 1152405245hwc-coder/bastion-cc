# Similar project review

This review compares public project architecture with the current CC Relay Forge design. It extracts boundaries and operating rules; it does not copy private deployment values or upstream implementation code.

## Reverse-Tunnel Desktop Workflows

The reference desktop workflow uses persistent remote sessions controlled through a reverse tunnel, where recurring stability pressure centers on mixed control/history traffic, large frames, heartbeats, locks, and reconnects.

**Adopted:** preserve a single-user trust-root model, versioned envelopes, cursor recovery, explicit generations, compatibility conversion and an outbound runner boundary.

**Changed:** control metadata, history and execution are separate in the domain model; the new HTTP entry point is loopback-first and requires a bearer token for public binding; event recovery does not return prompt bodies.

## OpenHands

Sources: <https://github.com/OpenHands/OpenHands> and <https://github.com/OpenHands/docs/blob/main/openhands/usage/architecture/runtime.mdx>

OpenHands treats the agent server and execution runtime as separate components and uses a sandbox to contain arbitrary code. The runtime boundary gives the product a place to enforce resource, filesystem and network policy.

**Adopted:** provider adapters and runners are separate from the control plane. The mock provider lets the protocol be tested without an account. A future container or VM runner can be added without changing the client envelope.

**Changed:** Docker is optional deployment infrastructure, not a hidden requirement of the core. A single-user local runner starts dry-run and capability-scoped; it does not silently run arbitrary shell commands.

## OpenCode

Source: <https://github.com/anomalyco/opencode>

OpenCode makes multiple surfaces clients of a shared server and uses an HTTP API, event stream and SQLite-backed state. This is close to the desired product shape: CLI, web, desktop and IDE surfaces can evolve without duplicating session logic.

**Adopted:** CC Relay Forge now has a real HTTP control entry point, a network client, SQLite event storage and a provider adapter boundary. The event endpoint returns cursor metadata and redacted event metadata.

**Changed:** no UI is forced into the first release, and no provider login is hidden inside the server. The transport is intentionally small until backpressure and reconnect behavior have a measured contract.

## Podman rootless containers

Sources: <https://github.com/containers/podman> and <https://github.com/podman-container-tools/podman/blob/main/docs/tutorials/rootless_tutorial.md>

Rootless containers demonstrate a useful deployment rule: the runtime should not gain more host privilege than the user who launched it. This is stronger than merely placing a process in a container while keeping a rootful control path.

**Adopted later:** a container runner should be rootless by default, use explicit mounts, no-new-privileges and a deny-by-default network policy.

**Not adopted now:** the core does not require Docker or Podman. The current production optimization uses Docker as a host packaging choice, so the public project keeps the firewall/NAT protection as a deployment template while treating the runner backend as replaceable.

## Claude-Cage, HAPI, Happier, opcode, and CloudCLI

Sources:
- Claude-Cage: <https://github.com/Lee-xeo/Claude-Cage>
- HAPI: <https://github.com/tiann/hapi>
- Happier: <https://github.com/happier-dev/happier>
- opcode (formerly Claudia): <https://github.com/winfunc/opcode>
- CloudCLI (`claudecodeui`): <https://github.com/siteboon/claudecodeui>

### Architecture Tradeoff: API Reverse Proxy vs. Server Native CLI (`--resume`)

- **Server CLI + API Reverse Proxy (e.g. Magpie API forwarding to local third-party API clients):** Local clients can render a polished GUI, but translating interactive IDE/client prompts through a generic API proxy frequently breaks Anthropic's prompt prefix alignment, drops native tool-use state, bypasses `claude` CLI's session compaction, and forces frequent cache misses (`cache_read_input_tokens` drop), exhausting Pro subscription quotas rapidly.
- **Server Native `claude` CLI (`--resume`) + Thin Remote Client (CC Relay Forge model):** Keeping the official `claude` CLI resident on the trusted US VPS preserves native session transcripts, built-in compaction, tool schemas, and multi-turn prompt caching via `--resume <session_id>`. Remote CLI (`ccrf chat`), Web Workbench, and Desktop act only as thin authenticated UI/transport surfaces without rewriting model prompts.

### Capabilities Adopted into CC Relay Forge

- **From Claude-Cage:** Per-account isolation slots (`accountProfile` / `CLAUDE_CONFIG_DIR`), consistent US locale/timezone fingerprint env (`TZ=America/Los_Angeles`, `LANG=en_US.UTF-8`), fail-closed DNS/SOCKS verification (`network_check.py`), and `GET /v1/cage/status`.
- **From HAPI:** Hub + Runner separation, short-lived single-use 6-digit pairing codes (`POST /v1/devices/pair-code` + `/v1/devices/redeem-pair`) for ergonomic phone/CLI onboarding alongside scoped tokens, and clear separation between loopback runners and public control APIs.
- **From Happier:** Encrypted prompt/output body separation (`AES-256-GCM` `run_bodies` vs metadata-only `events` log) so remote status/notifications never leak prompts or code.
- **From opcode & CloudCLI:** Project-grouped sessions, session forking, Markdown export, live token & cache hit rate telemetry (`cacheHitRate`), reasoning effort & approval mode selectors — while keeping security controls strict (scoped auth, fail-closed external link routing, and no unauthenticated shell exposure).

## Resulting design rule

The durable boundary is:

```text
client -> authenticated transport -> control plane + SQLite events
                                  -> outbound capability-scoped runner
                                  -> provider adapter (mock now, real provider later)
```

This keeps the user's proven network isolation and operational safeguards while avoiding a product that only works with one vendor login, one desktop shell or one container runtime.
