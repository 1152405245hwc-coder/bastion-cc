# Rootless container runner

The container runner is an execution boundary, not a control-plane service. It invokes Podman (default) or Docker through an injected executor so tests can inspect argv without starting a container.

Every invocation uses a non-root UID/GID, a read-only root filesystem, `no-new-privileges`, one explicit workspace bind mount, and `network=none`. Capability scopes must also declare `network: "none"`; network-enabled grants are rejected until an allowlist policy is implemented. Keep the workspace mount path explicit and do not add host mounts or privileged flags.
