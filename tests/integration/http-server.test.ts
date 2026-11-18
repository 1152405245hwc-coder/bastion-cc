import test from "node:test";
import assert from "node:assert/strict";
import { createHttpControlServer, handleControlRequest } from "../../server/http/src/index.ts";
import { ControlPlane } from "../../server/control/src/index.ts";
import { DeviceRegistry } from "../../server/auth/src/index.ts";
import { MockProviderAdapter } from "../../server/adapters/src/index.ts";

const plane = new ControlPlane();

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = {
    method,
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield Buffer.from(payload);
    },
  } as any;
  let output = "";
  const response = {
    statusCode: 0,
    setHeader() {},
    end(value?: string) { output = value ?? ""; },
  } as any;
  await handleControlRequest(request, response, { plane, authToken: "test-token", maxBodyBytes: 64 * 1024, version: "0.1.0" });
  return { status: response.statusCode, body: JSON.parse(output) };
}

test("HTTP control server exposes authenticated metadata and cursor recovery", async () => {
  assert.equal((await call("GET", "/health", undefined)).status, 401);
  assert.equal((await call("GET", "/health", undefined, "test-token")).body.ok, true);
  assert.equal((await call("POST", "/v1/sessions/create", { sessionId: "s1" }, "test-token")).status, 201);
  const run = await call("POST", "/v1/sessions/s1/runs", {
      requestId: "req-1", generation: 0, idempotencyKey: "idem-1", prompt: "private prompt",
  }, "test-token");
  assert.equal(run.status, 201);
  assert.equal(run.body.data.status, "queued");
  assert.equal(JSON.stringify(run.body).includes("private prompt"), false);
  const events = await call("GET", "/v1/sessions/s1/events?cursor=0", undefined, "test-token");
  assert.equal(events.status, 200);
  assert.deepEqual(events.body.data.map((event: any) => event.type), ["SessionCreated", "RunQueued"]);
  assert.equal(JSON.stringify(events.body).includes("private prompt"), false);
  assert.equal(plane.getSession("s1").status, "ready");
});

test("public HTTP binding fails closed without an auth token", () => {
  assert.throws(() => createHttpControlServer({ host: "0.0.0.0", port: 0 }), /requires authToken/);
});

test("HTTP control server handles /runs/approve and resolves web assets independent of cwd", async () => {
  const localPlane = new ControlPlane();
  localPlane.createSession("s-approve");
  const started = localPlane.startRun({
    protocolMajor: 1,
    protocolMinor: 0,
    messageType: "run.start",
    requestId: "req-approve",
    sessionId: "s-approve",
    runId: "run-approve",
    generation: 0,
    idempotencyKey: "idem-approve",
    payload: { prompt: "private" },
  }, "private");
  localPlane.leaseRun("s-approve", started.runId, "lease-approve", 60_000);
  localPlane.markRunning("s-approve", started.runId, "lease-approve");
  localPlane.requestApproval("s-approve", started.runId, "lease-approve", "confirm");

  const invoke = async (method: string, path: string, body?: unknown) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = {
      method,
      url: path,
      headers: { authorization: "Bearer test-token" },
      async *[Symbol.asyncIterator]() {
        if (payload !== undefined) yield Buffer.from(payload);
      },
    } as any;
    let output = "";
    const response = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name] = value; },
      end(value?: string | Buffer) { output = Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? ""); },
    } as any;
    await handleControlRequest(request, response, { plane: localPlane, authToken: "test-token", maxBodyBytes: 64 * 1024, version: "0.1.0" });
    return { status: response.statusCode, body: output };
  };

  const invalid = await invoke("POST", "/v1/sessions/s-approve/runs/approve", {
    runId: "run-approve",
    leaseId: "lease-approve",
    approved: "yes",
  });
  assert.equal(invalid.status, 400);

  const approved = await invoke("POST", "/v1/sessions/s-approve/runs/approve", {
    runId: "run-approve",
    leaseId: "lease-approve",
    approved: true,
  });
  assert.equal(approved.status, 200);
  assert.equal(JSON.parse(approved.body).data.status, "running");

  const previousCwd = process.cwd();
  process.chdir("/tmp");
  try {
    const webPage = await invoke("GET", "/");
    assert.equal(webPage.status, 200);
    assert.ok(webPage.body.includes("<!doctype html>") || webPage.body.includes("<html"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("HTTP control server supports sessions, provider execution, transcripts, SSE, and scoped devices", async () => {
  const localPlane = new ControlPlane();
  const deviceRegistry = new DeviceRegistry();
  const provider = new MockProviderAdapter();

  const invoke = async (method: string, path: string, body?: unknown, bearer = "root-secret") => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = {
      method,
      url: path,
      headers: { authorization: `Bearer ${bearer}` },
      async *[Symbol.asyncIterator]() {
        if (payload !== undefined) yield Buffer.from(payload);
      },
    } as any;
    let output = "";
    const response = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
      end(value?: string | Buffer) { output = Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? ""); },
    } as any;
    await handleControlRequest(request, response, {
      plane: localPlane,
      authToken: "root-secret",
      deviceRegistry,
      provider,
      maxBodyBytes: 64 * 1024,
      version: "0.1.0",
    });
    return { status: response.statusCode, headers: response.headers, body: output };
  };

  assert.equal((await invoke("POST", "/v1/sessions/create", { sessionId: "s-exec" })).status, 201);
  const executed = await invoke("POST", "/v1/sessions/s-exec/runs", {
    requestId: "req-exec",
    generation: 0,
    idempotencyKey: "idem-exec",
    prompt: "hello provider",
    execute: true,
  });
  assert.equal(executed.status, 201);
  const runData = JSON.parse(executed.body).data;
  assert.equal(runData.status, "completed");

  const list = await invoke("GET", "/v1/sessions");
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.body).data.length, 1);

  const transcript = await invoke("GET", `/v1/sessions/s-exec/runs/${runData.runId}?cursor=0`);
  assert.equal(transcript.status, 200);
  const chunks = JSON.parse(transcript.body).data.chunks;
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].role, "prompt");
  assert.equal(chunks[1].text, "[mock:14 chars]");

  const stream = await invoke("GET", "/v1/sessions/s-exec/stream?cursor=0&once=1");
  assert.equal(stream.status, 200);
  assert.ok(stream.headers["content-type"]?.includes("text/event-stream"));
  assert.ok(stream.body.includes("event: RunCompleted"));
  assert.equal(stream.body.includes("hello provider"), false);

  const enrolled = await invoke("POST", "/v1/devices/enroll", {
    deviceId: "dev-reader",
    label: "Reader Phone",
    scopes: ["read"],
  });
  assert.equal(enrolled.status, 201);
  const readerCred = JSON.parse(enrolled.body).data.credential;
  assert.equal((await invoke("GET", "/v1/sessions", undefined, readerCred)).status, 200);
  assert.equal((await invoke("POST", "/v1/sessions/compact", { keepLatestRunsPerSession: 1 }, readerCred)).status, 401);

  const revoked = await invoke("POST", "/v1/devices/revoke", { deviceId: "dev-reader" });
  assert.equal(revoked.status, 200);
  assert.equal((await invoke("GET", "/v1/sessions", undefined, readerCred)).status, 401);

  assert.equal((await invoke("POST", "/v1/sessions/compact", { keepLatestRunsPerSession: 1 })).status, 200);
  assert.equal((await invoke("DELETE", "/v1/sessions/s-exec")).status, 200);
  assert.equal(JSON.parse((await invoke("GET", "/v1/sessions")).body).data.length, 0);
});

test("HTTP control server supports metrics, search, update, fork, export, and plan-only execution", async () => {
  const localPlane = new ControlPlane();
  const capturedPrompts: string[] = [];
  const captureProvider = {
    name: "capture",
    async *execute(request: { runId: string; prompt: string }) {
      capturedPrompts.push(request.prompt);
      yield { type: "started" as const, runId: request.runId };
      yield { type: "output" as const, runId: request.runId, text: "plan ready" };
      yield { type: "completed" as const, runId: request.runId };
    },
  };

  const invoke = async (method: string, path: string, body?: unknown) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = {
      method,
      url: path,
      headers: { authorization: "Bearer test-token" },
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
      plane: localPlane,
      authToken: "test-token",
      provider: captureProvider,
      maxBodyBytes: 64 * 1024,
      version: "0.1.0",
    });
    return { status: response.statusCode, body: JSON.parse(output) };
  };

  assert.equal((await invoke("POST", "/v1/sessions/create", {
    sessionId: "proj-1",
    title: "Initial Build",
    project: "/repo/app",
    approvalMode: "plan-only",
    reasoningEffort: "high",
  })).status, 201);

  assert.equal((await invoke("PATCH", "/v1/sessions/proj-1", { title: "Updated Build" })).status, 200);
  const searched = await invoke("GET", "/v1/sessions?q=updated&project=%2Frepo%2Fapp");
  assert.equal(searched.status, 200);
  assert.equal(searched.body.data.length, 1);
  assert.equal(searched.body.data[0].title, "Updated Build");

  const executed = await invoke("POST", "/v1/sessions/proj-1/runs", {
    requestId: "req-plan",
    generation: 0,
    idempotencyKey: "idem-plan",
    prompt: "design schema",
    execute: true,
    reasoningEffort: "max",
  });
  assert.equal(executed.status, 201);
  assert.equal(capturedPrompts[0], "[PLAN-ONLY MODE]\ndesign schema");

  const forked = await invoke("POST", "/v1/sessions/proj-1/fork", { newSessionId: "proj-1-copy" });
  assert.equal(forked.status, 201);
  assert.equal(forked.body.data.parentSessionId, "proj-1");

  const exported = await invoke("GET", "/v1/sessions/proj-1-copy/export?format=markdown");
  assert.equal(exported.status, 200);
  assert.ok(exported.body.data.markdown.includes("design schema"));
  assert.ok(exported.body.data.markdown.includes("plan ready"));

  const metrics = await invoke("GET", "/v1/metrics");
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.data.totalSessions, 2);
  assert.equal(metrics.body.data.totalRuns, 2);
});

test("HTTP control server supports 6-digit pairing, cage status, --resume continuity, and cache hit metrics", async () => {
  const localPlane = new ControlPlane();
  const deviceRegistry = new DeviceRegistry();
  const resumeSeen: Array<string | undefined> = [];
  const profileSeen: Array<string | undefined> = [];
  const telemetryProvider = {
    name: "claude-cli",
    async *execute(request: { runId: string; prompt: string; resumeSessionId?: string; accountProfile?: string }) {
      resumeSeen.push(request.resumeSessionId);
      profileSeen.push(request.accountProfile);
      yield { type: "started" as const, runId: request.runId };
      yield {
        type: "telemetry" as const,
        runId: request.runId,
        providerSessionId: "native-thread-42",
        cumulative: true,
        usage: {
          inputTokens: request.resumeSessionId ? 50 : 200,
          outputTokens: 30,
          cacheReadInputTokens: request.resumeSessionId ? 1950 : 0,
          cacheCreationInputTokens: request.resumeSessionId ? 0 : 800,
        },
      };
      yield { type: "output" as const, runId: request.runId, text: `reply:${request.prompt}` };
      yield { type: "completed" as const, runId: request.runId };
    },
  };

  const invoke = async (method: string, path: string, body?: unknown, bearer?: string) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = {
      method,
      url: path,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
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
      plane: localPlane,
      authToken: "root-secret",
      deviceRegistry,
      provider: telemetryProvider,
      maxBodyBytes: 64 * 1024,
      version: "0.1.0",
    });
    return { status: response.statusCode, body: JSON.parse(output) };
  };

  const challengeRes = await invoke("POST", "/v1/devices/pair-code", {
    deviceId: "phone-paired",
    label: "Paired Phone",
    scopes: ["control", "read"],
  }, "root-secret");
  assert.equal(challengeRes.status, 201);
  assert.match(challengeRes.body.data.code, /^\d{6}$/);

  const redeemed = await invoke("POST", "/v1/devices/redeem-pair", { code: challengeRes.body.data.code });
  assert.equal(redeemed.status, 200);
  const pairedToken = redeemed.body.data.credential;

  const cage = await invoke("GET", "/v1/cage/status", undefined, pairedToken);
  assert.equal(cage.status, 200);
  assert.equal(cage.body.data.provider, "claude-cli");
  assert.equal(cage.body.data.sessionResumeSupported, true);

  await invoke("POST", "/v1/sessions/create", { sessionId: "cage-s1", accountProfile: "pro-2" }, pairedToken);
  await invoke("POST", "/v1/sessions/cage-s1/runs", {
    requestId: "r-1",
    generation: 0,
    idempotencyKey: "k-1",
    prompt: "turn 1",
    execute: true,
  }, pairedToken);
  await invoke("POST", "/v1/sessions/cage-s1/runs", {
    requestId: "r-2",
    generation: 0,
    idempotencyKey: "k-2",
    prompt: "turn 2",
    execute: true,
  }, pairedToken);

  assert.deepEqual(resumeSeen, [undefined, "native-thread-42"]);
  assert.deepEqual(profileSeen, ["pro-2", "pro-2"]);

  const metrics = await invoke("GET", "/v1/metrics", undefined, pairedToken);
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.data.cacheReadTokens, 1950);
  assert.equal(metrics.body.data.cacheHitRate, 65);

  const rehydrated = new ControlPlane(localPlane.store);
  assert.equal(rehydrated.getSession("cage-s1").providerSessionId, "native-thread-42");
  assert.equal(rehydrated.getSession("cage-s1").accountProfile, "pro-2");
  assert.equal(rehydrated.getUsageMetrics().cacheHitRate, 65);
});
