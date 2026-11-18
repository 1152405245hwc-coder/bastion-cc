import { randomUUID } from "node:crypto";
import { assertCommandAllowed, assertWorkspacePath, validateCapability, type CapabilityToken } from "../../core/capabilities/src/index.ts";

export type LocalRunnerStatus = "completed" | "cancelled" | "failed" | "unknown";
export interface LocalCommand { commandId: string; sessionId: string; runId: string; generation: number; command: string; args: readonly string[]; cwd: string; input?: string; timeoutMs?: number; }
export interface ProcessResult { stdout: string; stderr: string; exitCode: number; }
export interface ProcessExecutor { run(command: LocalCommand, signal: AbortSignal): Promise<ProcessResult>; }
export interface LocalRunnerOptions { runnerId: string; deviceId: string; audience: string; dryRun?: boolean; executor?: ProcessExecutor; now?: () => number; }
export interface LocalRunnerResult { status: LocalRunnerStatus; commandId: string; stdout: string; stderr: string; exitCode?: number; sideEffectCount: number; }

export class LocalRunner {
  readonly runnerId: string;
  private readonly deviceId: string;
  private readonly audience: string;
  private readonly dryRun: boolean;
  private readonly executor: ProcessExecutor | undefined;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<LocalRunnerResult>>();
  private readonly cancelled = new Set<string>();

  constructor(options: LocalRunnerOptions) {
    this.runnerId = options.runnerId;
    this.deviceId = options.deviceId;
    this.audience = options.audience;
    this.dryRun = options.dryRun ?? true;
    this.executor = options.executor;
    this.now = options.now ?? (() => Date.now());
  }

  cancel(commandId: string): void { this.cancelled.add(commandId); }

  execute(command: LocalCommand, capability: CapabilityToken): Promise<LocalRunnerResult> {
    const existing = this.inFlight.get(command.commandId);
    if (existing) return existing;
    const promise = this.executeOnce(command, capability);
    this.inFlight.set(command.commandId, promise);
    return promise;
  }

  private async executeOnce(command: LocalCommand, capability: CapabilityToken): Promise<LocalRunnerResult> {
    validateCapability(capability, { deviceId: this.deviceId, sessionId: command.sessionId, runnerId: this.runnerId, audience: this.audience, now: this.now() });
    if (!Number.isInteger(command.generation) || command.generation < 0) throw new Error("invalid command generation");
    if (/\s/.test(command.command) || command.command.includes(";") || command.command.includes("|")) throw new Error("command must be a single executable name; shell syntax is forbidden");
    assertCommandAllowed(capability, command.command);
    const normalized: LocalCommand = { ...command, cwd: assertWorkspacePath(capability, command.cwd) };
    if (this.cancelled.has(command.commandId)) return { status: "cancelled", commandId: command.commandId, stdout: "", stderr: "", sideEffectCount: 0 };
    if (this.dryRun || !this.executor) {
      await this.delay(command.timeoutMs ?? 0);
      if (this.cancelled.has(command.commandId)) return { status: "cancelled", commandId: command.commandId, stdout: "", stderr: "", sideEffectCount: 0 };
      return { status: "completed", commandId: command.commandId, stdout: `[dry-run] ${JSON.stringify([normalized.command, ...normalized.args])} cwd=${normalized.cwd}`, stderr: "", sideEffectCount: 0 };
    }
    const controller = new AbortController();
    const timeout = normalized.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), normalized.timeoutMs);
    try {
      const operation = this.executor.run(normalized, controller.signal);
      const timeoutResult = normalized.timeoutMs === undefined ? undefined : new Promise<never>((_, reject) => setTimeout(() => reject(new Error("process timeout")), normalized.timeoutMs));
      const result = await (timeoutResult === undefined ? operation : Promise.race([operation, timeoutResult]));
      if (this.cancelled.has(command.commandId)) return { status: "cancelled", commandId: command.commandId, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, sideEffectCount: 0 };
      return { status: result.exitCode === 0 ? "completed" : "failed", commandId: command.commandId, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, sideEffectCount: result.exitCode === 0 ? 1 : 0 };
    } catch (error) {
      if (controller.signal.aborted) return { status: "unknown", commandId: command.commandId, stdout: "", stderr: "process timeout; side effect is unknown", sideEffectCount: 1 };
      return { status: "failed", commandId: command.commandId, stdout: "", stderr: error instanceof Error ? error.message : String(error), sideEffectCount: 0 };
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }

  private async delay(ms: number): Promise<void> { if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms)); }
}

export function createCapabilityToken(overrides: Partial<CapabilityToken> = {}): CapabilityToken {
  return { tokenId: randomUUID(), deviceId: "device-a", sessionId: "session-a", runnerId: "runner-a", audience: "local-runner", nonce: randomUUID(), issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, scope: { workspaceRoots: [process.cwd()], commands: ["echo"], network: "none", networkTargets: [], approval: false, credentialRefs: [] }, ...overrides };
}
