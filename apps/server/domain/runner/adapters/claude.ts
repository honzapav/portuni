// Claude Code adapter over @anthropic-ai/claude-agent-sdk (spec: "Claude
// adapter"). `query`/`exec` are constructor-injected so tests run against a
// scripted fake SDK instead of a real, logged-in CLI (the container has
// neither); production callers (registry.ts) use the real SDK function and
// node:child_process.execFile.
//
// Streaming-input mode throughout (spec: "this is what makes interrupt(),
// queued messages and answer() possible"): the prompt passed to query() is
// an async iterable this module feeds via a small push queue, never a plain
// string, even for a brief-only fresh run.

import { execFile as nodeExecFile } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookInput,
  HookJSONOutput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { isPortuniEnvKey } from "../../../shared/runner-env.js";
import { decidePermission } from "../permissions.js";
import { isProcessAlive } from "../process-liveness.js";
import type {
  DeltaFrame,
  EventSink,
  QuestionDecision,
  RunHandle,
  RunStart,
  RunnerAdapter,
  RunnerAvailability,
  ToolCallCategory,
} from "../types.js";

const DETECT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_POLL_INTERVAL_MS = 500;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

type ExecFile = typeof nodeExecFile;
type SdkQuery = typeof sdkQuery;

export interface CreateClaudeAdapterDeps {
  query?: SdkQuery;
  exec?: ExecFile;
  // Test-only overrides for close()/interrupt()'s "the pid is already dead"
  // safety net -- production leaves these at their 500ms/10s defaults.
  closePollIntervalMs?: number;
  closeTimeoutMs?: number;
}

// `signal` lets a caller cancel a still-pending sleep the instant it no
// longer cares about the result -- used by close()/interrupt() to tear down
// the "losing" branch of a Promise.race against state.endedPromise as soon
// as the race is decided, instead of leaving a timer to fire (and, if
// unref'd, risking it never firing at all once nothing else keeps the event
// loop alive -- exactly what a plain `await` on this function in a test
// depends on).
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// Resolves once `pid` is confirmed dead, after `timeoutMs` either way, or as
// soon as `signal` aborts -- a safety net for close()/interrupt() not
// hanging forever waiting for the SDK's own iterator to notice a process
// that already exited/crashed. A null pid (not captured yet) can't be
// polled at all, so this just waits out the full timeout as the bound.
export async function waitForPidDeadOrTimeout(
  pid: number | null,
  pollIntervalMs: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  if (pid === null) {
    await sleep(timeoutMs, signal);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    if (signal?.aborted) return;
    await sleep(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)), signal);
  }
}

// --- Push queue feeding query()'s streaming prompt -------------------------

interface PushQueue<T> {
  push(item: T): void;
  end(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

function createPushQueue<T>(): PushQueue<T> {
  const buffer: T[] = [];
  let waiter: ((r: IteratorResult<T>) => void) | null = null;
  let ended = false;
  return {
    push(item: T): void {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: item, done: false });
      } else {
        buffer.push(item);
      }
    },
    end(): void {
      if (ended) return;
      ended = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: undefined as unknown as T, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift() as T, done: false });
          if (ended) return Promise.resolve({ value: undefined as unknown as T, done: true });
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
      };
    },
  };
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

// --- env composition ---------------------------------------------------
// The SDK replaces the subprocess environment entirely (no merge with
// process.env), so PATH and HOME are passed explicitly -- HOME is never
// overridden by an instance's own env, since the CLI login lives in the
// Keychain under it; CLAUDE_CONFIG_DIR (an instance's own env key) is what
// actually selects a different account.

function buildEnv(instanceEnv: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  for (const [key, value] of Object.entries(instanceEnv)) {
    if (isPortuniEnvKey(key) || key === "HOME") continue;
    env[key] = value;
  }
  return env;
}

// --- tool categorization / titling --------------------------------------

const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FILE_READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const ALWAYS_EDIT_WRITE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

export function categorizeTool(tool: string): ToolCallCategory {
  if (tool === "Bash") return "command";
  if (FILE_READ_TOOLS.has(tool)) return "file_read";
  if (FILE_CHANGE_TOOLS.has(tool)) return "file_change";
  if (tool.startsWith("mcp__")) return "mcp";
  return "other";
}

const TITLE_ARG_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "prompt", "query"];

function primaryArgument(input: Record<string, unknown>): string | null {
  for (const key of TITLE_ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function toolTitle(tool: string, input: Record<string, unknown>): string {
  const arg = primaryArgument(input);
  const firstLine = arg?.split("\n")[0];
  return firstLine ? `${tool}: ${firstLine}` : tool;
}

// Write on a path that did not exist -> create, else edit (spec). Edit/
// MultiEdit/NotebookEdit always operate on an existing file. `path` is
// resolved against `cwd` when relative.
async function resolveWriteOp(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<"create" | "edit" | undefined> {
  if (ALWAYS_EDIT_WRITE_TOOLS.has(tool)) return "edit";
  if (tool !== "Write") return undefined;
  const rawPath = input.file_path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return "edit";
  const absPath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
  try {
    await stat(absPath);
    return "edit";
  } catch {
    return "create";
  }
}

// --- run state -----------------------------------------------------------

interface PendingToolCall {
  tool: string;
  category: ToolCallCategory;
  writeOp?: "create" | "edit";
  // The tool_use's own path argument, captured at "started" time -- the
  // matching tool_result never carries the original arguments back, so a
  // completed file_change event needs this snapshot to name the file.
  path: string | null;
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  input: Record<string, unknown>;
}

interface RunTranslationState {
  agentSessionId: string | null;
  latestUsage: unknown;
  pendingToolCalls: Map<string, PendingToolCall>;
  pendingPermissions: Map<string, PendingPermission>;
  interrupting: boolean;
  ended: boolean;
  endedResolve: () => void;
  endedPromise: Promise<void>;
  capturedPid: number | null;
}

function createState(): RunTranslationState {
  let endedResolve!: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    endedResolve = resolve;
  });
  return {
    agentSessionId: null,
    latestUsage: null,
    pendingToolCalls: new Map(),
    pendingPermissions: new Map(),
    interrupting: false,
    ended: false,
    endedResolve,
    endedPromise,
    capturedPid: null,
  };
}

function notLoggedInMessage(message: string): boolean {
  return /not logged in|not authenticated|please run.*login|no valid credentials/i.test(message);
}

// --- message translation --------------------------------------------------

async function translateAssistantMessage(
  msg: Extract<SDKMessage, { type: "assistant" }>,
  state: RunTranslationState,
  cwd: string,
  sink: EventSink,
): Promise<void> {
  const blocks = msg.message.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      sink({ kind: "assistant_message", payload: { text: block.text } });
    } else if (block.type === "tool_use") {
      const input = (block.input ?? {}) as Record<string, unknown>;
      const category = categorizeTool(block.name);
      const writeOp = await resolveWriteOp(block.name, input, cwd);
      const path = typeof input.file_path === "string" ? input.file_path : null;
      state.pendingToolCalls.set(block.id, { tool: block.name, category, writeOp, path });
      sink({
        kind: "tool_call",
        payload: {
          tool_use_id: block.id,
          tool: block.name,
          category,
          title: toolTitle(block.name, input),
          input_summary: JSON.stringify(input),
          status: "started",
          output_excerpt: null,
          truncated: false,
        },
      });
    }
  }
}

function excerptFromToolResultContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

// Translates a completed/failed tool_call from its matching tool_result,
// plus the file_change a successful write tool produces -- the result
// itself carries no arguments back, so the path/op come from the
// PendingToolCall snapshot taken when the tool_use started.
function translateUserMessage(
  msg: Extract<SDKMessage, { type: "user" }>,
  state: RunTranslationState,
  sink: EventSink,
): void {
  const content = msg.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as unknown as Record<string, unknown>).type !== "tool_result") {
      continue;
    }
    const result = block as { tool_use_id: string; is_error?: boolean; content?: unknown };
    const pending = state.pendingToolCalls.get(result.tool_use_id);
    if (!pending) continue;
    state.pendingToolCalls.delete(result.tool_use_id);
    const isError = result.is_error === true;
    sink({
      kind: "tool_call",
      payload: {
        tool_use_id: result.tool_use_id,
        tool: pending.tool,
        category: pending.category,
        title: "",
        input_summary: "",
        status: isError ? "failed" : "completed",
        output_excerpt: excerptFromToolResultContent(result.content),
        truncated: false,
      },
    });
    if (!isError && pending.category === "file_change" && pending.writeOp && pending.path) {
      sink({ kind: "file_change", payload: { path: pending.path, op: pending.writeOp } });
    }
  }
}

function translateStreamEvent(msg: Extract<SDKMessage, { type: "stream_event" }>, sink: EventSink): void {
  const event = msg.event;
  if (event.type !== "content_block_delta") return;
  const delta = event.delta;
  if (delta.type !== "text_delta" || typeof delta.text !== "string") return;
  const frame: DeltaFrame = { type: "delta", run_id: "", text: delta.text };
  sink(frame);
}

// --- adapter ---------------------------------------------------------------

export function createClaudeAdapter(deps: CreateClaudeAdapterDeps = {}): RunnerAdapter {
  const query = deps.query ?? sdkQuery;
  const exec = deps.exec ?? nodeExecFile;
  const closePollIntervalMs = deps.closePollIntervalMs ?? DEFAULT_CLOSE_POLL_INTERVAL_MS;
  const closeTimeoutMs = deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

  async function runExec(args: string[]): Promise<{ ok: boolean; stdout: string }> {
    return new Promise((resolve) => {
      exec("claude", args, { timeout: DETECT_TIMEOUT_MS }, (err, stdout) => {
        resolve({ ok: !err, stdout: stdout?.toString() ?? "" });
      });
    });
  }

  async function detect(): Promise<RunnerAvailability> {
    const versionResult = await runExec(["--version"]);
    if (!versionResult.ok) {
      return { installed: false, version: null, logged_in: false, instances_supported: true };
    }
    const version = versionResult.stdout.trim().split("\n")[0] || null;
    const authResult = await runExec(["auth", "status"]);
    return { installed: true, version, logged_in: authResult.ok, instances_supported: true };
  }

  async function start(run: RunStart, sink: EventSink): Promise<import("../types.js").RunHandle> {
    const state = createState();
    const promptQueue = createPushQueue<SDKUserMessage>();
    if (run.brief !== null) promptQueue.push(userMessage(run.brief));

    async function canUseTool(
      toolName: string,
      input: Record<string, unknown>,
      options: { requestId: string },
    ): Promise<PermissionResult> {
      const decision = decidePermission({
        tool: toolName,
        input,
        cwd: run.cwd,
        portuniRoot: run.portuniRoot,
        mirrors: run.mirrors,
        policy: run.policy,
      });
      if (decision.kind === "allow") return { behavior: "allow", updatedInput: input };
      if (decision.kind === "deny") return { behavior: "deny", message: decision.message };

      const requestId = options.requestId;
      sink({
        kind: "question",
        payload: {
          request_id: requestId,
          type: decision.question.type,
          tool: toolName,
          title: decision.question.title,
          detail: decision.question.detail,
          options: decision.question.options,
          decision: null,
        },
      });
      return new Promise<PermissionResult>((resolve) => {
        state.pendingPermissions.set(requestId, { resolve, input });
      });
    }

    async function preCompactHook(input: HookInput): Promise<HookJSONOutput> {
      if (input.hook_event_name === "PreCompact") {
        sink({ kind: "compaction", payload: { trigger: input.trigger === "manual" ? "manual" : "auto" } });
      }
      return {};
    }

    function spawnClaudeCodeProcess(spawnOptions: SpawnOptions): SpawnedProcess {
      const child = nodeSpawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
      });
      state.capturedPid = child.pid ?? null;
      return child as unknown as SpawnedProcess;
    }

    const options: Options = {
      cwd: run.cwd,
      systemPrompt: { type: "preset", preset: "claude_code", append: run.orientation },
      mcpServers: {
        portuni: {
          type: "http",
          url: run.mcp.url,
          headers: { Authorization: `Bearer ${run.mcp.token}`, ...run.mcp.headers },
        },
      },
      settingSources: ["user"],
      includePartialMessages: true,
      permissionMode: "default",
      canUseTool,
      env: buildEnv(run.instance.env),
      hooks: { PreCompact: [{ hooks: [preCompactHook] }] },
      spawnClaudeCodeProcess,
      ...(run.resume
        ? {
            resume: run.resume.agentSessionId,
            ...(run.resume.at !== undefined ? { resumeSessionAt: run.resume.at } : {}),
          }
        : {}),
    };

    const q: Query = query({ prompt: promptQueue, options });

    async function translateMessage(msg: SDKMessage): Promise<void> {
      if (msg.type === "system" && msg.subtype === "init") {
        state.agentSessionId = msg.session_id;
        return;
      }
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        sink({ kind: "compaction", payload: { trigger: "auto" } });
        return;
      }
      if (msg.type === "assistant") {
        await translateAssistantMessage(msg, state, run.cwd, sink);
        return;
      }
      if (msg.type === "user") {
        translateUserMessage(msg, state, sink);
        return;
      }
      if (msg.type === "stream_event") {
        translateStreamEvent(msg, sink);
        return;
      }
      if (msg.type === "result") {
        state.latestUsage = { usage: msg.usage, total_cost_usd: msg.total_cost_usd };
      }
    }

    void (async () => {
      try {
        for await (const msg of q) {
          await translateMessage(msg);
        }
        sink({
          kind: "run_ended",
          payload: {
            run_id: run.runId,
            reason: state.interrupting ? "interrupted" : "completed",
            usage: state.latestUsage,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (notLoggedInMessage(message)) {
          sink({
            kind: "error",
            payload: { class: "provider", message: "Claude Code není přihlášený na tomto zařízení." },
          });
        } else {
          sink({ kind: "error", payload: { class: "unknown", message } });
        }
        sink({ kind: "run_ended", payload: { run_id: run.runId, reason: "error", usage: state.latestUsage } });
      } finally {
        state.ended = true;
        state.endedResolve();
      }
    })();

    const handle: RunHandle = {
      async send(text: string): Promise<void> {
        promptQueue.push(userMessage(text));
      },
      async answer(requestId: string, decision: QuestionDecision): Promise<void> {
        const pending = state.pendingPermissions.get(requestId);
        if (!pending) return;
        state.pendingPermissions.delete(requestId);
        if (decision.value === false) {
          pending.resolve({ behavior: "deny", message: "Zamítnuto uživatelem." });
        } else if (decision.value === true) {
          pending.resolve({ behavior: "allow", updatedInput: pending.input });
        } else {
          // AskUserQuestion (input-type ask): the typed answer becomes part
          // of the tool's own input rather than a plain allow/deny.
          pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answer: decision.value } });
        }
      },
      async interrupt(): Promise<void> {
        if (state.ended) return;
        state.interrupting = true;
        try {
          await q.interrupt();
        } catch {
          // Best-effort -- the process may already be gone.
        }
        promptQueue.end();
        const abort = new AbortController();
        try {
          await Promise.race([
            state.endedPromise,
            waitForPidDeadOrTimeout(state.capturedPid, closePollIntervalMs, closeTimeoutMs, abort.signal),
          ]);
        } finally {
          abort.abort();
        }
      },
      async close(): Promise<void> {
        if (state.ended) return;
        promptQueue.end();
        // A run whose child is already gone (crashed, killed out of band)
        // must not hang here waiting for the SDK's own iterator to notice --
        // resolve as soon as the pid is confirmed dead, bounded either way.
        const abort = new AbortController();
        try {
          await Promise.race([
            state.endedPromise,
            waitForPidDeadOrTimeout(state.capturedPid, closePollIntervalMs, closeTimeoutMs, abort.signal),
          ]);
        } finally {
          abort.abort();
        }
      },
      agentSessionId(): string | null {
        return state.agentSessionId;
      },
      pid(): number | null {
        return state.capturedPid;
      },
    };
    return handle;
  }

  return { id: "claude", detect, start };
}
