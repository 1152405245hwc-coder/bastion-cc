import test from "node:test";
import assert from "node:assert/strict";
import {
  IdempotencyLedger,
  InMemoryEventStore,
  applyEvent,
  createSessionSnapshot,
  type EventRecord,
} from "../../core/events/src/index.ts";

test("replays events into a consistent session snapshot", () => {
  const store = new InMemoryEventStore();
  const sessionId = "s-1";
  const events: Array<Omit<EventRecord, "hash">> = [
    { eventId: "e-1", aggregateId: sessionId, sequence: 1, generation: 0, type: "SessionCreated", payload: {}, occurredAt: 1 },
    { eventId: "e-2", aggregateId: sessionId, sequence: 2, generation: 0, type: "RunnerAttached", payload: { runnerId: "r-1" }, occurredAt: 2 },
    { eventId: "e-3", aggregateId: sessionId, sequence: 3, generation: 0, type: "RunQueued", payload: { runId: "run-1" }, occurredAt: 3 },
    { eventId: "e-4", aggregateId: sessionId, sequence: 4, generation: 0, type: "RunLeased", payload: { runId: "run-1" }, occurredAt: 4 },
    { eventId: "e-5", aggregateId: sessionId, sequence: 5, generation: 0, type: "RunStarted", payload: { runId: "run-1" }, occurredAt: 5 },
    { eventId: "e-6", aggregateId: sessionId, sequence: 6, generation: 0, type: "RunCompleted", payload: { runId: "run-1" }, occurredAt: 6 },
  ];
  for (const event of events) store.append(event);
  let snapshot = createSessionSnapshot(sessionId);
  for (const event of store.read(sessionId)) snapshot = applyEvent(snapshot, event);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.attachedRunnerId, "r-1");
  assert.equal(snapshot.runs["run-1"]!.state, "completed");
  assert.equal(snapshot.lastSequence, 6);
});

test("duplicate event ids are idempotent while content conflicts fail", () => {
  const store = new InMemoryEventStore();
  const event = { eventId: "e-1", aggregateId: "s-1", sequence: 1, generation: 0, type: "SessionCreated" as const, payload: {}, occurredAt: 1 };
  const first = store.append(event);
  const retry = store.append(event);
  assert.equal(retry.hash, first.hash);
  assert.throws(() => store.append({ ...event, payload: { changed: true } }), /Event id was reused/);
});

test("rejects sequence gaps and illegal transitions", () => {
  const store = new InMemoryEventStore();
  assert.throws(() => store.append({ eventId: "e-2", aggregateId: "s-1", sequence: 2, generation: 0, type: "SessionCreated", payload: {}, occurredAt: 1 }), /sequence/);
  const sessionId = "s-1";
  let snapshot = createSessionSnapshot(sessionId);
  snapshot = applyEvent(snapshot, { eventId: "e-1", aggregateId: sessionId, sequence: 1, generation: 0, type: "SessionCreated", payload: {}, occurredAt: 1, hash: "" });
  snapshot = applyEvent(snapshot, { eventId: "e-2", aggregateId: sessionId, sequence: 2, generation: 0, type: "RunnerAttached", payload: { runnerId: "r" }, occurredAt: 2, hash: "" });
  snapshot = applyEvent(snapshot, { eventId: "e-3", aggregateId: sessionId, sequence: 3, generation: 0, type: "RunQueued", payload: { runId: "run" }, occurredAt: 3, hash: "" });
  snapshot = applyEvent(snapshot, { eventId: "e-4", aggregateId: sessionId, sequence: 4, generation: 0, type: "RunLeased", payload: { runId: "run" }, occurredAt: 4, hash: "" });
  snapshot = applyEvent(snapshot, { eventId: "e-5", aggregateId: sessionId, sequence: 5, generation: 0, type: "RunStarted", payload: { runId: "run" }, occurredAt: 5, hash: "" });
  assert.throws(() => applyEvent(snapshot, { eventId: "e-6", aggregateId: sessionId, sequence: 6, generation: 0, type: "RunStarted", payload: { runId: "run" }, occurredAt: 6, hash: "" }), /Invalid run transition/);
});

test("idempotency retries return the first result and conflicts fail", () => {
  const ledger = new IdempotencyLedger<number>();
  let calls = 0;
  const first = ledger.run("key", "hash-a", () => ++calls);
  const retry = ledger.run("key", "hash-a", () => ++calls);
  assert.equal(first, 1);
  assert.equal(retry, 1);
  assert.equal(calls, 1);
  assert.throws(() => ledger.run("key", "hash-b", () => ++calls), /Idempotency key/);
});
