import { assertWorkspacePath, validateCapability, type CapabilityToken } from "../../core/capabilities/src/index.ts";

export type ContainerRuntime = "podman" | "docker";

export interface ContainerCommand {
  commandId: string;
  sessionId: string;
  runId: string;
  generation: number;
  image: string;
  args: readonly string[];
  cwd: string;
  workspace: string;
  input?: string;
  timeoutMs?: number;
}

export interface ContainerInvocation {
  executable: ContainerRuntime;
  args: readonly string[];
  input?: string;
  command: ContainerCommand;
}

export interface ContainerResult { stdout: string; stderr: string; exitCode: number; }
export interface ContainerExecutor { run(invocation: ContainerInvocation, signal: AbortSignal): Promise<ContainerResult>; }
export interface ContainerRunnerOptions {
  runnerId: string;
  deviceId: string;
  audience?: string;
  runtime?: ContainerRuntime;
  executor: ContainerExecutor;
  uid?: number;
  gid?: number;
  now?: () => number;
}
export interface ContainerRunnerResult {
  status: "completed" | "failed" | "cancelled" | "unknown";
  commandId: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  sideEffectCount: number;
  invocation: ContainerInvocation;
}

function rejectUnsafe(value: string, label: string): void {
  if (!value || value.includes("\0") || value.startsWith("-")) throw new Error(`${label} is invalid`);
}

export function buildContainerInvocation(command: ContainerCommand, capability: CapabilityToken, runtime: ContainerRuntime = "podman", uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000): ContainerInvocation {
  rejectUnsafe(command.image, "image");
  const workspace = assertWorkspacePath(capability, command.workspace);
  const cwd = assertWorkspacePath(capability, command.cwd);
  if (capability.scope.network !== "none") throw new Error("container runner only permits network=none");
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 1 || gid < 1) throw new Error("rootless uid/gid required");
  const args: string[] = ["run", "--rm", "--read-only", "--network=none", "--security-opt=no-new-privileges"];
  if (runtime === "podman") args.push("--userns=keep-id", `--user=${uid}:${gid}`);
  else args.push(`--user=${uid}:${gid}`);
  args.push("--mount", `type=bind,src=${workspace},dst=/workspace,readonly=false`, "--workdir", `/workspace${cwd === workspace ? "" : cwd.slice(workspace.length)}`);
  args.push(command.image, ...command.args);
  return { executable: runtime, args, ...(command.input === undefined ? {} : { input: command.input }), command };
}

export class ContainerRunner {
  readonly runnerId: string;
  private readonly options: ContainerRunnerOptions;
  private readonly inFlight = new Map<string, Promise<ContainerRunnerResult>>();
  private readonly cancelled = new Set<string>();
  constructor(options: ContainerRunnerOptions) { this.runnerId = options.runnerId; this.options = options; }
  cancel(commandId: string): void { this.cancelled.add(commandId); }
  execute(command: ContainerCommand, capability: CapabilityToken): Promise<ContainerRunnerResult> {
    const existing = this.inFlight.get(command.commandId); if (existing) return existing;
    const promise = this.executeOnce(command, capability); this.inFlight.set(command.commandId, promise); return promise;
  }
  private async executeOnce(command: ContainerCommand, capability: CapabilityToken): Promise<ContainerRunnerResult> {
    validateCapability(capability, { deviceId: this.options.deviceId, sessionId: command.sessionId, runnerId: this.runnerId, audience: this.options.audience ?? "container-runner", now: (this.options.now ?? Date.now)() });
    if (!Number.isInteger(command.generation) || command.generation < 0) throw new Error("invalid command generation");
    const invocation = buildContainerInvocation(command, capability, this.options.runtime ?? "podman", this.options.uid ?? (process.getuid?.() ?? 1000), this.options.gid ?? (process.getgid?.() ?? 1000));
    if (this.cancelled.has(command.commandId)) return { status: "cancelled", commandId: command.commandId, stdout: "", stderr: "", sideEffectCount: 0, invocation };
    const controller = new AbortController(); const timer = command.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), command.timeoutMs);
    try { const result = await this.options.executor.run(invocation, controller.signal); if (this.cancelled.has(command.commandId)) return { status: "cancelled", commandId: command.commandId, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, sideEffectCount: 0, invocation }; return { status: result.exitCode === 0 ? "completed" : "failed", commandId: command.commandId, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, sideEffectCount: result.exitCode === 0 ? 1 : 0, invocation }; }
    catch (error) { return { status: controller.signal.aborted ? "unknown" : "failed", commandId: command.commandId, stdout: "", stderr: error instanceof Error ? error.message : String(error), sideEffectCount: controller.signal.aborted ? 1 : 0, invocation }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
