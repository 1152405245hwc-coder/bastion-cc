import test from "node:test";
import assert from "node:assert/strict";
import { HttpCliClient } from "../../clients/cli/src/http-client.ts";
import { OutboundRunnerDaemon } from "../../runner/daemon/index.ts";
import { MockProviderAdapter } from "../../server/adapters/src/index.ts";
import { DeviceRegistry } from "../../server/auth/src/index.ts";
import { ControlPlane } from "../../server/control/src/index.ts";
import { handleControlRequest } from "../../server/http/src/index.ts";

test("OutboundRunnerDaemon leases queued runs over HTTP, streams output, and marks completion", async () => {
  const plane = new ControlPlane();
  const deviceRegistry = new DeviceRegistry();
  const { credential } = deviceRegistry.enroll({
    deviceId: "runner-box",
    label: "Mac Runner",
    scopes: ["runner"],
  });

  const fetchImpl = async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(input);
    const payload = init?.body;
    const request = {
      method: init?.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      headers: init?.headers ?? {},
      async *[Symbol.asyncIterator]() {
        if (payload !== undefined) yield Buffer.from(payload);
      },
    } as any;
    let output = "";
    const response = {
      statusCode: 0,
      setHeader() {},
      end(value?: string | Buffer) { output = Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? ""); },
    } as any;
    await handleControlRequest(request, response, {
      plane,
      authToken: "root-secret",
      deviceRegistry,
      maxBodyBytes: 64 * 1024,
      version: "0.1.0",
    });
    return {
      status: response.statusCode,
      async json() { return JSON.parse(output); },
    };
  };

  const controlClient = new HttpCliClient({
    baseUrl: "http://127.0.0.1:8787",
    authToken: "root-secret",
    fetchImpl,
  });
  const runnerClient = new HttpCliClient({
    baseUrl: "http://127.0.0.1:8787",
    authToken: credential,
    fetchImpl,
  });

  await controlClient.createSession("daemon-s1");
  const queued = await controlClient.startRun("daemon-s1", {
    requestId: "req-d1",
    generation: 0,
    idempotencyKey: "idem-d1",
    prompt: "run via outbound runner",
  }) as { runId: string; status: string };
  assert.equal(queued.status, "queued");

  const daemon = new OutboundRunnerDaemon({
    runnerId: "runner-box",
    client: runnerClient,
    provider: new MockProviderAdapter(),
  });
  const idleBefore = await daemon.runOnce("other-session");
  assert.equal(idleBefore.processed, false);

  const worked = await daemon.runOnce();
  assert.equal(worked.processed, true);
  assert.equal(worked.runId, queued.runId);
  assert.equal(worked.status, "completed");

  const transcript = await controlClient.getRunTranscript("daemon-s1", queued.runId, 0) as {
    status: string;
    chunks: Array<{ role: string; text: string }>;
  };
  assert.equal(transcript.status, "completed");
  assert.equal(transcript.chunks.length, 2);
  assert.equal(transcript.chunks[0]?.text, "run via outbound runner");
  assert.equal(transcript.chunks[1]?.text, "[mock:23 chars]");
});
