import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlane } from "../../server/control/src/index.ts";
import { ExecutionService } from "../../server/execution/src/index.ts";
import { MockProviderAdapter, type ProviderAdapter } from "../../server/adapters/src/index.ts";

function createRun() {
  const plane = new ControlPlane();
  plane.createSession("s1");
  const run = plane.startRun({ protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "r1", sessionId: "s1", generation: 0, idempotencyKey: "i1", payload: { prompt: "hello" } }, "hello");
  plane.leaseRun("s1", run.runId, "lease", 60_000);
  return { plane, run };
}

test("execution service maps provider lifecycle into control events", async () => {
  const { plane, run } = createRun();
  const result = await new ExecutionService(plane, new MockProviderAdapter()).execute("s1", run.runId, "lease", { runId: run.runId, prompt: "hello" });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.outputs, ["[mock:5 chars]"]);
  assert.deepEqual(plane.resume("s1").map((event) => event.type), ["SessionCreated", "RunQueued", "RunLeased", "RunStarted", "OutputChunk", "RunCompleted"]);
});

test("provider failure becomes unknown without exposing provider text", async () => {
  const { plane, run } = createRun();
  const failing: ProviderAdapter = { name: "failing", async *execute() { throw new Error("private provider detail"); } };
  const result = await new ExecutionService(plane, failing).execute("s1", run.runId, "lease", { runId: run.runId, prompt: "hello" });
  assert.equal(result.status, "unknown");
  assert.equal(result.errorCode, "UNKNOWN");
  assert.equal(JSON.stringify(result).includes("private provider detail"), false);
});
