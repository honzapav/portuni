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
  createClaudeAdapter,
  resolveClaudeExecutable,
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
// `hold: true` keeps the iterator open after the script (the run stays
// live, as it is while a real turn is in flight) until `release()` is
// called -- canUseTool only means something on a live run.
function makeFakeQuery(script: readonly SDKMessage[], opts: { hold?: boolean } = {}) {
  let capturedOptions: Options | undefined;
  const interruptCalls: number[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fakeQuery = ((_params: { prompt: unknown; options?: Options }) => {
    capturedOptions = _params.options;
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const msg of script) yield msg;
      if (opts.hold) await held;
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
    release: () => release(),
  };
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
