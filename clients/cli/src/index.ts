import { ControlPlane } from "../../../server/control/src/index.ts";
import type { RunState } from "../../../server/control/src/index.ts";
import type { Envelope } from "../../../core/protocol/src/index.ts";
import { randomUUID } from "node:crypto";
import { CliTransportError, HttpCliClient } from "./http-client.ts";

export interface CliResult {
  ok: boolean;
  command: string;
  data?: unknown;
  error?: { code: string; message: string };
}

function runData(run: RunState): Record<string, unknown> {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.lifecycle.status,
    leaseId: run.lifecycle.leaseId,
    leaseExpiresAt: run.lifecycle.leaseExpiresAt,
  };
}

function ok(command: string, data: unknown): CliResult {
  return { ok: true, command, data };
}

function fail(command: string, error: unknown): CliResult {
  const value = error as { code?: string; message?: string };
  return {
    ok: false,
    command,
    error: { code: value.code ?? "UNKNOWN", message: value.message ?? String(error) },
  };
}

export function runCli(argv: readonly string[], plane = new ControlPlane()): CliResult {
  const [verb, action, ...args] = argv;
  const command = [verb, action].filter(Boolean).join(" ") || "help";
  try {
    if (verb === "session" && action === "list") {
      return ok(command, plane.listSessions());
    }

    if (verb === "session" && action === "create") {
      const sessionId = args[0];
      if (!sessionId) throw new Error("session create requires SESSION_ID");
      return ok(command, plane.createSession(sessionId));
    }

    if (verb === "session" && action === "get") {
      const sessionId = args[0];
      if (!sessionId) throw new Error("session get requires SESSION_ID");
      return ok(command, plane.getSession(sessionId));
    }

    if (verb === "session" && action === "delete") {
      const sessionId = args[0];
      if (!sessionId) throw new Error("session delete requires SESSION_ID");
      return ok(command, plane.deleteSession(sessionId));
    }

    if (verb === "session" && action === "compact") {
      const keep = Number(flag(args, "keep", "5"));
      return ok(command, plane.compactSessions(keep));
    }

    if (verb === "run" && action === "start") {
      const [sessionId, prompt, ...flags] = args;
      if (!sessionId || !prompt) throw new Error("run start requires SESSION_ID and PROMPT");
      const generation = Number(flag(flags, "generation", "0"));
      const explicitIdempotency = flag(flags, "idempotency", "");
      const requestId = flag(flags, "request-id", explicitIdempotency ? `request-${explicitIdempotency}` : `request-${randomUUID()}`);
      const idempotencyKey = explicitIdempotency || `cli-${requestId}`;
      const envelope: Envelope<{ prompt: string }> = {
        protocolMajor: 1,
        protocolMinor: 0,
        messageType: "run.start",
        requestId,
        sessionId,
        generation,
        idempotencyKey,
        payload: { prompt },
      };
      return ok(command, runData(plane.startRun(envelope, prompt)));
    }

    if (verb === "run" && action === "transcript") {
      const [sessionId, runId, ...flags] = args;
      if (!sessionId || !runId) throw new Error("run transcript requires SESSION_ID and RUN_ID");
      const cursor = Number(flag(flags, "cursor", "0"));
      return ok(command, plane.getRunTranscript(sessionId, runId, cursor));
    }

    if (verb === "resume") {
      const sessionId = action;
      if (!sessionId) throw new Error("resume requires SESSION_ID");
      const cursor = Number(args[0] ?? "0");
      return ok(command, plane.resume(sessionId, cursor).map((event) => ({
        eventId: event.eventId,
        aggregateId: event.aggregateId,
        sequence: event.sequence,
        generation: event.generation,
        type: event.type,
      })));
    }

    if (verb === "cancel") {
      const [sessionId, runId, leaseId] = [action, ...args];
      if (!sessionId || !runId || !leaseId) throw new Error("cancel requires SESSION_ID RUN_ID LEASE_ID");
      return ok(command, runData(plane.cancelRun(sessionId, runId, leaseId)));
    }

    if (verb === "approve") {
      const [sessionId, runId, leaseId, answer] = [action, ...args];
      if (!sessionId || !runId || !leaseId || !answer) throw new Error("approve requires SESSION_ID RUN_ID LEASE_ID yes|no");
      if (answer !== "yes" && answer !== "no") throw new Error("approve answer must be yes or no");
      return ok(command, runData(plane.respondApproval(sessionId, runId, leaseId, answer === "yes")));
    }

    throw new Error("unsupported command");
  } catch (error) {
    return fail(command, error);
  }
}

export async function runCliRemote(argv: readonly string[], client: HttpCliClient): Promise<CliResult> {
  const [verb, action, ...args] = argv;
  const command = [verb, action].filter(Boolean).join(" ") || "help";
  try {
    if (verb === "session" && action === "list") return ok(command, await client.listSessions());
    if (verb === "session" && action === "create") {
      const sessionId = args[0];
      if (!sessionId) throw new Error("session create requires SESSION_ID");
      return ok(command, await client.createSession(sessionId));
    }
    if (verb === "session" && action === "get") {
      const sessionId = args[0];
      if (!sessionId) throw new Error("session get requires SESSION_ID");
      return ok(command, await client.getSession(sessionId));
    }
    if (verb === "session" && action === "delete") {
      const sessionId = args[0];
      if (!sessionId) throw new Error("session delete requires SESSION_ID");
      return ok(command, await client.deleteSession(sessionId));
    }
    if (verb === "session" && action === "compact") {
      const keep = Number(flag(args, "keep", "5"));
      return ok(command, await client.compactSessions(keep));
    }
    if (verb === "run" && action === "start") {
      const [sessionId, prompt, ...flags] = args;
      if (!sessionId || !prompt) throw new Error("run start requires SESSION_ID and PROMPT");
      const generation = Number(flag(flags, "generation", "0"));
      const explicitIdempotency = flag(flags, "idempotency", "");
      const requestId = flag(flags, "request-id", explicitIdempotency ? `request-${explicitIdempotency}` : `request-${randomUUID()}`);
      const idempotencyKey = explicitIdempotency || `cli-${requestId}`;
      const execute = flags.includes("--execute");
      return ok(command, await client.startRun(sessionId, {
        requestId,
        generation,
        idempotencyKey,
        prompt,
        ...(execute ? { execute: true } : {}),
      }));
    }
    if (verb === "run" && action === "transcript") {
      const [sessionId, runId, ...flags] = args;
      if (!sessionId || !runId) throw new Error("run transcript requires SESSION_ID and RUN_ID");
      const cursor = Number(flag(flags, "cursor", "0"));
      return ok(command, await client.getRunTranscript(sessionId, runId, cursor));
    }
    if (verb === "resume") {
      const sessionId = action;
      if (!sessionId) throw new Error("resume requires SESSION_ID");
      const cursor = Number(args[0] ?? "0");
      return ok(command, await client.resume(sessionId, cursor));
    }
    if (verb === "cancel") {
      const [sessionId, runId, leaseId] = [action, ...args];
      if (!sessionId || !runId || !leaseId) throw new Error("cancel requires SESSION_ID RUN_ID LEASE_ID");
      return ok(command, await client.cancelRun(sessionId, { runId, leaseId }));
    }
    if (verb === "approve") {
      const [sessionId, runId, leaseId, answer] = [action, ...args];
      if (!sessionId || !runId || !leaseId || !answer) throw new Error("approve requires SESSION_ID RUN_ID LEASE_ID yes|no");
      if (answer !== "yes" && answer !== "no") throw new Error("approve answer must be yes or no");
      return ok(command, await client.respondApproval(sessionId, { runId, leaseId, approved: answer === "yes" }));
    }
    if (verb === "disconnect" && action) return ok(command, await client.disconnect(action));
    if (verb === "reconnect" && action) return ok(command, await client.reconnect(action));
    if (verb === "chat") {
      const [sessionId, prompt, ...flags] = [action, ...args];
      if (!sessionId || !prompt) throw new Error("chat requires SESSION_ID and PROMPT");
      const project = flag(flags, "project", "");
      const accountProfile = flag(flags, "account", "");
      const approvalMode = flag(flags, "mode", "");
      const reasoningEffort = flag(flags, "effort", "");
      let session: { generation: number; providerSessionId?: string };
      try {
        session = await client.getSession(sessionId) as { generation: number; providerSessionId?: string };
      } catch (error) {
        if (error instanceof CliTransportError && error.status === 404) {
          session = await client.createSession(sessionId, {
            ...(project ? { project } : {}),
            ...(accountProfile ? { accountProfile } : {}),
            ...(approvalMode ? { approvalMode } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          }) as { generation: number; providerSessionId?: string };
        } else {
          throw error;
        }
      }
      const run = await client.startRun(sessionId, {
        requestId: `chat-${randomUUID()}`,
        generation: session.generation,
        idempotencyKey: `chat-${randomUUID()}`,
        prompt,
        execute: true,
        ...(approvalMode ? { approvalMode } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }) as { runId: string; status: string };
      const transcript = await client.getRunTranscript(sessionId, run.runId, 0) as {
        chunks?: Array<{ role: string; text: string }>;
      };
      const updated = await client.getSession(sessionId) as { providerSessionId?: string };
      const output = (transcript.chunks ?? [])
        .filter((chunk) => chunk.role === "output")
        .map((chunk) => chunk.text)
        .join("");
      return ok(command, {
        sessionId,
        runId: run.runId,
        status: run.status,
        ...(updated.providerSessionId ? { providerSessionId: updated.providerSessionId } : {}),
        output,
      });
    }
    if (verb === "pair") {
      const code = action;
      if (!code) throw new Error("pair requires CODE");
      return ok(command, await client.redeemPairingCode(code));
    }
    if (verb === "device" && action === "list") return ok(command, await client.listDevices());
    if (verb === "device" && action === "enroll") {
      const [deviceId, label, ...flags] = args;
      if (!deviceId || !label) throw new Error("device enroll requires DEVICE_ID LABEL");
      const scopes = flag(flags, "scopes", "control,read").split(",").map((s) => s.trim()).filter(Boolean) as Array<"control" | "read" | "runner">;
      return ok(command, await client.enrollDevice({ deviceId, label, scopes }));
    }
    if (verb === "device" && action === "revoke") {
      const deviceId = args[0];
      if (!deviceId) throw new Error("device revoke requires DEVICE_ID");
      return ok(command, await client.revokeDevice(deviceId));
    }
    throw new Error("unsupported command");
  } catch (error) {
    return fail(command, error);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const urlIndex = argv.indexOf("--url");
  const baseUrl = urlIndex >= 0 ? argv[urlIndex + 1] : process.env.CCRF_BASE_URL;
  const cleaned = urlIndex >= 0 ? [...argv.slice(0, urlIndex), ...argv.slice(urlIndex + 2)] : argv;
  if (baseUrl) {
    const client = new HttpCliClient({
      baseUrl,
      authToken: process.env.CCRF_AUTH_TOKEN,
      totp: process.env.CCRF_TOTP_CODE,
    });
    const result = await runCliRemote(cleaned, client);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(runCli(cleaned))}\n`);
}

function flag(flags: readonly string[], name: string, fallback: string): string {
  const index = flags.indexOf(`--${name}`);
  return index >= 0 ? flags[index + 1] ?? fallback : fallback;
}

if (process.argv[1]?.endsWith("/clients/cli/src/index.ts")) {
  void main();
}
