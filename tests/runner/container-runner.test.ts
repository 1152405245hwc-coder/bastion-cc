import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerRunner, buildContainerInvocation, type ContainerCommand } from "../../runner/container/index.ts";
import { createCapabilityToken } from "../../runner/local/index.ts";

const workspace = mkdtempSync(join(tmpdir(), "ccrf-container-"));
const token = createCapabilityToken({ audience: "container-runner", scope: { workspaceRoots: [workspace], commands: ["*"], network: "none", networkTargets: [], approval: false, credentialRefs: [] } });
const command: ContainerCommand = { commandId: "c1", sessionId: "session-a", runId: "run-a", generation: 0, image: "alpine:3", args: ["echo", "hello"], cwd: workspace, workspace };

test("builds rootless podman argv without starting a container", () => {
  const invocation = buildContainerInvocation(command, token, "podman", 1000, 1000);
  assert.equal(invocation.executable, "podman");
  assert.deepEqual(invocation.args.slice(0, 8), ["run", "--rm", "--read-only", "--network=none", "--security-opt=no-new-privileges", "--userns=keep-id", "--user=1000:1000", "--mount"]);
  assert.ok(invocation.args.some((arg) => arg.startsWith("type=bind,src=") && arg.endsWith(",dst=/workspace,readonly=false")));
  assert.ok(invocation.args.includes("--workdir"));
  assert.ok(!invocation.args.includes("--privileged"));
});

test("executor is injected and command is deduplicated", async () => {
  const calls: unknown[] = [];
  const runner = new ContainerRunner({ runnerId: "runner-a", deviceId: "device-a", executor: { run: async (invocation) => { calls.push(invocation); return { stdout: "ok", stderr: "", exitCode: 0 }; } } });
  const first = await runner.execute(command, token); const second = await runner.execute(command, token);
  assert.equal(calls.length, 1); assert.deepEqual(second, first); assert.equal(first.status, "completed");
});

test("rejects network-enabled capability", () => {
  assert.throws(() => buildContainerInvocation(command, { ...token, scope: { ...token.scope, network: "any" } }), /network=none/);
});
