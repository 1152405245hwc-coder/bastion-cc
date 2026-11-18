import { ProtocolError, validateEnvelope, type Envelope, type MessageType } from "../../../core/protocol/src/index.ts";
import type { StoredEvent } from "../../../server/storage/src/index.ts";

export interface LegacyV26Envelope<T = unknown> {
  protocolVersion: 26;
  type: string;
  requestId: string;
  sessionId?: string;
  runId?: string;
  streamId?: string;
  generation: number;
  sequence?: number;
  cursor?: string;
  idempotencyKey?: string;
  payload: T;
}

export interface LegacyResponse<T = unknown> {
  protocolVersion: 26;
  type: "response" | "event" | "error";
  requestId: string;
  sessionId?: string;
  runId?: string;
  streamId?: string;
  generation?: number;
  sequence?: number;
  cursor?: string;
  payload?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export class GatewayError extends Error {
  readonly code: "INVALID_LEGACY_MESSAGE" | "UNSUPPORTED" | "PROTOCOL_ERROR";
  readonly details: Record<string, unknown>;

  constructor(code: GatewayError["code"], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.details = details;
  }
}

const supported = new Set<MessageType>([
  "device.register",
  "session.create",
  "session.subscribe",
  "history.open",
  "history.ack",
  "stream.cancel",
  "run.start",
  "run.cancel",
  "approval.respond",
]);

function validateLegacy(value: unknown): LegacyV26Envelope {
  if (!value || typeof value !== "object") throw new GatewayError("INVALID_LEGACY_MESSAGE", "Legacy message must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.protocolVersion !== 26) throw new GatewayError("UNSUPPORTED", "Only legacy protocol v26 is supported", { protocolVersion: candidate.protocolVersion });
  if (typeof candidate.type !== "string" || typeof candidate.requestId !== "string" || candidate.requestId === "") {
    throw new GatewayError("INVALID_LEGACY_MESSAGE", "Legacy type and requestId are required");
  }
  if (!Number.isInteger(candidate.generation) || (candidate.generation as number) < 0) {
    throw new GatewayError("INVALID_LEGACY_MESSAGE", "Legacy generation must be a non-negative integer");
  }
  if (candidate.payload === undefined) throw new GatewayError("INVALID_LEGACY_MESSAGE", "Legacy payload is required");
  return candidate as unknown as LegacyV26Envelope;
}

export function toNewEnvelope(value: unknown): Envelope {
  const legacy = validateLegacy(value);
  if (!supported.has(legacy.type as MessageType)) {
    throw new GatewayError("UNSUPPORTED", "Legacy command is not supported by the compatibility gateway", { type: legacy.type });
  }
  const envelope: Envelope = {
    protocolMajor: 1,
    protocolMinor: 0,
    messageType: legacy.type as MessageType,
    requestId: legacy.requestId,
    generation: legacy.generation,
    payload: legacy.payload,
  };
  for (const key of ["sessionId", "runId", "streamId", "sequence", "cursor", "idempotencyKey"] as const) {
    const value = legacy[key];
    if (value !== undefined) (envelope as unknown as Record<string, unknown>)[key] = value;
  }
  return validateEnvelope(envelope);
}

const eventNames: Record<string, string> = {
  SessionCreated: "session.created", RunnerAttached: "runner.attached", RunnerDetached: "runner.detached",
  RunQueued: "run.queued", RunLeased: "run.leased", RunStarted: "run.started", OutputChunk: "run.output",
  ApprovalRequested: "approval.requested", ApprovalResponded: "approval.responded", RunCompleted: "run.completed",
  RunFailed: "run.failed", RunCancelled: "run.cancelled", RunUnknown: "run.unknown", SnapshotCreated: "snapshot.created",
};

export function fromNewEvent(event: StoredEvent): LegacyResponse {
  return { protocolVersion: 26, type: "event", requestId: `event:${event.eventId}`, sessionId: event.aggregateId, generation: event.generation, sequence: event.sequence, payload: { eventType: eventNames[event.type] ?? "unsupported.event", eventId: event.eventId, data: event.payload } };
}

export function toLegacyError(requestId: string, error: unknown): LegacyResponse {
  if (error instanceof GatewayError) return { protocolVersion: 26, type: "error", requestId, error: { code: error.code, message: error.message, details: error.details } };
  if (error instanceof ProtocolError) return { protocolVersion: 26, type: "error", requestId, error: { code: error.code, message: error.message, details: error.details } };
  return { protocolVersion: 26, type: "error", requestId, error: { code: "UNKNOWN", message: "Gateway operation failed" } };
}
