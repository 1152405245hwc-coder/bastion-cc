import test from "node:test";
import assert from "node:assert/strict";
import { HttpCliClient } from "../../clients/cli/src/http-client.ts";

test("HTTP CLI client sends bearer auth and keeps response metadata-only", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const client = new HttpCliClient({
    baseUrl: "http://127.0.0.1:8787/",
    authToken: "secret-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status: 201, async json() { return { ok: true, data: { runId: "run-1", status: "queued" } }; } };
    },
  });
  const result = await client.startRun("session 1", { requestId: "request-1", generation: 0, idempotencyKey: "idem-1", prompt: "private" });
  assert.deepEqual(result, { runId: "run-1", status: "queued" });
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.url, "http://127.0.0.1:8787/v1/sessions/session%201/runs");
  assert.equal(first.init.headers.authorization, "Bearer secret-token");
  assert.equal(first.init.body.includes("private"), true);
});

test("HTTP CLI client exposes remote errors", async () => {
  const client = new HttpCliClient({
    baseUrl: "https://example.invalid",
    fetchImpl: async () => ({ status: 409, async json() { return { ok: false, error: { code: "STALE_GENERATION", message: "stale" } }; } }),
  });
  await assert.rejects(() => client.resume("s1"), (error: any) => error.code === "STALE_GENERATION" && error.status === 409);
});

test("HTTP CLI client exposes session lifecycle and approval endpoints", async () => {
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const client = new HttpCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetchImpl: async (url, init) => {
      requests.push({ method: init?.method ?? "GET", url, ...(init?.body === undefined ? {} : { body: init.body }) });
      return { status: 200, async json() { return { ok: true, data: { ok: true } }; } };
    },
  });

  await client.getSession("s 1");
  await client.cancelRun("s 1", { runId: "r1", leaseId: "l1" });
  await client.respondApproval("s 1", { runId: "r1", leaseId: "l1", approved: true });
  await client.disconnect("s 1");
  await client.reconnect("s 1");
  await client.listSessions({ query: "auth", project: "/work/repo" });
  await client.updateSession("s 1", { title: "Renamed", reasoningEffort: "high" });
  await client.forkSession("s 1", { newSessionId: "s 2" });
  await client.exportSession("s 1", "markdown");
  await client.getMetrics();

  assert.deepEqual(
    requests.map((item) => [item.method, item.url]),
    [
      ["GET", "http://127.0.0.1:8787/v1/sessions/s%201"],
      ["POST", "http://127.0.0.1:8787/v1/sessions/s%201/runs/cancel"],
      ["POST", "http://127.0.0.1:8787/v1/sessions/s%201/runs/approve"],
      ["POST", "http://127.0.0.1:8787/v1/sessions/s%201/disconnect"],
      ["POST", "http://127.0.0.1:8787/v1/sessions/s%201/reconnect"],
      ["GET", "http://127.0.0.1:8787/v1/sessions?q=auth&project=%2Fwork%2Frepo"],
      ["PATCH", "http://127.0.0.1:8787/v1/sessions/s%201"],
      ["POST", "http://127.0.0.1:8787/v1/sessions/s%201/fork"],
      ["GET", "http://127.0.0.1:8787/v1/sessions/s%201/export?format=markdown"],
      ["GET", "http://127.0.0.1:8787/v1/metrics"],
    ],
  );
  assert.equal(JSON.parse(requests[2]!.body!).approved, true);
});
