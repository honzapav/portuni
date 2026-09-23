// Tests for the Claude adapter (apps/server/domain/runner/adapters/claude.ts,
// runner batch #324) against an injected fake `query` function -- the
// container has no logged-in `claude` CLI, so this exercises every
// translation rule and the permission round trip without a real SDK call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { isProcessAlive } from "../apps/server/domain/runner/process-liveness.js";
import {
  buildEnv,
  categorizeTool,
  consumeSendUuids,
  createClaudeAdapter,
  resolveClaudeExecutable,
  toolTitle,
  waitForPidDeadOrTimeout,
  type CreateClaudeAdapterDeps,
} from "../apps/server/domain/runner/adapters/claude.js";
import { isRunEndedError } from "../apps/server/domain/runner/types.js";
import type { CanonicalEvent, DeltaFrame, RunStart } from "../apps/server/domain/runner/types.js";
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

function makeRunStart(overrides: Partial<RunStart> = {}): RunStart {
  return {
    sessionId: "S1",
    runId: "R1",
    cwd: "/tmp",
    brief: "Fix the bug",
    resume: null,
    orientation: "orientation text",
    instance: { id: null, env: {} },
    mcp: { url: "http://localhost:4011/mcp", token: "tok", homeNodeId: "N1", headers: { "X-Portuni-Spawn-Id": "S1" } },
    policy: "default",
    portuniRoot: "/tmp",
    mirrors: ["/tmp"],
    model: null,
    effort: null,
    ...overrides,
  };
}

// A fake `query()`: yields the given script as an async generator and
// captures the `options` object so tests can invoke `canUseTool` directly
// (the real SDK invokes it internally when a tool call needs a decision;
// nothing in this fake simulates that plumbing, so tests call it themselves).
// `hold: true` keeps the iterator open after the script (the run stays
// live, as it is while a real turn is in flight) until `release()` is
// called -- canUseTool only means something on a live run.
// `collectPrompt: true` additionally drains the prompt stream the way the
// real CLI does, so a test can see the SDKUserMessages the adapter pushed
// (#490: their uuids are what a result echoes back), and `inject()` feeds a
// message into the live iterator after the script -- the only way to get a
// result AFTER a send, which is what a queued message needs.
function makeFakeQuery(
  script: readonly SDKMessage[],
  opts: {
    hold?: boolean;
    collectPrompt?: boolean;
    supportedModels?: () => ReturnType<Query["supportedModels"]>;
    mcpServerStatus?: () => ReturnType<Query["mcpServerStatus"]>;
    // What the CLI does on a Stop besides ending the turn (#493: it
    // cancels the pending permission request, aborting canUseTool's signal).
    onInterrupt?: () => void;
  } = {},
) {
  let capturedOptions: Options | undefined;
  const interruptCalls: number[] = [];
  const setModelCalls: (string | undefined)[] = [];
  const toggleCalls: [string, boolean][] = [];
  const sent: SDKUserMessage[] = [];
  const sentWaiters: { n: number; resolve: () => void }[] = [];
  const inbox: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let released = false;
  const wakeGen = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const release = (): void => {
    released = true;
    wakeGen();
  };
  const fakeQuery = ((_params: { prompt: unknown; options?: Options }) => {
    capturedOptions = _params.options;
    if (opts.collectPrompt) {
      void (async () => {
        for await (const m of _params.prompt as AsyncIterable<SDKUserMessage>) {
          sent.push(m);
          for (let i = sentWaiters.length - 1; i >= 0; i--) {
            if (sentWaiters[i].n <= sent.length) sentWaiters.splice(i, 1)[0].resolve();
          }
        }
      })();
    }
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const msg of script) yield msg;
      if (!opts.hold) return;
      for (;;) {
        while (inbox.length > 0) yield inbox.shift() as SDKMessage;
        if (released) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    const iterator = gen() as unknown as Query;
    (iterator as unknown as { interrupt: () => Promise<undefined> }).interrupt = async () => {
      interruptCalls.push(1);
      opts.onInterrupt?.();
      return undefined;
    };
    (iterator as unknown as { setModel: (model?: string) => Promise<undefined> }).setModel = async (
      model?: string,
    ) => {
      setModelCalls.push(model);
      return undefined;
    };
    (iterator as unknown as { supportedModels: Query["supportedModels"] }).supportedModels =
      opts.supportedModels ?? (async () => []);
    (iterator as unknown as { mcpServerStatus: Query["mcpServerStatus"] }).mcpServerStatus =
      opts.mcpServerStatus ?? (async () => []);
    (iterator as unknown as { toggleMcpServer: Query["toggleMcpServer"] }).toggleMcpServer = async (
      name: string,
      enabled: boolean,
    ) => {
      toggleCalls.push([name, enabled]);
    };
    return iterator;
  }) as CreateClaudeAdapterDeps["query"];
  return {
    query: fakeQuery,
    options: () => capturedOptions,
    interruptCalls,
    setModelCalls,
    toggleCalls,
    release: () => release(),
    sent,
    // Resolves once the adapter has pushed at least `n` messages into the
    // prompt stream -- the stream's own signal, never a timer.
    waitForSent: (n: number): Promise<void> =>
      sent.length >= n ? Promise.resolve() : new Promise<void>((resolve) => sentWaiters.push({ n, resolve })),
    inject: (msg: SDKMessage): void => {
      inbox.push(msg);
      wakeGen();
    },
  };
}

// Flushes the microtask queue so a fire-and-forget `.then()` (models()'s
// own cache-fill after start()) has had a chance to run before a test
// asserts on it.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const FAKE_CLAUDE = "/fake/bin/claude";
const resolveFake = async () => FAKE_CLAUDE;

function fakeExec(
  responses: Record<string, { err?: Error; stdout?: string }>,
  seen: string[] = [],
): CreateClaudeAdapterDeps["exec"] {
  return ((cmd: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    seen.push(cmd);
    const key = args.join(" ");
    const r = responses[key] ?? { err: new Error("unexpected args") };
    cb(r.err ?? null, r.stdout ?? "");
  }) as unknown as CreateClaudeAdapterDeps["exec"];
}

describe("categorizeTool / toolTitle", () => {
  it("categorizes built-in tools", () => {
    assert.equal(categorizeTool("Bash"), "command");
    assert.equal(categorizeTool("Read"), "file_read");
    assert.equal(categorizeTool("Grep"), "file_read");
    assert.equal(categorizeTool("Edit"), "file_change");
    assert.equal(categorizeTool("Write"), "file_change");
    assert.equal(categorizeTool("mcp__portuni__portuni_get_node"), "mcp");
    assert.equal(categorizeTool("SomethingElse"), "other");
  });

  it("titles with the tool name and the first line of its primary argument", () => {
    assert.equal(toolTitle("Bash", { command: "ls -la\nmore" }), "Bash: ls -la");
    assert.equal(toolTitle("Read", { file_path: "/a/b.md" }), "Read: /a/b.md");
    assert.equal(toolTitle("Unknown", {}), "Unknown");
  });
});

describe("Claude adapter: message translation", () => {
  it("system/init sets agentSessionId without emitting a canonical event", async () => {
    const script: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "1.0.0",
        cwd: "/tmp",
        tools: [],
        mcp_servers: [],
        model: "claude",
        permissionMode: "default",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        uuid: "u1",
        session_id: "agent-sess-1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    assert.equal(handle.agentSessionId(), "agent-sess-1");
    assert.equal(events.filter((e) => !("kind" in e && e.kind === "run_ended")).length, 0);
  });

  it("translates assistant text and tool_use blocks, then the matching tool_result", async () => {
    const script: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let's look" },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la" } },
          ],
        },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false, content: "file1\nfile2" }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();

    const kinds = events.map((e) => ("kind" in e ? e.kind : e.type));
    // v2: every assistant message is followed by its context_usage.
    assert.deepEqual(kinds, ["assistant_message", "tool_call", "context_usage", "tool_call", "run_ended"]);
    const started = events[1] as Extract<CanonicalEvent, { kind: "tool_call" }>;
    assert.equal(started.payload.status, "started");
    assert.equal(started.payload.category, "command");
    assert.equal(started.payload.title, "Bash: ls -la");
    const completed = events[3] as Extract<CanonicalEvent, { kind: "tool_call" }>;
    assert.equal(completed.payload.status, "completed");
    assert.equal(completed.payload.output_excerpt, "file1\nfile2");
    const ended = events[4] as Extract<CanonicalEvent, { kind: "run_ended" }>;
    assert.equal(ended.payload.reason, "completed");
  });

  it("translates a thinking block into one reasoning event, batched not per-delta", async () => {
    const script: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Let me consider the options.", signature: "sig1" },
            { type: "text", text: "Here's my answer" },
          ],
        },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();

    const kinds = events.map((e) => ("kind" in e ? e.kind : e.type));
    assert.deepEqual(kinds, ["reasoning", "assistant_message", "context_usage", "run_ended"]);
    const reasoning = events[0] as Extract<CanonicalEvent, { kind: "reasoning" }>;
    assert.equal(reasoning.payload.summary, "Let me consider the options.");
    assert.equal(reasoning.payload.duration_ms, undefined, "no delta streamed, so no duration");
  });

  it("a failed tool_result translates to a failed tool_call and no file_change", async () => {
    const script: SDKMessage[] = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "x.md" } }] },
        parent_tool_use_id: null,
      } as unknown as SDKMessage,
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "boom" }] },
        parent_tool_use_id: null,
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    const kinds = events.map((e) => ("kind" in e ? e.kind : e.type));
    assert.deepEqual(kinds, ["tool_call", "context_usage", "tool_call", "run_ended"]);
    const completed = events[2] as Extract<CanonicalEvent, { kind: "tool_call" }>;
    assert.equal(completed.payload.status, "failed");
  });

  it("a successful Write on a new path emits file_change with op create; an existing path with op edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-claude-adapter-"));
    try {
      const existingPath = join(dir, "existing.md");
      await writeFile(existingPath, "hello", "utf8");
      const newPath = join(dir, "new.md");

      const script: SDKMessage[] = [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu1", name: "Write", input: { file_path: newPath } },
              { type: "tool_use", id: "tu2", name: "Write", input: { file_path: existingPath } },
            ],
          },
          parent_tool_use_id: null,
        } as unknown as SDKMessage,
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu1", is_error: false, content: "ok" },
              { type: "tool_result", tool_use_id: "tu2", is_error: false, content: "ok" },
            ],
          },
          parent_tool_use_id: null,
        } as unknown as SDKMessage,
      ];
      const { query } = makeFakeQuery(script);
      const events: (CanonicalEvent | DeltaFrame)[] = [];
      const adapter = createClaudeAdapter({ query });
      const handle = await adapter.start(makeRunStart({ cwd: dir }), (e) => events.push(e));
      await handle.close();

      const fileChanges = events.filter((e) => "kind" in e && e.kind === "file_change") as Extract<
        CanonicalEvent,
        { kind: "file_change" }
      >[];
      assert.equal(fileChanges.length, 2);
      assert.deepEqual(
        fileChanges.map((f) => [f.payload.path, f.payload.op]).sort(),
        [
          [existingPath, "edit"],
          [newPath, "create"],
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stream_event text deltas become DeltaFrames", async () => {
    const script: SDKMessage[] = [
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    const deltas = events.filter((e) => "type" in e && e.type === "delta") as DeltaFrame[];
    assert.deepEqual(
      deltas.map((d) => d.text),
      ["hel", "lo"],
    );
  });

  it("stream_event thinking deltas become reasoning DeltaFrames, then exactly one reasoning event", async () => {
    const script: SDKMessage[] = [
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "consider this." } },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Let me consider this.", signature: "sig1" },
            { type: "text", text: "Here's my answer" },
          ],
        },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    // The clock advances 1.5 s per read and is read twice: at the first
    // delta (the second one does not re-stamp) and at the batched block.
    let t = 1_000_000;
    const adapter = createClaudeAdapter({ query, now: () => (t += 1_500) });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();

    const deltas = events.filter((e) => "type" in e && e.type === "delta") as DeltaFrame[];
    assert.deepEqual(
      deltas.map((d) => [d.channel, d.text]),
      [
        ["reasoning", "Let me "],
        ["reasoning", "consider this."],
      ],
    );

    const reasoningEvents = events.filter((e) => "kind" in e && e.kind === "reasoning") as Extract<CanonicalEvent, { kind: "reasoning" }>[];
    assert.equal(reasoningEvents.length, 1, "the batched reasoning event must not be duplicated by the deltas");
    assert.equal(reasoningEvents[0].payload.duration_ms, 1_500, "first delta to the batched block");
  });

  it("system/compact_boundary translates to a compaction event", async () => {
    const script: SDKMessage[] = [
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 100 },
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    const compactions = events.filter((e) => "kind" in e && e.kind === "compaction");
    assert.equal(compactions.length, 1);
    assert.deepEqual((compactions[0] as Extract<CanonicalEvent, { kind: "compaction" }>).payload, { trigger: "auto" });
  });

  it("the PreCompact hook emits a compaction event with the real trigger", async () => {
    const { query, options } = makeFakeQuery([]);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const hook = options()?.hooks?.PreCompact?.[0]?.hooks?.[0];
    assert.ok(hook, "PreCompact hook must be registered");
    await hook!(
      { hook_event_name: "PreCompact", trigger: "manual", custom_instructions: null, session_id: "s1", transcript_path: "", cwd: "/tmp" } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    await handle.close();
    const compactions = events.filter((e) => "kind" in e && e.kind === "compaction");
    assert.equal(compactions.length, 1);
    assert.deepEqual((compactions[0] as Extract<CanonicalEvent, { kind: "compaction" }>).payload, { trigger: "manual" });
  });

  // A successful result is the turn-complete signal: the CLI stays alive
  // for the next prompt, so without this event the run reads as "still
  // working" forever. A failed result ends the run instead (below).
  it("a successful result emits turn_ended for the run, a failed one does not", async () => {
    const success: SDKMessage[] = [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        duration_ms: 1,
        duration_api_ms: 1,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    {
      const { query } = makeFakeQuery(success);
      const events: (CanonicalEvent | DeltaFrame)[] = [];
      const handle = await createClaudeAdapter({ query }).start(makeRunStart(), (e) => events.push(e));
      await handle.close();
      const ends = events.filter((e) => "kind" in e && e.kind === "turn_ended");
      assert.equal(ends.length, 1);
      // #490: the run's brief is its first message, and this turn answered
      // it -- one message, the SDK's own one-result-per-turn default.
      assert.deepEqual((ends[0] as Extract<CanonicalEvent, { kind: "turn_ended" }>).payload, {
        run_id: "R1",
        consumed_messages: 1,
      });
    }
    {
      const failed = [{ ...(success[0] as object), is_error: true, result: "Not logged in" }] as unknown as SDKMessage[];
      const { query } = makeFakeQuery(failed);
      const events: (CanonicalEvent | DeltaFrame)[] = [];
      const handle = await createClaudeAdapter({ query }).start(makeRunStart(), (e) => events.push(e));
      await handle.close();
      assert.equal(events.some((e) => "kind" in e && e.kind === "turn_ended"), false);
    }
  });

  // v2 context ring: one context_usage per assistant message and per
  // result; the window is unknown until the first result names it.
  it("emits context_usage after every assistant message and every result; max_tokens is null before the first result", async () => {
    const script: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 },
        },
        parent_tool_use_id: null,
        uuid: "a1",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: null,
        total_cost_usd: 0.05,
        usage: { input_tokens: 150, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: { "claude-opus-5": { contextWindow: 200000, inputTokens: 150, outputTokens: 7 } },
        permission_denials: [],
        duration_ms: 1,
        duration_api_ms: 1,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    const usages = events.filter(
      (e): e is Extract<CanonicalEvent, { kind: "context_usage" }> => "kind" in e && e.kind === "context_usage",
    );
    assert.equal(usages.length, 2);
    assert.deepEqual(usages[0].payload, {
      run_id: "R1",
      model: "claude-opus-5",
      used_tokens: 150,
      max_tokens: null,
      input_tokens: 100,
      cached_tokens: 50,
      output_tokens: 5,
    });
    assert.equal(usages[1].payload.max_tokens, 200000);
    assert.equal(usages[1].payload.used_tokens, 150);
    assert.equal(usages[1].payload.output_tokens, 7);
  });

  // The result's usage is the TURN's sum over every request it made, so a
  // long turn's cache buckets add up past the window; only the window
  // size and the turn's output are read from it.
  it("the result's turn total never becomes the context's content", async () => {
    const script: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "hotovo" }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 161_483, output_tokens: 2 },
        },
        parent_tool_use_id: null,
        uuid: "a1",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 12,
        result: "done",
        stop_reason: null,
        total_cost_usd: 0.5,
        usage: { input_tokens: 14, output_tokens: 7_873, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 992_209 },
        modelUsage: { "claude-sonnet-5": { contextWindow: 1_000_000, inputTokens: 14, outputTokens: 7_873 } },
        permission_denials: [],
        duration_ms: 1,
        duration_api_ms: 1,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await createClaudeAdapter({ query }).start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    const usages = events.filter(
      (e): e is Extract<CanonicalEvent, { kind: "context_usage" }> => "kind" in e && e.kind === "context_usage",
    );
    assert.equal(usages.length, 2);
    assert.deepEqual(usages[1].payload, {
      run_id: "R1",
      model: "claude-sonnet-5",
      used_tokens: 164_485,
      max_tokens: 1_000_000,
      input_tokens: 2,
      cached_tokens: 164_483,
      output_tokens: 7_873,
    });
  });

  // #499: frames with parent_tool_use_id come from a subagent the main
  // agent started; none of them is the thread's reply, activity or context.
  it("a subagent's frames stay out of the transcript, the model and the context ring", async () => {
    const sub = { parent_tool_use_id: "task-1", session_id: "s1" };
    const script: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "tool_use", id: "task-1", name: "Task", input: { description: "prozkoumej", prompt: "..." } }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000, output_tokens: 5 },
        },
        parent_tool_use_id: null,
        uuid: "a1",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "sub hmm" } },
        uuid: "se1",
        ...sub,
      } as unknown as SDKMessage,
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub te" } },
        uuid: "se2",
        ...sub,
      } as unknown as SDKMessage,
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [
            { type: "thinking", thinking: "sub hmm" },
            { type: "text", text: "subagent text" },
            { type: "tool_use", id: "sub-w", name: "Write", input: { file_path: "/tmp/sub.txt", content: "x" } },
          ],
          usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 150_000, output_tokens: 9 },
        },
        uuid: "a2",
        ...sub,
      } as unknown as SDKMessage,
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub-w", content: "ok" }] },
        uuid: "u2",
        ...sub,
      } as unknown as SDKMessage,
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "task-1", content: "hotovo" }] },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "main reply" }],
          usage: { input_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 40_000, output_tokens: 6 },
        },
        parent_tool_use_id: null,
        uuid: "a3",
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        result: "done",
        stop_reason: null,
        total_cost_usd: 0.1,
        usage: { input_tokens: 33, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 230_000 },
        modelUsage: {
          "claude-haiku-4-5": { contextWindow: 200_000, inputTokens: 3, outputTokens: 9 },
          "claude-opus-5": { contextWindow: 1_000_000, inputTokens: 30, outputTokens: 11 },
        },
        permission_denials: [],
        duration_ms: 1,
        duration_api_ms: 1,
        uuid: "r1",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await createClaudeAdapter({ query }).start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    const canonical = events.filter((e): e is CanonicalEvent => "kind" in e);
    const texts = canonical.flatMap((e) => (e.kind === "assistant_message" ? [e.payload.text] : []));
    assert.deepEqual(texts, ["main reply"]);
    assert.equal(canonical.filter((e) => e.kind === "reasoning").length, 0);
    assert.equal(canonical.filter((e) => e.kind === "file_change").length, 0);
    const tools = canonical.flatMap((e) => (e.kind === "tool_call" ? [`${e.payload.tool_use_id}:${e.payload.status}`] : []));
    assert.deepEqual(tools, ["task-1:started", "task-1:completed"]);
    assert.equal(events.filter((e) => !("kind" in e)).length, 0, "no subagent delta reaches the chat");
    const usages = canonical.filter(
      (e): e is Extract<CanonicalEvent, { kind: "context_usage" }> => e.kind === "context_usage",
    );
    assert.deepEqual(
      usages.map((u) => [u.payload.model, u.payload.used_tokens, u.payload.max_tokens]),
      [
        ["claude-opus-5", 40_010, null],
        ["claude-opus-5", 40_120, null],
        ["claude-opus-5", 40_120, 1_000_000],
      ],
    );
  });

  it("a result message's usage/cost folds into the run_ended event", async () => {
    const script: SDKMessage[] = [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: null,
        total_cost_usd: 0.05,
        usage: { input_tokens: 10, output_tokens: 20 },
        modelUsage: {},
        permission_denials: [],
        duration_ms: 1,
        duration_api_ms: 1,
        uuid: "u1",
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeFakeQuery(script);
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    await handle.close();
    const ended = events.find((e) => "kind" in e && e.kind === "run_ended") as Extract<
      CanonicalEvent,
      { kind: "run_ended" }
    >;
    assert.ok(ended);
    assert.deepEqual(ended.payload.usage, {
      usage: { input_tokens: 10, output_tokens: 20 },
      total_cost_usd: 0.05,
    });
  });
});

describe("Claude adapter: a provider limit/error ends the run (#411)", () => {
  // Collects the run's events and exposes a promise that settles on the
  // run_ended -- the run's own signal, so no test here waits a fixed time
  // for the teardown that produces it.
  function collector() {
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    let resolveEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    return {
      events,
      ended,
      sink(e: CanonicalEvent | DeltaFrame): void {
        events.push(e);
        if ("kind" in e && e.kind === "run_ended") resolveEnded();
      },
    };
  }

  function resultMessage(overrides: Record<string, unknown>): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {},
      permission_denials: [],
      duration_ms: 1,
      duration_api_ms: 1,
      uuid: "u1",
      session_id: "s1",
      ...overrides,
    } as unknown as SDKMessage;
  }

  function runEndedEvents(events: (CanonicalEvent | DeltaFrame)[]) {
    return events.filter((e) => "kind" in e && e.kind === "run_ended") as Extract<
      CanonicalEvent,
      { kind: "run_ended" }
    >[];
  }

  it("a spend-limit result (is_error, subtype success) ends the run with reason limit", async () => {
    const script: SDKMessage[] = [
      resultMessage({
        is_error: true,
        result: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      }),
    ];
    // hold: true -- the real CLI stays alive waiting for the next prompt
    // after the failing result, which is exactly what left the run live
    // forever before this fix.
    const { query, release } = makeFakeQuery(script, { hold: true });
    const c = collector();
    const adapter = createClaudeAdapter({
      query,
      closePollIntervalMs: 5,
      closeGraceMs: 10,
      closeTermMs: 10,
      closeTimeoutMs: 10,
    });
    const handle = await adapter.start(makeRunStart(), c.sink);
    await c.ended;

    const errors = c.events.filter((e) => "kind" in e && e.kind === "error") as Extract<
      CanonicalEvent,
      { kind: "error" }
    >[];
    assert.equal(errors.length, 1, "exactly one error event");
    assert.equal(errors[0].payload.class, "provider");
    assert.match(errors[0].payload.message, /spend limit/);

    const ends = runEndedEvents(c.events);
    assert.equal(ends.length, 1, "exactly one run_ended");
    assert.equal(ends[0].payload.reason, "limit");

    // close() resolves rather than waiting out a run that already ended.
    await handle.close();
    release();
  });

  it("an error subtype joins its errors array into the provider message and ends with reason error", async () => {
    const script: SDKMessage[] = [
      resultMessage({ subtype: "error_during_execution", is_error: true, errors: ["a", "b"] }),
    ];
    const { query } = makeFakeQuery(script);
    const c = collector();
    const adapter = createClaudeAdapter({ query, closePollIntervalMs: 5, closeGraceMs: 10, closeTimeoutMs: 10 });
    const handle = await adapter.start(makeRunStart(), c.sink);
    await c.ended;

    const errors = c.events.filter((e) => "kind" in e && e.kind === "error") as Extract<
      CanonicalEvent,
      { kind: "error" }
    >[];
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.class, "provider");
    assert.equal(errors[0].payload.message, "a\nb");

    const ends = runEndedEvents(c.events);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].payload.reason, "error");
    await handle.close();
  });

  it("an iterator that ends on its own after the failing result still emits exactly one run_ended", async () => {
    const script: SDKMessage[] = [
      resultMessage({ is_error: true, result: "You've hit your monthly spend limit" }),
    ];
    const { query, release } = makeFakeQuery(script, { hold: true });
    const c = collector();
    const adapter = createClaudeAdapter({
      query,
      closePollIntervalMs: 5,
      closeGraceMs: 50,
      closeTermMs: 50,
      closeTimeoutMs: 50,
    });
    const handle = await adapter.start(makeRunStart(), c.sink);
    // The SDK ends the iterator itself, racing the teardown the failing
    // result started: both paths lead to a run end, only one may report it.
    release();
    await c.ended;
    await handle.close();
    await flushMicrotasks();

    assert.equal(runEndedEvents(c.events).length, 1, "exactly one run_ended");
    assert.equal(runEndedEvents(c.events)[0].payload.reason, "limit");
    assert.equal(
      c.events.filter((e) => "kind" in e && e.kind === "error").length,
      1,
      "exactly one error event",
    );
  });
});

describe("Claude adapter: Stop (Esc) ends the turn, not the run", () => {
  // A fake whose turn only ends when interrupt() is called, the way the
  // real CLI answers a Stop: a synthetic "[Request interrupted by user]"
  // user message and an error_during_execution result. `release(err)`
  // then ends the prompt stream; the real SDK throws there when the last
  // result was that Stop.
  function interruptibleQuery() {
    let interrupted: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      interrupted = resolve;
    });
    let release: (err?: Error) => void = () => undefined;
    const held = new Promise<Error | undefined>((resolve) => {
      release = resolve;
    });
    const query = ((_params: { prompt: unknown; options?: Options }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await stopped;
        yield {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
          parent_tool_use_id: null,
          session_id: "s1",
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: 0.01,
          usage: { input_tokens: 1, output_tokens: 2 },
          modelUsage: {},
          permission_denials: [],
          duration_ms: 1,
          duration_api_ms: 1,
          uuid: "u1",
          session_id: "s1",
        } as unknown as SDKMessage;
        const err = await held;
        if (err) throw err;
      }
      const iterator = gen() as unknown as Query;
      (iterator as unknown as { interrupt: () => Promise<undefined> }).interrupt = async () => {
        interrupted();
        return undefined;
      };
      return iterator;
    }) as CreateClaudeAdapterDeps["query"];
    return { query, release: (err?: Error) => release(err) };
  }

  function kinds(events: (CanonicalEvent | DeltaFrame)[], kind: string) {
    return events.filter((e) => "kind" in e && e.kind === kind) as CanonicalEvent[];
  }

  it("the Stop's error_during_execution result ends the turn and keeps the run alive", async () => {
    const { query, release } = interruptibleQuery();
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    let turnEnded: () => void = () => undefined;
    const turnEndedP = new Promise<void>((resolve) => {
      turnEnded = resolve;
    });
    let ended: () => void = () => undefined;
    const endedP = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const adapter = createClaudeAdapter({ query, closePollIntervalMs: 5, closeGraceMs: 10, closeTimeoutMs: 10 });
    const handle = await adapter.start(makeRunStart(), (e) => {
      events.push(e);
      if ("kind" in e && e.kind === "turn_ended") turnEnded();
      if ("kind" in e && e.kind === "run_ended") ended();
    });

    await handle.interrupt();
    await turnEndedP;
    await flushMicrotasks();
    assert.equal(kinds(events, "error").length, 0, "a Stop is no error");
    assert.equal(kinds(events, "run_ended").length, 0, "the run outlives the Stop");

    // The prompt stream ends later (Uzavřít, idle): the SDK's throw about
    // the Stop's result is still a graceful close.
    release(new Error("Claude Code returned an error result: [ede_diagnostic] result_type=user"));
    await endedP;
    const ends = kinds(events, "run_ended") as Extract<CanonicalEvent, { kind: "run_ended" }>[];
    assert.equal(ends.length, 1);
    assert.equal(ends[0].payload.reason, "completed");
    assert.equal(kinds(events, "error").length, 0);
    await handle.close();
  });
});

describe("Claude adapter: canUseTool", () => {
  it("a tier-1 write is allowed without a question", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const dir = await mkdtemp(join(tmpdir(), "portuni-claude-adapter-perm-"));
    try {
      const events: (CanonicalEvent | DeltaFrame)[] = [];
      const handle = await adapter.start(
        makeRunStart({ cwd: dir, portuniRoot: dir, mirrors: [dir] }),
        (e) => events.push(e),
      );
      const canUseTool = options()!.canUseTool!;
      const result = (await canUseTool(
        "Edit",
        { file_path: join(dir, "a.md") },
        { requestId: "req-1", signal: new AbortController().signal } as never,
      )) as PermissionResult;
      assert.equal(result.behavior, "allow");
      assert.equal(
        events.filter((e) => !("kind" in e && e.kind === "run_ended")).length,
        0,
        "an allow must not emit a question",
      );
      await handle.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a tier-3 write (outside every mirror) is denied without a question", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(
      makeRunStart({ cwd: "/tmp/mirror-a", portuniRoot: "/tmp", mirrors: ["/tmp/mirror-a"] }),
      (e) => events.push(e),
    );
    const canUseTool = options()!.canUseTool!;
    const result = (await canUseTool(
      "Edit",
      { file_path: "/etc/passwd" },
      { requestId: "req-2", signal: new AbortController().signal } as never,
    )) as PermissionResult;
    assert.equal(result.behavior, "deny");
    assert.equal(events.filter((e) => !("kind" in e && e.kind === "run_ended")).length, 0);
    await handle.close();
  });

  it("an ask (portuni_expand_scope) emits a question and round-trips through answer()", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const canUseTool = options()!.canUseTool!;
    const pending = canUseTool(
      "mcp__portuni__portuni_expand_scope",
      { node_id: "N2" },
      { requestId: "req-3", signal: new AbortController().signal } as never,
    );
    // The question event must be emitted synchronously (before the promise
    // resolves), so the runtime can persist it and set waiting_since.
    await Promise.resolve();
    const question = events.find((e) => "kind" in e && e.kind === "question");
    assert.ok(question, "an ask must emit a question event");

    await handle.answer("req-3", { by: "U1", value: true, at: new Date().toISOString() });
    const result = (await pending) as PermissionResult;
    assert.equal(result.behavior, "allow");
    release();
    await handle.close();
  });

  // #492: the tool reads `answers: { [question text]: answer }`
  // (sdk-tools.d.ts AskUserQuestionInput); an `answer` field is ignored and
  // the model is told the user did not answer.
  it("an AskUserQuestion answer reaches the tool as answers keyed by question text", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const input = { questions: [{ question: "Continue?", header: "Go", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] };
    const pending = options()!.canUseTool!("AskUserQuestion", input, {
      requestId: "req-a",
      signal: new AbortController().signal,
    } as never);
    const question = events.find((e) => "kind" in e && e.kind === "question") as
      | Extract<CanonicalEvent, { kind: "question" }>
      | undefined;
    assert.deepEqual(question?.payload.options, ["Yes", "No"]);
    assert.deepEqual(question?.payload.questions, [{ question: "Continue?", options: ["Yes", "No"], multi_select: false }]);

    await handle.answer("req-a", { by: "U1", value: "Yes", at: new Date().toISOString() });
    const result = (await pending) as { behavior: string; updatedInput: Record<string, unknown> };
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput.answers, { "Continue?": "Yes" });
    assert.equal("answer" in result.updatedInput, false);
    release();
    await handle.close();
  });

  it("a multi-question AskUserQuestion answered with a map passes one answer per question", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    const input = {
      questions: [
        { question: "Which environment?", header: "Env", options: [{ label: "staging" }, { label: "production" }], multiSelect: false },
        { question: "Dry run first?", header: "Mode", options: [{ label: "yes" }, { label: "no" }], multiSelect: false },
      ],
    };
    const pending = options()!.canUseTool!("AskUserQuestion", input, {
      requestId: "req-m",
      signal: new AbortController().signal,
    } as never);
    await handle.answer("req-m", {
      by: "U1",
      value: { "Which environment?": "production", "Dry run first?": "no" },
      at: new Date().toISOString(),
    });
    const result = (await pending) as { behavior: string; updatedInput: Record<string, unknown> };
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput.answers, { "Which environment?": "production", "Dry run first?": "no" });
    assert.deepEqual(result.updatedInput.questions, input.questions);
    release();
    await handle.close();
  });

  it("rejecting an ask denies with the Czech refusal message", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const canUseTool = options()!.canUseTool!;
    const pending = canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] },
      { requestId: "req-4", signal: new AbortController().signal } as never,
    );
    await handle.answer("req-4", { by: "U1", value: false, at: new Date().toISOString() });
    const result = (await pending) as PermissionResult;
    assert.equal(result.behavior, "deny");
    assert.equal((result as { message: string }).message, "Zamítnuto uživatelem.");
    release();
    await handle.close();
  });
});

describe("Claude adapter: MCP elicitation", () => {
  const PORTUNI_CONFIRM = {
    serverName: "portuni",
    message: "Allow writing to project Naturamed Asana Adopce?",
    mode: "form" as const,
    requestedSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", title: "Confirm", description: "Yes, allow it" } },
      required: ["confirm"],
    },
  };

  it("a confirmation dialog becomes an approval question, and Ano accepts it", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const onElicitation = options()!.onElicitation!;
    assert.ok(onElicitation, "the adapter must install onElicitation");
    const pending = onElicitation(PORTUNI_CONFIRM, { signal: new AbortController().signal, requestId: "el-1" });
    await Promise.resolve();
    const question = events.find((e) => "kind" in e && e.kind === "question") as
      | Extract<CanonicalEvent, { kind: "question" }>
      | undefined;
    assert.ok(question, "a dialog must emit a question event");
    assert.equal(question.payload.request_id, "el-1");
    assert.equal(question.payload.type, "approval");
    assert.equal(question.payload.detail, PORTUNI_CONFIRM.message);

    await handle.answer("el-1", { by: "U1", value: true, at: new Date().toISOString() });
    assert.deepEqual(await pending, { action: "accept", content: { confirm: true } });
    release();
    await handle.close();
  });

  it("Ne declines the dialog", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    const pending = options()!.onElicitation!(PORTUNI_CONFIRM, {
      signal: new AbortController().signal,
      requestId: "el-2",
    });
    await handle.answer("el-2", { by: "U1", value: false, at: new Date().toISOString() });
    assert.deepEqual(await pending, { action: "decline" });
    release();
    await handle.close();
  });

  it("a form the chat cannot render is declined without a question", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const result = await options()!.onElicitation!(
      {
        serverName: "other",
        message: "Your name?",
        mode: "form",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      },
      { signal: new AbortController().signal, requestId: "el-3" },
    );
    assert.deepEqual(result, { action: "decline" });
    assert.equal(events.filter((e) => "kind" in e && e.kind === "question").length, 0);
    release();
    await handle.close();
  });

  it("a form with a second field is declined: the chat would grant it unseen", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const result = await options()!.onElicitation!(
      {
        ...PORTUNI_CONFIRM,
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean" }, rememberForever: { type: "boolean" } },
        },
      },
      { signal: new AbortController().signal, requestId: "el-two" },
    );
    assert.deepEqual(result, { action: "decline" });
    assert.equal(events.filter((e) => "kind" in e && e.kind === "question").length, 0);
    release();
    await handle.close();
  });

  // #493: a Stop cancels the turn, and the SDK aborts the signal of the
  // permission request that turn was waiting on. The question must close
  // (a decided question event the runtime reads as "stop waiting") and
  // free the line, so the next turn's question shows at once.
  it("Stop while a permission question is open closes it and the next question shows at once", async () => {
    const aborts: AbortController[] = [];
    const { query, options, release } = makeFakeQuery([], {
      hold: true,
      onInterrupt: () => {
        for (const controller of aborts.splice(0)) controller.abort();
      },
    });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const questions = () =>
      events.filter((e) => "kind" in e && e.kind === "question") as Extract<CanonicalEvent, { kind: "question" }>[];
    const ask = (requestId: string) => {
      const controller = new AbortController();
      aborts.push(controller);
      return options()!.canUseTool!("ExitPlanMode", { plan: "the plan" }, {
        requestId,
        signal: controller.signal,
      } as never);
    };

    const first = ask("perm-stop");
    await flushMicrotasks();
    assert.equal(questions().length, 1);

    await handle.interrupt();
    const result = (await first) as PermissionResult;
    assert.equal(result.behavior, "deny");
    assert.equal(questions().length, 2, "the chat learns the question closed");
    assert.equal(questions()[1].payload.request_id, "perm-stop");
    assert.deepEqual(
      { by: questions()[1].payload.decision?.by, value: questions()[1].payload.decision?.value },
      { by: "system", value: false },
    );
    assert.equal(questions()[1].payload.tool, "ExitPlanMode");

    // The next turn's question is not stuck behind the dead one.
    const second = ask("perm-next");
    await flushMicrotasks();
    assert.equal(questions().length, 3, "the next question is shown at once");
    assert.equal(questions()[2].payload.request_id, "perm-next");
    assert.equal(questions()[2].payload.decision, null);
    await handle.answer("perm-next", { by: "U1", value: true, at: new Date().toISOString() });
    assert.equal(((await second) as PermissionResult).behavior, "allow");

    // A late click on the closed question changes nothing.
    await handle.answer("perm-stop", { by: "U1", value: true, at: new Date().toISOString() });
    assert.equal(questions().length, 3);
    release();
    await handle.close();
  });

  it("a permission ask cancelled while waiting in line is never shown", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const questions = () => events.filter((e) => "kind" in e && e.kind === "question");
    const open = options()!.canUseTool!("ExitPlanMode", { plan: "a" }, {
      requestId: "perm-open",
      signal: new AbortController().signal,
    } as never);
    const controller = new AbortController();
    const queued = options()!.canUseTool!("ExitPlanMode", { plan: "b" }, {
      requestId: "perm-queued",
      signal: controller.signal,
    } as never);
    await flushMicrotasks();
    controller.abort();
    await handle.answer("perm-open", { by: "U1", value: true, at: new Date().toISOString() });
    assert.equal(((await open) as PermissionResult).behavior, "allow");
    assert.equal(((await queued) as PermissionResult).behavior, "deny");
    assert.equal(questions().length, 1, "the cancelled ask never reached the chat");
    release();
    await handle.close();
  });

  it("a dialog raised while a permission question is open waits for its turn", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const questions = () => events.filter((e) => "kind" in e && e.kind === "question");
    const permission = options()!.canUseTool!(
      "ExitPlanMode",
      { plan: "the plan" },
      { requestId: "perm-1", signal: new AbortController().signal } as never,
    );
    const dialog = options()!.onElicitation!(PORTUNI_CONFIRM, {
      signal: new AbortController().signal,
      requestId: "el-queued",
    });
    await flushMicrotasks();
    assert.equal(questions().length, 1, "the dialog must not be shown while the permission question is open");

    await handle.answer("perm-1", { by: "U1", value: true, at: new Date().toISOString() });
    assert.equal(((await permission) as PermissionResult).behavior, "allow");
    await flushMicrotasks();
    assert.equal(questions().length, 2, "the dialog is shown once the first question is answered");
    assert.equal((questions()[1] as Extract<CanonicalEvent, { kind: "question" }>).payload.request_id, "el-queued");

    await handle.answer("el-queued", { by: "U1", value: true, at: new Date().toISOString() });
    assert.deepEqual(await dialog, { action: "accept", content: { confirm: true } });
    release();
    await handle.close();
  });

  it("a dialog the SDK abandons is cancelled and the chat learns the question closed", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const controller = new AbortController();
    const pending = options()!.onElicitation!(PORTUNI_CONFIRM, { signal: controller.signal, requestId: "el-abort" });
    await flushMicrotasks();
    controller.abort();
    assert.deepEqual(await pending, { action: "cancel" });
    const questions = events.filter((e) => "kind" in e && e.kind === "question") as Extract<
      CanonicalEvent,
      { kind: "question" }
    >[];
    assert.equal(questions.length, 2);
    assert.equal(questions[1].payload.request_id, "el-abort");
    assert.equal(questions[1].payload.decision?.value, false);
    // A late click on the closed question changes nothing.
    await handle.answer("el-abort", { by: "U1", value: true, at: new Date().toISOString() });
    release();
    await handle.close();
  });

  it("a dialog still open when the run ends is cancelled, so the server stops waiting", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    const pending = options()!.onElicitation!(PORTUNI_CONFIRM, {
      signal: new AbortController().signal,
      requestId: "el-late",
    });
    await handle.close();
    assert.deepEqual(await pending, { action: "cancel" });
  });
});

describe("Claude adapter: inherited claude.ai Portuni connectors", () => {
  const INIT = {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "1.0.0",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "u1",
    session_id: "agent-sess-1",
  } as unknown as SDKMessage;
  const proxy = (name: string, url: string) =>
    ({ name, status: "connected", scope: "claudeai", config: { type: "claudeai-proxy", url, id: `mcpsrv_${name}` } }) as never;

  it("switches off the claude.ai connectors that point at this Portuni, whatever they are named", async () => {
    const { query, options, toggleCalls } = makeFakeQuery([INIT], {
      mcpServerStatus: async () => [
        { name: "portuni", status: "connected", scope: "dynamic", config: { type: "http", url: "http://127.0.0.1:47011/mcp" } } as never,
        proxy("claude.ai Portuni Tempo", "https://api.portuni.com/mcp"),
        proxy("claude.ai Firemní graf", "https://api.portuni.com/mcp"),
        proxy("claude.ai Asana", "https://mcp.asana.com/v2/mcp"),
        proxy("claude.ai Portuni jinde", "https://portuni.example.org/mcp"),
      ],
    });
    const adapter = createClaudeAdapter({ query, portuniOrigins: () => ["https://api.portuni.com"] });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    await flushMicrotasks();
    assert.deepEqual(toggleCalls, [
      ["claude.ai Portuni Tempo", false],
      ["claude.ai Firemní graf", false],
    ]);
    // The backstop for a call issued before the toggle lands: the tool is
    // refused, and the model is pointed at the run's own server.
    const denied = (await options()!.canUseTool!(
      "mcp__claude_ai_Portuni_Tempo__portuni_get_node",
      { node_id: "N1" },
      { requestId: "req-c", signal: new AbortController().signal } as never,
    )) as PermissionResult;
    assert.equal(denied.behavior, "deny");
    const asana = (await options()!.canUseTool!(
      "mcp__claude_ai_Asana__get_task",
      { task_id: "1" },
      { requestId: "req-d", signal: new AbortController().signal } as never,
    )) as PermissionResult;
    assert.equal(asana.behavior, "allow");
    await handle.close();
  });

  it("without a known Portuni origin nothing is switched off", async () => {
    const { query, toggleCalls } = makeFakeQuery([INIT], {
      mcpServerStatus: async () => [proxy("claude.ai Portuni Tempo", "https://api.portuni.com/mcp")],
    });
    const adapter = createClaudeAdapter({ query, portuniOrigins: () => [] });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    await handle.close();
    await flushMicrotasks();
    assert.deepEqual(toggleCalls, []);
  });
});

describe("Claude adapter: an approval answered with text", () => {
  it("denies: only true allows an approval, text is an answer to an input question alone", async () => {
    const { query, options, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    const pending = options()!.canUseTool!(
      "ExitPlanMode",
      { plan: "the plan" },
      { requestId: "perm-text", signal: new AbortController().signal } as never,
    );
    await handle.answer("perm-text", { by: "U1", value: "Ne", at: new Date().toISOString() });
    const result = (await pending) as PermissionResult;
    assert.equal(result.behavior, "deny");
    release();
    await handle.close();
  });
});

describe("Claude adapter: close() escalation (end stdin, SIGTERM, SIGKILL)", () => {
  // A fake query that spawns a REAL child through the adapter's own
  // spawnClaudeCodeProcess seam (so the pid is captured and the child sits
  // in its own process group, exactly as with the SDK) and whose iterator
  // only finishes once that child has exited -- a CLI that ignores the end
  // of its prompt stream, which is what close() must be able to end.
  function childBackedQuery(command: string, args: string[]) {
    let exitCode: number | null = null;
    const fakeQuery = ((params: { prompt: unknown; options?: Options }) => {
      const spawnSeam = params.options?.spawnClaudeCodeProcess;
      assert.ok(spawnSeam, "the adapter must install spawnClaudeCodeProcess");
      const child = spawnSeam({ command, args, cwd: process.cwd(), env: process.env as Record<string, string> }) as unknown as import("node:child_process").ChildProcess;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>((resolve) => {
          child.once("exit", (code) => {
            exitCode = code;
            resolve();
          });
        });
      }
      const iterator = gen() as unknown as Query;
      (iterator as unknown as { interrupt: () => Promise<undefined> }).interrupt = async () => undefined;
      return iterator;
    }) as CreateClaudeAdapterDeps["query"];
    return { query: fakeQuery, exitCode: () => exitCode };
  }

  it("a child that outlives the end of its prompt stream is SIGTERMed, and close() resolves once it is gone", async () => {
    const { query } = childBackedQuery("sleep", ["30"]);
    const adapter = createClaudeAdapter({ query, closePollIntervalMs: 10, closeGraceMs: 50, closeTermMs: 5_000, closeTimeoutMs: 5_000 });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(makeRunStart(), (e) => events.push(e));
    const pid = handle.pid();
    assert.ok(pid !== null && isProcessAlive(pid), "the child must be running before close()");

    const startedAt = Date.now();
    await handle.close();
    const elapsed = Date.now() - startedAt;
    assert.ok(!isProcessAlive(pid), "the child must be dead after close()");
    assert.ok(elapsed < 3_000, `SIGTERM must have ended it well before the SIGKILL step, took ${elapsed}ms`);
    assert.ok(events.some((e) => "kind" in e && e.kind === "run_ended"), "run_ended must follow the child's exit");
  });

  it("a child that ignores SIGTERM is SIGKILLed after the term window", async () => {
    const { query } = childBackedQuery("sh", ["-c", "trap '' TERM; sleep 30"]);
    const adapter = createClaudeAdapter({ query, closePollIntervalMs: 10, closeGraceMs: 50, closeTermMs: 150, closeTimeoutMs: 5_000 });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    const pid = handle.pid();
    assert.ok(pid !== null);
    // Give the shell a moment to install its trap before we start signalling.
    await new Promise((r) => setTimeout(r, 150));

    const startedAt = Date.now();
    await handle.close();
    const elapsed = Date.now() - startedAt;
    assert.ok(!isProcessAlive(pid), "the child must be dead after SIGKILL");
    assert.ok(elapsed >= 150, `must have waited out the SIGTERM window first, took ${elapsed}ms`);
    assert.ok(elapsed < 3_000, `SIGKILL must have ended it promptly, took ${elapsed}ms`);
  });

  it("a question still open when the run ends is denied, so the SDK-side awaiter settles", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    const canUseTool = options()!.canUseTool!;
    const pending = canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
      { requestId: "req-late", signal: new AbortController().signal } as never,
    );
    // The empty script ends the run on its own; close() just waits for it.
    await handle.close();
    const result = (await pending) as PermissionResult;
    assert.equal(result.behavior, "deny");
  });
});

describe("Claude adapter: env composition", () => {
  it("HOME/PATH/USER/LOGNAME come from process.env; PORTUNI_* and an instance's own HOME/USER/LOGNAME are dropped", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(
      makeRunStart({
        instance: {
          id: "inst-1",
          env: {
            CLAUDE_CONFIG_DIR: "/home/x/.claude-work",
            PORTUNI_ROOT: "/should/drop",
            HOME: "/should/drop/too",
            USER: "should-drop",
            LOGNAME: "should-drop",
          },
        },
      }),
      () => undefined,
    );
    const env = options()!.env!;
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.USER, process.env.USER);
    assert.equal(env.LOGNAME, process.env.LOGNAME);
    assert.equal(env.CLAUDE_CONFIG_DIR, "/home/x/.claude-work");
    assert.equal("PORTUNI_ROOT" in env, false);
    await handle.close();
  });
});

describe("Claude adapter: buildEnv", () => {
  const saved = { USER: process.env.USER, LOGNAME: process.env.LOGNAME };
  const restore = () => {
    if (saved.USER === undefined) delete process.env.USER;
    else process.env.USER = saved.USER;
    if (saved.LOGNAME === undefined) delete process.env.LOGNAME;
    else process.env.LOGNAME = saved.LOGNAME;
  };

  it("drops CLAUDE_CONFIG_DIR when it names the CLI's own default dir", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = "/Users/someone";
    try {
      assert.equal("CLAUDE_CONFIG_DIR" in buildEnv({ CLAUDE_CONFIG_DIR: "/Users/someone/.claude" }), false);
      assert.equal("CLAUDE_CONFIG_DIR" in buildEnv({ CLAUDE_CONFIG_DIR: "/Users/someone/.claude/" }), false);
      assert.equal(
        buildEnv({ CLAUDE_CONFIG_DIR: "/Users/someone/.claude-tempo" }).CLAUDE_CONFIG_DIR,
        "/Users/someone/.claude-tempo",
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("forwards USER/LOGNAME when set on process.env", () => {
    process.env.USER = "honzapav";
    process.env.LOGNAME = "honzapav";
    try {
      const env = buildEnv({});
      assert.equal(env.USER, "honzapav");
      assert.equal(env.LOGNAME, "honzapav");
    } finally {
      restore();
    }
  });

  it("omits USER/LOGNAME when absent from process.env", () => {
    delete process.env.USER;
    delete process.env.LOGNAME;
    try {
      const env = buildEnv({});
      assert.equal("USER" in env, false);
      assert.equal("LOGNAME" in env, false);
    } finally {
      restore();
    }
  });

  it("an instance's own USER/LOGNAME never override process.env's", () => {
    process.env.USER = "honzapav";
    process.env.LOGNAME = "honzapav";
    try {
      const env = buildEnv({ USER: "someone-else", LOGNAME: "someone-else" });
      assert.equal(env.USER, "honzapav");
      assert.equal(env.LOGNAME, "honzapav");
    } finally {
      restore();
    }
  });
});

describe("Claude adapter: resume options", () => {
  it("a conversation resume sets resume + resumeSessionAt", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(
      makeRunStart({ brief: null, resume: { agentSessionId: "conv-1", at: "msg-uuid-1" } }),
      () => undefined,
    );
    assert.equal(options()!.resume, "conv-1");
    assert.equal(options()!.resumeSessionAt, "msg-uuid-1");
    await handle.close();
  });

  it("a fresh run omits resume entirely", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    assert.equal(options()!.resume, undefined);
    await handle.close();
  });
});

// #375: model and reasoning effort, resolved once by session-runtime.ts
// onto RunStart -- the adapter only ever reads run.model/run.effort, never
// config of its own.
describe("Claude adapter: model and effort", () => {
  it("sets Options.model/effort from RunStart when given", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart({ model: "claude-opus-4-8", effort: "high" }), () => undefined);
    assert.equal(options()!.model, "claude-opus-4-8");
    assert.equal(options()!.effort, "high");
    await handle.close();
  });

  it("omits Options.model/effort entirely when RunStart carries neither (the runner's own default)", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart({ model: null, effort: null }), () => undefined);
    assert.equal(options()!.model, undefined);
    assert.equal(options()!.effort, undefined);
    await handle.close();
  });

  it("setModel reaches the live query, resetting to the runner default on null", async () => {
    const { query, setModelCalls } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);

    await handle.setModel("claude-sonnet-5");
    await handle.setModel(null);

    assert.deepEqual(setModelCalls, ["claude-sonnet-5", undefined]);
    await handle.close();
  });

  it("setModel is a no-op once the run has ended", async () => {
    const { query, setModelCalls } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    await handle.close();

    await handle.setModel("claude-sonnet-5");
    assert.deepEqual(setModelCalls, []);
  });
});

// #376: the model picker's list. No throwaway process is ever started for
// this -- the cache is only ever filled as a side effect of a real run.
describe("Claude adapter: models()", () => {
  it("before any run, returns the documented aliases -- never throws, never blocks", async () => {
    const adapter = createClaudeAdapter({ query: makeFakeQuery([]).query });
    const models = await adapter.models();
    assert.deepEqual(
      models.map((m) => m.id),
      ["sonnet", "opus", "haiku"],
    );
    assert.ok(models.every((m) => m.displayName.length > 0 && m.description.length > 0));
  });

  it("fills its cache from the first live run's own supportedModels(), and serves it after", async () => {
    const sdkModels = [
      {
        value: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        description: "Most capable model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] as const,
      },
      {
        value: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        description: "Fastest model",
        supportsEffort: false,
      },
    ];
    const { query } = makeFakeQuery([], { supportedModels: async () => sdkModels });
    const adapter = createClaudeAdapter({ query });

    // Before the first run, still the alias fallback.
    assert.deepEqual(
      (await adapter.models()).map((m) => m.id),
      ["sonnet", "opus", "haiku"],
    );

    const handle = await adapter.start(makeRunStart(), () => undefined);
    await handle.close();
    await flushMicrotasks();

    const models = await adapter.models();
    assert.deepEqual(models, [
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", description: "Most capable model", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", description: "Fastest model", supportsEffort: false, effortLevels: [] },
    ]);
  });

  it("never calls supportedModels() again once the cache is filled", async () => {
    let calls = 0;
    const { query } = makeFakeQuery([], {
      supportedModels: async () => {
        calls += 1;
        return [{ value: "claude-opus-4-8", displayName: "Opus", description: "d", supportsEffort: false }];
      },
    });
    const adapter = createClaudeAdapter({ query });

    const handle1 = await adapter.start(makeRunStart(), () => undefined);
    await handle1.close();
    await flushMicrotasks();
    const handle2 = await adapter.start(makeRunStart(), () => undefined);
    await handle2.close();
    await flushMicrotasks();

    assert.equal(calls, 1, "supportedModels() must only ever be asked once it has already succeeded");
  });

  it("a failed supportedModels() leaves the cache empty -- still the alias fallback, no throw", async () => {
    const { query } = makeFakeQuery([], {
      supportedModels: async () => {
        throw new Error("boom");
      },
    });
    const adapter = createClaudeAdapter({ query });

    const handle = await adapter.start(makeRunStart(), () => undefined);
    await handle.close();
    await flushMicrotasks();

    assert.deepEqual(
      (await adapter.models()).map((m) => m.id),
      ["sonnet", "opus", "haiku"],
    );
  });
});

describe("resolveClaudeExecutable", () => {
  const only = (...ok: string[]) => async (path: string) => ok.includes(path);

  it("prefers PATH order, then ~/.local/bin, ~/.claude/local, Homebrew and /usr/local", async () => {
    const env = { PATH: "/usr/bin:/opt/x/bin", HOME: "/Users/u" };
    assert.equal(await resolveClaudeExecutable(env, only("/opt/x/bin/claude", "/Users/u/.local/bin/claude")), "/opt/x/bin/claude");
    assert.equal(await resolveClaudeExecutable(env, only("/Users/u/.local/bin/claude")), "/Users/u/.local/bin/claude");
    assert.equal(await resolveClaudeExecutable(env, only("/Users/u/.claude/local/claude")), "/Users/u/.claude/local/claude");
    assert.equal(await resolveClaudeExecutable(env, only("/opt/homebrew/bin/claude")), "/opt/homebrew/bin/claude");
    assert.equal(await resolveClaudeExecutable(env, only("/usr/local/bin/claude")), "/usr/local/bin/claude");
  });

  it("finds the native installer's binary even with launchd's bare PATH", async () => {
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/u" };
    assert.equal(await resolveClaudeExecutable(env, only("/Users/u/.local/bin/claude")), "/Users/u/.local/bin/claude");
  });

  it("is null when nothing is executable", async () => {
    assert.equal(await resolveClaudeExecutable({ PATH: "/usr/bin", HOME: "/Users/u" }, async () => false), null);
  });
});

describe("Claude adapter: start() executable", () => {
  it("hands the resolved binary to the SDK as pathToClaudeCodeExecutable", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query, resolveExecutable: resolveFake });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    await handle.close();
    assert.equal(options()?.pathToClaudeCodeExecutable, FAKE_CLAUDE);
  });
});

describe("Claude adapter: detect()", () => {
  it("reports installed + version + logged_in on success, probing the resolved binary by absolute path", async () => {
    const seen: string[] = [];
    const exec = fakeExec(
      {
        "--version": { stdout: "1.2.3 (Claude Code)\n" },
        "auth status": { stdout: "Logged in as a@b.com\n" },
      },
      seen,
    );
    const adapter = createClaudeAdapter({ exec, resolveExecutable: resolveFake });
    const availability = await adapter.detect();
    assert.equal(availability.installed, true);
    assert.equal(availability.version, "1.2.3 (Claude Code)");
    assert.equal(availability.logged_in, true);
    assert.deepEqual(seen, [FAKE_CLAUDE, FAKE_CLAUDE]);
  });

  it("reports not installed when no binary resolves, without running anything", async () => {
    const seen: string[] = [];
    const exec = fakeExec({ "--version": { stdout: "1.2.3\n" } }, seen);
    const adapter = createClaudeAdapter({ exec, resolveExecutable: async () => null });
    const availability = await adapter.detect();
    assert.equal(availability.installed, false);
    assert.equal(availability.logged_in, false);
    assert.deepEqual(seen, []);
  });

  it("reports not installed when --version fails", async () => {
    const exec = fakeExec({ "--version": { err: new Error("ENOENT") } });
    const adapter = createClaudeAdapter({ exec, resolveExecutable: resolveFake });
    const availability = await adapter.detect();
    assert.equal(availability.installed, false);
    assert.equal(availability.logged_in, false);
  });

  it("reports logged_in false when auth status exits non-zero", async () => {
    const exec = fakeExec({
      "--version": { stdout: "1.2.3\n" },
      "auth status": { err: new Error("not logged in") },
    });
    const adapter = createClaudeAdapter({ exec, resolveExecutable: resolveFake });
    const availability = await adapter.detect();
    assert.equal(availability.installed, true);
    assert.equal(availability.logged_in, false);
  });
});

describe("Claude adapter: pid-death race (#325)", () => {
  // A real spawn-then-kill dance is flaky under a container's own zombie-
  // reaping timing (the whole reason this bound exists in the first place
  // is uncertainty about exactly when a dead process is noticed) -- tested
  // directly against waitForPidDeadOrTimeout with synthetic pids instead,
  // which is deterministic: no such pid was ever allocated, so it never
  // needs the OS to reap anything.
  const NEVER_ALLOCATED_PID = 999_999_999;

  it("resolves quickly for a pid that was never alive", async () => {
    const startedAt = Date.now();
    await waitForPidDeadOrTimeout(NEVER_ALLOCATED_PID, 20, 2000);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 200, `expected an immediate resolution, took ${elapsedMs}ms`);
  });

  it("waits out the full timeout for a pid that stays alive", async () => {
    const startedAt = Date.now();
    await waitForPidDeadOrTimeout(process.pid, 20, 100);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 90, `expected to wait out the timeout, resolved after ${elapsedMs}ms`);
  });

  it("waits out the full timeout when no pid was captured at all", async () => {
    const startedAt = Date.now();
    await waitForPidDeadOrTimeout(null, 20, 100);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 90, `expected to wait out the timeout, resolved after ${elapsedMs}ms`);
  });

  it("RunHandle.close() resolves quickly when the run's captured pid is already dead", async () => {
    // A script that never completes on its own -- simulates a real CLI
    // process that crashed/was killed before the SDK's own iterator
    // noticed, the exact case close()'s pid-based race exists for.
    let releaseIterator: (() => void) | null = null;
    const hangingQuery = ((params: { prompt: unknown; options?: Options }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>((resolve) => {
          releaseIterator = resolve;
        });
      }
      const iterator = gen() as unknown as Query;
      (iterator as unknown as { interrupt: () => Promise<undefined> }).interrupt = async () => undefined;
      void params;
      return iterator;
    }) as CreateClaudeAdapterDeps["query"];

    const adapter = createClaudeAdapter({
      query: hangingQuery,
      closePollIntervalMs: 20,
      closeTimeoutMs: 300,
      closeGraceMs: 20,
    });
    const handle = await adapter.start(makeRunStart(), () => undefined);
    // pid() is null here (spawnClaudeCodeProcess was never invoked by this
    // fake query) -- close() must still resolve, just via the full timeout
    // bound rather than an early pid-death detection.
    assert.equal(handle.pid(), null);

    const startedAt = Date.now();
    await handle.close();
    assert.ok(Date.now() - startedAt >= 280, "a null pid must wait out the full close timeout, not return early");

    // Let the background translate loop actually finish (independent of
    // close()'s own race) so no pending promise chain outlives this test.
    releaseIterator?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

// #489: a message handed to a run that is over (or tearing down) used to be
// pushed into a prompt stream nobody reads any more -- the chat showed it,
// the agent never saw it. The handle now says so and the runtime delivers
// it to the next run.
describe("Claude adapter: send() into a run that is ending (#489)", () => {
  function resultMsg(overrides: Record<string, unknown>): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {},
      permission_denials: [],
      duration_ms: 1,
      duration_api_ms: 1,
      uuid: "u1",
      session_id: "s1",
      ...overrides,
    } as unknown as SDKMessage;
  }

  it("a live run still takes the message; close() ending the prompt stream makes the next one throw", async () => {
    const { query, release } = makeFakeQuery([], { hold: true });
    const adapter = createClaudeAdapter({
      query,
      closePollIntervalMs: 5,
      closeGraceMs: 10,
      closeTermMs: 10,
      closeTimeoutMs: 10,
    });
    const handle = await adapter.start(makeRunStart(), () => undefined);

    // The ordinary case is untouched.
    await handle.send("keep going");

    const closing = handle.close();
    await assert.rejects(
      () => handle.send("too late"),
      (err: unknown) => {
        assert.equal(isRunEndedError(err), true);
        return true;
      },
    );
    release();
    await closing;
  });

  it("a message during a provider-limit teardown is refused, not buffered", async () => {
    const script: SDKMessage[] = [
      resultMsg({ is_error: true, result: "You've hit your monthly spend limit" }),
    ];
    // hold: true -- the CLI is still alive while the teardown runs, which is
    // exactly when a user who just read the error writes the next message.
    const { query, release } = makeFakeQuery(script, { hold: true });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    let markEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const adapter = createClaudeAdapter({
      query,
      closePollIntervalMs: 5,
      closeGraceMs: 10,
      closeTermMs: 10,
      closeTimeoutMs: 10,
    });
    const handle = await adapter.start(makeRunStart(), (e) => {
      events.push(e);
      if ("kind" in e && e.kind === "error") {
        // The provider error is the signal the teardown has begun.
        markEnded();
      }
    });
    await ended;

    await assert.rejects(
      () => handle.send("a co teď?"),
      (err: unknown) => {
        assert.equal(isRunEndedError(err), true);
        return true;
      },
    );
    release();
    await handle.close();
  });
});

// #490: a turn is not a message. The SDK's own contract (sdk.d.ts of
// @anthropic-ai/claude-agent-sdk 0.3.270) says the CLI "emits exactly one
// result message per turn" and that "queued sends may coalesce into fewer
// turns", echoing in `user_message_uuids` "client uuids of every user
// message whose prompt this turn consumed" -- so a second message written
// mid-turn can be answered by the SAME result as the first. The adapter
// tags every send with a uuid and reports on turn_ended how many of them
// the turn answered; the runtime and the chat count with that number.
describe("Claude adapter: how many messages a turn answered (#490)", () => {
  function resultMessage(overrides: Record<string, unknown>): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {},
      permission_denials: [],
      duration_ms: 1,
      duration_api_ms: 1,
      uuid: "u1",
      session_id: "s1",
      ...overrides,
    } as unknown as SDKMessage;
  }

  // Collects events and hands out a promise per turn_ended, so nothing here
  // waits a fixed time for the adapter to translate an injected result.
  function turnCollector() {
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const waiters: (() => void)[] = [];
    const turns = (): Extract<CanonicalEvent, { kind: "turn_ended" }>[] =>
      events.filter((e) => "kind" in e && e.kind === "turn_ended") as Extract<
        CanonicalEvent,
        { kind: "turn_ended" }
      >[];
    return {
      events,
      turns,
      sink(e: CanonicalEvent | DeltaFrame): void {
        events.push(e);
        if ("kind" in e && e.kind === "turn_ended") {
          for (const w of waiters.splice(0)) w();
        }
      },
      nextTurn(seen: number): Promise<void> {
        return turns().length > seen ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
      },
    };
  }

  it("one result that answered both sends reports both: the turn is over for two messages", async () => {
    const fake = makeFakeQuery([], { hold: true, collectPrompt: true });
    const c = turnCollector();
    const adapter = createClaudeAdapter({
      query: fake.query,
      closePollIntervalMs: 5,
      closeGraceMs: 10,
      closeTermMs: 10,
      closeTimeoutMs: 10,
    });
    const handle = await adapter.start(makeRunStart({ brief: "první" }), c.sink);
    await fake.waitForSent(1);
    await handle.send("druhá");
    await fake.waitForSent(2);

    const uuids = fake.sent.map((m) => String(m.uuid));
    assert.equal(new Set(uuids).size, 2, "every send carries a uuid of its own");
    assert.deepEqual(
      fake.sent.map((m) => m.message.content),
      ["první", "druhá"],
    );

    // The CLI folded the queued message into the running turn: one result,
    // both uuids, nothing left in the queue.
    fake.inject(
      resultMessage({ user_message_uuids: uuids, user_message_uuid: uuids[1], queued_turn_count: 0 }),
    );
    await c.nextTurn(0);
    assert.equal(c.turns().length, 1);
    assert.equal(c.turns()[0].payload.consumed_messages, 2);

    fake.release();
    await handle.close();
  });

  it("a result that answered only the first send leaves the second in flight", async () => {
    const fake = makeFakeQuery([], { hold: true, collectPrompt: true });
    const c = turnCollector();
    const adapter = createClaudeAdapter({
      query: fake.query,
      closePollIntervalMs: 5,
      closeGraceMs: 10,
      closeTermMs: 10,
      closeTimeoutMs: 10,
    });
    const handle = await adapter.start(makeRunStart({ brief: "první" }), c.sink);
    await fake.waitForSent(1);
    await handle.send("druhá");
    await fake.waitForSent(2);
    const uuids = fake.sent.map((m) => String(m.uuid));

    fake.inject(resultMessage({ user_message_uuids: [uuids[0]], user_message_uuid: uuids[0], queued_turn_count: 1 }));
    await c.nextTurn(0);
    assert.equal(c.turns()[0].payload.consumed_messages, 1, "one message answered, one still queued");

    fake.inject(resultMessage({ user_message_uuids: [uuids[1]], user_message_uuid: uuids[1], queued_turn_count: 0 }));
    await c.nextTurn(1);
    assert.equal(c.turns()[1].payload.consumed_messages, 1);

    fake.release();
    await handle.close();
  });
});

describe("consumeSendUuids (#490)", () => {
  it("takes every send the turn echoed, in any order", () => {
    const pending = ["a", "b", "c"];
    assert.equal(consumeSendUuids(pending, { user_message_uuids: ["a", "b"], user_message_uuid: "b" }), 2);
    assert.deepEqual(pending, ["c"]);
  });

  it("a coalesced turn that echoes only its last member takes everything before it too", () => {
    const pending = ["a", "b", "c"];
    assert.equal(consumeSendUuids(pending, { user_message_uuid: "b" }), 2);
    assert.deepEqual(pending, ["c"]);
  });

  it("no echo at all is one message: one result per turn", () => {
    const pending = ["a", "b"];
    assert.equal(consumeSendUuids(pending, {}), 1);
    assert.deepEqual(pending, ["b"]);
  });

  it("the queue count resyncs what no echo reported: an interrupt that dropped the backlog", () => {
    const pending = ["a", "b", "c"];
    // The interrupted turn answered "a"; the CLI reports an empty queue, so
    // nothing is waiting any more -- b and c are gone with it.
    assert.equal(consumeSendUuids(pending, { user_message_uuid: "a", queued_turn_count: 0 }), 3);
    assert.deepEqual(pending, []);
  });

  it("a turn that consumed none of ours takes nothing", () => {
    const pending = ["a"];
    assert.equal(consumeSendUuids(pending, { user_message_uuids: ["x"], user_message_uuid: "x", queued_turn_count: 1 }), 0);
    assert.deepEqual(pending, ["a"]);
  });

  it("nothing pending is nothing consumed", () => {
    const pending: string[] = [];
    assert.equal(consumeSendUuids(pending, { user_message_uuid: "a" }), 0);
  });
});
