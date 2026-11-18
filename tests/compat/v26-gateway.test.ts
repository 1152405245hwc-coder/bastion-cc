import test from "node:test";
import assert from "node:assert/strict";
import { fromNewEvent, GatewayError, toLegacyError, toNewEnvelope } from "../../compat/legacy-v26-gateway/src/index.ts";

const legacy = { protocolVersion: 26 as const, type: "run.start", requestId: "req-1", sessionId: "session-1", runId: "run-1", generation: 3, cursor: "42", idempotencyKey: "idem-1", payload: { prompt: "hello" } };

test("maps v26 run start while preserving routing and recovery fields", () => { const mapped = toNewEnvelope(legacy); assert.equal(mapped.protocolMajor, 1); assert.equal(mapped.messageType, "run.start"); assert.equal(mapped.sessionId, "session-1"); assert.equal(mapped.runId, "run-1"); assert.equal(mapped.generation, 3); assert.equal(mapped.cursor, "42"); assert.equal(mapped.idempotencyKey, "idem-1"); });
test("rejects unsupported legacy commands explicitly", () => { assert.throws(() => toNewEnvelope({ ...legacy, type: "admin.shell" }), (error: unknown) => error instanceof GatewayError && error.code === "UNSUPPORTED"); });
test("rejects protocol versions other than v26", () => { assert.throws(() => toNewEnvelope({ ...legacy, protocolVersion: 25 }), (error: unknown) => error instanceof GatewayError && error.code === "UNSUPPORTED"); });
test("maps events to legacy event responses", () => { const response = fromNewEvent({ eventId: "e-1", aggregateId: "session-1", sequence: 8, generation: 3, type: "RunUnknown", payload: { reason: "runner_disconnected" }, createdAt: "2026-01-01T00:00:00.000Z" }); assert.equal(response.type, "event"); assert.equal(response.sequence, 8); assert.equal((response.payload as { eventType: string }).eventType, "run.unknown"); });
test("maps gateway errors without exposing hidden values", () => { const response = toLegacyError("req-1", new GatewayError("UNSUPPORTED", "unsupported", { type: "x" })); assert.equal(response.error?.code, "UNSUPPORTED"); assert.equal(response.requestId, "req-1"); });
