import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlane } from "../../server/control/src/index.ts";
import { ProtocolError } from "../../core/protocol/src/index.ts";

test("duplicate idempotency key returns the same run without a second event", () => {
  const plane = new ControlPlane();
  plane.createSession("s1");
  const first = plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "r1",
    sessionId: "s1", generation: 0, idempotencyKey: "idem-1", payload: { prompt: "x" },
  }, "x");
  const second = plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "r2",
    sessionId: "s1", generation: 0, idempotencyKey: "idem-1", payload: { prompt: "x" },
  }, "x");
  assert.equal(first.runId, second.runId);
  assert.equal(plane.resume("s1").filter((event) => event.type === "RunQueued").length, 1);
});

test("idempotency keys reject reuse with different session or prompt", () => {
  const plane = new ControlPlane();
  plane.createSession("s1");
  plane.createSession("s2");
  const first = plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "req-1",
    sessionId: "s1", generation: 0, idempotencyKey: "idem-1", payload: { prompt: "one" },
  }, "one");
  assert.throws(() => plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "req-2",
    sessionId: "s1", generation: 0, idempotencyKey: "idem-1", payload: { prompt: "two" },
  }, "two"), (error: unknown) => error instanceof ProtocolError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.throws(() => plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "req-3",
    sessionId: "s2", generation: 0, idempotencyKey: "idem-1", payload: { prompt: "one" },
  }, "one"), (error: unknown) => error instanceof ProtocolError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(plane.getRun("s1", first.runId).runId, first.runId);
});

test("stale generations are rejected after disconnect", () => {
  const plane = new ControlPlane();
  plane.createSession("s1");
  plane.disconnect("s1");
  assert.throws(() => plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "r1",
    sessionId: "s1", generation: 0, idempotencyKey: "idem", payload: {},
  }, "x"), (error: unknown) => error instanceof ProtocolError && error.code === "STALE_GENERATION");
});

test("approval and cancellation survive state export/import", () => {
  const plane = new ControlPlane();
  plane.createSession("s1");
  const run = plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "r1",
    sessionId: "s1", generation: 0, idempotencyKey: "idem", payload: {},
  }, "x");
  plane.leaseRun("s1", run.runId, "lease", 60_000);
  plane.markRunning("s1", run.runId, "lease");
  plane.requestApproval("s1", run.runId, "lease", "write");
  const restored = new ControlPlane();
  restored.importState(plane.exportState());
  assert.equal(restored.getRun("s1", run.runId).lifecycle.status, "awaiting_approval");
  restored.respondApproval("s1", run.runId, "lease", false);
  assert.equal(restored.getRun("s1", run.runId).lifecycle.status, "cancelled");
});

test("state import rejects malformed snapshots before mutating the plane", () => {
  const plane = new ControlPlane();
  plane.createSession("s1");
  assert.throws(() => plane.importState({ sessions: [], runs: [], idempotency: [], store: { events: "bad", snapshots: [] } }), (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_ENVELOPE");
  assert.equal(plane.getSession("s1").status, "ready");
});

test("runner disconnect makes active work unknown and revokes the lease", () => {
  const plane = new ControlPlane();
  plane.createSession("s1");
  const run = plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "r1",
    sessionId: "s1", generation: 0, idempotencyKey: "idem", payload: {},
  }, "x");
  plane.leaseRun("s1", run.runId, "lease", 60_000);
  plane.markRunning("s1", run.runId, "lease");
  plane.disconnect("s1");
  assert.equal(plane.getRun("s1", run.runId).lifecycle.status, "unknown");
  assert.throws(() => plane.markRunning("s1", run.runId, "lease"), (error: unknown) =>
    error instanceof ProtocolError && error.code === "INVALID_STATE");
});


test("event store rejects reused event ids with different content", () => {
  const plane = new ControlPlane();
  plane.createSession("s1");
  const event = plane.resume("s1")[0]!;
  assert.throws(() => plane.store.append({ ...event, payload: { changed: true } }), (error: unknown) =>
    error instanceof ProtocolError && error.code === "IDEMPOTENCY_CONFLICT");
});

test("session metadata, project filtering, fork, export, metrics, and hydration", () => {
  const plane = new ControlPlane();
  plane.createSession("alpha", {
    title: "Auth Refactor",
    project: "/work/backend",
    approvalMode: "auto-edit",
    reasoningEffort: "high",
  });
  plane.createSession("beta", { title: "Docs Polish", project: "/work/docs" });
  plane.updateSession("alpha", { title: "Auth Hardening", approvalMode: "plan-only" });

  const filtered = plane.listSessions({ query: "hardening" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.sessionId, "alpha");
  assert.equal(plane.listSessions({ project: "/work/docs" }).map((s) => s.sessionId).join(","), "beta");

  const run = plane.startRun({
    protocolMajor: 1, protocolMinor: 0, messageType: "run.start", requestId: "r-alpha",
    sessionId: "alpha", generation: 0, idempotencyKey: "idem-alpha", payload: { prompt: "audit" },
  }, "audit auth");
  plane.leaseRun("alpha", run.runId, "lease-alpha", 60_000);
  plane.markRunning("alpha", run.runId, "lease-alpha");
  plane.recordOutputChunk("alpha", run.runId, "lease-alpha", "checked ok");
  plane.completeRun("alpha", run.runId, "lease-alpha", "completed");

  const forked = plane.forkSession("alpha", "alpha-fork");
  assert.equal(forked.parentSessionId, "alpha");
  assert.equal(forked.project, "/work/backend");
  assert.equal(forked.approvalMode, "plan-only");
  assert.equal(forked.reasoningEffort, "high");
  assert.equal(forked.title, "Auth Hardening (Fork)");

  const forkedTranscript = plane.getRunTranscript("alpha-fork", forked.currentRunId!, 0);
  assert.deepEqual(forkedTranscript.chunks.map((c) => c.text), ["audit auth", "checked ok"]);

  const exported = plane.exportSession("alpha-fork", "markdown");
  assert.ok(exported.markdown.includes("# Session: Auth Hardening (Fork)"));
  assert.ok(exported.markdown.includes("audit auth"));
  assert.ok(exported.markdown.includes("checked ok"));

  const metrics = plane.getUsageMetrics();
  assert.equal(metrics.totalSessions, 3);
  assert.equal(metrics.totalRuns, 2);
  assert.equal(metrics.activeRuns, 0);
  assert.ok(metrics.promptBytes > 0 && metrics.outputBytes > 0 && metrics.estimatedTokens > 0);

  const rehydrated = new ControlPlane(plane.store);
  assert.equal(rehydrated.getSession("alpha").title, "Auth Hardening");
  assert.equal(rehydrated.getSession("alpha").approvalMode, "plan-only");
  assert.equal(rehydrated.getSession("alpha-fork").parentSessionId, "alpha");
});

test("startRun rejects overlapping active runs on the same session while permitting idempotent retries", () => {
  const plane = new ControlPlane();
  plane.createSession("concurrent-s1");
  const run1 = plane.startRun({
    protocolMajor: 1,
    protocolMinor: 0,
    messageType: "run.start",
    requestId: "r-c1",
    sessionId: "concurrent-s1",
    generation: 0,
    idempotencyKey: "idem-c1",
    payload: { prompt: "first" },
  }, "first");

  const retry = plane.startRun({
    protocolMajor: 1,
    protocolMinor: 0,
    messageType: "run.start",
    requestId: "r-c1-retry",
    sessionId: "concurrent-s1",
    generation: 0,
    idempotencyKey: "idem-c1",
    payload: { prompt: "first" },
  }, "first");
  assert.equal(retry.runId, run1.runId);

  assert.throws(() => plane.startRun({
    protocolMajor: 1,
    protocolMinor: 0,
    messageType: "run.start",
    requestId: "r-c2",
    sessionId: "concurrent-s1",
    generation: 0,
    idempotencyKey: "idem-c2",
    payload: { prompt: "second" },
  }, "second"), (err: unknown) => err instanceof ProtocolError && err.code === "INVALID_STATE");

  plane.leaseRun("concurrent-s1", run1.runId, "lease-c1", 60_000);
  plane.markRunning("concurrent-s1", run1.runId, "lease-c1");
  plane.completeRun("concurrent-s1", run1.runId, "lease-c1", "completed");

  const run2 = plane.startRun({
    protocolMajor: 1,
    protocolMinor: 0,
    messageType: "run.start",
    requestId: "r-c2",
    sessionId: "concurrent-s1",
    generation: 0,
    idempotencyKey: "idem-c2",
    payload: { prompt: "second" },
  }, "second");
  assert.notEqual(run2.runId, run1.runId);
});
