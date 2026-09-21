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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../../infra/db.js";
import { getSessionScope, threadNameFromFirstMessage } from "../sessions.js";
import {
  buildRunSummaryContent,
  checkConversationResumable,
  suspendSessionServerSide,
  type ServerHandoffReason,
  type SummaryEvent,
} from "../session-handoff.js";
import type { SessionRow } from "../../shared/types.js";
import type { ListEventsOptions, SessionEventRow, SessionRunRow, SessionStore } from "./store.js";
import { detectAll } from "./registry.js";
import { getInstanceDefaults, getInstanceEnv, listInstances, type InstanceDefaults } from "./instances.js";
import { localHostId } from "./hosts.js";
import { resolveRunnerDataDir } from "./data-dir.js";
import { removePidFile, writePidFile } from "./pid-file.js";
import type { ProvisionRunInput, ProvisionRunResult } from "./provision.js";
import type {
  CanonicalEvent,
  DeltaFrame,
  EffortLevel,
  PermissionPolicy,
  QuestionDecision,
  RunHandle,
  RunStart,
  RunnerAdapter,
} from "./types.js";

// A draft's first message (#374) has no runner/instance chosen up front --
// the spec's "a thread opens empty: no modal, no required field" rules out
// a picker before then, so sendMessage resolves both itself, the same rule
// NewTaskDialog used to apply client-side before it was removed: the first
// installed-and-logged-in runner, and the node's organization's default
// instance for it, if one is set.
export class NoRunnerAvailableError extends Error {}

// Resolves the node's organization -- the key the runner instance's
// org_defaults are looked up under. Local mode reads the belongs_to edge
// straight off the graph db; agent mode has no graph db at all, so
// createAgentSessionRuntime injects the central-backed implementation
// (#407) instead of silently resolving every node to "no organization".
// Rejecting is how a failed lookup is reported: resolveTaskDefaults tells
// a genuine null (the node has no organization) from an error, which is
// what the warning below is about.
export type ResolveNodeOrgId = (nodeId: string) => Promise<string | null>;

async function resolveNodeOrgIdLocal(nodeId: string): Promise<string | null> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT e.target_id FROM edges e JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization' LIMIT 1`,
    args: [nodeId],
  });
  return res.rows.length > 0 ? String(res.rows[0].target_id) : null;
}

// #375: first match wins -- the thread's own value, then the runner
// instance's defaults, then unset (the runner's own default). Pure, so
// it's directly testable independent of the store/instances file I/O
// startRun (its only caller) otherwise needs.
export function resolveModelAndEffort(
  session: { model: string | null; effort: string | null },
  instanceDefaults: InstanceDefaults | null,
): { model: string | null; effort: EffortLevel | null } {
  return {
    model: session.model ?? instanceDefaults?.model ?? null,
    effort: (session.effort as EffortLevel | null) ?? instanceDefaults?.effort ?? null,
  };
}

async function resolveTaskDefaults(
  nodeId: string,
  resolveNodeOrgId: ResolveNodeOrgId,
): Promise<{ runner: string; instanceId: string | null }> {
  const detections = await detectAll();
  const usable = detections.find((d) => d.availability.installed && d.availability.logged_in);
  if (!usable) {
    throw new NoRunnerAvailableError("no runner is installed and logged in on this device");
  }
  const instances = await listInstances();
  const forRunner = instances.filter((i) => i.runner === usable.id);

  let orgId: string | null = null;
  let failure: string | null = null;
  try {
    orgId = await resolveNodeOrgId(nodeId);
  } catch (err) {
    // A resolver error degrades to "no organization" -- it never fails the
    // promotion. It is only worth a line in the log when the fallback is
    // actually visible to the user: more than one instance to choose from
    // for this runner, and an organization default configured somewhere.
    failure = err instanceof Error ? err.message : String(err);
  }
  if (failure !== null && forRunner.length >= 2 && forRunner.some((i) => i.org_defaults.length > 0)) {
    console.warn(
      `[portuni:runner] node ${nodeId}: could not resolve its organization (${failure}) - ` +
        `falling back to the runner's own default instance`,
    );
  }

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
  // #378: writes the mechanical summary and moves the session to suspended
  // -- called whenever a run ends other than by Uzavřít/continue (any
  // reason), and by the idle sweep specifically ("idle"). Defaults to the
  // local-mode implementation (suspendSessionServerSide against the graph
  // db); boot/session-runtime.ts's createAgentSessionRuntime supplies
  // domain/runner/suspend-fallback-central.ts's version instead, since
  // agent mode has no graph db to write against.
  suspendFallback?: (sessionId: string, reason: ServerHandoffReason) => Promise<SessionRow | null>;
  // #407: how a node's organization is resolved when a draft's first
  // message picks the organization's default runner instance. Defaults to
  // the local graph-db query; createAgentSessionRuntime supplies the
  // central-backed one (CentralClient.nodeOrganizationId), since agent
  // mode has no graph db and would otherwise never apply an org default.
  resolveNodeOrgId?: ResolveNodeOrgId;
}

export interface StartTaskInput {
  userId: string;
  nodeId: string;
  brief: string;
  runner: string;
  instanceId?: string | null;
  policy?: PermissionPolicy;
  // #375: the thread's own model/effort override, resolved against the
  // instance's defaults in startRun -- unset here means "no override",
  // not "no model at all".
  model?: string | null;
  effort?: string | null;
}

// #426: the body of POST /sessions/:id/model -- at least one of the two,
// `null` meaning "no override, fall back to the instance/runner default".
export interface SetModelAndEffortInput {
  model?: string | null;
  effort?: string | null;
}

export interface CreateDraftInput {
  userId: string;
  nodeId: string;
  model?: string | null;
  effort?: string | null;
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
  // #374's draft thread: the row exists from the moment the thread opens,
  // with no brief, runner or run -- sendMessage is what promotes it. Here
  // rather than only in api/sessions.ts because agent mode has no local
  // graph db to write the row to; the store it is bound to decides where
  // the row lands (rule 1, "one implementation").
  createDraft(input: CreateDraftInput): Promise<SessionRow>;
  // Plain read-through to the store -- agent-router.ts's REST handlers have
  // no local db of their own to re-fetch a session row from after a
  // mutation the way api/sessions.ts's handlers do, so they go through this
  // instead (local mode's own handlers still use domain/sessions.ts's
  // getSession directly; this exists for the agent-mode caller).
  getSession(sessionId: string): Promise<SessionRow | null>;
  // #378: sending into a session with no live run is what promotes a draft
  // (#374, unchanged) or resumes a suspended thread (new: `--resume` on the
  // last run's agent_session_id while that's still valid, else from the
  // summary) -- there is no separate resume verb to call first. Throws
  // "has no live run" only for a closed/archived session, same wording as
  // before.
  sendMessage(sessionId: string, text: string): Promise<void>;
  answer(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void>;
  // Cancels the CURRENT TURN only (Query.interrupt()) -- the process, the
  // prompt queue and the run all stay alive; a message right after is
  // ordinary. Ending the run is close()'s job alone.
  interrupt(sessionId: string): Promise<void>;
  // #375/#426: the thread's own model/effort override, both halves in one
  // call -- a model change is forwarded to a live run's Query (no restart,
  // and a no-op when the session has no live run) and the columns are
  // written through the store. Both halves run on the device that drives
  // the run, so the store decides where the record lands: the local graph
  // db in a personal workspace, central in sync-agent mode (rule 1, "one
  // implementation"). `effort` has no live setter; it applies from the
  // next run only.
  setModelAndEffort(sessionId: string, patch: SetModelAndEffortInput): Promise<SessionRow>;
  closeSession(sessionId: string): Promise<SessionRow>;
  // #378: closes THIS session (summary written from what's in the log,
  // used to seed the new one -- not from a fresh suspend, since Uzavřít-
  // shaped closes never go through the auto-summary path) and starts a new
  // one, running, on the same node -- "Pokračovat v nové session" (offered
  // any time) and "Navázat" (a closed thread, same call minus the prior
  // close) both call this.
  continueSession(sessionId: string): Promise<{ session: SessionRow; run: SessionRunRow }>;
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
  // #378: ends any live run idle for longer than idleMs (no activity --
  // messages, adapter events, answers), writing the same mechanical
  // summary as any other non-close run end (reason "idle"). Called
  // directly by tests (no timer involved); production wiring is an
  // external interval (boot/session-sweep.ts) calling this on the
  // process's one runtime instance, same pattern as the other boot sweeps.
  checkIdleRunsOnce(idleMs: number, now?: number): Promise<void>;
}

interface LiveRun {
  handle: RunHandle;
  runId: string;
}

export function createSessionRuntime(deps: CreateSessionRuntimeDeps): SessionRuntime {
  const { store, registry, provision } = deps;
  const suspendFallback =
    deps.suspendFallback ?? ((sessionId: string, reason: ServerHandoffReason) => suspendSessionServerSide(getDb(), sessionId, reason));
  const resolveNodeOrgId = deps.resolveNodeOrgId ?? resolveNodeOrgIdLocal;

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
  // #378: sessions a closeSession()/continueSession() close is in progress
  // for -- the run_ended that follows must NOT trigger the auto-summary/
  // suspend path (handleAdapterEvent), since these two already own the
  // resulting state transition (closed) themselves.
  const closingSessions = new Set<string>();
  // #378: the reason the NEXT run_ended for this session should suspend
  // with, when it's the idle sweep asking for it specifically ("idle")
  // rather than the generic "run_ended" catch-all handleAdapterEvent falls
  // back to. Set by endIdleRun just before closing, consumed once.
  const pendingEndReason = new Map<string, ServerHandoffReason>();
  // #378: last time ANY activity was observed for a session's live run
  // (started, a message sent, an adapter event, a question answered) --
  // the idle sweep's own cutoff. Cleared once the run ends.
  const lastActivityAt = new Map<string, number>();

  function touchActivity(sessionId: string): void {
    lastActivityAt.set(sessionId, Date.now());
  }

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
      lastActivityAt.delete(sessionId);
      runStartScopeSize.delete(runId);
      await store.patchRun(runId, {
        ended_at: new Date().toISOString(),
        end_reason: canonical.payload.reason,
        usage: canonical.payload.usage,
        ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
      });
      await removePidFile(resolveRunnerDataDir(), runId).catch(() => undefined);
      await clearWaitingIfPending(sessionId, runId);

      // #378: closeSession()/continueSession() already own the resulting
      // transition (to "closed") for their own run end -- everything else
      // (idle, error, a natural CLI-initiated end) writes the mechanical
      // summary and moves the session to suspended instead.
      if (closingSessions.has(sessionId)) {
        closingSessions.delete(sessionId);
      } else {
        const reason = pendingEndReason.get(sessionId) ?? "run_ended";
        pendingEndReason.delete(sessionId);
        const suspended = await suspendFallback(sessionId, reason);
        if (suspended) {
          await appendAndPublish(sessionId, runId, [
            { kind: "handoff", payload: { path: suspended.handoff_path, hash: suspended.handoff_hash } },
          ]);
        }
      }
    }
  }

  // A run ended by anything other than an explicit close/continue is
  // recorded as "suspended" (whatever the adapter's own close() reported --
  // the fake, and any graceful close, says "completed"; the adapter cannot
  // know why it was closed) so the run's own history matches the session
  // ending up suspended. An adapter-reported error/limit/host_lost reason
  // stays as-is -- that IS the informative reason, not an artifact of who
  // called close().
  function withSuspendReason(sessionId: string, event: CanonicalEvent | DeltaFrame): CanonicalEvent | DeltaFrame {
    if (
      "kind" in event &&
      event.kind === "run_ended" &&
      event.payload.reason === "completed" &&
      !closingSessions.has(sessionId)
    ) {
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

    // #375: resolved once here, so the adapter never reads config itself.
    const instanceDefaults = run.instance_id ? await getInstanceDefaults(run.instance_id) : null;
    const { model, effort } = resolveModelAndEffort(session, instanceDefaults);

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
      model,
      effort,
    };

    const handle = await adapter.start(runStart, makeSink(session.id, run.id));
    liveRuns.set(session.id, { handle, runId: run.id });
    touchActivity(session.id);
    // Written before drain() lets any already-queued run_ended handler
    // remove it, so write-then-remove ordering always holds even for a
    // wait-free script. A null pid (the fake adapter, or a real one that
    // hasn't spawned yet) means the boot sweep simply has nothing to find
    // for this run -- best-effort, not a correctness requirement.
    const pid = handle.pid();
    if (pid !== null) {
      await writePidFile(resolveRunnerDataDir(), run.id, pid, session.id).catch(() => undefined);
    }
    // A script-driven (or otherwise fast) adapter may already have emitted
    // events synchronously during start() -- e.g. a wait-free fake script
    // runs to completion, including its own run_ended, before start()
    // returns. Draining here means a caller awaiting startTask()/resume()
    // sees the fully persisted result, not a still-in-flight background
    // write.
    await drain(session.id);
  }

  async function createDraft(input: CreateDraftInput): Promise<SessionRow> {
    return store.createDraft({
      node_id: input.nodeId,
      user_id: input.userId,
      model: input.model ?? null,
      effort: input.effort ?? null,
    });
  }

  async function startTask(input: StartTaskInput): Promise<{ session: SessionRow; run: SessionRunRow }> {
    const instanceId = input.instanceId ?? null;
    const session = await store.createSession({
      node_id: input.nodeId,
      user_id: input.userId,
      brief: input.brief,
      runner: input.runner,
      instance_id: instanceId,
      host_id: localHostId(),
      model: input.model ?? null,
      effort: input.effort ?? null,
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
      host_id: localHostId(),
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
      touchActivity(sessionId);
      await enqueue(sessionId, () =>
        appendAndPublish(sessionId, live.runId, [{ kind: "user_message", payload: { text, source: "chat" } }]),
      );
      await live.handle.send(text);
      return;
    }

    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`sendMessage: session ${sessionId} not found`);
    if (session.state === "draft") {
      await promoteDraftAndStart(sessionId, text);
      return;
    }
    if (session.state === "suspended") {
      await resumeByWriting(sessionId, session, text);
      return;
    }
    throw new Error(`sendMessage: session ${sessionId} has no live run`);
  }

  // A thread is a session row from the moment it opens (#374, "the session
  // row exists from the moment the thread opens"): the first message is
  // what promotes a draft to running and starts its first run, resolving
  // runner/instance the same way startTask's caller used to before it was
  // chosen up front in a now-removed dialog.
  async function promoteDraftAndStart(sessionId: string, text: string): Promise<void> {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`sendMessage: session ${sessionId} not found`);
    if (session.state !== "draft") throw new Error(`sendMessage: session ${sessionId} has no live run`);
    if (!session.node_id) throw new Error(`sendMessage: draft session ${sessionId} has no anchor node`);

    const { runner, instanceId } = await resolveTaskDefaults(session.node_id, resolveNodeOrgId);
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
    const run = await store.createRun({
      session_id: sessionId,
      runner,
      instance_id: instanceId,
      host_id: localHostId(),
    });
    const instanceEnv = instanceId ? ((await getInstanceEnv(instanceId)) ?? {}) : {};

    await startRun(updated, run, provisioned, instanceEnv, {
      brief: text,
      runStartResume: null,
      resumeMode: null,
      policy: "default",
    });
  }

  // #378 ("Resume is writing"): sending into a thread whose last run ended
  // starts a new one -- no mode picker, the server decides. `--resume` on
  // the last run's agent_session_id while the CLI's own transcript for it
  // still exists (checkConversationResumable, the same check GET
  // /sessions/:id/resume-info already used); otherwise the session's own
  // summary (written when the last run ended) becomes extra orientation,
  // same as the old handoff-mode resume did.
  async function resumeByWriting(sessionId: string, session: SessionRow, text: string): Promise<void> {
    if (!session.node_id) throw new Error(`sendMessage: session ${sessionId} has no anchor node`);
    const runner = session.runner;
    if (!runner) throw new Error(`sendMessage: session ${sessionId} has no runner to resume under`);

    const runs = await store.listRuns(sessionId);
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

    const provisioned = await provision({ userId: session.user_id, nodeId: session.node_id, sessionId, resume: null });

    const canResumeConversation =
      lastRun?.agent_session_id != null &&
      (await checkConversationResumable(session.cli, lastRun.agent_session_id, provisioned.cwd));

    let runStartResume: RunStart["resume"] = null;
    let runProvisioned = provisioned;
    if (canResumeConversation && lastRun?.agent_session_id) {
      runStartResume = { agentSessionId: lastRun.agent_session_id };
    } else {
      const summary = session.handoff_path
        ? await readFile(join(provisioned.cwd, session.handoff_path), "utf8").catch(() => null)
        : session.handoff_inline;
      if (summary) {
        runProvisioned = {
          ...provisioned,
          orientation: `${provisioned.orientation}\n\n## Předání (obnovení ze shrnutí)\n\nKonverzace se neobnovuje přímo; pokračuješ z tohoto shrnutí:\n\n${summary}`,
        };
      }
    }

    const instanceId = session.instance_id;
    const run = await store.createRun({
      session_id: sessionId,
      runner,
      instance_id: instanceId,
      host_id: localHostId(),
      resumed_from_run_id: lastRun?.id ?? null,
      agent_session_id: runStartResume?.agentSessionId ?? null,
    });
    const instanceEnv = instanceId ? ((await getInstanceEnv(instanceId)) ?? {}) : {};
    const updated = await store.patchSession(sessionId, { state: "running" });

    // Same reason as promoteDraftAndStart's own state_changed: a window
    // other than this one showing the thread learns it woke up.
    await appendAndPublish(sessionId, null, [
      { kind: "state_changed", payload: { from: "suspended", to: "running", waiting: false } },
    ]);

    await startRun(updated, run, runProvisioned, instanceEnv, {
      brief: text,
      runStartResume,
      resumeMode: runStartResume ? "conversation" : "handoff",
      policy: "default",
    });
  }

  // Same ordering rule: the answered question (and the waiting: false
  // state) is recorded before the adapter learns the decision.
  async function answer(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live) throw new Error(`answer: session ${sessionId} has no live run`);
    touchActivity(sessionId);

    const pending = pendingQuestions.get(sessionId);
    if (pending && pending.request_id === requestId) {
      await enqueue(sessionId, async () => {
        await appendAndPublish(sessionId, live.runId, [{ kind: "question", payload: { ...pending, decision } }]);
        await clearWaitingIfPending(sessionId, live.runId);
      });
    }
    await live.handle.answer(requestId, decision);
    // Whatever the adapter does in reaction (more events, or the run
    // ending) is sunk through the same per-session queue -- drain it so a
    // caller awaiting answer() sees the reaction, not just the decision.
    await drain(sessionId);
  }

  // #378: cancels the CURRENT TURN only (Query.interrupt()) -- the process,
  // the prompt queue and the run stay alive, so a message right after is an
  // ordinary one. Ending the run belongs to close() alone (closeSession,
  // continueSession, the idle sweep).
  async function interrupt(sessionId: string): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live) return;
    touchActivity(sessionId);
    await live.handle.interrupt();
    await drain(sessionId);
  }

  // #375/#426: model is the one setting the SDK allows to change mid-run,
  // no restart -- reasoning effort has no equivalent and only ever applies
  // from the next run, so nothing is forwarded for it. The column write
  // (source of truth for the next run, and the only effect for a session
  // with no live run right now) goes through the store, which is what puts
  // the record on central in sync-agent mode: the live half can only be
  // done by the device driving the run, so the whole call lives here
  // rather than in the REST handler (#426).
  // Record first, live run second: the record half is the one that can be
  // refused (in a team workspace it is a PATCH on the central server), and a
  // refused write must not leave the live run on a model the record never
  // took. The live half cannot fail the same way -- it is an in-process
  // call on the run this sidecar drives.
  async function setModelAndEffort(sessionId: string, patch: SetModelAndEffortInput): Promise<SessionRow> {
    const row = await store.patchSession(sessionId, { model: patch.model, effort: patch.effort });
    if (patch.model !== undefined) {
      const live = liveRuns.get(sessionId);
      if (live) await live.handle.setModel(patch.model);
    }
    return row;
  }

  // #378: the only action that actually ends a live run's process (besides
  // continueSession and the idle sweep) -- close(), not interrupt(), so the
  // run genuinely stops instead of just cancelling the current turn.
  // Uzavřít is the one irreversible action, so closingSessions is set
  // first: the run_ended this produces must not ALSO trigger the auto-
  // summary/suspend path, since this function already owns the transition
  // to closed.
  async function closeSession(sessionId: string): Promise<SessionRow> {
    const live = liveRuns.get(sessionId);
    if (live) {
      closingSessions.add(sessionId);
      await live.handle.close();
      await drain(sessionId);
    }
    return store.patchSession(sessionId, { state: "closed" });
  }

  // #378: ends an idle live run (no activity for longer than idleMs) the
  // same way closeSession would, EXCEPT it does NOT add to closingSessions
  // -- the resulting run_ended is meant to fall through to the auto-
  // summary/suspend path in handleAdapterEvent, tagged "idle" specifically
  // (via pendingEndReason) rather than the generic "run_ended".
  async function endIdleRun(sessionId: string): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live) return;
    pendingEndReason.set(sessionId, "idle");
    await live.handle.close();
    await drain(sessionId);
  }

  async function checkIdleRunsOnce(idleMs: number, now: number = Date.now()): Promise<void> {
    const staleIds = [...liveRuns.keys()].filter((id) => now - (lastActivityAt.get(id) ?? now) > idleMs);
    for (const id of staleIds) {
      await endIdleRun(id);
    }
  }

  async function nodeNameForSession(nodeId: string): Promise<string | null> {
    try {
      const db = getDb();
      const res = await db.execute({ sql: "SELECT name FROM nodes WHERE id = ?", args: [nodeId] });
      return res.rows.length > 0 ? String(res.rows[0].name) : null;
    } catch {
      return null;
    }
  }

  // #378: "Pokračovat v nové session" / "Navázat" -- closes THIS session
  // (summary built from whatever's in its own log right now, used only to
  // seed the new one -- not the auto-summary/suspend path, since this ends
  // as closed, never suspended) and starts a fresh one, running, on the
  // same node, carrying the old summary as extra orientation. No mode
  // picker, no brief: the new thread starts itself, same shape as a
  // handoff-mode resume used to, just into a brand new session row.
  async function continueSession(sessionId: string): Promise<{ session: SessionRow; run: SessionRunRow }> {
    const oldSession = await mustGetSession(sessionId);
    if (!oldSession.node_id) throw new Error(`continueSession: session ${sessionId} has no anchor node`);
    const runner = oldSession.runner;
    if (!runner) throw new Error(`continueSession: session ${sessionId} has no runner to continue under`);

    const live = liveRuns.get(sessionId);
    if (live) {
      closingSessions.add(sessionId);
      await live.handle.close();
      await drain(sessionId);
    }

    const scope = await getSessionScope(getDb(), sessionId).catch(() => []);
    const rows = await store.listEvents(sessionId);
    const events: SummaryEvent[] = rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
    const nodeName = await nodeNameForSession(oldSession.node_id);
    const summary = buildRunSummaryContent({
      nodeName,
      sessionName: oldSession.name,
      reason: "continue",
      events,
      writeSet: scope.filter((s) => s.writable === 1).map((s) => s.node_id),
      readSet: scope.map((s) => s.node_id),
      lastActiveAt: oldSession.last_active_at,
    });

    await store.patchSession(sessionId, { state: "closed" });
    await appendAndPublish(sessionId, null, [
      { kind: "state_changed", payload: { from: oldSession.state, to: "closed", waiting: false } },
    ]);

    const newSession = await store.createSession({
      node_id: oldSession.node_id,
      user_id: oldSession.user_id,
      brief: null,
      runner,
      instance_id: oldSession.instance_id,
      host_id: localHostId(),
      model: oldSession.model,
      effort: oldSession.effort,
    });
    await store.patchSession(newSession.id, { name: oldSession.name, name_is_custom: true });

    const provisioned = await provision({
      userId: oldSession.user_id,
      nodeId: oldSession.node_id,
      sessionId: newSession.id,
      resume: null,
    });
    const seededProvisioned = {
      ...provisioned,
      orientation: `${provisioned.orientation}\n\n## Pokračování z předchozí session\n\n${summary}`,
    };

    const run = await store.createRun({
      session_id: newSession.id,
      runner,
      instance_id: oldSession.instance_id,
      host_id: localHostId(),
    });
    const instanceEnv = oldSession.instance_id ? ((await getInstanceEnv(oldSession.instance_id)) ?? {}) : {};

    await startRun(await mustGetSession(newSession.id), run, seededProvisioned, instanceEnv, {
      brief: null,
      runStartResume: null,
      resumeMode: null,
      policy: "default",
    });

    return { session: await mustGetSession(newSession.id), run };
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
    createDraft,
    getSession: (sessionId: string) => store.getSession(sessionId),
    sendMessage,
    answer,
    interrupt,
    setModelAndEffort,
    closeSession,
    continueSession,
    pendingQuestion,
    recordStoppedBy,
    subscriberCount,
    listEvents,
    subscribe,
    sessionSignals,
    checkIdleRunsOnce,
  };
}
