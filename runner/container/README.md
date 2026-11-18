# Container runner

`ContainerRunner` builds rootless Podman/Docker argv and delegates process execution to an injected `ContainerExecutor`. It never invokes a shell. The default policy is read-only root, no network, no-new-privileges, non-root UID/GID, and one explicit workspace mount.
