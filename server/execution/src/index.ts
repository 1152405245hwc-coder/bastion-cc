import { isAbsolute } from "node:path";
import { ControlPlane, type RunState } from "../../control/src/index.ts";
import { ProtocolError } from "../../../core/protocol/src/index.ts";
import type { ProviderAdapter, ProviderRequest } from "../../adapters/src/index.ts";

export interface ExecutionResult {
  status: RunState["lifecycle"]["status"];
  outputs: string[];
  errorCode?: string;
}

/** Connects a provider adapter to the lifecycle without making the provider the trust boundary. */
export class ExecutionService {
  private readonly plane: ControlPlane;
  private readonly provider: ProviderAdapter;
  constructor(plane: ControlPlane, provider: ProviderAdapter) { this.plane = plane; this.provider = provider; }

  async execute(sessionId: string, runId: string, leaseId: string, request: ProviderRequest): Promise<ExecutionResult> {
    const session = this.plane.getSession(sessionId);
    const resumeSessionId = request.resumeSessionId ?? session.providerSessionId;
    const accountProfile = request.accountProfile ?? session.accountProfile;
    const projectCwd = session.project && isAbsolute(session.project) ? session.project : undefined;
    const cwd = request.cwd ?? projectCwd;
    const approvalMode = request.approvalMode ?? session.approvalMode;
    const reasoningEffort = request.reasoningEffort ?? session.reasoningEffort;
    const enrichedRequest: ProviderRequest = {
      ...request,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      ...(accountProfile !== undefined ? { accountProfile } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(approvalMode !== undefined ? { approvalMode } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    this.plane.markRunning(sessionId, runId, leaseId);
    const outputs: string[] = [];
    let completed = false;
    try {
      for await (const event of this.provider.execute(enrichedRequest)) {
        if (enrichedRequest.signal?.aborted || this.plane.getRun(sessionId, runId).lifecycle.status === "cancelled") {
          return { status: "cancelled", outputs };
        }
        if (event.type === "output") {
          outputs.push(event.text);
          this.plane.recordOutputChunk(sessionId, runId, leaseId, event.text);
        } else if (event.type === "telemetry") {
          this.plane.recordRunTelemetry(sessionId, runId, {
            ...(event.providerSessionId !== undefined ? { providerSessionId: event.providerSessionId } : {}),
            ...(event.usage !== undefined ? { usage: event.usage } : {}),
            ...(event.cumulative !== undefined ? { cumulative: event.cumulative } : {}),
          });
        } else if (event.type === "completed") {
          completed = true;
        }
      }
      if (this.plane.getRun(sessionId, runId).lifecycle.status === "cancelled") {
        return { status: "cancelled", outputs };
      }
      const finalState = this.plane.completeRun(sessionId, runId, leaseId, completed ? "completed" : "unknown");
      return { status: finalState.lifecycle.status, outputs };
    } catch (error) {
      if (this.plane.getRun(sessionId, runId).lifecycle.status === "cancelled") {
        return { status: "cancelled", outputs };
      }
      let finalState: RunState;
      try {
        finalState = this.plane.completeRun(sessionId, runId, leaseId, "unknown");
      } catch {
        throw error;
      }
      return { status: finalState.lifecycle.status, outputs, errorCode: error instanceof ProtocolError ? error.code : "UNKNOWN" };
    }
  }
}
