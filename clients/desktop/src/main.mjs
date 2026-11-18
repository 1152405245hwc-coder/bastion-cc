import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HttpCliClient } from "../../cli/src/http-client.ts";
import { routeExternalLink } from "./link-router.mjs";
import { ControlPlane } from "../../../server/control/src/index.ts";
import { SqliteEventStore } from "../../../server/storage/src/index.ts";
import { createHttpControlServer } from "../../../server/http/src/index.ts";
import { DeviceRegistry } from "../../../server/auth/src/index.ts";
import {
  createProviderAdapterFromEnvironment,
  MockProviderAdapter,
} from "../../../server/adapters/src/index.ts";
import { OutboundRunnerDaemon } from "../../../runner/daemon/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let client;
let mainWindow = null;
let localServer = null;
let localServerUrl = "";
let localRunner = null;
let runnerRunning = false;
let currentConfig = {
  baseUrl: process.env.CC_RELAY_BASE_URL || "http://127.0.0.1:8787",
  authToken: process.env.CC_RELAY_AUTH_TOKEN || "",
  lastProject: "",
};

function configFilePath() {
  return path.join(app.getPath("userData"), "ccrf-desktop-config.json");
}

async function loadSavedConfig() {
  try {
    const raw = await readFile(configFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      currentConfig = {
        baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : currentConfig.baseUrl,
        authToken: typeof parsed.authToken === "string" ? parsed.authToken : currentConfig.authToken,
        lastProject: typeof parsed.lastProject === "string" ? parsed.lastProject : "",
      };
    }
  } catch {
    // Use defaults on first launch.
  }
  return currentConfig;
}

async function persistConfig(overrides = {}) {
  currentConfig = {
    baseUrl: typeof overrides.baseUrl === "string" && overrides.baseUrl ? overrides.baseUrl : currentConfig.baseUrl,
    authToken: typeof overrides.authToken === "string" ? overrides.authToken : currentConfig.authToken,
    lastProject: typeof overrides.lastProject === "string" ? overrides.lastProject : currentConfig.lastProject,
  };
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(configFilePath(), `${JSON.stringify(currentConfig, null, 2)}\n`, { mode: 0o600 });
  return { ...currentConfig };
}

function buildClient(overrides = {}) {
  return new HttpCliClient({
    baseUrl: overrides.baseUrl || currentConfig.baseUrl || "http://127.0.0.1:8787",
    authToken: (overrides.authToken ?? currentConfig.authToken) || undefined,
    totp: overrides.totp ?? process.env.CC_RELAY_TOTP,
  });
}

function desktopRuntimeState() {
  return {
    config: {
      baseUrl: currentConfig.baseUrl,
      hasAuthToken: Boolean(currentConfig.authToken),
      authToken: currentConfig.authToken,
      lastProject: currentConfig.lastProject,
    },
    localServer: {
      running: Boolean(localServer),
      baseUrl: localServerUrl,
    },
    localRunner: {
      running: runnerRunning,
    },
  };
}

async function toggleLocalServer() {
  if (localServer) {
    await localServer.close();
    localServer = null;
    localServerUrl = "";
    return desktopRuntimeState();
  }
  const stateDir = path.join(app.getPath("userData"), "state");
  await mkdir(stateDir, { recursive: true });
  const plane = new ControlPlane(new SqliteEventStore(path.join(stateDir, "events.sqlite")));
  const deviceRegistry = new DeviceRegistry();
  const localToken = currentConfig.authToken || `ccrf_local_${randomUUID()}`;
  const provider = process.env.CCRF_PROVIDER
    ? createProviderAdapterFromEnvironment()
    : new MockProviderAdapter();
  const preferredPort = Number(process.env.CCRF_LOCAL_PORT || 8787);
  let server = createHttpControlServer({
    host: "127.0.0.1",
    port: preferredPort,
    authToken: localToken,
    plane,
    deviceRegistry,
    provider,
  });
  try {
    await server.start();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      server = createHttpControlServer({ host: "127.0.0.1", port: 0, authToken: localToken, plane, deviceRegistry, provider });
      await server.start();
    } else {
      throw error;
    }
  }
  const address = server.address();
  localServer = server;
  localServerUrl = address ? `http://127.0.0.1:${address.port}` : `http://127.0.0.1:${preferredPort}`;
  await persistConfig({ baseUrl: localServerUrl, authToken: localToken });
  client = buildClient({ baseUrl: localServerUrl, authToken: localToken });
  return desktopRuntimeState();
}

function toggleLocalRunner() {
  if (localRunner && runnerRunning) {
    localRunner.stop();
    localRunner = null;
    runnerRunning = false;
    return desktopRuntimeState();
  }
  const provider = process.env.CCRF_PROVIDER
    ? createProviderAdapterFromEnvironment()
    : new MockProviderAdapter();
  localRunner = new OutboundRunnerDaemon({
    runnerId: "desktop-local-runner",
    client,
    provider,
    pollIntervalMs: 800,
  });
  runnerRunning = true;
  void localRunner.start().catch(() => {
    runnerRunning = false;
  });
  return desktopRuntimeState();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      routeExternalLink(url, { openExternal: (target) => shell.openExternal(target) });
    } catch {
      // Blocked unexpected origins fail closed.
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return;
    event.preventDefault();
    try {
      routeExternalLink(url, { openExternal: (target) => shell.openExternal(target) });
    } catch {
      // Blocked unexpected navigation fails closed.
    }
  });

  window.loadFile(path.join(__dirname, "index.html"));
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = "default-src 'self'; connect-src 'self' http: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
  await loadSavedConfig();
  client = buildClient();

  ipcMain.handle("relay:configure", async (_event, config) => {
    await persistConfig(config || {});
    client = buildClient(config);
    return { configured: true };
  });
  ipcMain.handle("relay:desktop-state", () => desktopRuntimeState());
  ipcMain.handle("relay:save-config", (_event, config) => persistConfig(config || {}));
  ipcMain.handle("relay:toggle-local-server", () => toggleLocalServer());
  ipcMain.handle("relay:toggle-local-runner", () => toggleLocalRunner());
  ipcMain.handle("relay:pick-folder", async () => {
    const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const result = await dialog.showOpenDialog(targetWindow, {
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory"],
    });
    const selected = result.canceled ? "" : (result.filePaths?.[0] ?? "");
    if (selected) await persistConfig({ lastProject: selected });
    return { canceled: result.canceled, path: selected };
  });
  ipcMain.handle("relay:list-sessions", (_event, filter) => client.listSessions(filter));
  ipcMain.handle("relay:create-session", (_event, sessionId, options) => client.createSession(sessionId, options));
  ipcMain.handle("relay:update-session", (_event, sessionId, patch) => client.updateSession(sessionId, patch));
  ipcMain.handle("relay:fork-session", (_event, sessionId, input) => client.forkSession(sessionId, input));
  ipcMain.handle("relay:export-session", (_event, sessionId, format) => client.exportSession(sessionId, format));
  ipcMain.handle("relay:get-metrics", () => client.getMetrics());
  ipcMain.handle("relay:get-cage-status", () => client.getCageStatus());
  ipcMain.handle("relay:get-session", (_event, sessionId) => client.getSession(sessionId));
  ipcMain.handle("relay:delete-session", (_event, sessionId) => client.deleteSession(sessionId));
  ipcMain.handle("relay:compact-sessions", (_event, keep) => client.compactSessions(keep));
  ipcMain.handle("relay:start-run", (_event, sessionId, input) => client.startRun(sessionId, input));
  ipcMain.handle("relay:get-transcript", (_event, sessionId, runId, cursor, maxBytes) => client.getRunTranscript(sessionId, runId, cursor, maxBytes));
  ipcMain.handle("relay:cancel-run", (_event, sessionId, input) => client.cancelRun(sessionId, input));
  ipcMain.handle("relay:respond-approval", (_event, sessionId, input) => client.respondApproval(sessionId, input));
  ipcMain.handle("relay:disconnect", (_event, sessionId) => client.disconnect(sessionId));
  ipcMain.handle("relay:reconnect", (_event, sessionId) => client.reconnect(sessionId));
  ipcMain.handle("relay:resume", (_event, sessionId, cursor) => client.resume(sessionId, cursor));
  ipcMain.handle("relay:enroll-device", (_event, input) => client.enrollDevice(input));
  ipcMain.handle("relay:list-devices", () => client.listDevices());
  ipcMain.handle("relay:revoke-device", (_event, deviceId) => client.revokeDevice(deviceId));
  ipcMain.handle("relay:create-pairing-code", (_event, input) => client.createPairingCode(input));
  ipcMain.handle("relay:redeem-pairing-code", (_event, code) => client.redeemPairingCode(code));
  ipcMain.handle("relay:open-external", (_event, targetUrl) => routeExternalLink(targetUrl, { openExternal: (target) => shell.openExternal(target) }));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", async () => {
  localRunner?.stop();
  runnerRunning = false;
  if (localServer) {
    await localServer.close().catch(() => {});
    localServer = null;
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
