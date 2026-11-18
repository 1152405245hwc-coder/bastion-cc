import { assertCommandAllowed, assertWorkspacePath, validateCapability, type CapabilityToken } from "../../core/capabilities/src/index.ts";

export type VmSecurityStatus = "experimental" | "unsupported";
export type VmPlanAction = "verify-image" | "snapshot" | "launch" | "rollback" | "destroy";

export interface VmImage { ref: string; digest: string; signature: string; signer: string; }
export interface VmCommand { commandId: string; sessionId: string; runId: string; generation: number; command: string; args: readonly string[]; cwd: string; workspace: string; }
export interface VmPlan { status: VmSecurityStatus; action: VmPlanAction; runnerId: string; command?: VmCommand; image?: VmImage; snapshotId?: string; network: "default-deny"; capabilities: { tokenId: string; audience: string; runnerId: string; deviceId: string; sessionId: string }; steps: string[]; }

function reject(value: string, label: string): void {
  if (!value || value.includes("\0") || value.startsWith("-")) throw new Error(`${label} is invalid`);
}
function requireImage(image: VmImage): void {
  reject(image.ref, "image ref"); reject(image.digest, "image digest"); reject(image.signature, "image signature"); reject(image.signer, "image signer");
  if (!/^sha256:[a-f0-9]{64}$/.test(image.digest)) throw new Error("image digest must be sha256");
}
function basePlan(action: VmPlanAction, runnerId: string, token: CapabilityToken, image: VmImage, snapshotId?: string): VmPlan {
  requireImage(image);
  if (token.runnerId !== runnerId) throw new Error("capability runner binding mismatch");
  if (snapshotId !== undefined) reject(snapshotId, "snapshot id");
  return { status: "unsupported", action, runnerId, image, ...(snapshotId === undefined ? {} : { snapshotId }), network: "default-deny", capabilities: { tokenId: token.tokenId, audience: token.audience, runnerId: token.runnerId, deviceId: token.deviceId, sessionId: token.sessionId }, steps: [] };
}

export function buildVmLaunchPlan(command: VmCommand, image: VmImage, capability: CapabilityToken, context: { runnerId: string; deviceId: string; audience?: string; now?: number }): VmPlan {
  validateCapability(capability, { deviceId: context.deviceId, sessionId: command.sessionId, runnerId: context.runnerId, audience: context.audience ?? "vm-runner", ...(context.now === undefined ? {} : { now: context.now }) });
  if (!Number.isInteger(command.generation) || command.generation < 0) throw new Error("invalid command generation");
  if (/\s/.test(command.command) || command.command.includes(";") || command.command.includes("|")) throw new Error("command must be a single executable name; shell syntax is forbidden");
  assertCommandAllowed(capability, command.command);
  const workspace = assertWorkspacePath(capability, command.workspace); const cwd = assertWorkspacePath(capability, command.cwd);
  if (capability.scope.network !== "none") throw new Error("vm runner only permits network=none (default-deny)");
  const plan = basePlan("launch", context.runnerId, capability, image);
  plan.command = { ...command, workspace, cwd };
  plan.steps = ["verify-image-signature", "create-ephemeral-vm", "apply-default-deny-network", "bind-capability", "launch-command"];
  return plan;
}

export function buildVmSnapshotPlan(runnerId: string, image: VmImage, capability: CapabilityToken, snapshotId: string): VmPlan {
  const plan = basePlan("snapshot", runnerId, capability, image, snapshotId); plan.steps = ["verify-image-signature", "quiesce-vm", "create-snapshot"]; return plan;
}
export function buildVmRollbackPlan(runnerId: string, image: VmImage, capability: CapabilityToken, snapshotId: string): VmPlan {
  const plan = basePlan("rollback", runnerId, capability, image, snapshotId); plan.steps = ["verify-image-signature", "restore-snapshot", "reapply-default-deny-network", "rebind-capability"]; return plan;
}
export function buildVmDestroyPlan(runnerId: string, image: VmImage, capability: CapabilityToken, snapshotId?: string): VmPlan {
  const plan = basePlan("destroy", runnerId, capability, image, snapshotId); plan.steps = ["stop-vm", "destroy-vm", "delete-ephemeral-disk"]; return plan;
}

/** VM execution is intentionally absent until an independently verified backend exists. */
export class VmRunner {
  readonly status: VmSecurityStatus = "unsupported";
  readonly runnerId: string;
  constructor(runnerId: string) { this.runnerId = runnerId; }
  execute(): never { throw new Error("VM runner execution is unsupported; use plan builders"); }
}
