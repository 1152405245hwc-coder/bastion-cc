import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { assertCommandAllowed, assertNetworkAllowed, assertWorkspacePath, validateCapability, type CapabilityToken } from "../../core/capabilities/src/index.ts";

const token: CapabilityToken = {
  tokenId: "cap-1",
  deviceId: "d-1",
  sessionId: "s-1",
  runnerId: "r-1",
  audience: "runner",
  nonce: "nonce",
  issuedAt: 100,
  expiresAt: 200,
  scope: { workspaceRoots: ["/workspace/project"], commands: ["git"], network: "none", networkTargets: [], approval: false, credentialRefs: [] },
};

test("capability binds device, session, runner and audience", () => {
  assert.doesNotThrow(() => validateCapability(token, { deviceId: "d-1", sessionId: "s-1", runnerId: "r-1", audience: "runner", now: 150 }));
  assert.throws(() => validateCapability(token, { deviceId: "d-2", sessionId: "s-1", runnerId: "r-1", audience: "runner", now: 150 }), /another execution context/);
  assert.throws(() => validateCapability(token, { deviceId: "d-1", sessionId: "s-1", runnerId: "r-1", audience: "runner", now: 250 }), /validity/);
});

test("capability restricts workspace paths and commands", () => {
  assert.equal(assertWorkspacePath(token, "/workspace/project/src/index.ts"), "/workspace/project/src/index.ts");
  assert.throws(() => assertWorkspacePath(token, "/workspace/other/file"), /outside/);
  assert.doesNotThrow(() => assertCommandAllowed(token, "git"));
  assert.throws(() => assertCommandAllowed(token, "sh"), /not included/);
});

test("network targets are independent from credential references", () => {
  const scoped = { ...token, scope: { ...token.scope, network: "allowlist" as const, networkTargets: ["api.example.invalid:443"], credentialRefs: ["anthropic-oauth"] } };
  assert.doesNotThrow(() => assertNetworkAllowed(scoped, "api.example.invalid:443"));
  assert.throws(() => assertNetworkAllowed(scoped, "anthropic-oauth"), /not allowlisted/);
});


test("rejects symlink escapes from the workspace capability", () => {
  const root = mkdtempSync(join(tmpdir(), "ccrf-cap-"));
  const outside = mkdtempSync(join(tmpdir(), "ccrf-out-"));
  mkdirSync(join(root, "project"));
  symlinkSync(outside, join(root, "project", "link"));
  const scoped = { ...token, scope: { ...token.scope, workspaceRoots: [join(root, "project")] } };
  assert.throws(() => assertWorkspacePath(scoped, join(root, "project", "link", "secret.txt")), /outside/);
});
