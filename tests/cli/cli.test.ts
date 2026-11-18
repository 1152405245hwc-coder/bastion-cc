import test from "node:test";
import assert from "node:assert/strict";
import { runCli, runCliRemote } from "../../clients/cli/src/index.ts";
import { HttpCliClient } from "../../clients/cli/src/http-client.ts";
import { ControlPlane } from "../../server/control/src/index.ts";

test("CLI returns stable JSON-safe session and run results", () => {
  const plane = new ControlPlane();
  assert.deepEqual(runCli(["session", "create", "s1"], plane), {
    ok: true,
    command: "session create",
    data: { sessionId: "s1", generation: 0, status: "ready" },
  });
  const started = runCli(["run", "start", "s1", "private prompt", "--idempotency", "idem-1"], plane);
  assert.equal(started.ok, true);
  assert.deepEqual(started.data, {
    runId: "run-request-idem-1",
    sessionId: "s1",
    status: "queued",
    leaseId: undefined,
    leaseExpiresAt: undefined,
  });
  assert.equal(JSON.stringify(started).includes("private prompt"), false);
});

test("CLI resume emits metadata only and unsupported commands fail visibly", () => {
  const plane = new ControlPlane();
  runCli(["session", "create", "s1"], plane);
  const resumed = runCli(["resume", "s1"], plane);
  assert.equal(resumed.ok, true);
  assert.deepEqual((resumed.data as Array<Record<string, unknown>>)[0]!.type, "SessionCreated");
  const failed = runCli(["unknown"], plane);
  assert.equal(failed.ok, false);
  assert.equal((failed.error as { code: string }).code, "UNKNOWN");
});

test("remote CLI supports one-shot chat with auto-create and 6-digit pair redemption", async () => {
  let getSessionCount = 0;
  const client = new HttpCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetchImpl: async (url, init) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/v1/devices/redeem-pair")) {
        return { status: 200, async json() { return { ok: true, data: { credential: "ccrf_dev_ok" } }; } };
      }
      if (method === "GET" && url.endsWith("/v1/sessions/demo")) {
        getSessionCount += 1;
        if (getSessionCount === 1) {
          return { status: 404, async json() { return { ok: false, error: { code: "NOT_FOUND", message: "missing" } }; } };
        }
        return { status: 200, async json() { return { ok: true, data: { sessionId: "demo", generation: 0, providerSessionId: "claude-99" } }; } };
      }
      if (method === "POST" && url.endsWith("/v1/sessions/create")) {
        return { status: 201, async json() { return { ok: true, data: { sessionId: "demo", generation: 0 } }; } };
      }
      if (method === "POST" && url.endsWith("/v1/sessions/demo/runs")) {
        return { status: 201, async json() { return { ok: true, data: { runId: "run-9", status: "completed" } }; } };
      }
      if (method === "GET" && url.includes("/v1/sessions/demo/runs/run-9")) {
        return {
          status: 200,
          async json() {
            return {
              ok: true,
              data: {
                chunks: [
                  { role: "prompt", text: "hi" },
                  { role: "output", text: "hello from server cli" },
                ],
              },
            };
          },
        };
      }
      return { status: 404, async json() { return { ok: false, error: { code: "NOT_FOUND", message: "unknown" } }; } };
    },
  });

  const paired = await runCliRemote(["pair", "123456"], client);
  assert.equal(paired.ok, true);
  assert.deepEqual(paired.data, { credential: "ccrf_dev_ok" });

  const chatted = await runCliRemote(["chat", "demo", "hi", "--account", "pro-1"], client);
  assert.equal(chatted.ok, true);
  assert.deepEqual(chatted.data, {
    sessionId: "demo",
    runId: "run-9",
    status: "completed",
    providerSessionId: "claude-99",
    output: "hello from server cli",
  });
});
