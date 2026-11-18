import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../../server/control/src/index.ts";
import { SqliteEventStore } from "../../server/storage/src/index.ts";

test("SQLite event store preserves event idempotency and cursor order", () => {
  const directory = mkdtempSync(join(tmpdir(), "cc-relay-forge-sqlite-"));
  const filename = join(directory, "events.sqlite");
  const store = new SqliteEventStore(filename);
  try {
    const first = store.append({
      eventId: "event-1",
      aggregateId: "session-1",
      generation: 0,
      type: "SessionCreated",
      payload: { sessionId: "session-1" },
    });
    const retry = store.append({
      eventId: "event-1",
      aggregateId: "session-1",
      generation: 0,
      type: "SessionCreated",
      payload: { sessionId: "session-1" },
    });
    assert.equal(retry.sequence, first.sequence);
    store.append({
      eventId: "event-2",
      aggregateId: "session-1",
      generation: 0,
      type: "RunQueued",
      payload: { runId: "run-1" },
    });
    assert.deepEqual(store.readAfter("session-1", 1).map((event) => event.eventId), ["event-2"]);
    assert.equal(store.latestSequence("session-1"), 2);

    const exported = store.exportState();
    const restored = new SqliteEventStore(join(directory, "restored.sqlite"));
    try {
      restored.importState(exported);
      assert.deepEqual(restored.readAfter("session-1").map((event) => event.eventId), ["event-1", "event-2"]);
    } finally {
      restored.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ControlPlane hydrates sessions, runs, leases, and output sequences from SqliteEventStore on restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "cc-relay-forge-hydrate-"));
  const filename = join(directory, "events.sqlite");
  try {
    const firstStore = new SqliteEventStore(filename);
    try {
      const firstPlane = new ControlPlane(firstStore);
      firstPlane.createSession("session-hydrate");
      const run = firstPlane.startRun({
        protocolMajor: 1,
        protocolMinor: 0,
        messageType: "run.start",
        requestId: "req-h1",
        sessionId: "session-hydrate",
        runId: "run-h1",
        generation: 0,
        idempotencyKey: "idem-h1",
        payload: { prompt: "private prompt" },
      }, "private prompt");
      firstPlane.leaseRun("session-hydrate", run.runId, "lease-h1", 60_000);
      firstPlane.markRunning("session-hydrate", run.runId, "lease-h1");
      firstPlane.recordOutputChunk("session-hydrate", run.runId, "lease-h1", "chunk-1");
      firstPlane.requestApproval("session-hydrate", run.runId, "lease-h1", "need confirm");
    } finally {
      firstStore.close();
    }

    const reopenedStore = new SqliteEventStore(filename);
    try {
      const recoveredPlane = new ControlPlane(reopenedStore);
      const session = recoveredPlane.getSession("session-hydrate");
      assert.equal(session.status, "ready");
      assert.equal(session.currentRunId, "run-h1");
      const recoveredRun = recoveredPlane.getRun("session-hydrate", "run-h1");
      assert.equal(recoveredRun.lifecycle.status, "awaiting_approval");
      assert.equal(recoveredRun.lifecycle.leaseId, "lease-h1");

      const resumed = recoveredPlane.respondApproval("session-hydrate", "run-h1", "lease-h1", true);
      assert.equal(resumed.lifecycle.status, "running");
      recoveredPlane.recordOutputChunk("session-hydrate", "run-h1", "lease-h1", "chunk-2");
      const completed = recoveredPlane.completeRun("session-hydrate", "run-h1", "lease-h1", "completed");
      assert.equal(completed.lifecycle.status, "completed");

      const disconnected = recoveredPlane.disconnect("session-hydrate");
      assert.equal(disconnected.status, "disconnected");
      assert.equal(disconnected.generation, 1);
    } finally {
      reopenedStore.close();
    }

    const finalStore = new SqliteEventStore(filename);
    try {
      const finalPlane = new ControlPlane(finalStore);
      assert.equal(finalPlane.getSession("session-hydrate").status, "disconnected");
      assert.equal(finalPlane.getSession("session-hydrate").generation, 1);
      assert.equal(finalPlane.getRun("session-hydrate", "run-h1").lifecycle.status, "completed");
    } finally {
      finalStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SqliteEventStore encrypts run bodies at rest, paginates, compacts, and deletes session data", () => {
  const directory = mkdtempSync(join(tmpdir(), "cc-relay-forge-body-"));
  const filename = join(directory, "events.sqlite");
  const key = createHash("sha256").update("synthetic-body-key").digest();
  try {
    const store = new SqliteEventStore(filename, { encryptionKey: key });
    try {
      store.appendChunk({
        sessionId: "s-body",
        runId: "r-old",
        chunkIndex: 0,
        role: "prompt",
        text: "old-secret-prompt",
        bytes: 17,
        digest: "d0",
      });
      store.appendChunk({
        sessionId: "s-body",
        runId: "r-new",
        chunkIndex: 0,
        role: "prompt",
        text: "prompt-one",
        bytes: 10,
        digest: "d1",
      });
      store.appendChunk({
        sessionId: "s-body",
        runId: "r-new",
        chunkIndex: 1,
        role: "output",
        text: "output-two",
        bytes: 10,
        digest: "d2",
      });

      const page1 = store.readChunks("s-body", "r-new", 0, 12);
      assert.equal(page1.chunks.length, 1);
      assert.equal(page1.chunks[0]?.text, "prompt-one");
      assert.equal(page1.hasMore, true);
      assert.equal(page1.nextCursor, 1);

      const page2 = store.readChunks("s-body", "r-new", page1.nextCursor, 12);
      assert.equal(page2.chunks.length, 1);
      assert.equal(page2.chunks[0]?.text, "output-two");
      assert.equal(page2.hasMore, false);
    } finally {
      store.close();
    }

    const unkeyedStore = new SqliteEventStore(filename);
    try {
      assert.throws(() => unkeyedStore.readChunks("s-body", "r-new", 0), /without encryption key/);
    } finally {
      unkeyedStore.close();
    }

    const reopened = new SqliteEventStore(filename, { encryptionKey: key });
    try {
      const pruned = reopened.compactBodies({ keepLatestRunsPerSession: 1 });
      assert.equal(pruned, 1);
      assert.equal(reopened.readChunks("s-body", "r-old", 0).chunks.length, 0);
      assert.equal(reopened.readChunks("s-body", "r-new", 0).chunks.length, 2);

      reopened.deleteSessionData("s-body");
      assert.equal(reopened.readChunks("s-body", "r-new", 0).chunks.length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
