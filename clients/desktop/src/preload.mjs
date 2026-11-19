import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("relay", Object.freeze({
  configure: (config) => ipcRenderer.invoke("relay:configure", config),
  getDesktopState: () => ipcRenderer.invoke("relay:desktop-state"),
  saveConfig: (config) => ipcRenderer.invoke("relay:save-config", config),
  toggleLocalServer: () => ipcRenderer.invoke("relay:toggle-local-server"),
  toggleLocalRunner: () => ipcRenderer.invoke("relay:toggle-local-runner"),
  pickFolder: () => ipcRenderer.invoke("relay:pick-folder"),
  listSessions: (filter) => ipcRenderer.invoke("relay:list-sessions", filter),
  createSession: (sessionId, options) => ipcRenderer.invoke("relay:create-session", sessionId, options),
  updateSession: (sessionId, patch) => ipcRenderer.invoke("relay:update-session", sessionId, patch),
  forkSession: (sessionId, input) => ipcRenderer.invoke("relay:fork-session", sessionId, input),
  exportSession: (sessionId, format = "markdown") => ipcRenderer.invoke("relay:export-session", sessionId, format),
  getMetrics: () => ipcRenderer.invoke("relay:get-metrics"),
  getCageStatus: () => ipcRenderer.invoke("relay:get-cage-status"),
  getSession: (sessionId) => ipcRenderer.invoke("relay:get-session", sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke("relay:delete-session", sessionId),
  compactSessions: (keep) => ipcRenderer.invoke("relay:compact-sessions", keep),
  startRun: (sessionId, input) => ipcRenderer.invoke("relay:start-run", sessionId, input),
  getRunTranscript: (sessionId, runId, cursor = 0, maxBytes) => ipcRenderer.invoke("relay:get-transcript", sessionId, runId, cursor, maxBytes),
  cancelRun: (sessionId, input) => ipcRenderer.invoke("relay:cancel-run", sessionId, input),
  respondApproval: (sessionId, input) => ipcRenderer.invoke("relay:respond-approval", sessionId, input),
  disconnect: (sessionId) => ipcRenderer.invoke("relay:disconnect", sessionId),
  reconnect: (sessionId) => ipcRenderer.invoke("relay:reconnect", sessionId),
  resume: (sessionId, cursor = 0) => ipcRenderer.invoke("relay:resume", sessionId, cursor),
  enrollDevice: (input) => ipcRenderer.invoke("relay:enroll-device", input),
  listDevices: () => ipcRenderer.invoke("relay:list-devices"),
  revokeDevice: (deviceId) => ipcRenderer.invoke("relay:revoke-device", deviceId),
  createPairingCode: (input) => ipcRenderer.invoke("relay:create-pairing-code", input),
  redeemPairingCode: (code) => ipcRenderer.invoke("relay:redeem-pairing-code", code),
  subscribeSession: (sessionId, cursor = 0) => ipcRenderer.invoke("relay:subscribe-session", sessionId, cursor),
  unsubscribeSession: () => ipcRenderer.invoke("relay:unsubscribe-session"),
  onSessionEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("relay:session-event", wrapped);
    return () => ipcRenderer.removeListener("relay:session-event", wrapped);
  },
  openExternal: (url) => ipcRenderer.invoke("relay:open-external", url),
}));
