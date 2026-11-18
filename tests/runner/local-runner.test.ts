import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunner, createCapabilityToken, type LocalCommand } from "../../runner/local/index.ts";

const root = mkdtempSync(join(tmpdir(), "ccrf-local-runner-"));
mkdirSync(join(root, "workspace"));
const token = createCapabilityToken({ scope: { workspaceRoots: [join(root, "workspace")], commands: ["echo"], network: "none", networkTargets: [], approval: false, credentialRefs: [] } });
const command: LocalCommand = { commandId: "c1", sessionId: "session-a", runId: "run-a", generation: 0, command: "echo", args: ["hello"], cwd: join(root, "workspace") };

test("dry-run never creates a process and deduplicates command ids", async () => {
  const runner = new LocalRunner({ runnerId: "runner-a", deviceId: "device-a", audience: "local-runner" });
  const first = await runner.execute(command, token); const second = await runner.execute(command, token);
  assert.equal(first.status, "completed"); assert.equal(first.sideEffectCount, 0); assert.deepEqual(second, first); assert.match(first.stdout, /dry-run/);
});

test("rejects shell syntax and commands outside the capability", async () => {
  const runner = new LocalRunner({ runnerId: "runner-a", deviceId: "device-a", audience: "local-runner" });
  await assert.rejects(() => runner.execute({ ...command, commandId: "c2", command: "echo;rm" }, token), /shell syntax/);
  await assert.rejects(() => runner.execute({ ...command, commandId: "c3", command: "sh" }, token), /not included/);
});

test("rejects workspace symlink escapes", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ccrf-outside-")); symlinkSync(outside, join(root, "workspace", "link"));
  const runner = new LocalRunner({ runnerId: "runner-a", deviceId: "device-a", audience: "local-runner" });
  await assert.rejects(() => runner.execute({ ...command, commandId: "c4", cwd: join(root, "workspace", "link") }, token), /outside/);
});

test("cancellation before dispatch has no side effect", async () => {
  const runner = new LocalRunner({ runnerId: "runner-a", deviceId: "device-a", audience: "local-runner" }); runner.cancel("c5");
  const result = await runner.execute({ ...command, commandId: "c5" }, token); assert.equal(result.status, "cancelled"); assert.equal(result.sideEffectCount, 0);
});

test("injected executor timeout is visible as unknown", async () => {
  const runner = new LocalRunner({ runnerId: "runner-a", deviceId: "device-a", audience: "local-runner", dryRun: false, executor: { run: async () => new Promise(() => {}) } });
  const result = await runner.execute({ ...command, commandId: "c6", timeoutMs: 5 }, token); assert.equal(result.status, "unknown"); assert.equal(result.sideEffectCount, 1);
});
