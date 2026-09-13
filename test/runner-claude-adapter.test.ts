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
import {
  categorizeTool,
  createClaudeAdapter,
  toolTitle,
  waitForPidDeadOrTimeout,
  type CreateClaudeAdapterDeps,
} from "../apps/server/domain/runner/adapters/claude.js";
import type { CanonicalEvent, DeltaFrame, RunStart } from "../apps/server/domain/runner/types.js";
import type { Options, PermissionResult, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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
    ...overrides,
  };
}

// A fake `query()`: yields the given script as an async generator and
// captures the `options` object so tests can invoke `canUseTool` directly
// (the real SDK invokes it internally when a tool call needs a decision;
// nothing in this fake simulates that plumbing, so tests call it themselves).
function makeFakeQuery(script: readonly SDKMessage[]) {
  let capturedOptions: Options | undefined;
  const interruptCalls: number[] = [];
  const fakeQuery = ((_params: { prompt: unknown; options?: Options }) => {
    capturedOptions = _params.options;
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const msg of script) yield msg;
    }
    const iterator = gen() as unknown as Query;
    (iterator as unknown as { interrupt: () => Promise<undefined> }).interrupt = async () => {
      interruptCalls.push(1);
      return undefined;
    };
    return iterator;
  }) as CreateClaudeAdapterDeps["query"];
  return {
    query: fakeQuery,
    options: () => capturedOptions,
    interruptCalls,
  };
}

function fakeExec(
  responses: Record<string, { err?: Error; stdout?: string }>,
): CreateClaudeAdapterDeps["exec"] {
  return ((_cmd: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
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
    assert.deepEqual(kinds, ["assistant_message", "tool_call", "tool_call", "run_ended"]);
    const started = events[1] as Extract<CanonicalEvent, { kind: "tool_call" }>;
    assert.equal(started.payload.status, "started");
    assert.equal(started.payload.category, "command");
    assert.equal(started.payload.title, "Bash: ls -la");
    const completed = events[2] as Extract<CanonicalEvent, { kind: "tool_call" }>;
    assert.equal(completed.payload.status, "completed");
    assert.equal(completed.payload.output_excerpt, "file1\nfile2");
    const ended = events[3] as Extract<CanonicalEvent, { kind: "run_ended" }>;
    assert.equal(ended.payload.reason, "completed");
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
    assert.deepEqual(kinds, ["tool_call", "tool_call", "run_ended"]);
    const completed = events[1] as Extract<CanonicalEvent, { kind: "tool_call" }>;
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
    const { query, options } = makeFakeQuery([]);
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
    await handle.close();
  });

  it("rejecting an ask denies with the Czech refusal message", async () => {
    const { query, options } = makeFakeQuery([]);
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
    await handle.close();
  });
});

describe("Claude adapter: env composition", () => {
  it("HOME/PATH come from process.env; PORTUNI_* and an instance's own HOME are dropped", async () => {
    const { query, options } = makeFakeQuery([]);
    const adapter = createClaudeAdapter({ query });
    const handle = await adapter.start(
      makeRunStart({
        instance: {
          id: "inst-1",
          env: { CLAUDE_CONFIG_DIR: "/home/x/.claude-work", PORTUNI_ROOT: "/should/drop", HOME: "/should/drop/too" },
        },
      }),
      () => undefined,
    );
    const env = options()!.env!;
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.CLAUDE_CONFIG_DIR, "/home/x/.claude-work");
    assert.equal("PORTUNI_ROOT" in env, false);
    await handle.close();
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

describe("Claude adapter: detect()", () => {
  it("reports installed + version + logged_in on success", async () => {
    const exec = fakeExec({
      "--version": { stdout: "1.2.3 (Claude Code)\n" },
      "auth status": { stdout: "Logged in as a@b.com\n" },
    });
    const adapter = createClaudeAdapter({ exec });
    const availability = await adapter.detect();
    assert.equal(availability.installed, true);
    assert.equal(availability.version, "1.2.3 (Claude Code)");
    assert.equal(availability.logged_in, true);
  });

  it("reports not installed when --version fails", async () => {
    const exec = fakeExec({ "--version": { err: new Error("ENOENT") } });
    const adapter = createClaudeAdapter({ exec });
    const availability = await adapter.detect();
    assert.equal(availability.installed, false);
    assert.equal(availability.logged_in, false);
  });

  it("reports logged_in false when auth status exits non-zero", async () => {
    const exec = fakeExec({
      "--version": { stdout: "1.2.3\n" },
      "auth status": { err: new Error("not logged in") },
    });
    const adapter = createClaudeAdapter({ exec });
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

    const adapter = createClaudeAdapter({ query: hangingQuery, closePollIntervalMs: 20, closeTimeoutMs: 300 });
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
