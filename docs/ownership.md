# Ownership map

- core/protocol: wire envelope, version negotiation and errors
- core/events: aggregates, state transitions, replay and snapshots
- core/capabilities: scopes, leases, revocation and path rules
- server/control: auth, connections and control stream
- server/storage: event store, read models and migrations
- server/scheduler: runs, approvals, cancellation and recovery
- runner/*: execution adapters and fault injection
- clients/*: CLI, web and desktop projections
- compat/*: legacy protocol translation only
- deploy/*: host integration and compatibility assets
- security/*: publication, network, chaos and release checks

Changes crossing these boundaries require contract tests and an updated architecture note.
