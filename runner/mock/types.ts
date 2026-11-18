export type MockFailureMode =
  | "none"
  | "disconnect-before"
  | "disconnect-after"
  | "duplicate"
  | "out-of-order"
  | "half-success"
  | "restart";

export type RunnerStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface CapabilityGrant {
  sessionId: string;
  runnerId: string;
  scopes: readonly string[];
  issuedAt: number;
  expiresAt: number;
  revoked?: boolean;
}

export interface RunnerCommand {
  commandId: string;
  sessionId: string;
  runId: string;
  generation: number;
  scope: string;
  input: string;
  durationMs?: number;
}

export interface RunnerEvent {
  eventId: string;
  commandId: string;
  sessionId: string;
  runId: string;
  generation: number;
  sequence: number;
  kind: "started" | "output" | "completed" | "failed" | "cancelled" | "unknown" | "runner-restarted";
  status: RunnerStatus;
  data?: string;
  error?: string;
}

export interface RunnerResult {
  status: RunnerStatus;
  commandId: string;
  events: readonly RunnerEvent[];
  sideEffectCount: number;
}

export interface MockRunnerOptions {
  runnerId?: string;
  defaultDelayMs?: number;
  failureMode?: MockFailureMode;
  now?: () => number;
  eventSink?: (event: RunnerEvent) => void;
}
