# Architecture

## Planes

~~~text
CLI / Web / Desktop
        |
   HTTP / WSS transport
        |
session aggregate + event log + read model
        |
 HistoryStream       ExecutionStream
        |                    |
  cursor/ACK/window     capability lease
                             |
                         outbound runner
                             |
                       provider adapter
~~~

Control messages stay small and bounded. History and output use independent streams with cursor, sequence, acknowledgement, backpressure and cancellation. Execution has its own lease, heartbeat and revocation lifecycle.

The current network implementation provides HTTP JSON with cursor-based event reads, chunked transcript pagination (`GET /v1/sessions/:sessionId/runs/:runId`), SSE event streaming (`GET /v1/sessions/:sessionId/stream`), and outbound runner polling (`OutboundRunnerDaemon` via `/v1/runners/lease`). Control, history, and execution stay decoupled so large output chunks never block control operations.

## Facts and projections

The append-only event log is the source of truth. Snapshots accelerate recovery, and `ControlPlane` hydrates in-memory sessions, runs, leases, and output sequences from the event store on startup. Client state, notifications and compatibility responses are projections. No notifier or legacy adapter writes a second authoritative database.

Event payloads are separated from metadata. Credentials never enter the event store. Conversation bodies (prompts and output chunks) are stored separately in the `run_bodies` store, optionally encrypted at rest with AES-256-GCM (`CCRF_BODY_KEY`), paginated by byte budget, and pruned by `compactBodies` without altering metadata event history.

## Versioning

Every connection performs a major/minor protocol handshake and feature negotiation before business messages. Requests carry request ID, session ID, run ID, stream ID, generation, sequence, cursor and idempotency key.

Unknown message types and unsupported features return explicit errors. Silent downgrade is forbidden.
