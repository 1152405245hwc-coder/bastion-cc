# Legacy Database & Protocol Migration

Migration is shadow-first and session-scoped.

1. Run the new protocol with the mock runner and synthetic data.
2. Import legacy sessions read-only; never double-write the old database.
3. Start the v26 compatibility gateway for authentication, session listing, history, send, stop, approval and cursor recovery.
4. Compare legacy and new read models without enabling side effects.
5. Enable one non-critical session through the new control plane.
6. Expand by device and session after recovery, duplicate-command, approval and rollback tests pass.
7. Move CLI, then web, then desktop to the new protocol.
8. Keep the legacy gateway until the compatibility matrix is complete and no legacy client has connected for 30 days.

Rollback changes routing to the legacy service. It must never overwrite events produced by the new system.

## Shadow migration (first slice)

`server/migration` provides an in-memory, session-scoped routing seam. A v26 request is converted through `compat/legacy-v26-gateway`; `routeMigration` can keep the legacy result while invoking a modern read handler in `shadow` mode. Both read models are recursively redacted before comparison. A mismatch, unsupported operation, or modern handler error produces a rollback decision; the legacy result remains the returned result.

`SessionSwitchRegistry` stores only per-process session route overrides (`legacy` or `new`). `rollback(sessionId)` removes the override and restores the default route. No event store, legacy database, dual write, or production migration is performed by this slice. Commands that lack a session id are unsupported for migration routing.

## Private shadow configuration

Use `deploy/migration/cc-relay-forge-shadow.env.example` as a private overlay. The first run should allow only a non-critical session, keep the legacy database read-only, disable dual writes, compare redacted metadata, and roll back on any mismatch or unsupported operation. Do not place real session IDs, database paths, domains or credentials in Git.
