export const PROTOCOL_MAJOR = 1 as const;
export const PROTOCOL_MINOR = 0 as const;

export type MessageType =
  | "device.register"
  | "session.create"
  | "session.subscribe"
  | "history.open"
  | "history.ack"
  | "stream.cancel"
  | "run.start"
  | "run.cancel"
  | "approval.respond"
  | "event"
  | "error";

export interface Envelope<TPayload = unknown> {
  protocolMajor: number;
  protocolMinor: number;
  messageType: MessageType | string;
  requestId: string;
  sessionId?: string;
  runId?: string;
  streamId?: string;
  generation: number;
  sequence?: number;
  cursor?: string;
  idempotencyKey?: string;
  payload: TPayload;
}

export interface ProtocolCapabilities {
  protocolMajor: number;
  protocolMinor: number;
  features: ReadonlySet<string>;
  maxFrameBytes: number;
  maxStreams: number;
}

export interface NegotiatedCapabilities {
  protocolMajor: number;
  protocolMinor: number;
  features: ReadonlySet<string>;
  maxFrameBytes: number;
  maxStreams: number;
}

export type ProtocolErrorCode =
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_VERSION"
  | "STALE_GENERATION"
  | "SEQUENCE_GAP"
  | "IDEMPOTENCY_CONFLICT"
  | "CAPABILITY_DENIED"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "UNKNOWN";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ProtocolErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}

const REQUIRED_STRING_FIELDS = ["requestId", "messageType"] as const;

export function validateEnvelope<T>(value: unknown): Envelope<T> {
  if (!value || typeof value !== "object") {
    throw new ProtocolError("INVALID_ENVELOPE", "Envelope must be an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof candidate[field] !== "string" || candidate[field] === "") {
      throw new ProtocolError("INVALID_ENVELOPE", `${field} must be a non-empty string`, { field });
    }
  }
  if (!Number.isInteger(candidate.protocolMajor) || !Number.isInteger(candidate.protocolMinor)) {
    throw new ProtocolError("INVALID_ENVELOPE", "protocolMajor and protocolMinor must be integers");
  }
  if (!Number.isInteger(candidate.generation) || (candidate.generation as number) < 0) {
    throw new ProtocolError("INVALID_ENVELOPE", "generation must be a non-negative integer");
  }
  for (const field of ["sequence"] as const) {
    if (candidate[field] !== undefined && (!Number.isInteger(candidate[field]) || (candidate[field] as number) < 0)) {
      throw new ProtocolError("INVALID_ENVELOPE", `${field} must be a non-negative integer`, { field });
    }
  }
  if (candidate.payload === undefined) {
    throw new ProtocolError("INVALID_ENVELOPE", "payload is required");
  }
  return candidate as unknown as Envelope<T>;
}

export function negotiateCapabilities(
  local: ProtocolCapabilities,
  remote: ProtocolCapabilities,
): NegotiatedCapabilities {
  if (local.protocolMajor !== remote.protocolMajor) {
    throw new ProtocolError("UNSUPPORTED_VERSION", "Protocol major versions do not match", {
      local: local.protocolMajor,
      remote: remote.protocolMajor,
    });
  }
  const features = new Set<string>();
  for (const feature of local.features) {
    if (remote.features.has(feature)) features.add(feature);
  }
  return {
    protocolMajor: local.protocolMajor,
    protocolMinor: Math.min(local.protocolMinor, remote.protocolMinor),
    features,
    maxFrameBytes: Math.min(local.maxFrameBytes, remote.maxFrameBytes),
    maxStreams: Math.min(local.maxStreams, remote.maxStreams),
  };
}

export function assertCurrentGeneration(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new ProtocolError("STALE_GENERATION", "Message belongs to an expired generation", {
      actual,
      expected,
    });
  }
}
