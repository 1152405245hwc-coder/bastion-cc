import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry } from "../../server/auth/src/index.ts";
import { ControlPlane } from "../../server/control/src/index.ts";
import { createHttpControlServer } from "../../server/http/src/index.ts";
import { MockProviderAdapter, type ProviderAdapter } from "../../server/adapters/src/index.ts";
import { SqliteEventStore } from "../../server/storage/src/index.ts";

test("E2E socket server serves Web UI assets, enforces pairing lockout, and persists state across SQLite restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bastioncc-e2e-persist-"));
  const dbPath = join(dir, "events.sqlite");
  let pairedCred = "";
  let revokedCred = "";
  let firstRunId = "";

  try {
    const store1 = new SqliteEventStore(dbPath);
    const plane1 = new ControlPlane(store1);
    const registry1 = new DeviceRegistry({ store: store1, maxFailedPairAttempts: 5, pairLockoutWindowMs: 60_000 });
    const app1 = createHttpControlServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "root-secret",
      plane: plane1,
      deviceRegistry: registry1,
      provider: new MockProviderAdapter(),
    });
    await app1.start();
    try {
      const addr = app1.address();
      assert.ok(addr && addr.port > 0);
      const base = `http://127.0.0.1:${addr.port}`;

      // Static Web UI routes work unauthenticated, while /health stays gated.
      const indexRes = await fetch(`${base}/`);
      assert.equal(indexRes.status, 200);
      assert.match(indexRes.headers.get("content-type") ?? "", /text\/html/);
      assert.match(indexRes.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.ok((await indexRes.text()).includes("BastionCC"));

      const cssRes = await fetch(`${base}/style.css`);
      assert.equal(cssRes.status, 200);
      assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/);

      const jsRes = await fetch(`${base}/app.js`);
      assert.equal(jsRes.status, 200);
      assert.match(jsRes.headers.get("content-type") ?? "", /text\/javascript/);

      const webJsRes = await fetch(`${base}/web/app.js`);
      assert.equal(webJsRes.status, 200);

      const favRes = await fetch(`${base}/favicon.ico`);
      assert.equal(favRes.status, 204);

      const healthUnauth = await fetch(`${base}/health`);
      assert.equal(healthUnauth.status, 401);
      const healthAuth = await fetch(`${base}/health`, { headers: { authorization: "Bearer root-secret" } });
      assert.equal(healthAuth.status, 200);

      // Pair code + persistence + revocation across restart.
      const pairIssue = await fetch(`${base}/v1/devices/pair-code`, {
        method: "POST",
        headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "persist-cli", label: "Persist CLI", scopes: ["control", "read"] }),
      });
      assert.equal(pairIssue.status, 201);
      const pairBody = await pairIssue.json() as { data: { code: string } };

      const redeemRes = await fetch(`${base}/v1/devices/redeem-pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairBody.data.code }),
      });
      assert.equal(redeemRes.status, 200);
      pairedCred = (await redeemRes.json() as { data: { credential: string } }).data.credential;

      const enrollRevoked = await fetch(`${base}/v1/devices/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "stale-phone", label: "Stale Phone", scopes: ["read"] }),
      });
      revokedCred = (await enrollRevoked.json() as { data: { credential: string } }).data.credential;
      await fetch(`${base}/v1/devices/revoke`, {
        method: "POST",
        headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "stale-phone" }),
      });

      // Pairing brute-force lockout after 5 wrong attempts.
      const lockedIssue = await fetch(`${base}/v1/devices/pair-code`, {
        method: "POST",
        headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "victim-cli", label: "Victim", scopes: ["read"] }),
      });
      const validCode = (await lockedIssue.json() as { data: { code: string } }).data.code;
      const wrongCode = validCode === "000000" ? "999999" : "000000";
      for (let i = 0; i < 5; i += 1) {
        const failRes = await fetch(`${base}/v1/devices/redeem-pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: wrongCode }),
        });
        assert.equal(failRes.status, 404);
      }
      const blockedRes = await fetch(`${base}/v1/devices/redeem-pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: validCode }),
      });
      assert.equal(blockedRes.status, 429);

      // Session + completed run with idempotencyKey persisted to SQLite.
      const created = await fetch(`${base}/v1/sessions/create`, {
        method: "POST",
        headers: { authorization: `Bearer ${pairedCred}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "persist-s1", title: "SQLite Restart Test" }),
      });
      assert.equal(created.status, 201);

      const started = await fetch(`${base}/v1/sessions/persist-s1/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${pairedCred}`, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "req-p1",
          generation: 0,
          idempotencyKey: "idem-persist-1",
          prompt: "persist prompt",
          execute: true,
        }),
      });
      assert.equal(started.status, 201);
      firstRunId = (await started.json() as { data: { runId: string } }).data.runId;
    } finally {
      await app1.close();
      store1.close();
    }

    // Restart with fresh SQLite store, ControlPlane, DeviceRegistry, and HTTP server.
    const store2 = new SqliteEventStore(dbPath);
    const plane2 = new ControlPlane(store2);
    const registry2 = new DeviceRegistry({ store: store2 });
    const app2 = createHttpControlServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "root-secret",
      plane: plane2,
      deviceRegistry: registry2,
      provider: new MockProviderAdapter(),
    });
    await app2.start();
    try {
      const addr2 = app2.address();
      assert.ok(addr2 && addr2.port > 0);
      const base2 = `http://127.0.0.1:${addr2.port}`;

      const listWithPaired = await fetch(`${base2}/v1/sessions`, {
        headers: { authorization: `Bearer ${pairedCred}` },
      });
      assert.equal(listWithPaired.status, 200);
      const sessions = (await listWithPaired.json() as { data: Array<{ sessionId: string }> }).data;
      assert.equal(sessions.some((s) => s.sessionId === "persist-s1"), true);

      const revokedCheck = await fetch(`${base2}/v1/sessions`, {
        headers: { authorization: `Bearer ${revokedCred}` },
      });
      assert.equal(revokedCheck.status, 401);

      const idempotentRetry = await fetch(`${base2}/v1/sessions/persist-s1/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${pairedCred}`, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "req-p2",
          generation: 0,
          idempotencyKey: "idem-persist-1",
          prompt: "persist prompt",
        }),
      });
      assert.equal(idempotentRetry.status, 201);
      const retryData = (await idempotentRetry.json() as { data: { runId: string; status: string } }).data;
      assert.equal(retryData.runId, firstRunId);
      assert.equal(retryData.status, "completed");

      const conflictRetry = await fetch(`${base2}/v1/sessions/persist-s1/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${pairedCred}`, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "req-p3",
          generation: 0,
          idempotencyKey: "idem-persist-1",
          prompt: "different prompt",
        }),
      });
      assert.equal(conflictRetry.status, 400);
      const conflictBody = await conflictRetry.json() as { error: { code: string } };
      assert.equal(conflictBody.error.code, "IDEMPOTENCY_CONFLICT");
    } finally {
      await app2.close();
      store2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2E socket server supports async execution, SSE live stream, concurrent lock, and real AbortSignal cancellation", async () => {
  let providerAborted = false;
  let callIndex = 0;
  const cancellableProvider: ProviderAdapter = {
    name: "cancellable-test",
    async *execute(request) {
      callIndex += 1;
      yield { type: "started", runId: request.runId };
      if (callIndex === 1) {
        yield { type: "output", runId: request.runId, text: "first chunk " };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            providerAborted = true;
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 10_000);
          timer.unref?.();
          request.signal?.addEventListener("abort", () => {
            providerAborted = true;
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (request.signal?.aborted) return;
      }
      yield { type: "output", runId: request.runId, text: "follow-up ok" };
      yield { type: "completed", runId: request.runId };
    },
  };

  const app = createHttpControlServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "root-secret",
    provider: cancellableProvider,
  });
  await app.start();
  const streamController = new AbortController();
  try {
    const addr = app.address();
    assert.ok(addr);
    const base = `http://127.0.0.1:${addr.port}`;

    await fetch(`${base}/v1/sessions/create`, {
      method: "POST",
      headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sse-s1" }),
    });

    const sseRes = await fetch(`${base}/v1/sessions/sse-s1/stream?cursor=0`, {
      headers: { authorization: "Bearer root-secret", accept: "text/event-stream" },
      signal: streamController.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.ok(sseRes.body);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();

    const asyncRunRes = await fetch(`${base}/v1/sessions/sse-s1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-async-1",
        generation: 0,
        idempotencyKey: "idem-async-1",
        prompt: "long task",
        execute: true,
        async: true,
      }),
    });
    assert.equal(asyncRunRes.status, 202);
    const startedRun = (await asyncRunRes.json() as { data: { runId: string; leaseId: string } }).data;
    assert.ok(startedRun.runId);
    assert.ok(startedRun.leaseId);

    // Concurrent second run on same session is rejected with 409 INVALID_STATE.
    const overlapping = await fetch(`${base}/v1/sessions/sse-s1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-async-2",
        generation: 0,
        idempotencyKey: "idem-async-2",
        prompt: "competing prompt",
        execute: true,
        async: true,
      }),
    });
    assert.equal(overlapping.status, 409);

    let sseLog = "";
    const deadline = Date.now() + 5_000;
    while (!sseLog.includes("event: OutputChunk") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseLog += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(sseLog.includes("event: OutputChunk"), `expected OutputChunk in SSE stream, got: ${sseLog}`);

    const cancelRes = await fetch(`${base}/v1/sessions/sse-s1/runs/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({ runId: startedRun.runId, leaseId: startedRun.leaseId }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelledData = (await cancelRes.json() as { data: { status: string } }).data;
    assert.equal(cancelledData.status, "cancelled");
    assert.equal(providerAborted, true);

    while (!sseLog.includes("event: RunCancelled") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseLog += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(sseLog.includes("event: RunCancelled"), `expected RunCancelled in SSE stream, got: ${sseLog}`);

    await reader.cancel().catch(() => {});

    // Follow-up run succeeds once previous run cancelled cleanly.
    const followUp = await fetch(`${base}/v1/sessions/sse-s1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-sync-follow",
        generation: 0,
        idempotencyKey: "idem-sync-follow",
        prompt: "next turn",
        execute: true,
      }),
    });
    assert.equal(followUp.status, 201);
    const followData = (await followUp.json() as { data: { status: string; runId: string } }).data;
    assert.equal(followData.status, "completed");
  } finally {
    streamController.abort();
    await app.close();
  }
});
