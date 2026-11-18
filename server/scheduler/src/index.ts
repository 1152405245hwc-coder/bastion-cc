import { ProtocolError } from "../../../core/protocol/src/index.ts";

export type RunStatus =
  | "queued"
  | "leased"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["leased", "cancelled", "expired"],
  leased: ["running", "cancelled", "expired", "unknown"],
  running: ["awaiting_approval", "completed", "failed", "cancelled", "unknown"],
  awaiting_approval: ["running", "cancelled", "expired", "unknown"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
  unknown: [],
};

export class RunLifecycle {
  status: RunStatus = "queued";
  leaseId: string | undefined;
  leaseExpiresAt: number | undefined;

  transition(next: RunStatus): void {
    if (!transitions[this.status].includes(next)) {
      throw new ProtocolError("INVALID_STATE", `Cannot transition run from ${this.status} to ${next}`, {
        current: this.status,
        next,
      });
    }
    this.status = next;
  }

  lease(leaseId: string, ttlMs: number, now = Date.now()): void {
    if (this.status !== "queued") {
      throw new ProtocolError("INVALID_STATE", "Only queued runs may be leased");
    }
    this.leaseId = leaseId;
    this.leaseExpiresAt = now + ttlMs;
    this.transition("leased");
  }

  assertLease(leaseId: string, now = Date.now()): void {
    if (
      this.status !== "leased" &&
      this.status !== "running" &&
      this.status !== "awaiting_approval"
    ) {
      throw new ProtocolError("INVALID_STATE", "Run has no active lease");
    }
    if (this.leaseId !== leaseId) {
      throw new ProtocolError("CAPABILITY_DENIED", "Lease does not belong to this run");
    }
    if ((this.leaseExpiresAt ?? 0) <= now) {
      this.status = "expired";
      throw new ProtocolError("INVALID_STATE", "Run lease has expired");
    }
  }

  renew(leaseId: string, ttlMs: number, now = Date.now()): void {
    this.assertLease(leaseId, now);
    this.leaseExpiresAt = now + ttlMs;
  }

  cancel(leaseId: string, now = Date.now()): void {
    this.assertLease(leaseId, now);
    this.transition("cancelled");
  }
}
