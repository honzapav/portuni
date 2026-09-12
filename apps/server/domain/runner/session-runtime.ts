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
import { getMirrorPath } from "../sync/mirror-registry.js";
import { getSessionScope } from "../sessions.js";
import { writeHandoffAndSuspend } from "../session-handoff.js";
import type { SessionRow } from "../../shared/types.js";
import type { SessionRunRow, SessionStore } from "./store.js";
import { getInstanceEnv } from "./instances.js";
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

export interface RunnerRegistryLookup {
  getAdapter(id: string): RunnerAdapter | null;
}

export type RuntimeListener = (sessionId: string, event: CanonicalEvent | DeltaFrame) => void;

export interface CreateSessionRuntimeDeps {
  store: SessionStore;
  registry: RunnerRegistryLookup;
  provision: (input: ProvisionRunInput) => Promise<ProvisionRunResult>;
  // Test-only overrides for the suspend() poll loop -- production leaves
  // these at their 1s/30s defaults.
  suspendPollIntervalMs?: number;
  suspendTimeoutMs?: number;
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

export interface SessionRuntime {
  startTask(input: StartTaskInput): Promise<{ session: SessionRow; run: SessionRunRow }>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  answer(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  suspend(sessionId: string): Promise<SessionRow>;
  resume(sessionId: string, mode: "conversation" | "handoff"): Promise<SessionRunRow>;
  closeSession(sessionId: string): Promise<SessionRow>;
  subscribe(target: string, listener: RuntimeListener): () => void;
  sessionSignals(sessionId: string): Promise<SessionSignals>;
}

interface LiveRun {
  handle: RunHandle;
  runId: string;
}

export function createSessionRuntime(deps: CreateSessionRuntimeDeps): SessionRuntime {
  const { store, registry, provision } = deps;
  const suspendPollIntervalMs = deps.suspendPollIntervalMs ?? DEFAULT_SUSPEND_POLL_INTERVAL_MS;
  const suspendTimeoutMs = deps.suspendTimeoutMs ?? DEFAULT_SUSPEND_TIMEOUT_MS;

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

  function publish(sessionId: string, event: CanonicalEvent | DeltaFrame): void {
    for (const listener of subscribers.get(sessionId) ?? []) listener(sessionId, event);
    for (const listener of subscribers.get("*") ?? []) listener(sessionId, event);
  }

  function enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    // A failed task must not break the chain for events queued after it,
    // and must not surface as an unhandled rejection either -- the sink
    // that calls this never awaits the result (EventSink is synchronous),
    // so nothing else would ever observe it.
    const next = prev.then(task, task).catch(() => undefined);
    queues.set(sessionId, next);
    return next;
  }

  function drain(sessionId: string): Promise<void> {
    return queues.get(sessionId) ?? Promise.resolve();
  }

  async function appendAndPublish(
    sessionId: string,
    runId: string | null,
    events: CanonicalEvent[],
  ): Promise<void> {
    await store.appendEvents(sessionId, runId, events);
    for (const event of events) publish(sessionId, event);
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
      await clearWaitingIfPending(sessionId, runId);
    }
  }

  function makeSink(sessionId: string, runId: string) {
    return (event: CanonicalEvent | DeltaFrame): void => {
      void enqueue(sessionId, () => handleAdapterEvent(sessionId, runId, event));
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

    runStartScopeSize.set(run.id, (await getSessionScope(getDb(), session.id)).length);

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
      mcp: provisioned.mcp,
      policy: opts.policy,
    };

    const handle = await adapter.start(runStart, makeSink(session.id, run.id));
    liveRuns.set(session.id, { handle, runId: run.id });
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

  async function sendMessage(sessionId: string, text: string): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live) throw new Error(`sendMessage: session ${sessionId} has no live run`);
    await appendAndPublish(sessionId, live.runId, [{ kind: "user_message", payload: { text, source: "chat" } }]);
    await live.handle.send(text);
  }

  async function answer(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live) throw new Error(`answer: session ${sessionId} has no live run`);
    await live.handle.answer(requestId, decision);

    const pending = pendingQuestions.get(sessionId);
    if (pending && pending.request_id === requestId) {
      await appendAndPublish(sessionId, live.runId, [{ kind: "question", payload: { ...pending, decision } }]);
      await clearWaitingIfPending(sessionId, live.runId);
    }
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

  function buildServerHandoffContent(input: {
    sessionName: string;
    nodeId: string;
    writeSet: string[];
    readSet: string[];
    lastActiveAt: string;
  }): string {
    return [
      `# ${input.sessionName}`,
      "",
      `Uzel: ${input.nodeId}`,
      `Poslední aktivita: ${input.lastActiveAt}`,
      "",
      "## Zápisový rozsah",
      input.writeSet.length > 0 ? input.writeSet.map((id) => `- ${id}`).join("\n") : "(žádný)",
      "",
      "## Čtecí rozsah",
      input.readSet.length > 0 ? input.readSet.map((id) => `- ${id}`).join("\n") : "(žádný)",
      "",
      "Konverzace nebyla uložena; pokračuj z tohoto handoffu.",
    ].join("\n");
  }

  async function generateServerHandoff(session: SessionRow): Promise<{ handoffPath: string; handoffHash: string }> {
    if (!session.node_id) {
      throw new Error(`suspend: session ${session.id} has no anchor node to write a handoff into`);
    }
    const mirrorRoot = await getMirrorPath(session.user_id, session.node_id);
    if (!mirrorRoot) {
      throw new Error(`suspend: no local mirror for node ${session.node_id} on this device`);
    }
    const scope = await getSessionScope(getDb(), session.id);
    const content = buildServerHandoffContent({
      sessionName: session.name,
      nodeId: session.node_id,
      writeSet: scope.filter((s) => s.writable === 1).map((s) => s.node_id),
      readSet: scope.map((s) => s.node_id),
      lastActiveAt: session.last_active_at,
    });
    const result = await writeHandoffAndSuspend(
      getDb(),
      session.user_id,
      { id: session.id, nodeId: session.node_id, mirrorRoot },
      content,
    );
    return { handoffPath: result.handoffPath, handoffHash: result.handoffHash };
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

    await appendAndPublish(sessionId, runId, [
      { kind: "user_message", payload: { text: SUSPEND_INSTRUCTION, source: "system" } },
    ]);
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
      const session = await mustGetSession(sessionId);
      const written = await generateServerHandoff(session);
      handoffEvent = {
        kind: "handoff",
        payload: { path: written.handoffPath, hash: written.handoffHash, generated_by: "server" },
      };
    }

    if (live) {
      await live.handle.close();
      await drain(sessionId);
    }

    await appendAndPublish(sessionId, runId, [handoffEvent]);
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
    const scope = await getSessionScope(getDb(), sessionId);
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

  return {
    startTask,
    sendMessage,
    answer,
    interrupt,
    suspend,
    resume,
    closeSession,
    subscribe,
    sessionSignals,
  };
}
