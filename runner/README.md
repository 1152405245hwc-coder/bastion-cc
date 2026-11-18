# Runners

Runners execute tasks outside the HTTP control server without exposing inbound ports:

- `daemon`: `OutboundRunnerDaemon` initiating outbound HTTP polling to `/v1/runners/lease`, sending lease heartbeats, streaming output chunks, and marking disconnected outcomes as `unknown`.
- `local`: capability-scoped dry-run/local command execution boundary with symlink-escape protection and allowlist enforcement.
- `container`: rootless Podman/Docker read-only invocation builder (`--read-only`, `--network=none`, `--security-opt=no-new-privileges`).
- `mock`: deterministic fault-injection runner for contract and recovery tests.
- `vm`: explicit fail-closed VM launch plan contract (kept `unsupported` until signed guest image verification is complete).
