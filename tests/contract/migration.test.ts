import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../../server/control/src/index.ts";
import { compareReadModels, importLegacyV26Database, redactReadModel, rollbackDecision, routeMigration, SessionSwitchRegistry } from "../../server/migration/src/index.ts";

const request = { protocolVersion: 26 as const, type: "session.subscribe", requestId: "r1", sessionId: "s1", generation: 0, payload: { cursor: "0" } };
test("session switch routes only the selected session", async () => {
  const registry = new SessionSwitchRegistry(); registry.switchTo("s1", "new");
  const result = await routeMigration(request, registry, { legacy: () => "old", modern: () => "new" });
  assert.equal(result.route, "new"); assert.equal(result.result, "new");
});
test("shadow compares redacted read models and never exposes secrets", async () => {
  const result = await routeMigration(request, new SessionSwitchRegistry(), { legacy: () => ({ token: ["sk", "ant", "secret"].join("-"), value: 1 }), modern: () => ({ token: ["sk", "ant", "other"].join("-"), value: 2 }) }, "shadow");
  assert.equal(result.shadow?.comparison.equal, false); assert.equal(result.shadow?.decision.reason, "read_model_mismatch");
  assert.deepEqual(result.shadow?.comparison.oldModel, { token: "[redacted]", value: 1 });
});
test("unsupported comparison requests rollback", () => assert.equal(rollbackDecision({ unsupported: true }).reason, "unsupported"));
test("redaction is recursive", () => assert.deepEqual(redactReadModel({ nested: { authorization: "Bearer abc" } }), { nested: { authorization: "[redacted]" } }));

test("importLegacyV26Database reads sessions.sqlite read-only without mutating source", () => {
  const getBuiltinModule = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule?.("node:sqlite") as { DatabaseSync: new (path: string) => any };
  const dir = mkdtempSync(join(tmpdir(), "ccrf-legacy-import-"));
  const legacyPath = join(dir, "sessions.sqlite");
  try {
    const db = new sqlite.DatabaseSync(legacyPath);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, metadata TEXT);");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("legacy-1", "completed", JSON.stringify({ durationSeconds: 22 }));
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("legacy-2", "awaiting_approval", JSON.stringify({ activeRun: "run-wait" }));
    db.close();

    const plane = new ControlPlane();
    const first = importLegacyV26Database(legacyPath, plane);
    assert.deepEqual(first, { importedSessions: 2, sessionIds: ["legacy-1", "legacy-2"] });
    assert.equal(plane.getRun("legacy-1", "legacy-legacy-1-run").lifecycle.status, "completed");
    assert.equal(plane.getRun("legacy-2", "run-wait").lifecycle.status, "awaiting_approval");

    const second = importLegacyV26Database(legacyPath, plane);
    assert.deepEqual(second, { importedSessions: 0, sessionIds: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
