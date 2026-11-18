import { GatewayError, toNewEnvelope, type LegacyV26Envelope } from "../../../compat/legacy-v26-gateway/src/index.ts";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR, ProtocolError, type Envelope } from "../../../core/protocol/src/index.ts";
import type { ControlPlane } from "../../control/src/index.ts";

export type SessionRoute = "legacy" | "new";
export type MigrationMode = "off" | "shadow" | "session";

export interface SessionMigrationConfig {
  mode: MigrationMode;
  route: SessionRoute;
}

/** In-memory routing state only. It deliberately has no persistence or store hooks. */
export class SessionSwitchRegistry {
  private readonly routes = new Map<string, SessionRoute>();
  private readonly defaultRoute: SessionRoute;
  constructor(defaultRoute: SessionRoute = "legacy") { this.defaultRoute = defaultRoute; }
  get(sessionId: string): SessionRoute { return this.routes.get(sessionId) ?? this.defaultRoute; }
  switchTo(sessionId: string, route: SessionRoute): SessionRoute {
    if (!sessionId) throw new Error("sessionId is required");
    this.routes.set(sessionId, route);
    return route;
  }
  rollback(sessionId: string): SessionRoute { this.routes.delete(sessionId); return this.get(sessionId); }
  clear(sessionId: string): void { this.routes.delete(sessionId); }
}

const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|credential|cookie|prompt|content|body|text)/i;
const SECRET_VALUE = /(sk-ant-[A-Za-z0-9_-]+|bearer\s+[A-Za-z0-9._~+/=-]+|AKIA[0-9A-Z]{16})/gi;

export function redactReadModel(value: unknown, path = "$"): unknown {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.map((item, index) => redactReadModel(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactReadModel(child, `${path}.${key}`);
    return out;
  }
  return value;
}

export interface ReadModelComparison {
  equal: boolean;
  differences: Array<{ path: string; oldValue: unknown; newValue: unknown }>;
  oldModel: unknown;
  newModel: unknown;
}

function compare(a: unknown, b: unknown, path: string, differences: ReadModelComparison["differences"]): void {
  if (Object.is(a, b)) return;
  if (typeof a !== typeof b || a === null || b === null) { differences.push({ path, oldValue: a, newValue: b }); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) differences.push({ path: `${path}.length`, oldValue: a.length, newValue: b.length });
    for (let i = 0; i < Math.max(a.length, b.length); i++) compare(a[i], b[i], `${path}[${i}]`, differences);
    return;
  }
  if (typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of keys) compare((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, differences);
    return;
  }
  differences.push({ path, oldValue: a, newValue: b });
}

export function compareReadModels(oldModel: unknown, newModel: unknown): ReadModelComparison {
  const oldRedacted = redactReadModel(oldModel);
  const newRedacted = redactReadModel(newModel);
  const differences: ReadModelComparison["differences"] = [];
  compare(oldRedacted, newRedacted, "$", differences);
  return { equal: differences.length === 0, differences, oldModel: oldRedacted, newModel: newRedacted };
}

export type RollbackReason = "read_model_mismatch" | "unsupported" | "handler_error";
export interface RollbackDecision { rollback: boolean; reason?: RollbackReason; details?: Record<string, unknown>; }
export function rollbackDecision(comparison: ReadModelComparison | { unsupported: boolean; error?: unknown }): RollbackDecision {
  if ("unsupported" in comparison && comparison.unsupported) return { rollback: true, reason: "unsupported" };
  if ("equal" in comparison && !comparison.equal) return { rollback: true, reason: "read_model_mismatch", details: { differences: comparison.differences } };
  return { rollback: false };
}

export interface MigrationHandlers<T = unknown> {
  legacy: (request: LegacyV26Envelope) => Promise<T> | T;
  modern: (request: Envelope) => Promise<T> | T;
}
export interface MigrationResult<T> { route: SessionRoute; request: Envelope; result: T; shadow?: { result: unknown; comparison: ReadModelComparison; decision: RollbackDecision }; }

/** Routes one request. Shadow runs the modern read path for comparison and returns legacy output. */
export async function routeMigration<T>(legacyRequest: unknown, registry: SessionSwitchRegistry, handlers: MigrationHandlers<T>, mode: MigrationMode = "session"): Promise<MigrationResult<T>> {
  const request = toNewEnvelope(legacyRequest);
  const sessionId = request.sessionId;
  if (!sessionId && mode !== "off") throw new GatewayError("UNSUPPORTED", "Migration routing requires sessionId", { type: request.messageType });
  const route = mode === "off" ? "legacy" : (sessionId ? registry.get(sessionId) : "legacy");
  if (route === "new") return { route, request, result: await handlers.modern(request) };
  const result = await handlers.legacy(legacyRequest as LegacyV26Envelope);
  if (mode !== "shadow") return { route, request, result };
  try {
    const shadowResult = await handlers.modern(request);
    const comparison = compareReadModels(result, shadowResult);
    return { route, request, result, shadow: { result: shadowResult, comparison, decision: rollbackDecision(comparison) } };
  } catch (error) {
    return { route, request, result, shadow: { result: undefined, comparison: compareReadModels(undefined, undefined), decision: { rollback: true, reason: "handler_error" } } };
  }
}

export interface LegacyImportResult {
  importedSessions: number;
  sessionIds: string[];
}

/** Imports sessions from a legacy v26 sessions.sqlite database in read-only mode. */
export function importLegacyV26Database(sqlitePath: string, plane: ControlPlane): LegacyImportResult {
  const getBuiltinModule = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule?.("node:sqlite") as { DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => any } | undefined;
  if (!sqlite?.DatabaseSync) {
    throw new ProtocolError("UNKNOWN", "Node built-in SQLite support is unavailable", { required: "node:sqlite" });
  }
  const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
  const imported: string[] = [];
  try {
    const rows = database.prepare("SELECT id, status, metadata FROM sessions ORDER BY rowid").all() as Array<{
      id: unknown;
      status: unknown;
      metadata: unknown;
    }>;
    const existing = new Set(plane.listSessions().map((item) => item.sessionId));
    for (const row of rows) {
      const sessionId = typeof row.id === "string" && row.id ? row.id : undefined;
      if (!sessionId || existing.has(sessionId)) continue;
      plane.createSession(sessionId);
      existing.add(sessionId);
      imported.push(sessionId);

      const status = typeof row.status === "string" ? row.status : "";
      let metadata: Record<string, unknown> = {};
      if (typeof row.metadata === "string" && row.metadata) {
        try {
          const parsed = JSON.parse(row.metadata);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {
          metadata = {};
        }
      }
      const activeRun = typeof metadata.activeRun === "string" && metadata.activeRun ? metadata.activeRun : undefined;
      const terminal = status === "completed" || status === "failed" || status === "cancelled" || status === "awaiting_approval";
      const runId = activeRun ?? (terminal ? `legacy-${sessionId}-run` : undefined);
      if (!runId) continue;

      plane.startRun({
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: PROTOCOL_MINOR,
        messageType: "run.start",
        requestId: `import-${runId}`,
        sessionId,
        runId,
        generation: 0,
        idempotencyKey: `import-${sessionId}-${runId}`,
        payload: { prompt: "[imported-legacy-session]" },
      }, "[imported-legacy-session]");

      const leaseId = `import-lease-${runId}`;
      if (status === "awaiting_approval") {
        plane.leaseRun(sessionId, runId, leaseId, 60_000);
        plane.markRunning(sessionId, runId, leaseId);
        plane.requestApproval(sessionId, runId, leaseId, "imported awaiting approval");
      } else if (status === "completed" || status === "failed") {
        plane.leaseRun(sessionId, runId, leaseId, 60_000);
        plane.markRunning(sessionId, runId, leaseId);
        plane.completeRun(sessionId, runId, leaseId, status);
      } else if (status === "cancelled") {
        plane.leaseRun(sessionId, runId, leaseId, 60_000);
        plane.cancelRun(sessionId, runId, leaseId);
      } else if (activeRun) {
        plane.leaseRun(sessionId, runId, leaseId, 60_000);
        if (status === "running") {
          plane.markRunning(sessionId, runId, leaseId);
        }
      }
    }
    return { importedSessions: imported.length, sessionIds: imported };
  } finally {
    database.close();
  }
}
