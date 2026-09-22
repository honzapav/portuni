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
import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  ElicitationRequest,
  ElicitationResult,
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
  CanonicalEvent,
  EventSink,
  QuestionDecision,
  RunEndReason,
  RunHandle,
  RunStart,
  RunnerAdapter,
  RunnerAvailability,
  RunnerModel,
  ToolCallCategory,
} from "../types.js";

// #376: before this process has ever run a live query, there is nothing to
// ask supportedModels() -- and starting a throwaway process just to build a
// picker is explicitly ruled out. These are the documented aliases the SDK
// accepts as a bare `model` string; "sonnet" first since it's the sensible
// everyday default. Effort support is left false/[] here (deliberately
// conservative -- the real per-model answer only exists once
// supportedModels() has actually answered).
const CLAUDE_ALIAS_MODELS: readonly RunnerModel[] = [
  { id: "sonnet", displayName: "Sonnet", description: "Vyvážený model pro každodenní práci.", supportsEffort: false, effortLevels: [] },
  { id: "opus", displayName: "Opus", description: "Nejschopnější model, pomalejší a dražší.", supportsEffort: false, effortLevels: [] },
  { id: "haiku", displayName: "Haiku", description: "Nejrychlejší a nejlevnější model.", supportsEffort: false, effortLevels: [] },
];

const DETECT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_POLL_INTERVAL_MS = 500;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
// close()'s escalation (spec, "Process lifecycle": end stdin, 2 s, SIGTERM,
// 5 s, SIGKILL) -- how long the child gets to finish on its own after its
// prompt stream ends, then after SIGTERM, before the next step.
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const DEFAULT_CLOSE_TERM_MS = 5_000;

type ExecFile = typeof nodeExecFile;
type SdkQuery = typeof sdkQuery;

export interface CreateClaudeAdapterDeps {
  query?: SdkQuery;
  exec?: ExecFile;
  // Where the `claude` binary is; defaults to `resolveClaudeExecutable`.
  resolveExecutable?: () => Promise<string | null>;
  // Test-only overrides for close()/interrupt()'s "the pid is already dead"
  // safety net -- production leaves these at their 500ms/10s defaults.
  closePollIntervalMs?: number;
  closeTimeoutMs?: number;
  closeGraceMs?: number;
  closeTermMs?: number;
  // Clock for the reasoning duration; tests inject a fake.
  now?: () => number;
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

// --- executable resolution ---------------------------------------------
// The sidecar's PATH is whatever the host process handed it -- the desktop
// (lib.rs) resolves a login shell's PATH for it, but a standalone server or
// an older host may not -- so a bare `execFile("claude")` is not enough.
// Walk PATH first, then the native installer's and Homebrew's usual
// targets. The same absolute path then goes to the SDK as
// `pathToClaudeCodeExecutable`: the compiled sidecar does not ship the
// SDK's own optional native-binary package, so the SDK's default lookup
// would fail there even with `claude` on PATH.

const CLAUDE_FALLBACK_DIRS = [".local/bin", ".claude/local"];
const CLAUDE_SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export async function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (path: string) => Promise<boolean> = canExecute,
): Promise<string | null> {
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, "claude"));
  }
  if (env.HOME) {
    for (const dir of CLAUDE_FALLBACK_DIRS) candidates.push(join(env.HOME, dir, "claude"));
  }
  for (const dir of CLAUDE_SYSTEM_DIRS) candidates.push(join(dir, "claude"));
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// --- env composition ---------------------------------------------------
// The SDK replaces the subprocess environment entirely (no merge with
// process.env), so PATH, HOME, USER and LOGNAME are passed explicitly --
// none of the four are overridden by an instance's own env, since the CLI
// login lives in the Keychain under USER (HOME locates the Keychain search
// path, USER is the account key); CLAUDE_CONFIG_DIR (an instance's own env
// key) is what actually selects a different account.

export function buildEnv(instanceEnv: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.USER) env.USER = process.env.USER;
  if (process.env.LOGNAME) env.LOGNAME = process.env.LOGNAME;
  for (const [key, value] of Object.entries(instanceEnv)) {
    if (isPortuniEnvKey(key) || key === "HOME" || key === "USER" || key === "LOGNAME") continue;
    // The CLI keys its Keychain login by whether CLAUDE_CONFIG_DIR is set,
    // not only by where it points: with the variable set to its own
    // default (~/.claude) it looks for a different item than a plain
    // `claude` login wrote, and reports "Not logged in". An instance that
    // names the default dir is the unset case.
    if (key === "CLAUDE_CONFIG_DIR" && env.HOME && isDefaultClaudeConfigDir(value, env.HOME)) continue;
    env[key] = value;
  }
  return env;
}

function isDefaultClaudeConfigDir(value: string, home: string): boolean {
  const strip = (p: string) => p.replace(/\/+$/, "");
  return strip(value) === strip(join(home, ".claude"));
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

// A connector dialog (MCP elicitation) waiting on the chat's answer.
type PendingElicitation = (result: ElicitationResult) => void;

// The chat renders a dialog as a yes/no question, so it can answer a form
// only when every field is a boolean (Portuni's scope and write
// confirmations are one `confirm: boolean`); "yes" sets them all true.
// null means the form needs input the chat cannot collect.
export function booleanFormFields(request: ElicitationRequest): string[] | null {
  if (request.mode === "url") return null;
  const properties = (request.requestedSchema?.properties ?? {}) as Record<string, { type?: unknown }>;
  const names = Object.keys(properties);
  return names.every((name) => properties[name]?.type === "boolean") ? names : null;
}

// A run inherits the claude.ai connectors of its profile's account. A
// Portuni among them is a second Portuni: a connector session whose
// confirmation dialogs go to claude.ai, where nobody sees them. The run has
// its own Portuni connection, so those are switched off.
export function isClaudeAiPortuniServer(name: string): boolean {
  return /^claude\.ai portuni\b/i.test(name);
}

interface RunTranslationState {
  agentSessionId: string | null;
  latestUsage: unknown;
  // v2 context ring: the model the latest assistant message named and its
  // context window from the latest result's modelUsage (null until one).
  model: string | null;
  contextMaxTokens: number | null;
  // When the first thinking delta of the current block arrived; the
  // batched thinking block reads it as duration_ms and clears it.
  reasoningStartedAt: number | null;
  pendingToolCalls: Map<string, PendingToolCall>;
  pendingPermissions: Map<string, PendingPermission>;
  pendingElicitations: Map<string, PendingElicitation>;
  ended: boolean;
  endedResolve: () => void;
  endedPromise: Promise<void>;
  capturedPid: number | null;
  // #411: set once a `result` message reports a provider failure (a spend
  // limit, an error subtype). The run then ends with THIS reason instead of
  // the "completed" a natural end reports.
  providerEndReason: RunEndReason | null;
  // #411: run_ended is emitted exactly once, whichever path gets there
  // first -- the translate loop's own completion, its catch branch, or the
  // provider-failure teardown below.
  runEndedEmitted: boolean;
}

function createState(): RunTranslationState {
  let endedResolve!: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    endedResolve = resolve;
  });
  return {
    agentSessionId: null,
    latestUsage: null,
    model: null,
    contextMaxTokens: null,
    reasoningStartedAt: null,
    pendingToolCalls: new Map(),
    pendingPermissions: new Map(),
    pendingElicitations: new Map(),
    ended: false,
    endedResolve,
    endedPromise,
    capturedPid: null,
    providerEndReason: null,
    runEndedEmitted: false,
  };
}

function notLoggedInMessage(message: string): boolean {
  return /not logged in|not authenticated|please run.*login|no valid credentials/i.test(message);
}

// #411: a `result` message is the turn-complete signal, and it is also how
// the SDK reports a provider failure -- a spend/rate limit arrives as
// `subtype: "success"` with `is_error: true` and the provider's text in
// `result`; the `error_*` subtypes say the turn stopped early. Neither ends
// the CLI process in streaming-input mode (it waits for the next prompt),
// so without this the run would stay live forever. Returns null for an
// ordinary successful turn.
export function providerResultFailure(
  msg: Extract<SDKMessage, { type: "result" }>,
): { reason: RunEndReason; message: string } | null {
  const subtype = typeof msg.subtype === "string" ? msg.subtype : "success";
  const isError = (msg as { is_error?: unknown }).is_error === true;
  if (!isError && subtype === "success") return null;

  const text = (msg as { result?: unknown }).result;
  const errors = (msg as { errors?: unknown }).errors;
  let message = "";
  if (typeof text === "string" && text.trim() !== "") {
    message = text;
  } else if (Array.isArray(errors)) {
    message = errors.filter((e): e is string => typeof e === "string" && e.trim() !== "").join("\n");
  }
  if (message.trim() === "") message = `Běh skončil chybou poskytovatele (${subtype}).`;

  const terminalReason = (msg as { terminal_reason?: unknown }).terminal_reason;
  const limitByMetadata =
    /budget|limit/i.test(subtype) ||
    (typeof terminalReason === "string" && /budget|limit|exhaust/i.test(terminalReason));
  const reason: RunEndReason = limitByMetadata || /limit/i.test(message) ? "limit" : "error";
  return { reason, message };
}

// --- message translation --------------------------------------------------

function usageNumber(usage: Record<string, unknown> | undefined, key: string): number {
  const v = usage?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// The context ring's event (v2 spec): what the model's context holds
// after this message -- input plus both cache buckets of its usage.
function contextUsageFrom(
  runId: string,
  state: RunTranslationState,
  usage: Record<string, unknown> | undefined,
): CanonicalEvent {
  const input = usageNumber(usage, "input_tokens");
  const cached = usageNumber(usage, "cache_creation_input_tokens") + usageNumber(usage, "cache_read_input_tokens");
  return {
    kind: "context_usage",
    payload: {
      run_id: runId,
      model: state.model,
      used_tokens: input + cached,
      max_tokens: state.contextMaxTokens,
      input_tokens: input,
      cached_tokens: cached,
      output_tokens: usageNumber(usage, "output_tokens"),
    },
  };
}

async function translateAssistantMessage(
  msg: Extract<SDKMessage, { type: "assistant" }>,
  state: RunTranslationState,
  cwd: string,
  runId: string,
  sink: EventSink,
  now: () => number,
): Promise<void> {
  const message = msg.message as { model?: unknown; usage?: unknown; content?: unknown };
  if (typeof message.model === "string") state.model = message.model;
  const blocks = message.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      sink({ kind: "assistant_message", payload: { text: block.text } });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      const startedAt = state.reasoningStartedAt;
      state.reasoningStartedAt = null;
      sink({
        kind: "reasoning",
        payload:
          startedAt === null
            ? { summary: block.thinking }
            : { summary: block.thinking, duration_ms: Math.max(0, now() - startedAt) },
      });
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
  sink(contextUsageFrom(runId, state, message.usage as Record<string, unknown> | undefined));
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

function translateStreamEvent(
  msg: Extract<SDKMessage, { type: "stream_event" }>,
  state: RunTranslationState,
  runId: string,
  sink: EventSink,
  now: () => number,
): void {
  const event = msg.event;
  if (event.type !== "content_block_delta") return;
  const delta = event.delta;
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    sink({ type: "delta", run_id: runId, channel: "text", text: delta.text });
  } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    if (state.reasoningStartedAt === null) state.reasoningStartedAt = now();
    sink({ type: "delta", run_id: runId, channel: "reasoning", text: delta.thinking });
  }
}

// Signals the child's whole process group (it is spawned detached, i.e. as
// its own group leader, so `-pid` reaches every helper it forked too);
// falls back to the pid alone when the group is already gone. Never
// throws: a process that exited between the liveness check and the signal
// is exactly the outcome wanted.
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // No such group (or not a group leader on this platform) -- try the
    // process itself.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

// --- adapter ---------------------------------------------------------------

export function createClaudeAdapter(deps: CreateClaudeAdapterDeps = {}): RunnerAdapter {
  const query = deps.query ?? sdkQuery;
  const exec = deps.exec ?? nodeExecFile;
  const resolveExecutable = deps.resolveExecutable ?? (() => resolveClaudeExecutable());
  const closePollIntervalMs = deps.closePollIntervalMs ?? DEFAULT_CLOSE_POLL_INTERVAL_MS;
  const closeTimeoutMs = deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const closeGraceMs = deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const closeTermMs = deps.closeTermMs ?? DEFAULT_CLOSE_TERM_MS;
  const now = deps.now ?? Date.now;
  // #376: filled from the first live run's own Query.supportedModels() --
  // null until then (and re-attempted on the next run if that call itself
  // failed), never re-fetched once it holds a real list.
  let modelsCache: RunnerModel[] | null = null;

  async function models(): Promise<RunnerModel[]> {
    return modelsCache ?? [...CLAUDE_ALIAS_MODELS];
  }

  async function runExec(executable: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
    return new Promise((resolve) => {
      exec(executable, args, { timeout: DETECT_TIMEOUT_MS }, (err, stdout) => {
        resolve({ ok: !err, stdout: stdout?.toString() ?? "" });
      });
    });
  }

  const notInstalled: RunnerAvailability = {
    installed: false,
    version: null,
    logged_in: false,
    instances_supported: true,
  };

  async function detect(): Promise<RunnerAvailability> {
    const executable = await resolveExecutable();
    if (executable === null) return notInstalled;
    const versionResult = await runExec(executable, ["--version"]);
    if (!versionResult.ok) return notInstalled;
    const version = versionResult.stdout.trim().split("\n")[0] || null;
    const authResult = await runExec(executable, ["auth", "status"]);
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

      // The run is already over (the SDK can still call this from a turn
      // that was in flight when the iterator finished): nobody is left to
      // answer, so deny instead of parking a promise nothing will resolve.
      if (state.ended) return { behavior: "deny", message: "Běh skončil dřív, než přišla odpověď." };
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

    // An MCP server's confirmation dialog (Portuni's scope expansion and
    // write access) is asked in the chat like any other question; the
    // answer comes back through handle.answer().
    async function onElicitation(
      request: ElicitationRequest,
      options: { signal: AbortSignal; requestId: string },
    ): Promise<ElicitationResult> {
      const fields = booleanFormFields(request);
      if (fields === null) return { action: "decline" };
      if (state.ended) return { action: "cancel" };
      const requestId = options.requestId;
      sink({
        kind: "question",
        payload: {
          request_id: requestId,
          type: "approval",
          tool: `mcp__${request.serverName}`,
          title: request.title ?? `Potvrzení: ${request.displayName ?? request.serverName}`,
          detail: request.message,
          options: null,
          decision: null,
        },
      });
      return new Promise<ElicitationResult>((resolve) => {
        const settle = (result: ElicitationResult) => {
          state.pendingElicitations.delete(requestId);
          resolve(result);
        };
        state.pendingElicitations.set(requestId, (result) =>
          settle(
            result.action === "accept"
              ? { action: "accept", content: Object.fromEntries(fields.map((f) => [f, true])) }
              : result,
          ),
        );
        options.signal.addEventListener("abort", () => settle({ action: "cancel" }), { once: true });
      });
    }

    async function preCompactHook(input: HookInput): Promise<HookJSONOutput> {
      if (input.hook_event_name === "PreCompact") {
        sink({ kind: "compaction", payload: { trigger: input.trigger === "manual" ? "manual" : "auto" } });
      }
      return {};
    }

    // Overrides the SDK's own spawn for two reasons: to capture the pid
    // (the runtime's pid file, close()'s liveness race) and to put the
    // child in its own process group (spec, "Process lifecycle"), so
    // close()'s SIGTERM/SIGKILL reaches the CLI and every helper it forked,
    // never this sidecar's own group. `detached` on its own does not
    // unref the child -- the SDK still owns its stdio and lifetime.
    function spawnClaudeCodeProcess(spawnOptions: SpawnOptions): SpawnedProcess {
      const child = nodeSpawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        detached: process.platform !== "win32",
      });
      state.capturedPid = child.pid ?? null;
      return child as unknown as SpawnedProcess;
    }

    const executable = await resolveExecutable();
    const options: Options = {
      cwd: run.cwd,
      ...(executable !== null ? { pathToClaudeCodeExecutable: executable } : {}),
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
      onElicitation,
      env: buildEnv(run.instance.env),
      hooks: { PreCompact: [{ hooks: [preCompactHook] }] },
      spawnClaudeCodeProcess,
      ...(run.model !== null ? { model: run.model } : {}),
      ...(run.effort !== null ? { effort: run.effort } : {}),
      ...(run.resume
        ? {
            resume: run.resume.agentSessionId,
            ...(run.resume.at !== undefined ? { resumeSessionAt: run.resume.at } : {}),
          }
        : {}),
    };

    const q: Query = query({ prompt: promptQueue, options });

    // #376: fire-and-forget -- never blocks this run on the picker's own
    // data. A failure here just leaves modelsCache null, so models() keeps
    // serving the alias fallback and the next run's start() tries again.
    // Deferred into the promise chain itself (Promise.resolve().then(...))
    // rather than calling q.supportedModels() directly, so a query mock
    // that doesn't implement it (an older SDK, or a test double) rejects
    // instead of throwing synchronously past the .catch below.
    if (modelsCache === null) {
      void Promise.resolve()
        .then(() => q.supportedModels())
        .then((list) => {
          modelsCache = list.map((m) => ({
            id: m.value,
            displayName: m.displayName,
            description: m.description,
            supportsEffort: m.supportsEffort ?? false,
            effortLevels: m.supportedEffortLevels ?? [],
          }));
        })
        .catch(() => undefined);
    }

    async function translateMessage(msg: SDKMessage): Promise<void> {
      if (msg.type === "system" && msg.subtype === "init") {
        state.agentSessionId = msg.session_id;
        for (const server of msg.mcp_servers ?? []) {
          if (isClaudeAiPortuniServer(server.name)) {
            void Promise.resolve()
              .then(() => q.toggleMcpServer(server.name, false))
              .catch(() => undefined);
          }
        }
        return;
      }
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        sink({ kind: "compaction", payload: { trigger: "auto" } });
        return;
      }
      if (msg.type === "assistant") {
        await translateAssistantMessage(msg, state, run.cwd, run.runId, sink, now);
        return;
      }
      if (msg.type === "user") {
        translateUserMessage(msg, state, sink);
        return;
      }
      if (msg.type === "stream_event") {
        translateStreamEvent(msg, state, run.runId, sink, now);
        return;
      }
      if (msg.type === "result") {
        state.latestUsage = { usage: msg.usage, total_cost_usd: msg.total_cost_usd };
        // The window comes with the result's per-model usage; the ring
        // shows a bare count until the first one (spec, known gaps).
        const modelUsage = (msg as { modelUsage?: Record<string, { contextWindow?: unknown }> }).modelUsage ?? {};
        const entry = state.model ? modelUsage[state.model] : Object.values(modelUsage)[0];
        if (entry && typeof entry.contextWindow === "number") state.contextMaxTokens = entry.contextWindow;
        sink(contextUsageFrom(run.runId, state, msg.usage as unknown as Record<string, unknown> | undefined));
        // #411: a provider limit/error ends the run. The provider's own text
        // goes into the transcript once, then the prompt stream is ended so
        // the CLI exits and the translate loop below reports the run_ended
        // this reason belongs to; endAfterProviderFailure is the bound on a
        // child that ignores the end of its stdin.
        const failure = providerResultFailure(msg);
        if (failure !== null && state.providerEndReason === null) {
          state.providerEndReason = failure.reason;
          sink({ kind: "error", payload: { class: "provider", message: failure.message } });
          void endAfterProviderFailure(failure.reason);
        } else if (failure === null) {
          // The turn is over and the process waits for the next prompt: say
          // so, or the surface keeps showing the run as working.
          sink({ kind: "turn_ended", payload: { run_id: run.runId } });
        }
      }
    }

    // Emits the run's single run_ended, whichever path gets here first.
    function emitRunEnded(reason: RunEndReason): void {
      if (state.runEndedEmitted) return;
      state.runEndedEmitted = true;
      sink({ kind: "run_ended", payload: { run_id: run.runId, reason, usage: state.latestUsage } });
    }

    // Marks the run over and settles every SDK-side awaiter (a question
    // nobody answered would otherwise stay pending forever -- spec: "blocks
    // ... until answered or the run ends"). Idempotent.
    function finalizeEnded(): void {
      if (state.ended) return;
      state.ended = true;
      for (const [requestId, pending] of state.pendingPermissions) {
        state.pendingPermissions.delete(requestId);
        pending.resolve({ behavior: "deny", message: "Běh skončil dřív, než přišla odpověď." });
      }
      for (const settle of [...state.pendingElicitations.values()]) settle({ action: "cancel" });
      state.endedResolve();
    }

    // #411: the teardown a provider failure triggers. Normally the child
    // exits on the end of its prompt stream, the iterator finishes and the
    // loop's own completion reports the run end; this only has work left
    // when it does not -- then the escalation kills it and the run is ended
    // here instead of hanging live forever, which is the bug this fixes.
    async function endAfterProviderFailure(reason: RunEndReason): Promise<void> {
      try {
        await shutdownProcess();
      } catch {
        // Best-effort -- the run still has to end below.
      }
      if (state.ended) return;
      emitRunEnded(reason);
      finalizeEnded();
    }

    void (async () => {
      try {
        for await (const msg of q) {
          await translateMessage(msg);
        }
        // #378: the loop only ends naturally once the prompt queue itself
        // ends (close()'s own job) -- interrupt() no longer touches the
        // queue, so this is always a graceful close. session-runtime.ts's
        // own withSuspendReason is what rewrites this to "suspended" when
        // the close wasn't an explicit Uzavřít/continue. #411: a provider
        // failure ended the queue itself and left its own reason behind,
        // which withSuspendReason leaves untouched.
        emitRunEnded(state.providerEndReason ?? "completed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // #411: on a provider failure the provider's own message is already
        // in the transcript and this throw is a consequence of the teardown
        // it triggered -- exactly one error event per run.
        if (state.providerEndReason === null) {
          if (notLoggedInMessage(message)) {
            sink({
              kind: "error",
              payload: { class: "provider", message: "Claude Code není přihlášený na tomto zařízení." },
            });
          } else {
            sink({ kind: "error", payload: { class: "unknown", message } });
          }
        }
        emitRunEnded(state.providerEndReason ?? "error");
      } finally {
        finalizeEnded();
      }
    })();

    // Waits up to `ms` for the run to end on its own; true when it did.
    async function endedWithin(ms: number): Promise<boolean> {
      const abort = new AbortController();
      try {
        await Promise.race([
          state.endedPromise,
          waitForPidDeadOrTimeout(state.capturedPid, closePollIntervalMs, ms, abort.signal),
        ]);
      } finally {
        abort.abort();
      }
      return state.ended || (state.capturedPid !== null && !isProcessAlive(state.capturedPid));
    }

    // Spec, "Process lifecycle": end stdin (the prompt stream), 2 s,
    // SIGTERM, 5 s, SIGKILL. Each step is skipped as soon as the run ends
    // on its own or the child is confirmed dead; a run whose child is
    // already gone (crashed, killed out of band) therefore returns almost
    // immediately instead of waiting for the SDK's own iterator to notice.
    // Shared by close() and #411's provider-failure teardown.
    async function shutdownProcess(): Promise<void> {
      if (state.ended) return;
      promptQueue.end();
      if (await endedWithin(closeGraceMs)) return;
      if (state.capturedPid === null) {
        // Nothing to signal (the pid was never captured): fall back to the
        // bounded wait for the SDK to finish.
        await endedWithin(closeTimeoutMs);
        return;
      }
      signalProcessGroup(state.capturedPid, "SIGTERM");
      if (await endedWithin(closeTermMs)) return;
      signalProcessGroup(state.capturedPid, "SIGKILL");
      await endedWithin(closeTimeoutMs);
    }

    const handle: RunHandle = {
      async send(text: string): Promise<void> {
        promptQueue.push(userMessage(text));
      },
      async answer(requestId: string, decision: QuestionDecision): Promise<void> {
        const elicitation = state.pendingElicitations.get(requestId);
        if (elicitation) {
          elicitation(decision.value === true ? { action: "accept" } : { action: "decline" });
          return;
        }
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
      // #378 ("Stop, not Přerušit"): cancels the CURRENT TURN only
      // (Query.interrupt()) -- the process, the prompt queue and the run
      // all stay alive, so the very next send() is an ordinary message.
      // Ending the queue (and therefore the run) belongs to close() alone.
      async interrupt(): Promise<void> {
        if (state.ended) return;
        try {
          await q.interrupt();
        } catch {
          // Best-effort -- the process may already be gone.
        }
      },
      async close(): Promise<void> {
        await shutdownProcess();
      },
      async setModel(model: string | null): Promise<void> {
        if (state.ended) return;
        await q.setModel(model ?? undefined);
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

  return { id: "claude", detect, start, models };
}
