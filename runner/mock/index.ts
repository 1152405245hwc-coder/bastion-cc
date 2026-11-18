import { randomUUID } from "node:crypto";

import type {
  CapabilityGrant,
  MockFailureMode,
  MockRunnerOptions,
  RunnerCommand,
  RunnerEvent,
  RunnerResult,
  RunnerStatus,
} from "./types.ts";

interface StoredCommand {
  promise: Promise<RunnerResult>;
  sideEffectCount: number;
}

export class CapabilityDeniedError extends Error {
  readonly code = "CAPABILITY_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityDeniedError";
  }
}

export class MockRunner {
  readonly runnerId: string;
  private readonly defaultDelayMs: number;
  private readonly now: () => number;
  private readonly eventSink: ((event: RunnerEvent) => void) | undefined;
  private failureMode: MockFailureMode;
  private connected = true;
  private generation = 1;
  private sequence = 0;
  private readonly commands = new Map<string, StoredCommand>();
  private readonly cancelled = new Set<string>();
  private sideEffects = 0;

  constructor(options: MockRunnerOptions = {}) {
    this.runnerId = options.runnerId ?? "mock-runner";
    this.defaultDelayMs = options.defaultDelayMs ?? 0;
    this.failureMode = options.failureMode ?? "none";
    this.now = options.now ?? (() => Date.now());
    this.eventSink = options.eventSink;
  }

  setFailureMode(mode: MockFailureMode): void {
    this.failureMode = mode;
  }

  attach(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  revoke(): void {
    this.connected = false;
    this.generation += 1;
  }

  restart(): RunnerEvent {
    this.connected = true;
    this.generation += 1;
    return this.emit({
      commandId: "runner",
      sessionId: "runner",
      runId: "runner",
      generation: this.generation,
      kind: "runner-restarted",
      status: "running",
    });
  }

  cancel(commandId: string): void {
    this.cancelled.add(commandId);
  }

  getSideEffectCount(): number {
    return this.sideEffects;
  }

  async execute(command: RunnerCommand, grant: CapabilityGrant): Promise<RunnerResult> {
    const existing = this.commands.get(command.commandId);
    if (existing) return existing.promise;

    const promise = this.executeOnce(command, grant);
    this.commands.set(command.commandId, {
      promise,
      sideEffectCount: 0,
    });
    return promise;
  }

  private async executeOnce(command: RunnerCommand, grant: CapabilityGrant): Promise<RunnerResult> {
    this.validate(command, grant);
    const events: RunnerEvent[] = [];
    const emit = (event: RunnerEvent): void => {
      events.push(event);
      this.eventSink?.(event);
    };

    if (!this.connected) {
      emit(this.emit({
        ...command,
        kind: "unknown",
        status: "unknown",
        error: "runner disconnected before command dispatch",
      }));
      return { status: "unknown", commandId: command.commandId, events, sideEffectCount: 0 };
    }

    emit(this.emit({ ...command, kind: "started", status: "running" }));
    if (this.failureMode === "disconnect-before") {
      this.connected = false;
      emit(this.emit({
        ...command,
        kind: "failed",
        status: "failed",
        error: "runner disconnected before side effect",
      }));
      return { status: "failed", commandId: command.commandId, events, sideEffectCount: 0 };
    }

    await this.delay(command.durationMs ?? this.defaultDelayMs);
    if (this.cancelled.has(command.commandId)) {
      emit(this.emit({ ...command, kind: "cancelled", status: "cancelled" }));
      return { status: "cancelled", commandId: command.commandId, events, sideEffectCount: 0 };
    }

    this.sideEffects += 1;
    const sideEffectCount = 1;
    emit(this.emit({
      ...command,
      kind: "output",
      status: "running",
      data: command.input,
    }));

    if (this.failureMode === "disconnect-after" || this.failureMode === "half-success") {
      this.connected = false;
      emit(this.emit({
        ...command,
        kind: "unknown",
        status: "unknown",
        error: "runner disconnected after side effect; result is unknown",
      }));
      return { status: "unknown", commandId: command.commandId, events, sideEffectCount };
    }

    const completed = this.emit({ ...command, kind: "completed", status: "completed" });
    if (this.failureMode === "duplicate") {
      emit(completed);
    } else if (this.failureMode === "out-of-order") {
      const output = events.find((event) => event.kind === "output");
      if (output) {
        events.splice(events.indexOf(output), 1);
        events.push(output);
      }
    }
    emit(completed);

    if (this.failureMode === "restart") {
      this.restart();
    }
    return { status: "completed", commandId: command.commandId, events, sideEffectCount };
  }

  private validate(command: RunnerCommand, grant: CapabilityGrant): void {
    if (grant.revoked) throw new CapabilityDeniedError("capability has been revoked");
    if (grant.runnerId !== this.runnerId) throw new CapabilityDeniedError("capability runner mismatch");
    if (grant.sessionId !== command.sessionId) throw new CapabilityDeniedError("capability session mismatch");
    if (grant.expiresAt <= this.now()) throw new CapabilityDeniedError("capability has expired");
    if (!grant.scopes.includes(command.scope)) throw new CapabilityDeniedError(`scope denied: ${command.scope}`);
    if (command.generation !== this.generation) throw new CapabilityDeniedError("command generation is stale");
  }

  private emit(command: Omit<RunnerEvent, "eventId" | "sequence">): RunnerEvent {
    return {
      eventId: randomUUID(),
      sequence: ++this.sequence,
      ...command,
    };
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

export type {
  CapabilityGrant,
  MockFailureMode,
  MockRunnerOptions,
  RunnerCommand,
  RunnerEvent,
  RunnerResult,
  RunnerStatus,
} from "./types.ts";
