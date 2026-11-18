import test from "node:test";
import assert from "node:assert/strict";
import {
  ProtocolError,
  assertCurrentGeneration,
  negotiateCapabilities,
  validateEnvelope,
} from "../../core/protocol/src/index.ts";

test("validates envelope and rejects missing payload", () => {
  const value = validateEnvelope({
    protocolMajor: 1,
    protocolMinor: 0,
    messageType: "session.subscribe",
    requestId: "req-1",
    generation: 0,
    payload: { sessionId: "s-1" },
  });
  assert.equal(value.requestId, "req-1");
  assert.throws(
    () => validateEnvelope({ protocolMajor: 1, protocolMinor: 0, messageType: "event", requestId: "req-2", generation: 0 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_ENVELOPE",
  );
});

test("negotiates shared capabilities and rejects major mismatch", () => {
  const local = { protocolMajor: 1, protocolMinor: 2, features: new Set(["history.v2", "cancel"]), maxFrameBytes: 100, maxStreams: 4 };
  const remote = { protocolMajor: 1, protocolMinor: 1, features: new Set(["history.v2", "unknown"]), maxFrameBytes: 80, maxStreams: 2 };
  const negotiated = negotiateCapabilities(local, remote);
  assert.equal(negotiated.protocolMinor, 1);
  assert.deepEqual([...negotiated.features], ["history.v2"]);
  assert.equal(negotiated.maxFrameBytes, 80);
  assert.throws(() => negotiateCapabilities(local, { ...remote, protocolMajor: 2 }), /major versions/);
});

test("rejects stale generation", () => {
  assert.doesNotThrow(() => assertCurrentGeneration(3, 3));
  assert.throws(() => assertCurrentGeneration(2, 3), (error: unknown) => error instanceof ProtocolError && error.code === "STALE_GENERATION");
});
