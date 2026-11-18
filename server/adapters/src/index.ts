import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ProtocolError } from "../../../core/protocol/src/index.ts";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ProviderRequest {
  runId: string;
  prompt: string;
  signal?: AbortSignal;
  resumeSessionId?: string | undefined;
  accountProfile?: string | undefined;
  cwd?: string | undefined;
}

export type ProviderEvent =
  | { type: "started"; runId: string }
  | { type: "output"; runId: string; text: string }
  | { type: "telemetry"; runId: string; providerSessionId?: string; usage?: ProviderUsage; cumulative?: boolean }
  | { type: "completed"; runId: string };

export interface ProviderAdapter {
  readonly name: string;
  execute(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export interface ClaudeAgentSdkModule {
  query(input: { prompt: string; options?: { signal?: AbortSignal } }): AsyncIterable<unknown>;
}

export type ProviderAdapterOptions = {
  /** Dependency injection seam for tests; production uses a dynamic import. */
  loadSdk?: () => Promise<ClaudeAgentSdkModule>;
};

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

function providerFailure(message: string): ProtocolError {
  // Provider details are deliberately omitted: SDK errors can contain prompts,
  // account identifiers, or credentials.
  return new ProtocolError("UNKNOWN", message);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[redacted]")
    .replace(/\b(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\s*[:=]\s*[^\s,]+/gi, (match) => `${match.slice(0, match.search(/[:=]/))}: [redacted]`);
}

function extractUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const keys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  if (!keys.some((key) => typeof candidate[key] === "number" && Number.isFinite(candidate[key]))) {
    return undefined;
  }
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    inputTokens: num(candidate.input_tokens),
    outputTokens: num(candidate.output_tokens),
    cacheReadInputTokens: num(candidate.cache_read_input_tokens),
    cacheCreationInputTokens: num(candidate.cache_creation_input_tokens),
  };
}

function extractTelemetry(message: unknown): { providerSessionId?: string; usage?: ProviderUsage; cumulative?: boolean } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { type?: unknown; session_id?: unknown; usage?: unknown; message?: unknown };
  const providerSessionId = typeof candidate.session_id === "string" && candidate.session_id
    ? candidate.session_id
    : undefined;
  const topUsage = extractUsage(candidate.usage);
  const nestedUsage = candidate.message && typeof candidate.message === "object"
    ? extractUsage((candidate.message as { usage?: unknown }).usage)
    : undefined;
  const usage = topUsage ?? nestedUsage;
  if (!providerSessionId && !usage) return undefined;
  const cumulative = usage !== undefined && (candidate.type === "result" || Boolean(topUsage));
  return {
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(usage ? { usage, cumulative } : {}),
  };
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const candidate = message as {
    type?: unknown;
    result?: unknown;
    message?: unknown;
    content?: unknown;
    delta?: unknown;
    event?: unknown;
  };
  if (typeof candidate.result === "string") return candidate.result;
  if (candidate.type === "content_block_delta" && candidate.delta && typeof candidate.delta === "object") {
    const text = (candidate.delta as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (candidate.event && typeof candidate.event === "object") {
    const nested = messageText(candidate.event);
    if (nested) return nested;
  }
  const content = candidate.content ?? (candidate.message && typeof candidate.message === "object" ? (candidate.message as { content?: unknown }).content : undefined);
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
  }
  return "";
}

/** Optional real provider adapter. The SDK is never a bundled dependency. */
export class ClaudeAgentSdkProviderAdapter implements ProviderAdapter {
  readonly name = "claude-agent-sdk";
  private readonly loadSdk: () => Promise<ClaudeAgentSdkModule>;

  constructor(options: ProviderAdapterOptions = {}) {
    this.loadSdk = options.loadSdk ?? (async () => {
      const loaded = await import(SDK_PACKAGE) as unknown as ClaudeAgentSdkModule;
      if (!loaded || typeof loaded.query !== "function") throw providerFailure("Claude Agent SDK is unavailable");
      return loaded;
    });
  }

  async *execute(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (request.signal?.aborted) throw providerFailure("Provider execution was cancelled");
    let sdk: ClaudeAgentSdkModule;
    try { sdk = await this.loadSdk(); } catch { throw providerFailure("Claude Agent SDK is unavailable"); }
    yield { type: "started", runId: request.runId };
    try {
      const input = request.signal ? { prompt: request.prompt, options: { signal: request.signal } } : { prompt: request.prompt };
      for await (const message of sdk.query(input)) {
        if (request.signal?.aborted) throw providerFailure("Provider execution was cancelled");
        const text = redactSensitiveText(messageText(message));
        if (text) yield { type: "output", runId: request.runId, text };
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw providerFailure("Provider execution failed");
    }
    yield { type: "completed", runId: request.runId };
  }
}

export interface ClaudeCliOptions {
  executable?: string;
  extraArgs?: readonly string[];
  cwd?: string;
  accountsRoot?: string | undefined;
  spawnImpl?: (
    executable: string,
    args: readonly string[],
    options: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
  ) => AsyncIterable<string>;
}

async function* defaultSpawnLines(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): AsyncIterable<string> {
  const child = spawn(executable, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.env ? { env: options.env } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once("error", (err) => reject(err));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Claude CLI exited with ${code ?? signal ?? "error"}`));
    });
  });
  try {
    for await (const line of rl) {
      if (line.trim()) yield line;
    }
    await exitPromise;
  } finally {
    rl.close();
    if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
  }
}

/** Headless CLI provider adapter using an existing `claude` OAuth login. */
export class ClaudeCliProviderAdapter implements ProviderAdapter {
  readonly name = "claude-cli";
  private readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly cwd: string | undefined;
  private readonly accountsRoot: string | undefined;
  private readonly spawnImpl: NonNullable<ClaudeCliOptions["spawnImpl"]>;

  constructor(options: ClaudeCliOptions = {}) {
    this.executable = options.executable ?? process.env.CCRF_CLAUDE_BIN ?? "claude";
    this.extraArgs = options.extraArgs ?? [];
    this.cwd = options.cwd;
    this.accountsRoot = options.accountsRoot ?? process.env.CCRF_ACCOUNTS_ROOT;
    this.spawnImpl = options.spawnImpl ?? defaultSpawnLines;
  }

  async *execute(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (request.signal?.aborted) throw providerFailure("Provider execution was cancelled");
    if (request.accountProfile && !/^[A-Za-z0-9._-]+$/.test(request.accountProfile)) {
      throw providerFailure("Invalid account profile");
    }
    yield { type: "started", runId: request.runId };
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(request.resumeSessionId ? ["--resume", request.resumeSessionId] : []),
      ...this.extraArgs,
    ];
    const effectiveCwd = request.cwd ?? this.cwd;
    const isolatedEnv = request.accountProfile && this.accountsRoot
      ? {
          ...process.env,
          CLAUDE_CONFIG_DIR: join(this.accountsRoot, request.accountProfile),
          TZ: "America/Los_Angeles",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
        }
      : undefined;
    const spawnOptions: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(isolatedEnv !== undefined ? { env: isolatedEnv } : {}),
    };
    try {
      for await (const rawLine of this.spawnImpl(this.executable, args, spawnOptions)) {
        if (request.signal?.aborted) throw providerFailure("Provider execution was cancelled");
        let extracted: string;
        try {
          const parsed = JSON.parse(rawLine);
          const telemetry = extractTelemetry(parsed);
          if (telemetry) yield { type: "telemetry", runId: request.runId, ...telemetry };
          extracted = messageText(parsed);
        } catch {
          extracted = rawLine;
        }
        const text = redactSensitiveText(extracted);
        if (text) yield { type: "output", runId: request.runId, text };
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw providerFailure("Claude CLI execution failed");
    }
    yield { type: "completed", runId: request.runId };
  }
}

export function createProviderAdapterFromEnvironment(env: NodeJS.ProcessEnv = process.env): ProviderAdapter {
  const provider = env.CCRF_PROVIDER?.trim().toLowerCase();
  if (provider === "claude-cli") {
    return new ClaudeCliProviderAdapter({ ...(env.CCRF_CLAUDE_BIN ? { executable: env.CCRF_CLAUDE_BIN } : {}) });
  }
  if (provider === "claude-agent-sdk") return new ClaudeAgentSdkProviderAdapter();
  if (provider === "mock") return new MockProviderAdapter();
  return new UnconfiguredProviderAdapter();
}

/** Deterministic adapter for local development and recovery tests. */
export class MockProviderAdapter implements ProviderAdapter {
  readonly name = "mock";

  async *execute(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (request.signal?.aborted) throw new ProtocolError("UNKNOWN", "Provider execution was cancelled");
    yield { type: "started", runId: request.runId };
    yield { type: "output", runId: request.runId, text: `[mock:${request.prompt.length} chars]` };
    if (request.signal?.aborted) throw new ProtocolError("UNKNOWN", "Provider execution was cancelled");
    yield { type: "completed", runId: request.runId };
  }
}

/** Explicit boundary for a future Claude/Agent SDK integration. */
export class UnconfiguredProviderAdapter implements ProviderAdapter {
  readonly name = "unconfigured";

  async *execute(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
    throw new ProtocolError("UNKNOWN", "No provider adapter is configured");
  }
}
