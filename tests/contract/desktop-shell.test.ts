import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { routeExternalLink } from "../../clients/desktop/src/link-router.mjs";
const read = (p: string) => readFile(new URL(p, import.meta.url), "utf8");
test("desktop shell hardening and shared transport", async () => {
  const source = await read("../../clients/desktop/src/main.mjs");
  for (const setting of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false", "webSecurity: true"]) assert.ok(source.includes(setting));
  assert.ok(source.includes("HttpCliClient"));
  assert.ok(source.includes("Content-Security-Policy"));
  assert.ok(source.includes("setWindowOpenHandler"));
  assert.ok(source.includes("routeExternalLink"));
  assert.ok(source.includes("toggleLocalServer"));
  assert.ok(source.includes("toggleLocalRunner"));
  assert.ok(source.includes("relay:pick-folder"));
  assert.ok(source.includes("relay:create-pairing-code"));
  assert.ok(source.includes("relay:get-cage-status"));
});
test("preload exposes narrow relay API", async () => {
  const source = await read("../../clients/desktop/src/preload.mjs");
  assert.ok(source.includes('contextBridge.exposeInMainWorld("relay"'));
  for (const method of [
    "configure",
    "getDesktopState",
    "saveConfig",
    "toggleLocalServer",
    "toggleLocalRunner",
    "pickFolder",
    "listSessions",
    "createSession",
    "updateSession",
    "forkSession",
    "exportSession",
    "getMetrics",
    "getCageStatus",
    "getSession",
    "deleteSession",
    "compactSessions",
    "startRun",
    "getRunTranscript",
    "cancelRun",
    "respondApproval",
    "disconnect",
    "reconnect",
    "resume",
    "enrollDevice",
    "listDevices",
    "revokeDevice",
    "createPairingCode",
    "redeemPairingCode",
    "openExternal",
  ]) {
    assert.ok(source.includes(method));
  }
});
test("renderer declares restrictive CSP", async () => {
  const source = await read("../../clients/desktop/src/index.html");
  assert.ok(source.includes("Content-Security-Policy") && source.includes("object-src 'none'"));
});
test("native desktop link router isolates Claude OAuth URLs and fails closed on unknown hosts", () => {
  const spawned: Array<{ cmd: string; args: string[] }> = [];
  const opened: string[] = [];
  const claude = routeExternalLink("https://claude.ai/oauth/authorize", {
    isolatedBrowser: "claude-us-browser",
    spawnImpl: (cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return { unref() {} };
    },
  });
  assert.equal(claude.target, "isolated-browser");
  assert.deepEqual(spawned, [{ cmd: "claude-us-browser", args: ["https://claude.ai/oauth/authorize"] }]);

  const gh = routeExternalLink("https://github.com/example/repo", {
    openExternal: (url: string) => opened.push(url),
  });
  assert.equal(gh.target, "system-browser");
  assert.deepEqual(opened, ["https://github.com/example/repo"]);

  assert.throws(() => routeExternalLink("http://claude.ai/login"), /non-HTTPS/);
  assert.throws(() => routeExternalLink("https://untrusted.example.invalid/"), /Unexpected external host/);
});
