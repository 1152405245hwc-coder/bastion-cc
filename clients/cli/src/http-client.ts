export interface HttpCliClientOptions {
  baseUrl: string;
  authToken?: string | undefined;
  totp?: string | undefined;
  fetchImpl?: ((input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>) | undefined;
}

export class CliTransportError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CliTransportError";
    this.status = status;
    this.code = code;
  }
}

/** Thin network client. It only returns metadata and never logs request bodies. */
export class HttpCliClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly totp: string | undefined;
  private readonly fetchImpl: NonNullable<HttpCliClientOptions["fetchImpl"]>;

  constructor(options: HttpCliClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("baseUrl must use http or https");
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.authToken = options.authToken;
    this.totp = options.totp;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as NonNullable<HttpCliClientOptions["fetchImpl"]>);
    if (!this.fetchImpl) throw new Error("fetch is unavailable");
  }

  async listSessions(filter: { query?: string; project?: string } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (filter.query) params.set("q", filter.query);
    if (filter.project) params.set("project", filter.project);
    const qs = params.toString();
    return this.request("GET", qs ? `/v1/sessions?${qs}` : "/v1/sessions");
  }

  async createSession(
    sessionId: string,
    options: { title?: string; project?: string; approvalMode?: string; reasoningEffort?: string; accountProfile?: string } = {},
  ): Promise<unknown> {
    return this.request("POST", "/v1/sessions/create", { sessionId, ...options });
  }

  async updateSession(
    sessionId: string,
    patch: { title?: string; project?: string; approvalMode?: string; reasoningEffort?: string; accountProfile?: string },
  ): Promise<unknown> {
    return this.request("PATCH", `/v1/sessions/${encodeURIComponent(sessionId)}`, patch);
  }

  async forkSession(
    sessionId: string,
    input: { newSessionId: string; title?: string; project?: string },
  ): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/fork`, input);
  }

  async exportSession(sessionId: string, format: "json" | "markdown" = "json"): Promise<unknown> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`);
  }

  async getMetrics(): Promise<unknown> {
    return this.request("GET", "/v1/metrics");
  }

  async getCageStatus(): Promise<unknown> {
    return this.request("GET", "/v1/cage/status");
  }

  async getSession(sessionId: string): Promise<unknown> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async deleteSession(sessionId: string): Promise<unknown> {
    return this.request("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async compactSessions(keepLatestRunsPerSession = 5): Promise<unknown> {
    return this.request("POST", "/v1/sessions/compact", { keepLatestRunsPerSession });
  }

  async startRun(
    sessionId: string,
    input: {
      requestId: string;
      generation: number;
      idempotencyKey: string;
      prompt: string;
      runId?: string;
      execute?: boolean;
      approvalMode?: string;
      reasoningEffort?: string;
    },
  ): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs`, input);
  }

  async getRunTranscript(sessionId: string, runId: string, cursor = 0, maxBytes?: number): Promise<unknown> {
    const query = maxBytes === undefined ? `cursor=${cursor}` : `cursor=${cursor}&maxBytes=${maxBytes}`;
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}?${query}`);
  }

  async cancelRun(sessionId: string, input: { runId: string; leaseId: string }): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/cancel`, input);
  }

  async respondApproval(sessionId: string, input: { runId: string; leaseId: string; approved: boolean }): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/approve`, input);
  }

  async disconnect(sessionId: string): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/disconnect`);
  }

  async reconnect(sessionId: string): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/reconnect`);
  }

  async resume(sessionId: string, cursor = 0): Promise<unknown> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/events?cursor=${cursor}`);
  }

  async leaseNextRun(input: { runnerId: string; leaseId: string; ttlMs?: number; sessionId?: string }): Promise<unknown> {
    return this.request("POST", "/v1/runners/lease", input);
  }

  async markRunning(sessionId: string, input: { runId: string; leaseId: string }): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/start-running`, input);
  }

  async heartbeatRun(sessionId: string, input: { runId: string; leaseId: string; ttlMs?: number }): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/heartbeat`, input);
  }

  async appendRunOutput(sessionId: string, input: { runId: string; leaseId: string; text: string }): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/output`, input);
  }

  async requestApproval(sessionId: string, input: { runId: string; leaseId: string; reason: string }): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/request-approval`, input);
  }

  async completeRun(sessionId: string, input: { runId: string; leaseId: string; status: "completed" | "failed" | "unknown" }): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/runs/complete`, input);
  }

  async enrollDevice(input: { deviceId: string; label: string; scopes: readonly ("control" | "read" | "runner")[]; ttlMs?: number }): Promise<unknown> {
    return this.request("POST", "/v1/devices/enroll", input);
  }

  async listDevices(): Promise<unknown> {
    return this.request("GET", "/v1/devices");
  }

  async revokeDevice(deviceId: string): Promise<unknown> {
    return this.request("POST", "/v1/devices/revoke", { deviceId });
  }

  async createPairingCode(input: { deviceId: string; label: string; scopes: readonly ("control" | "read" | "runner")[]; ttlMs?: number }): Promise<unknown> {
    return this.request("POST", "/v1/devices/pair-code", input);
  }

  async redeemPairingCode(code: string): Promise<unknown> {
    return this.request("POST", "/v1/devices/redeem-pair", { code });
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    if (this.totp) headers["x-ccrf-totp"] = this.totp;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.status || response.status < 200 || response.status >= 300 || payload?.ok === false) {
      throw new CliTransportError(response.status, payload?.error?.code ?? "HTTP_ERROR", payload?.error?.message ?? "Request failed");
    }
    return payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
  }
}
