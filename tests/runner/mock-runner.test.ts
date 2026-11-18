import test from "node:test";
import assert from "node:assert/strict";

import {
  CapabilityDeniedError,
  MockRunner,
  type CapabilityGrant,
  type RunnerCommand,
} from "../../runner/mock/index.ts";

const grant: CapabilityGrant = {
  runnerId: "runner-a",
  sessionId: "session-a",
  scopes: ["workspace.write"],
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const command: RunnerCommand = {
  commandId: "command-1",
  sessionId: "session-a",
  runId: "run-a",
  generation: 1,
  scope: "workspace.write",
  input: "touch file",
};

test("executes once and deduplicates repeated command ids", async () => {
  const runner = new MockRunner({ runnerId: "runner-a" });
  const first = await runner.execute(command, grant);
  const second = await runner.execute(command, grant);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(runner.getSideEffectCount(), 1);
});

test("rejects expired, revoked, mismatched and out-of-scope capabilities", async () => {
  const runner = new MockRunner({ runnerId: "runner-a" });
  await assert.rejects(() => runner.execute(command, { ...grant, expiresAt: 0 }), CapabilityDeniedError);
  await assert.rejects(() => runner.execute(command, { ...grant, revoked: true }), CapabilityDeniedError);
  await assert.rejects(() => runner.execute(command, { ...grant, runnerId: "runner-b" }), CapabilityDeniedError);
  await assert.rejects(() => runner.execute(command, { ...grant, scopes: [] }), CapabilityDeniedError);
});

test("marks a post-side-effect disconnect as unknown", async () => {
  const runner = new MockRunner({ runnerId: "runner-a", failureMode: "disconnect-after" });
  const result = await runner.execute(command, grant);
  assert.equal(result.status, "unknown");
  assert.equal(result.sideEffectCount, 1);
  assert.ok(result.events.some((event) => event.kind === "unknown"));
});

test("cancels before applying the side effect", async () => {
  const runner = new MockRunner({ runnerId: "runner-a", defaultDelayMs: 5 });
  const pending = runner.execute(command, grant);
  runner.cancel(command.commandId);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.sideEffectCount, 0);
});

test("rejects stale generations after runner restart", async () => {
  const runner = new MockRunner({ runnerId: "runner-a" });
  runner.restart();
  await assert.rejects(() => runner.execute(command, grant), CapabilityDeniedError);
});

test("emits duplicate event in duplicate failure mode without duplicating side effects", async () => {
  const runner = new MockRunner({ runnerId: "runner-a", failureMode: "duplicate" });
  const result = await runner.execute(command, grant);
  const completed = result.events.filter((event) => event.kind === "completed");
  assert.equal(completed.length, 2);
  assert.equal(runner.getSideEffectCount(), 1);
});
