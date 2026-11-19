import {
  ProtocolError,
  assertCurrentGeneration,
  type Envelope,
} from "../../../core/protocol/src/index.ts";
import { createHash } from "node:crypto";
import type { ProviderUsage } from "../../adapters/src/index.ts";
import { RunLifecycle, type RunStatus } from "../../scheduler/src/index.ts";
import {
  EventStore,
  type ChunkPage,
  type EventStoreLike,
  type StoredChunk,
  type StoreState,
  type StoredEvent,
} from "../../storage/src/index.ts";

export type ApprovalMode = "manual" | "auto-edit" | "plan-only";
export type ReasoningEffort = "low" | "medium" | "high" | "max";

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["queued", "leased", "running", "awaiting_approval"]);

export interface SessionMetadataOptions {
  title?: string | undefined;
  project?: string | undefined;
  approvalMode?: ApprovalMode | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  parentSessionId?: string | undefined;
  accountProfile?: string | undefined;
  providerSessionId?: string | undefined;
}

export interface SessionState {
  sessionId: string;
  generation: number;
  status: "created" | "ready" | "disconnected";
  currentRunId?: string;
  title?: string;
  project?: string;
  approvalMode?: ApprovalMode;
  reasoningEffort?: ReasoningEffort;
  parentSessionId?: string;
  accountProfile?: string;
  providerSessionId?: string;
}

export interface ExportedRun {
  runId: string;
  status: RunStatus;
  chunks: StoredChunk[];
}

export interface SessionExport {
  sessionId: string;
  format: "json" | "markdown";
  markdown: string;
  session: SessionState;
  runs: ExportedRun[];
}

export interface UsageMetrics {
  totalSessions: number;
  totalRuns: number;
  activeRuns: number;
  awaitingApprovalRuns: number;
  promptBytes: number;
  outputBytes: number;
  totalChunks: number;
  estimatedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
}

export interface RunState {
  runId: string;
  sessionId: string;
  lifecycle: RunLifecycle;
  idempotencyKey: string;
  prompt: string;
  requestFingerprint: string;
  usage?: ProviderUsage;
}

interface PersistedRun {
  runId: string;
  sessionId: string;
  idempotencyKey: string;
  prompt: string;
  requestFingerprint?: string;
  status: RunStatus;
  leaseId?: string;
  leaseExpiresAt?: number;
  usage?: ProviderUsage;
}

interface PersistedControlState {
  sessions: SessionState[];
  runs: PersistedRun[];
  idempotency: Array<[string, string]>;
  store: StoreState;
}

export class ControlPlane {
  readonly store: EventStoreLike;
  private readonly sessions = new Map<string, SessionState>();
  private readonly runs = new Map<string, RunState>();
  private readonly idempotency = new Map<string, string>();
  private readonly outputSequences = new Map<string, number>();

  constructor(store: EventStoreLike = new EventStore()) {
    this.store = store;
    this.hydrateFromStore();
  }

  createSession(sessionId: string, options: SessionMetadataOptions = {}): SessionState {
    if (this.sessions.has(sessionId)) {
      throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Session already exists", { sessionId });
    }
    const session: SessionState = { sessionId, generation: 0, status: "ready" };
    applySessionMetadata(session, options);
    this.sessions.set(sessionId, session);
    this.store.append({
      eventId: `session:${sessionId}:created`,
      aggregateId: sessionId,
      generation: 0,
      type: "SessionCreated",
      payload: { ...session },
    });
    return { ...session };
  }

  updateSession(sessionId: string, patch: SessionMetadataOptions): SessionState {
    const session = this.getSessionRecord(sessionId);
    const updatedFields = applySessionMetadata(session, patch);
    if (Object.keys(updatedFields).length > 0) {
      const nextSeq = this.store.latestSequence(sessionId) + 1;
      this.store.append({
        eventId: `session:${sessionId}:updated:${nextSeq}`,
        aggregateId: sessionId,
        generation: session.generation,
        type: "SessionUpdated",
        payload: { sessionId, ...updatedFields },
      });
    }
    return { ...session };
  }

  forkSession(
    sourceSessionId: string,
    newSessionId: string,
    options: { title?: string | undefined; project?: string | undefined } = {},
  ): SessionState {
    if (newSessionId === sourceSessionId || this.sessions.has(newSessionId)) {
      throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Target forked session already exists", {
        sessionId: newSessionId,
      });
    }
    const source = this.getSessionRecord(sourceSessionId);
    const sourceRuns = [...this.runs.values()].filter((run) => run.sessionId === sourceSessionId);
    const forkedTitle = (options.title?.trim() || `${source.title ?? source.sessionId} (Fork)`).slice(0, 200);
    const forkedProject = options.project !== undefined ? options.project : source.project;
    return this.createAndSeedFork(source, sourceRuns, newSessionId, forkedTitle, forkedProject);
  }

  private createAndSeedFork(
    source: SessionState,
    sourceRuns: RunState[],
    newSessionId: string,
    forkedTitle: string,
    forkedProject: string | undefined,
  ): SessionState {
    const created = this.createSession(newSessionId, {
      title: forkedTitle,
      ...(forkedProject !== undefined ? { project: forkedProject } : {}),
      ...(source.approvalMode !== undefined ? { approvalMode: source.approvalMode } : {}),
      ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
      ...(source.accountProfile !== undefined ? { accountProfile: source.accountProfile } : {}),
      parentSessionId: source.sessionId,
    });

    const collectedChunks: StoredChunk[] = [];
    for (const run of sourceRuns) {
      for (const chunk of this.readAllRunChunks(source.sessionId, run.runId)) {
        collectedChunks.push(chunk);
      }
    }

    if (collectedChunks.length > 0) {
      const seedRunId = `fork-${newSessionId}-seed`;
      const firstPrompt = collectedChunks[0]!.role === "prompt"
        ? collectedChunks[0]!.text
        : `[Forked context from ${source.sessionId}]`;
      const remaining = collectedChunks[0]!.role === "prompt"
        ? collectedChunks.slice(1)
        : collectedChunks;
      this.startRun({
        protocolMajor: 1,
        protocolMinor: 0,
        messageType: "run.start",
        requestId: `fork-${newSessionId}`,
        sessionId: newSessionId,
        runId: seedRunId,
        generation: 0,
        idempotencyKey: `fork-${source.sessionId}-${newSessionId}`,
        payload: { prompt: firstPrompt },
      }, firstPrompt);
      const leaseId = `fork-lease-${seedRunId}`;
      this.leaseRun(newSessionId, seedRunId, leaseId, 60_000);
      this.markRunning(newSessionId, seedRunId, leaseId);
      for (const chunk of remaining) {
        const text = chunk.role === "prompt" ? `[Prompt]\n${chunk.text}` : chunk.text;
        this.recordOutputChunk(newSessionId, seedRunId, leaseId, text);
      }
      this.completeRun(newSessionId, seedRunId, leaseId, "completed");
    }

    return this.getSession(created.sessionId);
  }

  exportSession(sessionId: string, format: "json" | "markdown" = "json"): SessionExport {
    const session = this.getSession(sessionId);
    const sessionRuns = [...this.runs.values()].filter((run) => run.sessionId === sessionId);
    const runs: ExportedRun[] = sessionRuns.map((run) => ({
      runId: run.runId,
      status: run.lifecycle.status,
      chunks: this.readAllRunChunks(sessionId, run.runId),
    }));
    const lines: string[] = [
      `# Session: ${session.title ?? session.sessionId}`,
      "",
      `- Session ID: \`${session.sessionId}\``,
      ...(session.project ? [`- Project: \`${session.project}\``] : []),
      ...(session.parentSessionId ? [`- Parent Session: \`${session.parentSessionId}\``] : []),
      `- Status: \`${session.status}\``,
      ...(session.approvalMode ? [`- Approval Mode: \`${session.approvalMode}\``] : []),
      ...(session.reasoningEffort ? [`- Reasoning Effort: \`${session.reasoningEffort}\``] : []),
      "",
    ];
    for (const run of runs) {
      lines.push(`## Run \`${run.runId}\` (${run.status})`, "");
      for (const chunk of run.chunks) {
        lines.push(`### ${chunk.role === "prompt" ? "Prompt" : `Output #${chunk.chunkIndex}`}`, "", chunk.text, "");
      }
    }
    return {
      sessionId,
      format,
      markdown: lines.join("\n").trimEnd() + "\n",
      session,
      runs,
    };
  }

  getUsageMetrics(): UsageMetrics {
    let activeRuns = 0;
    let awaitingApprovalRuns = 0;
    let promptBytes = 0;
    let outputBytes = 0;
    let totalChunks = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    for (const run of this.runs.values()) {
      const status = run.lifecycle.status;
      if (status === "queued" || status === "leased" || status === "running" || status === "awaiting_approval") {
        activeRuns += 1;
      }
      if (status === "awaiting_approval") {
        awaitingApprovalRuns += 1;
      }
      if (run.usage) {
        inputTokens += run.usage.inputTokens;
        outputTokens += run.usage.outputTokens;
        cacheReadTokens += run.usage.cacheReadInputTokens;
        cacheWriteTokens += run.usage.cacheCreationInputTokens;
      }
      for (const chunk of this.readAllRunChunks(run.sessionId, run.runId)) {
        totalChunks += 1;
        if (chunk.role === "prompt") promptBytes += chunk.bytes;
        else outputBytes += chunk.bytes;
      }
    }
    const cacheDenominator = cacheReadTokens + cacheWriteTokens + inputTokens;
    const cacheHitRate = cacheDenominator > 0
      ? Math.round((cacheReadTokens / cacheDenominator) * 1000) / 10
      : 0;
    return {
      totalSessions: this.sessions.size,
      totalRuns: this.runs.size,
      activeRuns,
      awaitingApprovalRuns,
      promptBytes,
      outputBytes,
      totalChunks,
      estimatedTokens: Math.ceil((promptBytes + outputBytes) / 4),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate,
    };
  }

  getSession(sessionId: string): SessionState {
    return { ...this.getSessionRecord(sessionId) };
  }

  listSessions(filter: { query?: string | undefined; project?: string | undefined } = {}): Array<
    SessionState & { runCount: number; lastSequence: number; currentRunStatus?: RunStatus }
  > {
    const runCounts = new Map<string, number>();
    for (const run of this.runs.values()) {
      runCounts.set(run.sessionId, (runCounts.get(run.sessionId) ?? 0) + 1);
    }
    const query = filter.query?.trim().toLowerCase() ?? "";
    const projectFilter = filter.project?.trim();
    return [...this.sessions.values()]
      .filter((session) => {
        if (projectFilter && session.project !== projectFilter) return false;
        if (!query) return true;
        return (
          session.sessionId.toLowerCase().includes(query)
          || (session.title?.toLowerCase().includes(query) ?? false)
          || (session.project?.toLowerCase().includes(query) ?? false)
        );
      })
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map((session) => {
        const currentRun = session.currentRunId ? this.runs.get(session.currentRunId) : undefined;
        const currentRunStatus = currentRun?.lifecycle.status;
        return {
          ...session,
          runCount: runCounts.get(session.sessionId) ?? 0,
          lastSequence: this.store.latestSequence(session.sessionId),
          ...(currentRunStatus === undefined ? {} : { currentRunStatus }),
        };
      });
  }

  deleteSession(sessionId: string): { deleted: true; sessionId: string } {
    this.getSessionRecord(sessionId);
    this.sessions.delete(sessionId);
    for (const [runId, run] of this.runs.entries()) {
      if (run.sessionId === sessionId) {
        this.runs.delete(runId);
        this.outputSequences.delete(runId);
      }
    }
    for (const [key, runId] of this.idempotency.entries()) {
      if (!this.runs.has(runId)) this.idempotency.delete(key);
    }
    this.store.deleteSessionData(sessionId);
    return { deleted: true, sessionId };
  }

  private getSessionRecord(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProtocolError("NOT_FOUND", "Session not found", { sessionId });
    return session;
  }

  startRun<T>(envelope: Envelope<T>, prompt: string): RunState {
    if (!envelope.sessionId || !envelope.idempotencyKey) {
      throw new ProtocolError("INVALID_ENVELOPE", "run.start requires sessionId and idempotencyKey");
    }
    const session = this.getSessionRecord(envelope.sessionId);
    assertCurrentGeneration(session.generation, envelope.generation);
    const existing = this.idempotency.get(envelope.idempotencyKey);
    if (existing) {
      const prior = this.runs.get(existing);
      if (!prior) throw new ProtocolError("UNKNOWN", "Idempotency record points to missing run");
      const fingerprint = requestFingerprint(envelope.sessionId, envelope.generation, envelope.runId, prompt);
      if (prior.requestFingerprint !== fingerprint) {
        throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for different request content");
      }
      return this.copyRun(prior);
    }
    const activeRun = session.currentRunId ? this.runs.get(session.currentRunId) : undefined;
    if (activeRun && ACTIVE_RUN_STATUSES.has(activeRun.lifecycle.status)) {
      throw new ProtocolError("INVALID_STATE", "Session already has an active run", {
        sessionId: envelope.sessionId,
        activeRunId: activeRun.runId,
      });
    }
    const runId = envelope.runId ?? `run-${envelope.requestId}`;
    const lifecycle = new RunLifecycle();
    const run: RunState = {
      runId,
      sessionId: envelope.sessionId,
      lifecycle,
      idempotencyKey: envelope.idempotencyKey,
      prompt,
      requestFingerprint: requestFingerprint(envelope.sessionId, envelope.generation, envelope.runId, prompt),
    };
    this.store.append({
      eventId: `${runId}:queued`,
      aggregateId: envelope.sessionId,
      generation: session.generation,
      type: "RunQueued",
      // Prompt bodies stay in the private body store. The event log only
      // carries metadata so cursor recovery and notifications cannot leak it.
      payload: { runId },
    });
    this.store.appendChunk({
      runId,
      sessionId: envelope.sessionId,
      chunkIndex: 0,
      role: "prompt",
      text: prompt,
      bytes: Buffer.byteLength(prompt, "utf8"),
      digest: createHash("sha256").update(prompt).digest("hex"),
    });
    this.runs.set(runId, run);
    this.idempotency.set(envelope.idempotencyKey, runId);
    this.store.saveIdempotency?.({
      idempotencyKey: envelope.idempotencyKey,
      sessionId: envelope.sessionId,
      runId,
      requestFingerprint: run.requestFingerprint,
    });
    session.currentRunId = runId;
    return this.copyRun(run);
  }

  leaseRun(sessionId: string, runId: string, leaseId: string, ttlMs: number): RunState {
    const run = this.getRun(sessionId, runId);
    this.transitionRun(run, () => run.lifecycle.lease(leaseId, ttlMs), {
      eventId: `${runId}:leased:${leaseId}`,
      aggregateId: sessionId,
      generation: this.getSessionRecord(sessionId).generation,
      type: "RunLeased",
      payload: { runId, leaseId },
    });
    return this.copyRun(run);
  }

  leaseNextQueuedRun(_runnerId: string, leaseId: string, ttlMs: number, sessionId?: string): RunState | undefined {
    for (const run of this.runs.values()) {
      if (sessionId !== undefined && run.sessionId !== sessionId) continue;
      if (run.lifecycle.status !== "queued") continue;
      const session = this.getSessionRecord(run.sessionId);
      if (session.status !== "ready") continue;
      return this.leaseRun(run.sessionId, run.runId, leaseId, ttlMs);
    }
    return undefined;
  }

  renewRunLease(sessionId: string, runId: string, leaseId: string, ttlMs: number): RunState {
    const run = this.getRun(sessionId, runId);
    run.lifecycle.renew(leaseId, ttlMs);
    return this.copyRun(run);
  }

  markRunning(sessionId: string, runId: string, leaseId: string): RunState {
    const run = this.getRun(sessionId, runId);
    this.transitionRun(run, () => {
      run.lifecycle.assertLease(leaseId);
      run.lifecycle.transition("running");
    }, {
      eventId: `${runId}:running`,
      aggregateId: sessionId,
      generation: this.getSessionRecord(sessionId).generation,
      type: "RunStarted",
      payload: { runId },
    });
    return this.copyRun(run);
  }

  requestApproval(sessionId: string, runId: string, leaseId: string, reason: string): RunState {
    const run = this.getRun(sessionId, runId);
    this.transitionRun(run, () => {
      run.lifecycle.assertLease(leaseId);
      run.lifecycle.transition("awaiting_approval");
    }, {
      eventId: `${runId}:approval`,
      aggregateId: sessionId,
      generation: this.getSessionRecord(sessionId).generation,
      type: "ApprovalRequested",
      payload: { runId, reason },
    });
    return this.copyRun(run);
  }

  respondApproval(sessionId: string, runId: string, leaseId: string, approved: boolean): RunState {
    const run = this.getRun(sessionId, runId);
    this.transitionRun(run, () => {
      run.lifecycle.assertLease(leaseId);
      if (run.lifecycle.status !== "awaiting_approval") {
        throw new ProtocolError("INVALID_STATE", "Run is not awaiting approval");
      }
      run.lifecycle.transition(approved ? "running" : "cancelled");
    }, {
      eventId: `${runId}:approval:${approved ? "approved" : "denied"}`,
      aggregateId: sessionId,
      generation: this.getSessionRecord(sessionId).generation,
      type: "ApprovalResponded",
      payload: { runId, approved },
    });
    return this.copyRun(run);
  }

  cancelRun(sessionId: string, runId: string, leaseId: string): RunState {
    const run = this.getRun(sessionId, runId);
    this.transitionRun(run, () => run.lifecycle.cancel(leaseId), {
      eventId: `${runId}:cancelled`,
      aggregateId: sessionId,
      generation: this.getSessionRecord(sessionId).generation,
      type: "RunCancelled",
      payload: { runId },
    });
    return this.copyRun(run);
  }

  recordRunTelemetry(
    sessionId: string,
    runId: string,
    telemetry: { providerSessionId?: string; usage?: ProviderUsage; cumulative?: boolean },
  ): void {
    const session = this.getSessionRecord(sessionId);
    const run = this.getRun(sessionId, runId);
    if (telemetry.providerSessionId) {
      session.providerSessionId = telemetry.providerSessionId;
    }
    if (telemetry.usage) {
      if (telemetry.cumulative || !run.usage) {
        run.usage = { ...telemetry.usage };
      } else {
        run.usage = {
          inputTokens: run.usage.inputTokens + telemetry.usage.inputTokens,
          outputTokens: run.usage.outputTokens + telemetry.usage.outputTokens,
          cacheReadInputTokens: run.usage.cacheReadInputTokens + telemetry.usage.cacheReadInputTokens,
          cacheCreationInputTokens: run.usage.cacheCreationInputTokens + telemetry.usage.cacheCreationInputTokens,
        };
      }
    }
  }

  completeRun(sessionId: string, runId: string, leaseId: string, status: Extract<RunStatus, "completed" | "failed" | "unknown">): RunState {
    const run = this.getRun(sessionId, runId);
    const session = this.getSessionRecord(sessionId);
    const payload: Record<string, unknown> = status === "completed"
      ? {
          runId,
          ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
          ...(run.usage ? { usage: run.usage } : {}),
        }
      : { runId };
    this.transitionRun(run, () => {
      run.lifecycle.assertLease(leaseId);
      run.lifecycle.transition(status);
    }, {
      eventId: `${runId}:${status}`,
      aggregateId: sessionId,
      generation: session.generation,
      type: status === "completed" ? "RunCompleted" : status === "failed" ? "RunFailed" : "RunUnknown",
      payload,
    });
    return this.copyRun(run);
  }

  recordOutputChunk(sessionId: string, runId: string, leaseId: string, text: string): void {
    const run = this.getRun(sessionId, runId);
    run.lifecycle.assertLease(leaseId);
    const sequence = (this.outputSequences.get(runId) ?? 0) + 1;
    this.outputSequences.set(runId, sequence);
    const bytes = Buffer.byteLength(text, "utf8");
    const digest = createHash("sha256").update(text).digest("hex");
    this.store.append({
      eventId: `${runId}:output:${sequence}`,
      aggregateId: sessionId,
      generation: this.getSessionRecord(sessionId).generation,
      type: "OutputChunk",
      payload: { runId, bytes, digest },
    });
    this.store.appendChunk({
      runId,
      sessionId,
      chunkIndex: sequence,
      role: "output",
      text,
      bytes,
      digest,
    });
  }

  getRunTranscript(
    sessionId: string,
    runId: string,
    afterChunk = 0,
    maxBytes = 32 * 1024,
  ): ChunkPage & { runId: string; sessionId: string; status: RunStatus } {
    const run = this.getRun(sessionId, runId);
    const page = this.store.readChunks(sessionId, runId, afterChunk, maxBytes);
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.lifecycle.status,
      ...page,
    };
  }

  compactSessions(keepLatestRunsPerSession = 5): { prunedChunks: number } {
    if (!Number.isInteger(keepLatestRunsPerSession) || keepLatestRunsPerSession < 0) {
      throw new ProtocolError("INVALID_ENVELOPE", "keepLatestRunsPerSession must be a non-negative integer");
    }
    return {
      prunedChunks: this.store.compactBodies({ keepLatestRunsPerSession }),
    };
  }

  resume(sessionId: string, cursor = 0): StoredEvent[] {
    this.getSessionRecord(sessionId);
    return this.store.readAfter(sessionId, cursor);
  }

  disconnect(sessionId: string): SessionState {
    const session = this.getSessionRecord(sessionId);
    session.generation += 1;
    session.status = "disconnected";
    const run = session.currentRunId ? this.runs.get(session.currentRunId) : undefined;
    if (run && ["leased", "running", "awaiting_approval"].includes(run.lifecycle.status)) {
      run.lifecycle.status = "unknown";
      run.lifecycle.leaseId = undefined;
      run.lifecycle.leaseExpiresAt = undefined;
      this.store.append({
        eventId: `${run.runId}:unknown:disconnect:${session.generation}`,
        aggregateId: sessionId,
        generation: session.generation,
        type: "RunUnknown",
        payload: { runId: run.runId, reason: "runner_disconnected" },
      });
    }
    this.store.append({
      eventId: `session:${sessionId}:disconnect:${session.generation}`,
      aggregateId: sessionId,
      generation: session.generation,
      type: "RunnerDetached",
      payload: { sessionId, generation: session.generation },
    });
    return { ...session };
  }

  reconnect(sessionId: string): SessionState {
    const session = this.getSessionRecord(sessionId);
    session.status = "ready";
    this.store.append({
      eventId: `session:${sessionId}:reconnect:${session.generation}`,
      aggregateId: sessionId,
      generation: session.generation,
      type: "RunnerAttached",
      payload: { sessionId, generation: session.generation },
    });
    return { ...session };
  }

  getRun(sessionId: string, runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run || run.sessionId !== sessionId) {
      throw new ProtocolError("NOT_FOUND", "Run not found", { runId });
    }
    return run;
  }

  exportState(): PersistedControlState {
    return {
      sessions: [...this.sessions.values()],
      runs: [...this.runs.values()].map((run) => ({
        runId: run.runId,
        sessionId: run.sessionId,
        idempotencyKey: run.idempotencyKey,
        prompt: run.prompt,
        requestFingerprint: run.requestFingerprint,
        status: run.lifecycle.status,
        ...(run.lifecycle.leaseId === undefined ? {} : { leaseId: run.lifecycle.leaseId }),
        ...(run.lifecycle.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: run.lifecycle.leaseExpiresAt }),
        ...(run.usage === undefined ? {} : { usage: run.usage }),
      })),
      idempotency: [...this.idempotency.entries()],
      store: this.store.exportState(),
    };
  }

  importState(value: unknown): void {
    const state = parsePersistedState(value);
    this.sessions.clear();
    this.runs.clear();
    this.idempotency.clear();
    this.outputSequences.clear();
    for (const session of state.sessions) this.sessions.set(session.sessionId, { ...session });
    for (const item of state.runs) {
      const lifecycle = new RunLifecycle();
      lifecycle.status = item.status;
      lifecycle.leaseId = item.leaseId;
      lifecycle.leaseExpiresAt = item.leaseExpiresAt;
      this.runs.set(item.runId as string, {
        runId: item.runId,
        sessionId: item.sessionId,
        idempotencyKey: item.idempotencyKey,
        prompt: item.prompt,
        requestFingerprint: typeof item.requestFingerprint === "string"
          ? item.requestFingerprint
          : requestFingerprint(item.sessionId, 0, item.runId, item.prompt),
        lifecycle,
        ...(item.usage === undefined ? {} : { usage: item.usage }),
      });
    }
    for (const [key, runId] of state.idempotency) this.idempotency.set(key, runId);
    this.store.importState(state.store);
  }

  private copyRun(run: RunState): RunState {
    const cloneLifecycle = new RunLifecycle();
    cloneLifecycle.status = run.lifecycle.status;
    cloneLifecycle.leaseId = run.lifecycle.leaseId;
    cloneLifecycle.leaseExpiresAt = run.lifecycle.leaseExpiresAt;
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      idempotencyKey: run.idempotencyKey,
      prompt: run.prompt,
      requestFingerprint: run.requestFingerprint,
      lifecycle: cloneLifecycle,
      ...(run.usage === undefined ? {} : { usage: { ...run.usage } }),
    };
  }

  private transitionRun(run: RunState, transition: () => void, event: Omit<StoredEvent, "sequence" | "createdAt">): void {
    const before = {
      status: run.lifecycle.status,
      leaseId: run.lifecycle.leaseId,
      leaseExpiresAt: run.lifecycle.leaseExpiresAt,
    };
    transition();
    try {
      this.store.append(event);
    } catch (error) {
      run.lifecycle.status = before.status;
      run.lifecycle.leaseId = before.leaseId;
      run.lifecycle.leaseExpiresAt = before.leaseExpiresAt;
      throw error;
    }
  }

  private readAllRunChunks(sessionId: string, runId: string): StoredChunk[] {
    const all: StoredChunk[] = [];
    let cursor = 0;
    while (true) {
      const page = this.store.readChunks(sessionId, runId, cursor, 1024 * 1024);
      all.push(...page.chunks);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    return all;
  }

  private hydrateFromStore(): void {
    const byAggregate = new Map<string, StoredEvent[]>();
    for (const event of this.store.exportState().events) {
      const list = byAggregate.get(event.aggregateId) ?? [];
      list.push(event);
      byAggregate.set(event.aggregateId, list);
    }
    for (const events of byAggregate.values()) {
      events.sort((left, right) => left.sequence - right.sequence);
      for (const event of events) {
        this.applyStoredEvent(event);
      }
    }
    for (const record of this.store.listIdempotency?.() ?? []) {
      const run = this.runs.get(record.runId);
      if (run && run.sessionId === record.sessionId) {
        run.idempotencyKey = record.idempotencyKey;
        run.requestFingerprint = record.requestFingerprint;
        this.idempotency.set(record.idempotencyKey, record.runId);
      }
    }
  }

  private ensureHydratedSession(sessionId: string, generation: number): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionId, generation, status: "ready" };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private applyStoredEvent(event: StoredEvent): void {
    const payload = isRecord(event.payload) ? event.payload : {};
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    switch (event.type) {
      case "SessionCreated": {
        const created: SessionState = {
          sessionId: event.aggregateId,
          generation: event.generation,
          status: "ready",
        };
        applySessionMetadata(created, payload as SessionMetadataOptions);
        this.sessions.set(event.aggregateId, created);
        break;
      }
      case "SessionUpdated": {
        const session = this.ensureHydratedSession(event.aggregateId, event.generation);
        applySessionMetadata(session, payload as SessionMetadataOptions);
        break;
      }
      case "RunnerDetached": {
        const session = this.ensureHydratedSession(event.aggregateId, event.generation);
        session.generation = event.generation;
        session.status = "disconnected";
        break;
      }
      case "RunnerAttached": {
        const session = this.ensureHydratedSession(event.aggregateId, event.generation);
        session.generation = event.generation;
        session.status = "ready";
        break;
      }
      case "RunQueued": {
        const session = this.ensureHydratedSession(event.aggregateId, event.generation);
        const queuedRunId = runId ?? event.eventId.replace(/:queued$/, "");
        const lifecycle = new RunLifecycle();
        lifecycle.status = "queued";
        this.runs.set(queuedRunId, {
          runId: queuedRunId,
          sessionId: event.aggregateId,
          lifecycle,
          idempotencyKey: "",
          prompt: "",
          requestFingerprint: "",
        });
        session.currentRunId = queuedRunId;
        break;
      }
      case "RunLeased": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) {
          run.lifecycle.status = "leased";
          run.lifecycle.leaseId = typeof payload.leaseId === "string" ? payload.leaseId : undefined;
          run.lifecycle.leaseExpiresAt = Number.MAX_SAFE_INTEGER;
        }
        break;
      }
      case "RunStarted": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) run.lifecycle.status = "running";
        break;
      }
      case "ApprovalRequested": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) run.lifecycle.status = "awaiting_approval";
        break;
      }
      case "ApprovalResponded": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) run.lifecycle.status = payload.approved === true ? "running" : "cancelled";
        break;
      }
      case "OutputChunk": {
        if (runId) {
          this.outputSequences.set(runId, (this.outputSequences.get(runId) ?? 0) + 1);
        }
        break;
      }
      case "RunCompleted": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) {
          run.lifecycle.status = "completed";
          if (isProviderUsage(payload.usage)) {
            run.usage = { ...payload.usage };
          }
        }
        if (typeof payload.providerSessionId === "string" && payload.providerSessionId) {
          const session = this.sessions.get(event.aggregateId);
          if (session) session.providerSessionId = payload.providerSessionId;
        }
        break;
      }
      case "RunFailed": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) run.lifecycle.status = "failed";
        break;
      }
      case "RunCancelled": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) run.lifecycle.status = "cancelled";
        break;
      }
      case "RunUnknown": {
        const run = runId ? this.runs.get(runId) : undefined;
        if (run) {
          run.lifecycle.status = "unknown";
          if (payload.reason === "runner_disconnected") {
            run.lifecycle.leaseId = undefined;
            run.lifecycle.leaseExpiresAt = undefined;
          }
        }
        break;
      }
    }
  }
}

function requestFingerprint(sessionId: string, generation: number, runId: string | undefined, prompt: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ sessionId, generation, runId: runId ?? null, prompt }))
    .digest("hex");
}

function parsePersistedState(value: unknown): PersistedControlState {
  if (!isRecord(value) || !Array.isArray(value.sessions) || !Array.isArray(value.runs) || !Array.isArray(value.idempotency) || !isRecord(value.store)) {
    throw new ProtocolError("INVALID_ENVELOPE", "Persisted control state has an invalid shape");
  }
  const sessions = value.sessions.map((item) => {
    if (!isRecord(item) || typeof item.sessionId !== "string" || !Number.isInteger(item.generation) || !isSessionStatus(item.status)) {
      throw new ProtocolError("INVALID_ENVELOPE", "Persisted session is invalid");
    }
    return {
      sessionId: item.sessionId,
      generation: item.generation as number,
      status: item.status,
      ...(item.currentRunId === undefined ? {} : { currentRunId: requireString(item.currentRunId, "currentRunId") }),
      ...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
      ...(typeof item.project === "string" && item.project ? { project: item.project } : {}),
      ...(isApprovalMode(item.approvalMode) ? { approvalMode: item.approvalMode } : {}),
      ...(isReasoningEffort(item.reasoningEffort) ? { reasoningEffort: item.reasoningEffort } : {}),
      ...(typeof item.parentSessionId === "string" && item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
      ...(typeof item.accountProfile === "string" && item.accountProfile ? { accountProfile: item.accountProfile } : {}),
      ...(typeof item.providerSessionId === "string" && item.providerSessionId ? { providerSessionId: item.providerSessionId } : {}),
    } satisfies SessionState;
  });
  const runs = value.runs.map((item) => {
    if (!isRecord(item) || typeof item.runId !== "string" || typeof item.sessionId !== "string" || typeof item.idempotencyKey !== "string" || typeof item.prompt !== "string" || !isRunStatus(item.status)) {
      throw new ProtocolError("INVALID_ENVELOPE", "Persisted run is invalid");
    }
    if (item.leaseExpiresAt !== undefined && (!Number.isInteger(item.leaseExpiresAt) || (item.leaseExpiresAt as number) < 0)) {
      throw new ProtocolError("INVALID_ENVELOPE", "Persisted lease expiry is invalid");
    }
    return {
      runId: item.runId,
      sessionId: item.sessionId,
      idempotencyKey: item.idempotencyKey,
      prompt: item.prompt,
      ...(typeof item.requestFingerprint === "string" ? { requestFingerprint: item.requestFingerprint } : {}),
      status: item.status,
      ...(item.leaseId === undefined ? {} : { leaseId: requireString(item.leaseId, "leaseId") }),
      ...(item.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: item.leaseExpiresAt as number }),
      ...(isProviderUsage(item.usage) ? { usage: item.usage } : {}),
    } satisfies PersistedRun;
  });
  const idempotency = value.idempotency.map((item) => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") {
      throw new ProtocolError("INVALID_ENVELOPE", "Persisted idempotency entry is invalid");
    }
    return [item[0], item[1]] as [string, string];
  });
  const store = value.store as Record<string, unknown>;
  if (!Array.isArray(store.events) || !Array.isArray(store.snapshots)) throw new ProtocolError("INVALID_ENVELOPE", "Persisted event store is invalid");
  return { sessions, runs, idempotency, store: store as unknown as StoreState };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError("INVALID_ENVELOPE", `Persisted ${field} is invalid`);
  return value;
}

function isSessionStatus(value: unknown): value is SessionState["status"] {
  return value === "created" || value === "ready" || value === "disconnected";
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "queued" || value === "leased" || value === "running" || value === "awaiting_approval" || value === "completed" || value === "failed" || value === "cancelled" || value === "expired" || value === "unknown";
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "manual" || value === "auto-edit" || value === "plan-only";
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "max";
}

function applySessionMetadata(session: SessionState, options: SessionMetadataOptions): Record<string, unknown> {
  const updated: Record<string, unknown> = {};
  if (options.title !== undefined) {
    const trimmed = typeof options.title === "string" ? options.title.trim() : "";
    if (trimmed) {
      session.title = trimmed;
      updated.title = trimmed;
    } else {
      delete session.title;
      updated.title = "";
    }
  }
  if (options.project !== undefined) {
    const trimmed = typeof options.project === "string" ? options.project.trim() : "";
    if (trimmed) {
      session.project = trimmed;
      updated.project = trimmed;
    } else {
      delete session.project;
      updated.project = "";
    }
  }
  if (options.approvalMode !== undefined && isApprovalMode(options.approvalMode)) {
    session.approvalMode = options.approvalMode;
    updated.approvalMode = options.approvalMode;
  }
  if (options.reasoningEffort !== undefined && isReasoningEffort(options.reasoningEffort)) {
    session.reasoningEffort = options.reasoningEffort;
    updated.reasoningEffort = options.reasoningEffort;
  }
  if (options.parentSessionId !== undefined && typeof options.parentSessionId === "string" && options.parentSessionId) {
    session.parentSessionId = options.parentSessionId;
    updated.parentSessionId = options.parentSessionId;
  }
  if (options.accountProfile !== undefined) {
    const trimmed = typeof options.accountProfile === "string" ? options.accountProfile.trim() : "";
    if (trimmed) {
      session.accountProfile = trimmed;
      updated.accountProfile = trimmed;
    } else {
      delete session.accountProfile;
      updated.accountProfile = "";
    }
  }
  if (options.providerSessionId !== undefined && typeof options.providerSessionId === "string" && options.providerSessionId) {
    session.providerSessionId = options.providerSessionId;
    updated.providerSessionId = options.providerSessionId;
  }
  return updated;
}

function isProviderUsage(value: unknown): value is ProviderUsage {
  if (!isRecord(value)) return false;
  return (
    typeof value.inputTokens === "number"
    && typeof value.outputTokens === "number"
    && typeof value.cacheReadInputTokens === "number"
    && typeof value.cacheCreationInputTokens === "number"
  );
}
