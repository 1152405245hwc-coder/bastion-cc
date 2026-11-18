import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath, URL } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ControlPlane,
  isApprovalMode,
  isReasoningEffort,
  type SessionMetadataOptions,
} from "../../control/src/index.ts";
import { SqliteEventStore } from "../../storage/src/index.ts";
import { ProtocolError, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "../../../core/protocol/src/index.ts";
import { authorize, DeviceRegistry, type DeviceScope } from "../../auth/src/index.ts";
import { createProviderAdapterFromEnvironment, type ProviderAdapter } from "../../adapters/src/index.ts";
import { ExecutionService } from "../../execution/src/index.ts";

export interface HttpControlServerOptions {
  plane?: ControlPlane;
  /** Defaults to 127.0.0.1. Public binding requires an auth token. */
  host?: string;
  port?: number;
  authToken?: string | undefined;
  totpSecret?: string | undefined;
  deviceRegistry?: DeviceRegistry | undefined;
  provider?: ProviderAdapter | undefined;
  maxBodyBytes?: number;
  version?: string | undefined;
}

export interface HttpControlServer {
  readonly server: Server;
  start(): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number } | undefined;
}

export interface ControlRequestOptions {
  plane: ControlPlane;
  authToken?: string | undefined;
  totpSecret?: string | undefined;
  deviceRegistry?: DeviceRegistry | undefined;
  provider?: ProviderAdapter | undefined;
  maxBodyBytes: number;
  version: string;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WEB_ROOT = fileURLToPath(new URL("../../../clients/web/", import.meta.url));
const RUNNER_ACTIONS = new Set(["start-running", "heartbeat", "output", "request-approval", "complete"]);

export function createHttpControlServer(options: HttpControlServerOptions = {}): HttpControlServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const authToken = options.authToken;
  const plane = options.plane ?? new ControlPlane(
    process.env.CCRF_EVENT_DB ? new SqliteEventStore(process.env.CCRF_EVENT_DB) : undefined,
  );
  const deviceRegistry = options.deviceRegistry ?? new DeviceRegistry();
  const provider = options.provider ?? (process.env.CCRF_PROVIDER ? createProviderAdapterFromEnvironment() : undefined);
  let bound = false;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer from 0 to 65535");
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
    throw new Error("maxBodyBytes must be at least 1024");
  }
  if (!LOOPBACK_HOSTS.has(host) && !authToken) {
    throw new Error("public binding requires authToken");
  }

  const server = createServer((request, response) => {
    void handleControlRequest(request, response, {
      plane,
      authToken,
      totpSecret: options.totpSecret,
      deviceRegistry,
      ...(provider === undefined ? {} : { provider }),
      maxBodyBytes,
      version: options.version ?? "0.1.0",
    });
  });
  // A public listener must not let a slow client hold an unbounded request
  // open. These limits apply to headers/body framing, not provider execution.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    async start() {
      if (bound) return;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          bound = true;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    async close() {
      if (!bound) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      bound = false;
    },
    address() {
      const value = server.address();
      if (!value || typeof value === "string") return undefined;
      return { host: value.address, port: value.port };
    },
  };
}

function requiredScopeForRoute(method: string, segments: readonly string[]): DeviceScope {
  if (segments[0] === "v1" && segments[1] === "runners") return "runner";
  if (method === "POST" && segments[0] === "v1" && segments[1] === "sessions" && segments[3] === "runs" && RUNNER_ACTIONS.has(segments[4] ?? "")) {
    return "runner";
  }
  if (method === "GET") return "read";
  return "control";
}

export async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlRequestOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://cc-relay-forge.invalid");
  const segments = url.pathname.split("/").filter(Boolean);
  const authHeaders = {
    ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
    ...(typeof request.headers["x-ccrf-totp"] === "string" ? { totp: request.headers["x-ccrf-totp"] } : {}),
  };

  try {
    if (method === "POST" && segments.length === 3 && segments[0] === "v1" && segments[1] === "devices" && segments[2] === "redeem-pair") {
      if (!options.deviceRegistry) throw new ProtocolError("UNKNOWN", "Device registry is unavailable");
      const body = await readJson(request, options.maxBodyBytes);
      const code = boundedString(body.code, "code", 32);
      const redeemed = options.deviceRegistry.redeemPairingCode(code);
      writeJson(response, 200, { ok: true, data: redeemed });
      return;
    }

    const scope = requiredScopeForRoute(method, segments);
    const isDeviceAdminMutation = method === "POST" && segments[0] === "v1" && segments[1] === "devices";
    const authorized = isDeviceAdminMutation && options.authToken
      ? authorize(authHeaders, {
          bearerToken: options.authToken,
          ...(options.totpSecret === undefined ? {} : { totpSecret: options.totpSecret }),
        })
      : authorize(authHeaders, {
          ...(options.authToken === undefined ? {} : { bearerToken: options.authToken }),
          ...(options.totpSecret === undefined ? {} : { totpSecret: options.totpSecret }),
          ...(options.deviceRegistry === undefined ? {} : { deviceRegistry: options.deviceRegistry }),
          requiredScope: scope,
        });
    if (!authorized) {
      writeJson(response, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
      return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/web/"))) {
      const asset = url.pathname === "/" ? "index.html" : url.pathname.slice("/web/".length);
      if (!/^[a-zA-Z0-9._-]+$/.test(asset)) { writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Asset not found" } }); return; }
      const file = join(WEB_ROOT, asset);
      try {
        const body = await readFile(file);
        response.statusCode = 200;
        response.setHeader("Content-Type", asset.endsWith(".js") ? "text/javascript; charset=utf-8" : asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(body);
      } catch {
        writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Asset not found" } });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR, version: options.version });
      return;
    }

    if (segments[0] !== "v1") {
      writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found" } });
      return;
    }

    if (segments[1] === "devices") {
      if (!options.deviceRegistry) throw new ProtocolError("UNKNOWN", "Device registry is unavailable");
      if (method === "GET" && segments.length === 2) {
        writeJson(response, 200, { ok: true, data: options.deviceRegistry.list() });
        return;
      }
      if (method === "POST" && segments.length === 3 && segments[2] === "enroll") {
        const body = await readJson(request, options.maxBodyBytes);
        const deviceId = requiredId(body.deviceId, "deviceId");
        const label = boundedString(body.label, "label", 200);
        if (!Array.isArray(body.scopes) || body.scopes.some((s: unknown) => s !== "control" && s !== "read" && s !== "runner")) {
          throw new ProtocolError("INVALID_ENVELOPE", "scopes must be an array of control, read, or runner");
        }
        const ttlMs = body.ttlMs === undefined ? undefined : positiveInteger(body.ttlMs, "ttlMs");
        const enrolled = options.deviceRegistry.enroll({
          deviceId,
          label,
          scopes: body.scopes as DeviceScope[],
          ...(ttlMs === undefined ? {} : { ttlMs }),
        });
        writeJson(response, 201, { ok: true, data: enrolled });
        return;
      }
      if (method === "POST" && segments.length === 3 && segments[2] === "revoke") {
        const body = await readJson(request, options.maxBodyBytes);
        const deviceId = requiredId(body.deviceId, "deviceId");
        writeJson(response, 200, { ok: true, data: options.deviceRegistry.revoke(deviceId) });
        return;
      }
      if (method === "POST" && segments.length === 3 && segments[2] === "pair-code") {
        const body = await readJson(request, options.maxBodyBytes);
        const deviceId = requiredId(body.deviceId, "deviceId");
        const label = boundedString(body.label, "label", 200);
        if (!Array.isArray(body.scopes) || body.scopes.some((s: unknown) => s !== "control" && s !== "read" && s !== "runner")) {
          throw new ProtocolError("INVALID_ENVELOPE", "scopes must be an array of control, read, or runner");
        }
        const ttlMs = body.ttlMs === undefined ? undefined : positiveInteger(body.ttlMs, "ttlMs");
        const challenge = options.deviceRegistry.createPairingCode({
          deviceId,
          label,
          scopes: body.scopes as DeviceScope[],
          ...(ttlMs === undefined ? {} : { ttlMs }),
        });
        writeJson(response, 201, { ok: true, data: challenge });
        return;
      }
      writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found" } });
      return;
    }

    if (method === "GET" && segments.length === 3 && segments[1] === "cage" && segments[2] === "status") {
      writeJson(response, 200, {
        ok: true,
        data: {
          provider: options.provider?.name ?? "unconfigured",
          sessionResumeSupported: true,
          fingerprintIsolation: {
            timezone: "America/Los_Angeles",
            locale: "en_US.UTF-8",
            dnsFailClosed: true,
          },
          accountsRootConfigured: Boolean(process.env.CCRF_ACCOUNTS_ROOT),
        },
      });
      return;
    }

    if (method === "POST" && segments.length === 3 && segments[1] === "runners" && segments[2] === "lease") {
      const body = await readJson(request, options.maxBodyBytes);
      const runnerId = requiredId(body.runnerId, "runnerId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      const ttlMs = body.ttlMs === undefined ? 30_000 : positiveInteger(body.ttlMs, "ttlMs");
      const targetSessionId = body.sessionId === undefined ? undefined : requiredId(body.sessionId, "sessionId");
      const leased = options.plane.leaseNextQueuedRun(runnerId, leaseId, ttlMs, targetSessionId);
      if (!leased) {
        writeJson(response, 200, { ok: true, data: null });
        return;
      }
      const prompt = leased.prompt
        || options.plane.getRunTranscript(leased.sessionId, leased.runId, 0).chunks.find((chunk) => chunk.role === "prompt")?.text
        || "";
      writeJson(response, 200, { ok: true, data: { ...runMetadata(leased), prompt } });
      return;
    }

    if (method === "GET" && segments.length === 2 && segments[1] === "metrics") {
      writeJson(response, 200, { ok: true, data: options.plane.getUsageMetrics() });
      return;
    }

    if (method === "GET" && segments.length === 2 && segments[1] === "sessions") {
      const query = url.searchParams.get("q")?.trim() || undefined;
      const project = url.searchParams.get("project")?.trim() || undefined;
      writeJson(response, 200, { ok: true, data: options.plane.listSessions({ query, project }) });
      return;
    }

    if (method === "POST" && segments.length === 3 && segments[1] === "sessions" && segments[2] === "create") {
      const body = await readJson(request, options.maxBodyBytes);
      const sessionId = requiredId(body.sessionId, "sessionId");
      const metadata = parseSessionMetadata(body);
      writeJson(response, 201, { ok: true, data: options.plane.createSession(sessionId, metadata) });
      return;
    }

    if (method === "POST" && segments.length === 3 && segments[1] === "sessions" && segments[2] === "compact") {
      const body = await readJson(request, options.maxBodyBytes);
      const keep = body.keepLatestRunsPerSession === undefined
        ? 5
        : nonNegativeInteger(body.keepLatestRunsPerSession, "keepLatestRunsPerSession");
      writeJson(response, 200, { ok: true, data: options.plane.compactSessions(keep) });
      return;
    }

    if (segments.length < 3 || segments[1] !== "sessions") {
      writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found" } });
      return;
    }
    const sessionId = requiredId(segments[2], "sessionId");

    if (method === "GET" && segments.length === 3) {
      writeJson(response, 200, { ok: true, data: options.plane.getSession(sessionId) });
      return;
    }
    if (method === "DELETE" && segments.length === 3) {
      writeJson(response, 200, { ok: true, data: options.plane.deleteSession(sessionId) });
      return;
    }
    if (
      (method === "PATCH" && segments.length === 3)
      || (method === "POST" && segments.length === 4 && segments[3] === "update")
    ) {
      const body = await readJson(request, options.maxBodyBytes);
      const patch = parseSessionMetadata(body);
      writeJson(response, 200, { ok: true, data: options.plane.updateSession(sessionId, patch) });
      return;
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "fork") {
      const body = await readJson(request, options.maxBodyBytes);
      const newSessionId = requiredId(body.newSessionId, "newSessionId");
      const title = optionalBoundedString(body.title, "title", 200);
      const project = optionalBoundedString(body.project, "project", 200);
      writeJson(response, 201, {
        ok: true,
        data: options.plane.forkSession(sessionId, newSessionId, {
          ...(title !== undefined ? { title } : {}),
          ...(project !== undefined ? { project } : {}),
        }),
      });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[3] === "export") {
      const rawFormat = url.searchParams.get("format") ?? "json";
      if (rawFormat !== "json" && rawFormat !== "markdown") {
        throw new ProtocolError("INVALID_ENVELOPE", "format must be json or markdown");
      }
      writeJson(response, 200, { ok: true, data: options.plane.exportSession(sessionId, rawFormat) });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[3] === "events") {
      const cursor = parseCursor(url.searchParams.get("cursor"));
      const events = options.plane.resume(sessionId, cursor).map(formatEventMetadata);
      writeJson(response, 200, { ok: true, data: events, nextCursor: events.at(-1)?.sequence ?? cursor });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[3] === "stream") {
      options.plane.getSession(sessionId);
      const headerCursor = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : null;
      const cursor = parseCursor(url.searchParams.get("cursor") ?? headerCursor);
      const once = url.searchParams.get("once") === "1";
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("X-Content-Type-Options", "nosniff");
      let lastSequence = cursor;
      const renderBatch = () => {
        const batch = options.plane.resume(sessionId, lastSequence);
        let payload = "";
        for (const event of batch) {
          lastSequence = Math.max(lastSequence, event.sequence);
          payload += `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(formatEventMetadata(event))}\n\n`;
        }
        return payload;
      };
      const initial = `${renderBatch()}: ping\n\n`;
      if (once) {
        response.end(initial);
        return;
      }
      response.write(initial);
      let ticks = 0;
      const timer = setInterval(() => {
        if (response.destroyed || response.writableEnded) {
          clearInterval(timer);
          return;
        }
        ticks += 1;
        const chunk = renderBatch();
        if (chunk) response.write(chunk);
        else if (ticks % 30 === 0) response.write(": ping\n\n");
      }, 500);
      const cleanup = () => clearInterval(timer);
      request.on?.("close", cleanup);
      response.on?.("close", cleanup);
      return;
    }
    if (method === "GET" && segments.length === 5 && segments[3] === "runs") {
      const runId = requiredId(segments[4], "runId");
      const cursor = parseCursor(url.searchParams.get("cursor"));
      const rawMaxBytes = url.searchParams.get("maxBytes");
      const maxBytes = rawMaxBytes === null || rawMaxBytes === "" ? 32 * 1024 : positiveInteger(Number(rawMaxBytes), "maxBytes");
      writeJson(response, 200, { ok: true, data: options.plane.getRunTranscript(sessionId, runId, cursor, maxBytes) });
      return;
    }
    const action = segments[3];
    if (method === "POST" && segments.length === 4 && (action === "disconnect" || action === "reconnect")) {
      const data = action === "disconnect" ? options.plane.disconnect(sessionId) : options.plane.reconnect(sessionId);
      writeJson(response, 200, { ok: true, data });
      return;
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "runs") {
      const body = await readJson(request, options.maxBodyBytes);
      const prompt = boundedString(body.prompt, "prompt", 32 * 1024);
      const requestId = boundedString(body.requestId, "requestId", 200);
      const idempotencyKey = boundedString(body.idempotencyKey, "idempotencyKey", 200);
      const generation = nonNegativeInteger(body.generation, "generation");
      const shouldExecute = body.execute === true;
      const requestedApprovalMode = body.approvalMode === undefined
        ? undefined
        : parseEnum(body.approvalMode, "approvalMode", isApprovalMode);
      if (body.reasoningEffort !== undefined) {
        parseEnum(body.reasoningEffort, "reasoningEffort", isReasoningEffort);
      }
      if (shouldExecute && (!options.provider || options.provider.name === "unconfigured")) {
        throw new ProtocolError("UNKNOWN", "No provider adapter is configured");
      }
      const sessionRecord = options.plane.getSession(sessionId);
      const run = options.plane.startRun({
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: PROTOCOL_MINOR,
        messageType: "run.start",
        requestId,
        sessionId,
        ...(body.runId === undefined ? {} : { runId: boundedString(body.runId, "runId", 200) }),
        generation,
        idempotencyKey,
        payload: { prompt },
      }, prompt);
      if (shouldExecute && options.provider) {
        const leaseId = `lease-${randomUUID()}`;
        options.plane.leaseRun(sessionId, run.runId, leaseId, 60_000);
        const execution = new ExecutionService(options.plane, options.provider);
        const effectiveMode = requestedApprovalMode ?? sessionRecord.approvalMode;
        const executionPrompt = effectiveMode === "plan-only" ? `[PLAN-ONLY MODE]\n${prompt}` : prompt;
        await execution.execute(sessionId, run.runId, leaseId, { runId: run.runId, prompt: executionPrompt });
        writeJson(response, 201, { ok: true, data: runMetadata(options.plane.getRun(sessionId, run.runId)) });
        return;
      }
      writeJson(response, 201, { ok: true, data: runMetadata(run) });
      return;
    }
    if (method === "POST" && segments.length === 5 && segments[3] === "runs" && segments[4] === "cancel") {
      const body = await readJson(request, options.maxBodyBytes);
      const runId = requiredId(body.runId, "runId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      writeJson(response, 200, { ok: true, data: runMetadata(options.plane.cancelRun(sessionId, runId, leaseId)) });
      return;
    }
    if (method === "POST" && segments.length === 5 && segments[3] === "runs" && segments[4] === "approve") {
      const body = await readJson(request, options.maxBodyBytes);
      const runId = requiredId(body.runId, "runId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      if (typeof body.approved !== "boolean") throw new Error("approved must be a boolean");
      writeJson(response, 200, { ok: true, data: runMetadata(options.plane.respondApproval(sessionId, runId, leaseId, body.approved)) });
      return;
    }
    if (method === "POST" && segments.length === 5 && segments[3] === "runs" && segments[4] === "start-running") {
      const body = await readJson(request, options.maxBodyBytes);
      const runId = requiredId(body.runId, "runId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      writeJson(response, 200, { ok: true, data: runMetadata(options.plane.markRunning(sessionId, runId, leaseId)) });
      return;
    }
    if (method === "POST" && segments.length === 5 && segments[3] === "runs" && segments[4] === "heartbeat") {
      const body = await readJson(request, options.maxBodyBytes);
      const runId = requiredId(body.runId, "runId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      const ttlMs = body.ttlMs === undefined ? 30_000 : positiveInteger(body.ttlMs, "ttlMs");
      writeJson(response, 200, { ok: true, data: runMetadata(options.plane.renewRunLease(sessionId, runId, leaseId, ttlMs)) });
      return;
    }
    if (method === "POST" && segments.length === 5 && segments[3] === "runs" && segments[4] === "output") {
      const body = await readJson(request, options.maxBodyBytes);
      const runId = requiredId(body.runId, "runId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      const text = boundedString(body.text, "text", 32 * 1024);
      options.plane.recordOutputChunk(sessionId, runId, leaseId, text);
      writeJson(response, 200, { ok: true, data: { recorded: true, runId } });
      return;
    }
    if (method === "POST" && segments.length === 5 && segments[3] === "runs" && segments[4] === "request-approval") {
      const body = await readJson(request, options.maxBodyBytes);
      const runId = requiredId(body.runId, "runId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      const reason = boundedString(body.reason, "reason", 500);
      writeJson(response, 200, { ok: true, data: runMetadata(options.plane.requestApproval(sessionId, runId, leaseId, reason)) });
      return;
    }
    if (method === "POST" && segments.length === 5 && segments[3] === "runs" && segments[4] === "complete") {
      const body = await readJson(request, options.maxBodyBytes);
      const runId = requiredId(body.runId, "runId");
      const leaseId = requiredId(body.leaseId, "leaseId");
      const status = body.status;
      if (status !== "completed" && status !== "failed" && status !== "unknown") {
        throw new Error("status must be completed, failed, or unknown");
      }
      writeJson(response, 200, { ok: true, data: runMetadata(options.plane.completeRun(sessionId, runId, leaseId, status)) });
      return;
    }

    writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found" } });
  } catch (error) {
    const status = error instanceof ProtocolError && error.code === "NOT_FOUND" ? 404
      : error instanceof ProtocolError && error.code === "INVALID_STATE" ? 409
      : error instanceof ProtocolError && error.code === "STALE_GENERATION" ? 409
      : error instanceof SyntaxError ? 400
      : 400;
    const safe = error instanceof ProtocolError
      ? { code: error.code, message: publicProtocolMessage(error.code, error.message) }
      : { code: "INVALID_REQUEST", message: "Request failed" };
    writeJson(response, status, { ok: false, error: safe });
  }
}

function formatEventMetadata(event: {
  eventId: string;
  aggregateId: string;
  sequence: number;
  generation: number;
  type: string;
  createdAt: string;
}) {
  return {
    eventId: event.eventId,
    aggregateId: event.aggregateId,
    sequence: event.sequence,
    generation: event.generation,
    type: event.type,
    createdAt: event.createdAt,
  };
}

function publicProtocolMessage(code: string, fallback: string): string {
  return {
    INVALID_ENVELOPE: "Request is invalid",
    STALE_GENERATION: "Request belongs to an expired connection",
    IDEMPOTENCY_CONFLICT: "Idempotency key conflicts with an earlier request",
    CAPABILITY_DENIED: "Capability denied",
    INVALID_STATE: "Operation is not valid in the current state",
    NOT_FOUND: "Resource not found",
    UNSUPPORTED_VERSION: "Protocol version is not supported",
  }[code] ?? (code === "UNKNOWN" ? "Request failed" : fallback);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new ProtocolError("INVALID_ENVELOPE", "Request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("JSON body must be an object");
  return value;
}

function requiredId(value: unknown, name: string): string {
  return boundedString(value, name, 200);
}

function optionalBoundedString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${name} must be a string of at most ${max} characters`);
  }
  return value;
}

function parseEnum<T extends string>(value: unknown, name: string, guard: (candidate: unknown) => candidate is T): T {
  if (!guard(value)) throw new Error(`${name} has invalid value`);
  return value;
}

function parseSessionMetadata(body: Record<string, unknown>): SessionMetadataOptions {
  const metadata: SessionMetadataOptions = {};
  const title = optionalBoundedString(body.title, "title", 200);
  if (title !== undefined) metadata.title = title;
  const project = optionalBoundedString(body.project, "project", 200);
  if (project !== undefined) metadata.project = project;
  if (body.approvalMode !== undefined) {
    metadata.approvalMode = parseEnum(body.approvalMode, "approvalMode", isApprovalMode);
  }
  if (body.reasoningEffort !== undefined) {
    metadata.reasoningEffort = parseEnum(body.reasoningEffort, "reasoningEffort", isReasoningEffort);
  }
  const accountProfile = optionalBoundedString(body.accountProfile, "accountProfile", 100);
  if (accountProfile !== undefined) {
    if (accountProfile !== "" && !/^[A-Za-z0-9._-]+$/.test(accountProfile)) {
      throw new Error("accountProfile contains invalid characters");
    }
    metadata.accountProfile = accountProfile;
  }
  return metadata;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  const cursor = Number(value);
  return nonNegativeInteger(cursor, "cursor");
}

function runMetadata(run: { runId: string; sessionId: string; lifecycle: { status: string; leaseId: string | undefined; leaseExpiresAt: number | undefined } }): Record<string, unknown> {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.lifecycle.status,
    leaseId: run.lifecycle.leaseId,
    leaseExpiresAt: run.lifecycle.leaseExpiresAt,
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(payload);
}
