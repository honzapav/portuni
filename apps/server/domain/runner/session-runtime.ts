// The session runtime (spec: "session-runtime.ts"): the only writer of
// runs and events. Everything the REST/live-channel layer (a later issue)
// does is a thin call into the object this factory returns -- no SQL, no
// adapter calls, no orientation-building happens outside this module and
// provision.ts/store.ts.
//
// Live runs are held in an in-memory Map, not persisted: a process restart
// loses the handle (the pid-sweep issue, #325, is what notices and marks
// such a run host_lost). Every canonical event from an adapter's sink is
// funneled through a per-session serial queue before it touches the store,
// so two events emitted back-to-back (or a close()'s own run_ended firing
// while a caller is still awaiting a different runtime method) are
// persisted and published in emission order, never interleaved.

import { getDb } from "../../infra/db.js";
import { getSessionScope, threadNameFromFirstMessage } from "../sessions.js";
import { suspendSessionServerSide, type ServerHandoffReason } from "../session-handoff.js";
import type { SessionRow } from "../../shared/types.js";
import type { ListEventsOptions, SessionEventRow, SessionRunRow, SessionStore } from "./store.js";
import { detectAll } from "./registry.js";
import { getInstanceEnv, listInstances } from "./instances.js";
import { resolveRunnerDataDir } from "./data-dir.js";
import { removePidFile, writePidFile } from "./pid-file.js";
import type { ProvisionRunInput, ProvisionRunResult, ProvisionRunResumeInfo } from "./provision.js";
import type {
  CanonicalEvent,
  DeltaFrame,
  PermissionPolicy,
  QuestionDecision,
  RunHandle,
  RunStart,
  RunnerAdapter,
} from "./types.js";

// Moved from apps/web/src/lib/session-suspend.ts (the web copy is deleted
// once the terminal removal phase lands) -- the one instruction every
// suspend path sends the runner, asking the agent to write its own handoff
// and call portuni_session_suspend before the server gives up and writes a
// minimal one itself.
export const SUSPEND_INSTRUCTION =
  "Please suspend this session now: call portuni_session_suspend with a brief handoff summary of where you left off, then stop.";

const DEFAULT_SUSPEND_TIMEOUT_MS = 30_000;
const DEFAULT_SUSPEND_POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A draft's first message (#374) has no runner/instance chosen up front --
// the spec's "a thread opens empty: no modal, no required field" rules out
// a picker before then, so sendMessage resolves both itself, the same rule
// NewTaskDialog used to apply client-side before it was removed: the first
// installed-and-logged-in runner, and the node's organization's default
// instance for it, if one is set.
export class NoRunnerAvailableError extends Error {}

// session_scope's own graceful-degrade comment above explains why this is
// wrapped in try/catch the same way: edges/nodes are graph-db tables that
// simply do not exist in agent mode (no local graph db there), so this
// resolves to "no organization" rather than failing the whole promotion.
async function resolveNodeOrgId(nodeId: string): Promise<string | null> {
  try {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT e.target_id FROM edges e JOIN nodes n ON n.id = e.target_id
            WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization' LIMIT 1`,
      args: [nodeId],
    });
    return res.rows.length > 0 ? String(res.rows[0].target_id) : null;
  } catch {
    return null;
  }
}

async function resolveTaskDefaults(nodeId: string): Promise<{ runner: string; instanceId: string | null }> {
  const detections = await detectAll();
  const usable = detections.find((d) => d.availability.installed && d.availability.logged_in);
  if (!usable) {
    throw new NoRunnerAvailableError("no runner is installed and logged in on this device");
  }
  const orgId = await resolveNodeOrgId(nodeId);
  const instances = await listInstances();
  const forRunner = instances.filter((i) => i.runner === usable.id);
  const orgDefault = orgId ? forRunner.find((i) => i.org_defaults.includes(orgId)) : undefined;
  return { runner: usable.id, instanceId: orgDefault?.id ?? null };
}

export interface RunnerRegistryLookup {
  getAdapter(id: string): RunnerAdapter | null;
}

// A published canonical event carries the seq the store assigned it (the
// live channel, api/sessions-ws.ts, needs this to reconcile a buffered live
// event against the replay-from-`after` it raced) -- a delta never persists,
// so it never gets one.
export type PublishedEvent = (CanonicalEvent & { seq: number }) | DeltaFrame;
export type RuntimeListener = (sessionId: string, event: PublishedEvent) => void;

export interface CreateSessionRuntimeDeps {
  store: SessionStore;
  registry: RunnerRegistryLookup;
  provision: (input: ProvisionRunInput) => Promise<ProvisionRunResult>;
  // Test-only overrides for the suspend() poll loop -- production leaves
  // these at their 1s/30s defaults.
  suspendPollIntervalMs?: number;
  suspendTimeoutMs?: number;
  // What suspend() falls back to when no handoff arrived in time (spec:
  // "the server generates one from the session record"). Defaults to the
  // local-mode implementation (suspendSessionServerSide against the graph
  // db); boot/session-runtime.ts's createAgentSessionRuntime supplies
  // domain/runner/suspend-fallback-central.ts's version instead, since
  // agent mode has no graph db to write against.
  suspendFallback?: (sessionId: string, reason: ServerHandoffReason) => Promise<SessionRow | null>;
}

export interface StartTaskInput {
  userId: string;
  nodeId: string;
  brief: string;
  runner: string;
  instanceId?: string | null;
  policy?: PermissionPolicy;
}

export interface SessionSignals {
  // Age of the live run, or null when the session has none.
  runAgeMs: number | null;
  writeSetSize: number;
  readSetSize: number;
  // Growth of the read set since the live run started -- 0 when there is
  // no live run or nothing has been added since it started.
  expansionsSinceRunStart: number;
}

type QuestionPayload = Extract<CanonicalEvent, { kind: "question" }>["payload"];

export interface SessionRuntime {
  startTask(input: StartTaskInput): Promise<{ session: SessionRow; run: SessionRunRow }>;
  // Plain read-through to the store -- agent-router.ts's REST handlers have
  // no local db of their own to re-fetch a session row from after a
  // mutation the way api/sessions.ts's handlers do, so they go through this
  // instead (local mode's own handlers still use domain/sessions.ts's
  // getSession directly; this exists for the agent-mode caller).
  getSession(sessionId: string): Promise<SessionRow | null>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  answer(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  suspend(sessionId: string): Promise<SessionRow>;
  resume(sessionId: string, mode: "conversation" | "handoff"): Promise<SessionRunRow>;
  closeSession(sessionId: string): Promise<SessionRow>;
  subscribe(target: string, listener: RuntimeListener): () => void;
  sessionSignals(sessionId: string): Promise<SessionSignals>;
  // The session's currently open question, or null -- lets a caller (the
  // REST answer route) validate a request_id against the actually-pending
  // question before forwarding a decision to the adapter.
  pendingQuestion(sessionId: string): QuestionPayload | null;
  // Access table (remote-hosts-and-task-queue-design spec, "Visibility and
  // control"): appends a state_changed event naming the actor for an
  // interrupt/suspend/close performed by someone other than the session's
  // owner -- called by the REST route right after the action succeeds, so
  // "from"/"to" reflect the actor, not a real state transition.
  recordStoppedBy(sessionId: string, by: string): Promise<void>;
  listEvents(sessionId: string, opts?: ListEventsOptions): Promise<SessionEventRow[]>;
  // Number of live listeners currently registered for `target` (a session
  // id, or "*" for the global one) -- the live channel (api/sessions-ws.ts)
  // uses this only in tests, to assert a closed socket's subscription was
  // actually dropped rather than leaked.
  subscriberCount(target: string): number;
}

interface LiveRun {
  handle: RunHandle;
  runId: string;
}

export function createSessionRuntime(deps: CreateSessionRuntimeDeps): SessionRuntime {
  const { store, registry, provision } = deps;
  const suspendPollIntervalMs = deps.suspendPollIntervalMs ?? DEFAULT_SUSPEND_POLL_INTERVAL_MS;
  const suspendTimeoutMs = deps.suspendTimeoutMs ?? DEFAULT_SUSPEND_TIMEOUT_MS;
  const suspendFallback =
    deps.suspendFallback ?? ((sessionId: string, reason: ServerHandoffReason) => suspendSessionServerSide(getDb(), sessionId, reason));

  const liveRuns = new Map<string, LiveRun>();
  // The still-open question for a session, keyed by session id -- captured
  // from the question event's own payload so answer() can re-append it
  // with the decision filled in without re-deriving title/detail/options.
  const pendingQuestions = new Map<string, Extract<CanonicalEvent, { kind: "question" }>["payload"]>();
  // Read-set size at the moment a run started, keyed by run id -- the
  // baseline sessionSignals' expansionsSinceRunStart grows from.
  const runStartScopeSize = new Map<string, number>();
  const subscribers = new Map<string, Set<RuntimeListener>>();
  // Per-session serial dispatch: every appendAndPublish for a session
  // chains onto this so emission order survives concurrent sink calls.
  const queues = new Map<string, Promise<void>>();
  // Sessions a suspend() is in progress for: the run_ended the adapter's
  // close() emits during a suspend is recorded as "suspended", not the
  // adapter's own "completed" -- the adapter cannot know why it was closed.
  const suspending = new Set<string>();

  function publish(sessionId: string, event: PublishedEvent): void {
    for (const listener of subscribers.get(sessionId) ?? []) listener(sessionId, event);
    for (const listener of subscribers.get("*") ?? []) listener(sessionId, event);
  }

  // session_scope only exists on the local graph db; agent mode has none.
  // Degrades to 0 (empty scope) rather than failing the caller -- this
  // feeds the restart indicator's "expansions since run start" signal
  // only, never a correctness-load-bearing decision.
  async function readSessionScopeSize(sessionId: string): Promise<number> {
    try {
      return (await getSessionScope(getDb(), sessionId)).length;
    } catch {
      return 0;
    }
  }

  // Returns the task's own promise (rejecting when it fails) so a caller
  // that awaits it -- sendMessage/answer -- sees the store error; the
  // chain itself swallows the failure so events queued after it still run.
  function enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const result = prev.then(task, task);
    queues.set(
      sessionId,
      result.catch(() => undefined),
    );
    return result;
  }

  function drain(sessionId: string): Promise<void> {
    return queues.get(sessionId) ?? Promise.resolve();
  }

  async function appendAndPublish(
    sessionId: string,
    runId: string | null,
    events: CanonicalEvent[],
  ): Promise<void> {
    const seqs = await store.appendEvents(sessionId, runId, events);
    events.forEach((event, i) => {
      publish(sessionId, { ...event, seq: seqs[i] });
    });
  }

  function subscribe(target: string, listener: RuntimeListener): () => void {
    let set = subscribers.get(target);
    if (!set) {
      set = new Set();
      subscribers.set(target, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  async function mustGetSession(sessionId: string): Promise<SessionRow> {
    const row = await store.getSession(sessionId);
    if (!row) throw new Error(`session ${sessionId} not found`);
    return row;
  }

  async function clearWaitingIfPending(sessionId: string, runId: string | null): Promise<void> {
    if (!pendingQuestions.has(sessionId)) return;
    pendingQuestions.delete(sessionId);
    await store.patchSession(sessionId, { waiting_since: null });
    await appendAndPublish(sessionId, runId, [
      { kind: "state_changed", payload: { from: "running", to: "running", waiting: false } },
    ]);
  }

  async function handleAdapterEvent(
    sessionId: string,
    runId: string,
    event: CanonicalEvent | DeltaFrame,
  ): Promise<void> {
    if ("type" in event && event.type === "delta") {
      publish(sessionId, event);
      return;
    }
    const canonical = event as CanonicalEvent;
    await appendAndPublish(sessionId, runId, [canonical]);

    if (canonical.kind === "question") {
      pendingQuestions.set(sessionId, canonical.payload);
      await store.patchSession(sessionId, { waiting_since: new Date().toISOString() });
      await appendAndPublish(sessionId, runId, [
        { kind: "state_changed", payload: { from: "running", to: "running", waiting: true } },
      ]);
      return;
    }

    if (canonical.kind === "run_ended") {
      // Captured before the entry is removed: the adapter may only expose
      // the runner's own conversation id once the run is actually over
      // (a real CLI's translation learns it from an early protocol
      // message, but the value is only load-bearing at resume time, so
      // reading it here -- once, at run end -- is enough either way).
      const live = liveRuns.get(sessionId);
      const agentSessionId = live?.runId === runId ? live.handle.agentSessionId() : null;
      liveRuns.delete(sessionId);
      runStartScopeSize.delete(runId);
      await store.patchRun(runId, {
        ended_at: new Date().toISOString(),
        end_reason: canonical.payload.reason,
        usage: canonical.payload.usage,
        ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
      });
      await removePidFile(resolveRunnerDataDir(), runId).catch(() => undefined);
      await clearWaitingIfPending(sessionId, runId);
    }
  }

  // A run closed by suspend() ends as "suspended" whatever the adapter's
  // close() reported (the fake, and any graceful close, says "completed").
  function withSuspendReason(sessionId: string, event: CanonicalEvent | DeltaFrame): CanonicalEvent | DeltaFrame {
    if ("kind" in event && event.kind === "run_ended" && suspending.has(sessionId)) {
      return { kind: "run_ended", payload: { ...event.payload, reason: "suspended" } };
    }
    return event;
  }

  function makeSink(sessionId: string, runId: string) {
    return (event: CanonicalEvent | DeltaFrame): void => {
      // The chain has already swallowed the failure; nothing awaits a sink.
      enqueue(sessionId, () => handleAdapterEvent(sessionId, runId, withSuspendReason(sessionId, event))).catch(
        () => undefined,
      );
    };
  }

  async function startRun(
    session: SessionRow,
    run: SessionRunRow,
    provisioned: ProvisionRunResult,
    instanceEnv: Record<string, string>,
    opts: {
      brief: string | null;
      runStartResume: RunStart["resume"];
      resumeMode: null | "conversation" | "handoff";
      policy: PermissionPolicy;
    },
  ): Promise<void> {
    const adapter = registry.getAdapter(run.runner);
    if (!adapter) throw new Error(`startRun: unknown runner '${run.runner}'`);

    // session_scope is a local graph-db table; agent mode has none, so the
    // restart indicator's "expansions since run start" signal degrades to 0
    // there rather than failing the whole run start.
    runStartScopeSize.set(run.id, await readSessionScopeSize(session.id));

    await appendAndPublish(session.id, run.id, [
      {
        kind: "run_started",
        payload: {
          run_id: run.id,
          runner: run.runner,
          instance_id: run.instance_id,
          resume: opts.resumeMode,
        },
      },
    ]);
    if (opts.brief !== null) {
      await appendAndPublish(session.id, run.id, [
        { kind: "user_message", payload: { text: opts.brief, source: "chat" } },
      ]);
    }

    const runStart: RunStart = {
      sessionId: session.id,
      runId: run.id,
      cwd: provisioned.cwd,
      brief: opts.brief,
      resume: opts.runStartResume,
      orientation: provisioned.orientation,
      instance: { id: run.instance_id, env: instanceEnv },
      mcp: { ...provisioned.mcp, headers: { "X-Portuni-Spawn-Id": session.id } },
      policy: opts.policy,
      portuniRoot: provisioned.portuniRoot,
      mirrors: provisioned.mirrors,
    };

    const handle = await adapter.start(runStart, makeSink(session.id, run.id));
    liveRuns.set(session.id, { handle, runId: run.id });
    // Written before drain() lets any already-queued run_ended handler
    // remove it, so write-then-remove ordering always holds even for a
    // wait-free script. A null pid (the fake adapter, or a real one that
    // hasn't spawned yet) means the boot sweep simply has nothing to find
    // for this run -- best-effort, not a correctness requirement.
    const pid = handle.pid();
    if (pid !== null) await writePidFile(resolveRunnerDataDir(), run.id, pid).catch(() => undefined);
    // A script-driven (or otherwise fast) adapter may already have emitted
    // events synchronously during start() -- e.g. a wait-free fake script
    // runs to completion, including its own run_ended, before start()
    // returns. Draining here means a caller awaiting startTask()/resume()
    // sees the fully persisted result, not a still-in-flight background
    // write.
    await drain(session.id);
  }

  async function startTask(input: StartTaskInput): Promise<{ session: SessionRow; run: SessionRunRow }> {
    const instanceId = input.instanceId ?? null;
    const session = await store.createSession({
      node_id: input.nodeId,
      user_id: input.userId,
      brief: input.brief,
      runner: input.runner,
      instance_id: instanceId,
      host_id: null,
    });

    const provisioned = await provision({
      userId: input.userId,
      nodeId: input.nodeId,
      sessionId: session.id,
      resume: null,
    });

    const run = await store.createRun({
      session_id: session.id,
      runner: input.runner,
      instance_id: instanceId,
      host_id: null,
    });

    const instanceEnv = instanceId ? ((await getInstanceEnv(instanceId)) ?? {}) : {};

    await startRun(session, run, provisioned, instanceEnv, {
      brief: input.brief,
      runStartResume: null,
      resumeMode: null,
      policy: input.policy ?? "default",
    });

    return { session, run };
  }

  // The user's own message goes through the same per-session queue as the
  // adapter's events, and is handed to the adapter only once persisted --
  // so whatever the runner emits in reaction to it can never land before it.
  async function sendMessage(sessionId: string, text: string): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (live) {
      await enqueue(sessionId, () =>
        appendAndPublish(sessionId, live.runId, [{ kind: "user_message", payload: { text, source: "chat" } }]),
      );
      await live.handle.send(text);
      return;
    }
    await promoteDraftAndStart(sessionId, text);
  }

  // A thread is a session row from the moment it opens (#374, "the session
  // row exists from the moment the thread opens"): the first message is
  // what promotes a draft to running and starts its first run, resolving
  // runner/instance the same way startTask's caller used to before it was
  // chosen up front in a now-removed dialog. Any other session with no live
  // run (a thread whose run has already ended) is out of this issue's scope
  // -- #378 teaches that case to resume-by-writing; today it still refuses.
  async function promoteDraftAndStart(sessionId: string, text: string): Promise<void> {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`sendMessage: session ${sessionId} not found`);
    if (session.state !== "draft") throw new Error(`sendMessage: session ${sessionId} has no live run`);
    if (!session.node_id) throw new Error(`sendMessage: draft session ${sessionId} has no anchor node`);

    const { runner, instanceId } = await resolveTaskDefaults(session.node_id);
    const updated = await store.patchSession(sessionId, {
      state: "running",
      brief: text,
      runner,
      instance_id: instanceId,
      // Naming (#374): the thread names itself from its first message,
      // protected the same way a manual rename is so a later handoff-title
      // enrichment at suspend never overwrites it.
      name: threadNameFromFirstMessage(text),
      name_is_custom: true,
    });

    // Published so the live channel's session_state broadcast fires
    // (api/sessions-ws.ts only reacts to state_changed/question/run_ended) --
    // without it, a window that isn't this one showing the draft's thread
    // (the sidebar sub-row, Relace, Přehled) would never learn it was
    // promoted until its next unrelated refetch.
    await appendAndPublish(sessionId, null, [
      { kind: "state_changed", payload: { from: "draft", to: "running", waiting: false } },
    ]);

    const provisioned = await provision({
      userId: updated.user_id,
      nodeId: session.node_id,
      sessionId,
      resume: null,
    });
    const run = await store.createRun({ session_id: sessionId, runner, instance_id: instanceId, host_id: null });
    const instanceEnv = instanceId ? ((await getInstanceEnv(instanceId)) ?? {}) : {};

    await startRun(updated, run, provisioned, instanceEnv, {
      brief: text,
      runStartResume: null,
      resumeMode: null,
      policy: "default",
    });
  }

  // Same ordering rule: the answered question (and the waiting: false
  // state) is recorded before the adapter learns the decision.
  async function answer(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live) throw new Error(`answer: session ${sessionId} has no live run`);

    const pending = pendingQuestions.get(sessionId);
    if (pending && pending.request_id === requestId) {
      await enqueue(sessionId, async () => {
        await appendAndPublish(sessionId, live.runId, [{ kind: "question", payload: { ...pending, decision } }]);
        await clearWaitingIfPending(sessionId, live.runId);
      });
    }
    await live.handle.answer(requestId, decision);
  }

  async function interrupt(sessionId: string): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live) return;
    await live.handle.interrupt();
    await drain(sessionId);
  }

  async function closeSession(sessionId: string): Promise<SessionRow> {
    const live = liveRuns.get(sessionId);
    if (live) {
      await live.handle.interrupt();
      await drain(sessionId);
    }
    return store.patchSession(sessionId, { state: "closed" });
  }

  async function pollUntilSuspended(sessionId: string): Promise<boolean> {
    const deadline = Date.now() + suspendTimeoutMs;
    for (;;) {
      const row = await store.getSession(sessionId);
      if (row?.state === "suspended") return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(suspendPollIntervalMs, Math.max(deadline - Date.now(), 0)));
    }
  }

  async function suspend(sessionId: string): Promise<SessionRow> {
    const live = liveRuns.get(sessionId);
    const runId = live?.runId ?? (await store.liveRun(sessionId))?.id ?? null;

    suspending.add(sessionId);
    try {
      await enqueue(sessionId, () =>
        appendAndPublish(sessionId, runId, [
          { kind: "user_message", payload: { text: SUSPEND_INSTRUCTION, source: "system" } },
        ]),
      );
      if (live) await live.handle.send(SUSPEND_INSTRUCTION);

      const reachedSuspended = await pollUntilSuspended(sessionId);

      let handoffEvent: CanonicalEvent;
      if (reachedSuspended) {
        const session = await mustGetSession(sessionId);
        handoffEvent = {
          kind: "handoff",
          payload: { path: session.handoff_path, hash: session.handoff_hash, generated_by: "agent" },
        };
      } else {
        // The same server-written fallback every other server-side suspend
        // uses locally (#329): a file in the mirror when this device has
        // one, handoff_inline otherwise, marked with its reason either
        // way. suspendFallback is the agent-mode-aware seam (default:
        // suspendSessionServerSide against the graph db).
        const session = await suspendFallback(sessionId, "suspend_timeout");
        if (!session) throw new Error(`suspend: session ${sessionId} not found`);
        handoffEvent = {
          kind: "handoff",
          payload: { path: session.handoff_path, hash: session.handoff_hash, generated_by: "server" },
        };
      }

      if (live) {
        await live.handle.close();
        await drain(sessionId);
      }

      await enqueue(sessionId, () => appendAndPublish(sessionId, runId, [handoffEvent]));
    } finally {
      suspending.delete(sessionId);
    }
    return mustGetSession(sessionId);
  }

  async function resume(sessionId: string, mode: "conversation" | "handoff"): Promise<SessionRunRow> {
    const session = await mustGetSession(sessionId);
    if (!session.node_id) throw new Error(`resume: session ${sessionId} has no anchor node`);
    if (await store.liveRun(sessionId)) {
      throw new Error(`resume: session ${sessionId} already has a live run`);
    }

    const runs = await store.listRuns(sessionId);
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
    const runner = session.runner ?? lastRun?.runner;
    if (!runner) throw new Error(`resume: session ${sessionId} has no runner to resume under`);

    let runStartResume: RunStart["resume"] = null;
    let provisionResume: ProvisionRunResumeInfo;
    let agentSessionId: string | null = null;

    if (mode === "conversation") {
      if (!lastRun?.agent_session_id) {
        throw new Error(`resume: session ${sessionId} has no resumable conversation`);
      }
      agentSessionId = lastRun.agent_session_id;
      runStartResume = { agentSessionId };
      provisionResume = { mode: "conversation" };
    } else {
      provisionResume = { mode: "handoff", handoffPath: session.handoff_path };
    }

    const provisioned = await provision({
      userId: session.user_id,
      nodeId: session.node_id,
      sessionId,
      resume: provisionResume,
    });

    const run = await store.createRun({
      session_id: sessionId,
      runner,
      instance_id: session.instance_id,
      host_id: session.host_id,
      resumed_from_run_id: lastRun?.id ?? null,
      agent_session_id: agentSessionId,
    });

    const instanceEnv = session.instance_id ? ((await getInstanceEnv(session.instance_id)) ?? {}) : {};

    await store.patchSession(sessionId, { state: "running" });

    await startRun(session, run, provisioned, instanceEnv, {
      brief: null,
      runStartResume,
      resumeMode: mode,
      policy: "default",
    });

    return run;
  }

  async function sessionSignals(sessionId: string): Promise<SessionSignals> {
    const scope = await getSessionScope(getDb(), sessionId).catch(() => []);
    const writeSetSize = scope.filter((s) => s.writable === 1).length;
    const readSetSize = scope.length;
    const live = liveRuns.get(sessionId);
    let runAgeMs: number | null = null;
    let expansionsSinceRunStart = 0;
    if (live) {
      const run = (await store.listRuns(sessionId)).find((r) => r.id === live.runId);
      if (run) runAgeMs = Date.now() - new Date(run.started_at).getTime();
      const startSize = runStartScopeSize.get(live.runId);
      if (startSize !== undefined) expansionsSinceRunStart = Math.max(0, readSetSize - startSize);
    }
    return { runAgeMs, writeSetSize, readSetSize, expansionsSinceRunStart };
  }

  function pendingQuestion(sessionId: string): QuestionPayload | null {
    return pendingQuestions.get(sessionId) ?? null;
  }

  async function recordStoppedBy(sessionId: string, by: string): Promise<void> {
    const session = await mustGetSession(sessionId);
    const runId = liveRuns.get(sessionId)?.runId ?? (await store.liveRun(sessionId))?.id ?? null;
    await enqueue(sessionId, () =>
      appendAndPublish(sessionId, runId, [
        {
          kind: "state_changed",
          payload: { from: session.state, to: session.state, waiting: session.waiting_since !== null, by },
        },
      ]),
    );
  }

  function listEvents(sessionId: string, opts?: ListEventsOptions): Promise<SessionEventRow[]> {
    return store.listEvents(sessionId, opts);
  }

  function subscriberCount(target: string): number {
    return subscribers.get(target)?.size ?? 0;
  }

  return {
    startTask,
    getSession: (sessionId: string) => store.getSession(sessionId),
    sendMessage,
    answer,
    interrupt,
    suspend,
    resume,
    pendingQuestion,
    recordStoppedBy,
    subscriberCount,
    listEvents,
    closeSession,
    subscribe,
    sessionSignals,
  };
}
