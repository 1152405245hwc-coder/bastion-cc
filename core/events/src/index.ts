import { createHash } from "node:crypto";
import { ProtocolError } from "../../protocol/src/index.ts";

export type SessionState = "created" | "ready" | "disconnected";
export type RunState =
  | "queued"
  | "leased"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export type EventType =
  | "SessionCreated"
  | "RunnerAttached"
  | "RunQueued"
  | "RunLeased"
  | "RunStarted"
  | "OutputChunk"
  | "ApprovalRequested"
  | "ApprovalResponded"
  | "RunCompleted"
  | "RunFailed"
  | "RunUnknown"
  | "RunCancelled"
  | "RunnerDetached"
  | "SnapshotCreated";

export interface EventRecord<T = unknown> {
  eventId: string;
  aggregateId: string;
  sequence: number;
  generation: number;
  type: EventType;
  payload: T;
  occurredAt: number;
  hash: string;
}

export interface SessionSnapshot {
  sessionId: string;
  state: SessionState;
  generation: number;
  attachedRunnerId?: string;
  runs: Record<string, RunSnapshot>;
  lastSequence: number;
}

export interface RunSnapshot {
  runId: string;
  state: RunState;
  lastSequence: number;
  unknownReason?: string;
}

export interface EventStore {
  append<T>(event: Omit<EventRecord<T>, "hash">): EventRecord<T>;
  read(aggregateId: string, afterSequence?: number): readonly EventRecord[];
  snapshot(aggregateId: string): SessionSnapshot | undefined;
  saveSnapshot(snapshot: SessionSnapshot): void;
}

export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventRecord[]>();
  private readonly snapshots = new Map<string, SessionSnapshot>();
  private readonly eventIds = new Map<string, EventRecord>();

  append<T>(event: Omit<EventRecord<T>, "hash">): EventRecord<T> {
    const hash = hashEvent(event);
    const existing = this.eventIds.get(event.eventId);
    if (existing) {
      if (existing.hash !== hash) {
        throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Event id was reused with different content", { eventId: event.eventId });
      }
      return existing as EventRecord<T>;
    }
    const stream = this.events.get(event.aggregateId) ?? [];
    const previous = stream.at(-1);
    const expected = (previous?.sequence ?? 0) + 1;
    if (event.sequence !== expected) {
      throw new ProtocolError("SEQUENCE_GAP", "Event sequence is not contiguous", {
        aggregateId: event.aggregateId,
        expected,
        actual: event.sequence,
      });
    }
    const stored = { ...event, hash } as EventRecord<T>;
    stream.push(stored);
    this.events.set(event.aggregateId, stream);
    this.eventIds.set(event.eventId, stored);
    return stored;
  }

  read(aggregateId: string, afterSequence = 0): readonly EventRecord[] {
    return (this.events.get(aggregateId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  snapshot(aggregateId: string): SessionSnapshot | undefined {
    const value = this.snapshots.get(aggregateId);
    return value ? structuredClone(value) : undefined;
  }

  saveSnapshot(snapshot: SessionSnapshot): void {
    this.snapshots.set(snapshot.sessionId, structuredClone(snapshot));
  }
}

export class IdempotencyLedger<TResult = unknown> {
  private readonly entries = new Map<string, { fingerprint: string; result: TResult }>();

  run(key: string, fingerprint: string, action: () => TResult): TResult {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for another command", { key });
      }
      return existing.result;
    }
    const result = action();
    this.entries.set(key, { fingerprint, result });
    return result;
  }
}

export function hashEvent(event: Omit<EventRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

export function createSessionSnapshot(sessionId: string): SessionSnapshot {
  return { sessionId, state: "created", generation: 0, runs: {}, lastSequence: 0 };
}

export function applyEvent(snapshot: SessionSnapshot, event: EventRecord): SessionSnapshot {
  if (event.sequence !== snapshot.lastSequence + 1) {
    throw new ProtocolError("SEQUENCE_GAP", "Cannot apply an event with a sequence gap", {
      expected: snapshot.lastSequence + 1,
      actual: event.sequence,
    });
  }
  if (event.generation < snapshot.generation) {
    throw new ProtocolError("STALE_GENERATION", "Cannot apply an older generation");
  }
  const next = structuredClone(snapshot);
  next.generation = event.generation;
  next.lastSequence = event.sequence;
  switch (event.type) {
    case "SessionCreated":
      if (snapshot.lastSequence !== 0) transitionSession(next, "created");
      break;
    case "RunnerAttached":
      next.attachedRunnerId = String((event.payload as { runnerId: string }).runnerId);
      transitionSession(next, "ready");
      break;
    case "RunnerDetached":
      delete next.attachedRunnerId;
      transitionSession(next, "disconnected");
      break;
    case "RunQueued": {
      const runId = String((event.payload as { runId: string }).runId);
      next.runs[runId] = { runId, state: "queued", lastSequence: event.sequence };
      break;
    }
    case "RunLeased": {
      const run = requireRun(next, event);
      transitionRun(run, "leased");
      run.lastSequence = event.sequence;
      break;
    }
    case "RunStarted": {
      const run = requireRun(next, event);
      transitionRun(run, "running");
      run.lastSequence = event.sequence;
      break;
    }
    case "ApprovalRequested": {
      const run = requireRun(next, event);
      transitionRun(run, "awaiting_approval");
      run.lastSequence = event.sequence;
      break;
    }
    case "ApprovalResponded": {
      const run = requireRun(next, event);
      transitionRun(run, "running");
      run.lastSequence = event.sequence;
      break;
    }
    case "RunCompleted": {
      const run = requireRun(next, event);
      transitionRun(run, "completed");
      run.lastSequence = event.sequence;
      break;
    }
    case "RunFailed": {
      const run = requireRun(next, event);
      transitionRun(run, "failed");
      run.lastSequence = event.sequence;
      break;
    }
    case "RunUnknown": {
      const run = requireRun(next, event);
      transitionRun(run, "unknown");
      const reason = (event.payload as { reason?: string }).reason;
      if (reason) run.unknownReason = reason;
      run.lastSequence = event.sequence;
      break;
    }
    case "RunCancelled": {
      const run = requireRun(next, event);
      transitionRun(run, "cancelled");
      run.lastSequence = event.sequence;
      break;
    }
    case "OutputChunk": {
      const run = requireRun(next, event);
      if (!["running", "awaiting_approval"].includes(run.state)) {
        throw new ProtocolError("INVALID_STATE", "Output cannot be appended to a terminal run");
      }
      run.lastSequence = event.sequence;
      break;
    }
    case "SnapshotCreated":
      break;
  }
  return next;
}

function requireRun(snapshot: SessionSnapshot, event: EventRecord): RunSnapshot {
  const runId = String((event.payload as { runId: string }).runId);
  const run = snapshot.runs[runId];
  if (!run) throw new ProtocolError("NOT_FOUND", "Run does not exist", { runId });
  return run;
}

function transitionSession(snapshot: SessionSnapshot, next: SessionState): void {
  const allowed: Record<SessionState, readonly SessionState[]> = {
    created: ["ready"],
    ready: ["disconnected"],
    disconnected: ["ready"],
  };
  if (!allowed[snapshot.state].includes(next)) {
    throw new ProtocolError("INVALID_STATE", `Invalid session transition ${snapshot.state} -> ${next}`);
  }
  snapshot.state = next;
}

function transitionRun(run: RunSnapshot, next: RunState): void {
  const allowed: Record<RunState, readonly RunState[]> = {
    queued: ["leased", "cancelled", "expired"],
    leased: ["running", "cancelled", "expired", "unknown"],
    running: ["awaiting_approval", "completed", "failed", "cancelled", "unknown"],
    awaiting_approval: ["running", "cancelled", "expired", "unknown"],
    completed: [],
    failed: [],
    cancelled: [],
    expired: [],
    unknown: [],
  };
  if (!allowed[run.state].includes(next)) {
    throw new ProtocolError("INVALID_STATE", `Invalid run transition ${run.state} -> ${next}`, { runId: run.runId });
  }
  run.state = next;
}
