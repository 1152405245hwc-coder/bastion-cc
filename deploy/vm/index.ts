import { buildVmDestroyPlan, buildVmLaunchPlan, buildVmRollbackPlan, buildVmSnapshotPlan, type VmCommand, type VmImage, type VmPlan } from "../../runner/vm/index.ts";
import type { CapabilityToken } from "../../core/capabilities/src/index.ts";

export interface VmDeployment { status: "experimental" | "unsupported"; plans: readonly VmPlan[]; }
export function buildVmDeployment(command: VmCommand, image: VmImage, capability: CapabilityToken, options: { runnerId: string; deviceId: string; audience?: string; snapshotId: string; now?: number }): VmDeployment {
  const context = { runnerId: options.runnerId, deviceId: options.deviceId, ...(options.audience === undefined ? {} : { audience: options.audience }), ...(options.now === undefined ? {} : { now: options.now }) };
  const launch = buildVmLaunchPlan(command, image, capability, context);
  return { status: "unsupported", plans: [launch, buildVmSnapshotPlan(options.runnerId, image, capability, options.snapshotId), buildVmRollbackPlan(options.runnerId, image, capability, options.snapshotId), buildVmDestroyPlan(options.runnerId, image, capability, options.snapshotId)] };
}
