import { randomUUID } from "node:crypto";
import { HttpCliClient } from "../../clients/cli/src/http-client.ts";
import type { ProviderAdapter } from "../../server/adapters/src/index.ts";

export interface OutboundRunnerDaemonOptions {
  runnerId: string;
  client: HttpCliClient;
  provider: ProviderAdapter;
  leaseTtlMs?: number;
  pollIntervalMs?: number;
  sessionId?: string;
}

export interface DaemonPollResult {
  processed: boolean;
  sessionId?: string;
  runId?: string;
  status?: "completed" | "failed" | "unknown";
}

interface LeasedRunPayload {
  runId: string;
  sessionId: string;
  status: string;
  leaseId?: string;
  prompt?: string;
}

/**
 * Outbound worker daemon. It initiates all connections from the runner side
 * without exposing an inbound listener or SSH server.
 */
export class OutboundRunnerDaemon {
  readonly runnerId: string;
  private readonly client: HttpCliClient;
  private readonly provider: ProviderAdapter;
  private readonly leaseTtlMs: number;
  private readonly pollIntervalMs: number;
  private readonly sessionId: string | undefined;
  private running = false;
  private stopSignal: AbortController | undefined;

  constructor(options: OutboundRunnerDaemonOptions) {
    this.runnerId = options.runnerId;
    this.client = options.client;
    this.provider = options.provider;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.sessionId = options.sessionId;
  }

  async runOnce(sessionIdOverride?: string): Promise<DaemonPollResult> {
    const leaseId = `lease-${this.runnerId}-${randomUUID()}`;
    const targetSession = sessionIdOverride ?? this.sessionId;
    const leased = await this.client.leaseNextRun({
      runnerId: this.runnerId,
      leaseId,
      ttlMs: this.leaseTtlMs,
      ...(targetSession === undefined ? {} : { sessionId: targetSession }),
    }) as LeasedRunPayload | null;

    if (!leased || !leased.runId || !leased.sessionId) {
      return { processed: false };
    }

    const activeLease = leased.leaseId ?? leaseId;
    const prompt = leased.prompt ?? "";

    await this.client.markRunning(leased.sessionId, { runId: leased.runId, leaseId: activeLease });

    const heartbeatIntervalMs = Math.max(250, Math.floor(this.leaseTtlMs / 3));
    const heartbeat = setInterval(() => {
      void this.client.heartbeatRun(leased.sessionId, {
        runId: leased.runId,
        leaseId: activeLease,
        ttlMs: this.leaseTtlMs,
      }).catch(() => { /* loop stops when run finishes or fails */ });
    }, heartbeatIntervalMs);

    let completed = false;
    try {
      const request = {
        runId: leased.runId,
        prompt,
        ...(this.stopSignal ? { signal: this.stopSignal.signal } : {}),
      };
      for await (const event of this.provider.execute(request)) {
        if (event.type === "output" && event.text) {
          await this.client.appendRunOutput(leased.sessionId, {
            runId: leased.runId,
            leaseId: activeLease,
            text: event.text,
          });
        } else if (event.type === "completed") {
          completed = true;
        }
      }
      const finalStatus = completed ? "completed" : "unknown";
      await this.client.completeRun(leased.sessionId, {
        runId: leased.runId,
        leaseId: activeLease,
        status: finalStatus,
      });
      return {
        processed: true,
        sessionId: leased.sessionId,
        runId: leased.runId,
        status: finalStatus,
      };
    } catch {
      try {
        await this.client.completeRun(leased.sessionId, {
          runId: leased.runId,
          leaseId: activeLease,
          status: "unknown",
        });
      } catch {
        // Control plane connectivity may already be lost; leave run for lease/disconnect recovery.
      }
      return {
        processed: true,
        sessionId: leased.sessionId,
        runId: leased.runId,
        status: "unknown",
      };
    } finally {
      clearInterval(heartbeat);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopSignal = new AbortController();
    while (this.running) {
      const result = await this.runOnce();
      if (!this.running) break;
      if (!result.processed) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }

  stop(): void {
    this.running = false;
    this.stopSignal?.abort();
  }
}
