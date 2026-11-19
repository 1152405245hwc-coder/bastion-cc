import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSdkProviderAdapter, ClaudeCliProviderAdapter, MockProviderAdapter, UnconfiguredProviderAdapter, createProviderAdapterFromEnvironment } from "../../server/adapters/src/index.ts";

test("mock provider emits bounded, deterministic lifecycle events", async () => {
  const events = [];
  for await (const event of new MockProviderAdapter().execute({ runId: "run-1", prompt: "hello" })) events.push(event);
  assert.deepEqual(events, [
    { type: "started", runId: "run-1" },
    { type: "output", runId: "run-1", text: "[mock:5 chars]" },
    { type: "completed", runId: "run-1" },
  ]);
});

test("unconfigured provider fails visibly instead of pretending to run", async () => {
  await assert.rejects(async () => {
    for await (const _event of new UnconfiguredProviderAdapter().execute({ runId: "run-1", prompt: "hello" })) {
      void _event;
    }
  }, /No provider adapter is configured/);
});

test("Claude SDK adapter maps output and never emits token-shaped data", async () => {
  const tokenLike = ["sk", "ant", "secret-value"].join("-");
  const adapter = new ClaudeAgentSdkProviderAdapter({
    loadSdk: async () => ({
      async *query() {
        yield { type: "assistant", message: { content: [{ type: "text", text: `hello ${tokenLike}` }] } };
      },
    }),
  });
  const events = [];
  for await (const event of adapter.execute({ runId: "run-2", prompt: "hello" })) events.push(event);
  assert.deepEqual(events, [
    { type: "started", runId: "run-2" },
    { type: "output", runId: "run-2", text: "hello [redacted-token]" },
    { type: "completed", runId: "run-2" },
  ]);
});

test("environment selection is explicit and does not load an SDK by default", () => {
  assert.equal(createProviderAdapterFromEnvironment({}).name, "unconfigured");
  assert.equal(createProviderAdapterFromEnvironment({ CCRF_PROVIDER: "mock" }).name, "mock");
  assert.equal(createProviderAdapterFromEnvironment({ CCRF_PROVIDER: "claude-cli" }).name, "claude-cli");
});

test("Claude CLI adapter parses stream-json events, redacts secrets, and builds expected argv", async () => {
  const seenArgs: string[][] = [];
  const tokenLike = ["sk", "ant", "secret-cli"].join("-");
  const adapter = new ClaudeCliProviderAdapter({
    executable: "claude-stub",
    extraArgs: ["--permission-mode", "default"],
    spawnImpl: async function* (_exe, args) {
      seenArgs.push([...args]);
      yield JSON.stringify({ type: "system", subtype: "init" });
      yield JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "chunk-1 " } });
      yield JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `key=${tokenLike}` }] } });
    },
  });
  const events = [];
  for await (const event of adapter.execute({ runId: "run-cli-1", prompt: "inspect repo" })) events.push(event);
  assert.deepEqual(seenArgs, [["-p", "inspect repo", "--output-format", "stream-json", "--verbose", "--permission-mode", "default"]]);
  assert.deepEqual(events, [
    { type: "started", runId: "run-cli-1" },
    { type: "output", runId: "run-cli-1", text: "chunk-1 " },
    { type: "output", runId: "run-cli-1", text: "key=[redacted-token]" },
    { type: "completed", runId: "run-cli-1" },
  ]);
});

test("Claude CLI adapter emits session/cache telemetry, supports --resume, and isolates account profiles", async () => {
  const seenCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv | undefined }> = [];
  const adapter = new ClaudeCliProviderAdapter({
    executable: "claude-stub",
    accountsRoot: "/srv/ccrf/accounts",
    spawnImpl: async function* (_exe, args, opts) {
      seenCalls.push({ args: [...args], env: opts.env });
      yield JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-01" });
      yield JSON.stringify({
        type: "result",
        session_id: "claude-sess-01",
        result: "cached reply",
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 0,
        },
      });
    },
  });

  const events = [];
  for await (const event of adapter.execute({
    runId: "run-cli-2",
    prompt: "continue task",
    resumeSessionId: "claude-sess-01",
    accountProfile: "pro-1",
  })) {
    events.push(event);
  }

  assert.deepEqual(seenCalls[0]!.args, [
    "-p",
    "continue task",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    "claude-sess-01",
  ]);
  assert.equal(seenCalls[0]!.env?.CLAUDE_CONFIG_DIR, "/srv/ccrf/accounts/pro-1");
  assert.equal(seenCalls[0]!.env?.TZ, "America/Los_Angeles");
  assert.deepEqual(events, [
    { type: "started", runId: "run-cli-2" },
    { type: "telemetry", runId: "run-cli-2", providerSessionId: "claude-sess-01" },
    {
      type: "telemetry",
      runId: "run-cli-2",
      providerSessionId: "claude-sess-01",
      cumulative: true,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
      },
    },
    { type: "output", runId: "run-cli-2", text: "cached reply" },
    { type: "completed", runId: "run-cli-2" },
  ]);

  await assert.rejects(async () => {
    for await (const _event of adapter.execute({ runId: "run-bad", prompt: "x", accountProfile: "../escape" })) {
      void _event;
    }
  }, /Invalid account profile/);
});

test("Claude CLI adapter maps approvalMode to --permission-mode and drains heavy stderr without deadlock", async () => {
  const seenArgs: string[][] = [];
  const adapterWithMockSpawn = new ClaudeCliProviderAdapter({
    executable: "claude-stub",
    spawnImpl: async function* (_exe, args) {
      seenArgs.push([...args]);
      yield JSON.stringify({ type: "result", result: "ok" });
    },
  });

  for await (const _event of adapterWithMockSpawn.execute({ runId: "run-plan", prompt: "p", approvalMode: "plan-only" })) {
    void _event;
  }
  for await (const _event of adapterWithMockSpawn.execute({ runId: "run-edit", prompt: "e", approvalMode: "auto-edit" })) {
    void _event;
  }
  assert.ok(seenArgs[0]!.includes("--permission-mode") && seenArgs[0]!.includes("plan"));
  assert.ok(seenArgs[1]!.includes("--permission-mode") && seenArgs[1]!.includes("acceptEdits"));

  const dir = mkdtempSync(join(tmpdir(), "ccrf-cli-stub-"));
  try {
    const stubPath = join(dir, "claude-fake.mjs");
    writeFileSync(
      stubPath,
      [
        `#!${process.execPath}`,
        "if (process.argv.includes('sleep')) {",
        "  process.stdout.write(JSON.stringify({ type: 'content_block_delta', delta: { text: 'waiting' } }) + '\\n');",
        "  setInterval(() => {}, 1000);",
        "} else {",
        "  process.stderr.write('e'.repeat(131072));",
        "  process.stdout.write(JSON.stringify({ type: 'result', result: 'drained-ok' }) + '\\n');",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(stubPath, 0o700);

    const realAdapter = new ClaudeCliProviderAdapter({ executable: stubPath });
    const drainedEvents = [];
    for await (const event of realAdapter.execute({ runId: "run-stderr", prompt: "drain" })) {
      drainedEvents.push(event);
    }
    assert.deepEqual(drainedEvents, [
      { type: "started", runId: "run-stderr" },
      { type: "output", runId: "run-stderr", text: "drained-ok" },
      { type: "completed", runId: "run-stderr" },
    ]);

    const abortController = new AbortController();
    const cancelPromise = (async () => {
      for await (const event of realAdapter.execute({
        runId: "run-sleep",
        prompt: "sleep",
        signal: abortController.signal,
      })) {
        if (event.type === "output") {
          abortController.abort();
        }
      }
    })();
    await assert.rejects(cancelPromise, /Provider execution was cancelled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
