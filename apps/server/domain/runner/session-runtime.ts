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
  checkConversationResumable,
  extractHandoffTitle,
  isHandoffRelativePath,
  readNodeHandoffFile,
  createSessionHandoffs,
  localSuspendDeps,
  type ServerHandoffReason,
  type SessionHandoffs,
  type SuspendServerSide,
  type SuspendServerSideOptions,
} from "../session-handoff.js";
import type { SessionRow } from "../../shared/types.js";
import type { SessionRunRow, SessionStore } from "./store.js";
import type { ListEventsOptions, SessionContentStore } from "./store-content.js";
import type { SessionEventRow } from "../../shared/api-types.js";
import { detectAll } from "./registry.js";
import { getInstanceDefaults, getInstanceEnv, instanceClaudeConfigDir, listInstances, type InstanceDefaults } from "./instances.js";
import { localHostId, resolveHostLabel } from "./hosts.js";
import { getMirrorPath } from "../sync/mirror-registry.js";
import { resolveRunnerDataDir } from "./data-dir.js";
import { removePidFile, writePidFile } from "./pid-file.js";
import { isRunEndedError } from "./types.js";
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

// #459 (Předat): the thread cannot be handed to another machine right now.
// `code` is what the REST/live-channel layer answers with (409); `message`
// is Czech, because it is shown to the user as-is.
export class SessionHandoffError extends Error {
  constructor(
    readonly code:
      | "HANDOFF_NOT_ALLOWED"
      | "HANDOFF_NO_MIRROR"
      | "HANDOFF_RUN_ELSEWHERE"
      | "HANDOFF_TRANSCRIPT_ELSEWHERE"
      | "HANDOFF_NO_CONTENT"
      | "HANDOFF_FILE_NOT_HERE"
      | "HANDOFF_PATH_INVALID",
    message: string,
  ) {
    super(message);
  }
}

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

export async function resolveTaskDefaults(
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

// v2 rule 5: a draft opens with the organisation's defaults already on its
// row. The same resolution, but "no runner" is a legal answer (both null)
// -- the composer says so instead of showing a picker.
export async function resolveDraftDefaults(
  nodeId: string,
  resolveNodeOrgId: ResolveNodeOrgId,
): Promise<{ runner: string | null; instanceId: string | null }> {
  try {
    return await resolveTaskDefaults(nodeId, resolveNodeOrgId);
  } catch (err) {
    if (err instanceof NoRunnerAvailableError) return { runner: null, instanceId: null };
    throw err;
  }
}

export interface RunnerRegistryLookup {
  getAdapter(id: string): RunnerAdapter | null;
}

// A published canonical event carries the seq the store assigned it (the
// live channel, api/sessions-ws.ts, needs this to reconcile a buffered live
// event against the replay-from-`after` it raced) -- a delta never persists,
// so it never gets one.
// A row change that is not an event of the conversation (a rename): never
// persisted, never replayed, only fans out as the live channel's
// session_state so every window's sidebar, Relace tab and chat header
// pick the new row up at once.
export interface SessionChangedFrame {
  type: "session_changed";
  session_id: string;
}
export type PublishedEvent = (CanonicalEvent & { seq: number }) | DeltaFrame | SessionChangedFrame;
export type RuntimeListener = (sessionId: string, event: PublishedEvent) => void;

export interface CreateSessionRuntimeDeps {
  // The RECORD half: state, runner, instance, runs. DbSessionStore in a
  // personal workspace, CentralSessionStore in a team workspace.
  store: SessionStore;
  // The CONTENT half, always this device's own content.db (#456,
  // docs/superpowers/specs/2026-09-22-local-sessions-design.md): the
  // transcript, the first message and the inline handoff summary. Same
  // object in both workspaces -- the central server never sees any of it.
  content: SessionContentStore;
  registry: RunnerRegistryLookup;
  provision: (input: ProvisionRunInput) => Promise<ProvisionRunResult>;
  // #378: moves the session to suspended -- called whenever a run ends
  // other than by Uzavřít/continue (any reason), and by the idle sweep
  // specifically ("idle"); #497: only Předat ("handoff") writes a summary
  // with it. Defaults to the local-mode binding (suspendSessionServerSide
  // against the graph db); boot/session-runtime.ts's
  // createAgentSessionRuntime supplies the same code with its two graph-db
  // reads pointed at the central server (#458), since agent mode has no
  // graph db to write against.
  suspendFallback?: SuspendServerSide;
  // #497: the summary builder and the handoff-file writer Pokračovat v nové
  // session and a resume without a conversation use -- the same seams the
  // suspend above has (createSessionHandoffs). Defaults to the local-mode
  // binding; createAgentSessionRuntime supplies the central-backed one.
  handoffs?: Pick<SessionHandoffs, "summarize" | "writeFile">;
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

// #460 "Navázat na handoff": a new thread on THIS device that starts from a
// handoff file some other thread wrote -- possibly on another machine, which
// is the whole point. Only the node and the file's node-relative path: the
// runner/instance are resolved here the way a draft's are, and the name
// comes out of the summary's own title.
export interface StartFromHandoffInput {
  userId: string;
  nodeId: string;
  handoffPath: string;
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
  // summary) -- there is no separate resume verb to call first. #498: a
  // closed thread reopens the same way. Throws "has no live run" only for
  // an archived session, same wording as before.
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
  // Renames the thread (name_is_custom, so handoff-title enrichment at
  // suspend never overwrites it) and publishes a session_changed frame.
  renameSession(sessionId: string, name: string): Promise<SessionRow>;
  closeSession(sessionId: string): Promise<SessionRow>;
  // #459 "Předat": hands the thread to another machine through its handoff
  // file. On a running thread the current turn is interrupted, the run is
  // drained and ended, and the same summary path a limit or an idle end
  // takes writes wip/sessions/<id>-handoff.md into the node's mirror,
  // registers it and suspends the record -- only this time because the
  // owner asked (reason "handoff"). On an already-suspended thread that
  // has its file, a no-op answering the same path. A draft, a closed
  // thread, or a node with no mirror on this device throws
  // SessionHandoffError -- there is no file to hand over.
  handoff(sessionId: string): Promise<{ session: SessionRow; handoff_path: string }>;
  // #459/#460 "Navázat na handoff": the other end of Předat. Creates a new
  // thread on this device from a handoff file of the node -- a new record
  // (runner/instance resolved as for a draft, name from the summary's
  // title), whose first run gets the file's content as orientation, the way
  // a resume from a summary does. No events are imported: the transcript
  // starts here, and the thread the file came from is never touched.
  // The file is read from this device's mirror; no mirror or no file yet is
  // a SessionHandoffError and creates no record at all.
  startFromHandoff(input: StartFromHandoffInput): Promise<{ session: SessionRow; run: SessionRunRow }>;
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
  // Set once the run's agent_session_id has been written to its row, so
  // the capture below costs one write per run, not one per event.
  agentSessionIdSaved: boolean;
}

export function createSessionRuntime(deps: CreateSessionRuntimeDeps): SessionRuntime {
  const { store, content, registry, provision } = deps;
  const localHandoffs = () => createSessionHandoffs(localSuspendDeps(getDb(), content));
  const suspendFallback =
    deps.suspendFallback ??
    ((sessionId: string, reason: ServerHandoffReason, opts?: SuspendServerSideOptions) =>
      localHandoffs().suspend(sessionId, reason, opts));
  const handoffs: Pick<SessionHandoffs, "summarize" | "writeFile"> = deps.handoffs ?? {
    summarize: (session, reason) => localHandoffs().summarize(session, reason),
    writeFile: (session, summary) => localHandoffs().writeFile(session, summary),
  };
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
  // #488: per-session lifecycle lock. Starting a run takes as long as the
  // adapter needs to spawn its process, and the live handle only lands in
  // liveRuns once it returns -- so anything that decides what to do by
  // looking at liveRuns (a second message, Uzavřít, Předat, Pokračovat v
  // nové session) queues behind the start in progress instead of acting on
  // a session whose run is half-started. Without it two quick messages
  // into a suspended thread start two processes and one of them is
  // orphaned, a message in the start window is refused with "no live run",
  // and a close during the start leaves the process running on a closed
  // session.
  const lifecycleLocks = new Map<string, Promise<unknown>>();
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
  // #491: how many times activity was observed for this session's live run.
  // The idle sweep re-checks a session against this before ending it -- two
  // activities inside the same millisecond share a timestamp, so the count,
  // not the clock, is what says "something happened since I picked this
  // one". Cleared with lastActivityAt when the run ends.
  const activityTicks = new Map<string, number>();
  // #490: how many messages the session's live run has been sent that no
  // turn has answered yet -- a count, not a flag: a message written while
  // the agent works queues behind the turn in flight, and the first
  // turn_ended after it ends only ONE of them. The idle sweep never ends a
  // run with work outstanding -- the agent is working, only an open
  // question waits on the user. run_ended zeroes the count: no turn of a
  // run that is over can still be in flight.
  const turnsInFlight = new Map<string, number>();
  // #488: the run each session is starting or running, by run id -- set
  // when startRun begins, cleared when that run's run_ended is handled (or
  // its start fails). What isCurrentRun compares an event's run against.
  const currentRuns = new Map<string, string>();

  function addTurnInFlight(sessionId: string): void {
    turnsInFlight.set(sessionId, (turnsInFlight.get(sessionId) ?? 0) + 1);
  }

  // `count` is what the turn reported it answered (turn_ended's
  // consumed_messages): the SDK folds sends that arrive close together into
  // one turn, so one turn_ended can end more than one message's wait.
  function dropTurnInFlight(sessionId: string, count = 1): void {
    const left = (turnsInFlight.get(sessionId) ?? 0) - Math.max(count, 0);
    if (left > 0) turnsInFlight.set(sessionId, left);
    else turnsInFlight.delete(sessionId);
  }

  function isTurnInFlight(sessionId: string): boolean {
    return (turnsInFlight.get(sessionId) ?? 0) > 0;
  }
  // #489: the session's current run, from the moment it started until its
  // run_ended has been handled AND the suspend that follows it is written.
  // A message that arrives while a run is ending -- the adapter already
  // refuses it, or run_ended landed but the suspend is still in flight --
  // waits on this instead of being dropped or refused, and is then
  // delivered by resuming the thread (the ordinary "write into a suspended
  // thread" path).
  const runSettling = new Map<string, { runId: string; promise: Promise<void>; resolve: () => void }>();

  function trackRunSettling(sessionId: string, runId: string): void {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    runSettling.set(sessionId, { runId, promise, resolve });
  }

  // Called once the run's end is fully accounted for (the row, the suspend
  // or the close). A late run_ended from a run something already replaced
  // never settles the entry the newer run owns.
  function settleRun(sessionId: string, runId: string): void {
    const entry = runSettling.get(sessionId);
    if (!entry || entry.runId !== runId) return;
    runSettling.delete(sessionId);
    entry.resolve();
  }

  // Resolves once no run end is in flight for this session. Nothing here
  // waits on a clock: the promise is resolved by the run_ended handler
  // itself, on the event queue, which never takes the lifecycle lock a
  // caller of this holds.
  async function waitForRunToSettle(sessionId: string): Promise<void> {
    const entry = runSettling.get(sessionId);
    if (entry) await entry.promise;
  }

  function touchActivity(sessionId: string): void {
    lastActivityAt.set(sessionId, Date.now());
    activityTicks.set(sessionId, (activityTicks.get(sessionId) ?? 0) + 1);
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

  // #488: runs `task` after every lifecycle operation already queued for
  // this session, and hands the caller that task's own promise (so its
  // failure is still the caller's). Separate from `queues`, which serialises
  // the event sink: an adapter event handler must never wait on a start,
  // and a start drains the event queue while it holds this lock.
  function withLifecycleLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = lifecycleLocks.get(sessionId) ?? Promise.resolve();
    const result = prev.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    lifecycleLocks.set(sessionId, settled);
    void settled.then(() => {
      // Only the tail clears the entry, so a lock taken while this one was
      // running keeps its place in the chain.
      if (lifecycleLocks.get(sessionId) === settled) lifecycleLocks.delete(sessionId);
    });
    return result;
  }

  async function appendAndPublish(
    sessionId: string,
    runId: string | null,
    events: CanonicalEvent[],
  ): Promise<void> {
    const seqs = await content.appendEvents(sessionId, runId, events);
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

  // The CLI's own conversation id is the pointer a later resume continues
  // from. An adapter learns it from an early protocol message, so the first
  // event of the run is soon enough to write it down -- and it has to be
  // written this early, because a run whose host dies (a crash, a restart,
  // anything the boot sweep later marks host_lost) never reaches the
  // run_ended where this used to be read, and left no pointer at all.
  async function captureAgentSessionId(sessionId: string, runId: string): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (!live || live.runId !== runId || live.agentSessionIdSaved) return;
    const agentSessionId = live.handle.agentSessionId();
    if (!agentSessionId) return;
    // Set before the await so concurrent events don't write it twice;
    // cleared on failure so the next event retries.
    live.agentSessionIdSaved = true;
    try {
      await store.patchRun(runId, { agent_session_id: agentSessionId });
    } catch (e) {
      live.agentSessionIdSaved = false;
      throw e;
    }
  }

  // #488: whether an adapter event belongs to the session's current run --
  // the one being started or live, from startRun until its own run_ended
  // is handled. A late event from any other run (a run_ended arriving
  // after the next run started, or while it is still starting and has no
  // live handle yet) must not touch session-level state -- the live
  // handle, the turn in flight, the suspend path -- even though the run's
  // own row still records its end.
  function isCurrentRun(sessionId: string, runId: string): boolean {
    return currentRuns.get(sessionId) === runId;
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
    if (canonical.kind === "run_ended") {
      // #489: whatever this end turns out to be -- a close, a suspend, a
      // late end from a replaced run, or a failure anywhere in handling it
      // (the log write included) -- a message waiting for it stops waiting
      // here. Settling in a finally is what keeps a failed write from
      // wedging every later lifecycle verb on the thread.
      try {
        await handleRunEnded(sessionId, runId, canonical);
      } finally {
        settleRun(sessionId, runId);
      }
      return;
    }
    await appendAndPublish(sessionId, runId, [canonical]);
    touchActivity(sessionId);
    if (canonical.kind === "turn_ended" && isCurrentRun(sessionId, runId))
      dropTurnInFlight(sessionId, canonical.payload.consumed_messages ?? 1);
    await captureAgentSessionId(sessionId, runId);

    if (canonical.kind === "context_usage") {
      // The ring's counters on the row (v2 spec): lists and the header
      // read them without the log; the event itself stays the record.
      await store.patchSession(sessionId, {
        context_used_tokens: canonical.payload.used_tokens,
        context_max_tokens: canonical.payload.max_tokens,
      });
      return;
    }

    if (canonical.kind === "question") {
      // A decision already on the event means the adapter closed the
      // question itself (the SDK abandoned a dialog): stop waiting, the
      // way answer() does for a decision the user made.
      if (canonical.payload.decision !== null) {
        if (pendingQuestions.get(sessionId)?.request_id === canonical.payload.request_id) {
          await clearWaitingIfPending(sessionId, runId);
        }
        return;
      }
      pendingQuestions.set(sessionId, canonical.payload);
      await store.patchSession(sessionId, { waiting_since: new Date().toISOString() });
      await appendAndPublish(sessionId, runId, [
        { kind: "state_changed", payload: { from: "running", to: "running", waiting: true } },
      ]);
      return;
    }
  }

  async function handleRunEnded(
    sessionId: string,
    runId: string,
    canonical: Extract<CanonicalEvent, { kind: "run_ended" }>,
  ): Promise<void> {
    // The run is over whether or not its end reaches the log: a failed
    // write is reported and the teardown below still runs, so the thread
    // never keeps a dead handle (and a client replaying the log reads the
    // record's state, which the suspend below still writes).
    await appendAndPublish(sessionId, runId, [canonical]).catch((err) => {
      console.error(`[portuni:runner] session ${sessionId}: recording run_ended of run ${runId} failed:`, err);
    });
    touchActivity(sessionId);
    if (isCurrentRun(sessionId, runId)) turnsInFlight.delete(sessionId);
    // Captured before the entry is removed: the adapter may only expose
    // the runner's own conversation id once the run is actually over
    // (a real CLI's translation learns it from an early protocol
    // message, but the value is only load-bearing at resume time, so
    // reading it here -- once, at run end -- is enough either way).
    const live = liveRuns.get(sessionId);
    const agentSessionId = live?.runId === runId ? live.handle.agentSessionId() : null;
    // #488: only the current run's end takes the session with it.
    const current = isCurrentRun(sessionId, runId);
    if (current) {
      currentRuns.delete(sessionId);
      liveRuns.delete(sessionId);
      lastActivityAt.delete(sessionId);
      activityTicks.delete(sessionId);
    }
    runStartScopeSize.delete(runId);
    await store.patchRun(runId, {
      ended_at: new Date().toISOString(),
      end_reason: canonical.payload.reason,
      usage: canonical.payload.usage,
      ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
    });
    await removePidFile(resolveRunnerDataDir(), runId).catch(() => undefined);
    if (!current) return;
    await clearWaitingIfPending(sessionId, runId);

    // #378: closeSession()/continueSession() already own the resulting
    // transition (to "closed") for their own run end -- everything else
    // (idle, error, a natural CLI-initiated end) moves the session to
    // suspended instead; #497: with a summary only for Předat.
    if (closingSessions.has(sessionId)) {
      closingSessions.delete(sessionId);
    } else {
      const reason = pendingEndReason.get(sessionId) ?? "run_ended";
      pendingEndReason.delete(sessionId);
      const suspended = await suspendFallback(sessionId, reason);
      if (suspended) {
        // #494: the run_ended above already fanned a session_state out
        // (api/sessions-ws.ts reads the row the moment it sees one) --
        // but it read the row before this suspend wrote it, so every
        // window kept showing the thread as running. The transition
        // itself is what tells them it is suspended now.
        // #497: the handoff event (the chat's "Shrnutí uloženo" row)
        // only when a summary was actually written -- Předat.
        await appendAndPublish(sessionId, runId, [
          ...(suspended.state === "suspended"
            ? [{ kind: "state_changed" as const, payload: { from: "running", to: "suspended", waiting: false } }]
            : []),
          ...(reason === "handoff"
            ? [
                {
                  kind: "handoff" as const,
                  payload: { path: suspended.handoff_path, hash: suspended.handoff_hash },
                },
              ]
            : []),
        ]);
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
      // #489: false when the brief is a message already in the transcript
      // -- a message the previous run refused while it was ending, being
      // delivered to this one. The agent still gets it; the chat must not
      // show it twice.
      logBrief?: boolean;
    },
  ): Promise<void> {
    const adapter = registry.getAdapter(run.runner);
    if (!adapter) throw new Error(`startRun: unknown runner '${run.runner}'`);

    // #375: resolved once here, so the adapter never reads config itself.
    const instanceDefaults = run.instance_id ? await getInstanceDefaults(run.instance_id) : null;
    const { model, effort } = resolveModelAndEffort(session, instanceDefaults);

    // session_scope is a local graph-db table; agent mode has none, so the
    // restart indicator's "expansions since run start" signal degrades to 0
    // there rather than failing the whole run start.
    runStartScopeSize.set(run.id, await readSessionScopeSize(session.id));
    // #490: the brief's turn is counted before the adapter can answer it.
    // A start that fails gives the count and the baseline back -- no run
    // of it is live, and a leftover count would keep the next run of this
    // thread "working" for the idle sweep.
    let briefCounted = false;
    let handle: RunHandle;
    currentRuns.set(session.id, run.id);
    try {
      await appendAndPublish(session.id, run.id, [
        {
          kind: "run_started",
          payload: {
            run_id: run.id,
            runner: run.runner,
            instance_id: run.instance_id,
            resume: opts.resumeMode,
            // #489: the brief is a redelivered message the log already
            // holds (before this event); the web counts it from here.
            ...(opts.brief !== null && opts.logBrief === false ? { carried_messages: 1 } : {}),
          },
        },
      ]);
      if (opts.brief !== null) {
        if (opts.logBrief !== false) {
          await appendAndPublish(session.id, run.id, [
            { kind: "user_message", payload: { text: opts.brief, source: "chat" } },
          ]);
        }
        addTurnInFlight(session.id);
        briefCounted = true;
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

      handle = await adapter.start(runStart, makeSink(session.id, run.id));
    } catch (err) {
      if (briefCounted) dropTurnInFlight(session.id);
      runStartScopeSize.delete(run.id);
      if (currentRuns.get(session.id) === run.id) currentRuns.delete(session.id);
      throw err;
    }
    liveRuns.set(session.id, { handle, runId: run.id, agentSessionIdSaved: false });
    // #489: from here until this run's end is fully accounted for, a
    // message that the run refuses waits for that end rather than failing.
    trackRunSettling(session.id, run.id);
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
    const defaults = await resolveDraftDefaults(input.nodeId, resolveNodeOrgId);
    return store.createDraft({
      node_id: input.nodeId,
      user_id: input.userId,
      model: input.model ?? null,
      effort: input.effort ?? null,
      runner: defaults.runner,
      instance_id: defaults.instanceId,
    });
  }

  async function startTask(input: StartTaskInput): Promise<{ session: SessionRow; run: SessionRunRow }> {
    const instanceId = input.instanceId ?? null;
    // Provisioned before anything is created: a run that cannot start (no
    // front-door token, #507; a mirror that cannot be made) is refused
    // with no record and no first message left behind.
    const provisioned = await provision({
      userId: input.userId,
      nodeId: input.nodeId,
      sessionId: null,
      resume: null,
    });
    const session = await store.createSession({
      node_id: input.nodeId,
      user_id: input.userId,
      runner: input.runner,
      instance_id: instanceId,
      host_id: localHostId(),
      model: input.model ?? null,
      effort: input.effort ?? null,
    });
    // The brief is the thread's first message, i.e. content: it stays on
    // this device even when the record above was created on central.
    await content.setContent(session.id, { brief: input.brief });

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
  // #489: how many times one message may follow a run that ends before it
  // can be delivered. Each retry costs a whole run end, so a message that
  // gets this far is chasing a runner that cannot start, not a race.
  const MAX_DELIVERY_ATTEMPTS = 3;

  async function sendMessageLocked(
    sessionId: string,
    text: string,
    // #489: the message is already in the transcript (this is a redelivery
    // after the run it was written for refused it).
    logged = false,
    attempt = 0,
  ): Promise<void> {
    const live = liveRuns.get(sessionId);
    if (live) {
      touchActivity(sessionId);
      // Counted before the adapter can answer it; given back on any
      // failure below, so a message the run never took never keeps the
      // run "working" for the idle sweep (#490).
      addTurnInFlight(sessionId);
      try {
        if (!logged) {
          await enqueue(sessionId, () =>
            appendAndPublish(sessionId, live.runId, [{ kind: "user_message", payload: { text, source: "chat" } }]),
          );
        }
        await live.handle.send(text);
      } catch (err) {
        dropTurnInFlight(sessionId);
        if (!isRunEndedError(err)) throw err;
        // #489: the run was already tearing down (a provider error or
        // limit, the idle sweep, Předat) and never took the message. It is
        // in the chat, so it has to reach the agent: wait for the run to
        // end and for the suspend that follows, then deliver it the way a
        // message into a suspended thread is delivered -- as the next
        // run's first message, written once.
        await deliverAfterRunEnd(sessionId, text, attempt, true);
      }
      return;
    }

    // #489: run_ended has landed but the suspend it triggers is still being
    // written, so the row still says running and there is no handle. The
    // message is not refused -- it waits for the state that suspend leaves
    // behind and goes to the run it starts.
    if (runSettling.has(sessionId)) {
      await deliverAfterRunEnd(sessionId, text, attempt, logged);
      return;
    }

    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`sendMessage: session ${sessionId} not found`);
    if (session.state === "draft") {
      await promoteDraftAndStart(sessionId, text);
      return;
    }
    // #498: Uzavřít is "done, off the active lists", not "never again" --
    // writing into a closed thread reopens it exactly like a suspended one.
    if (session.state === "suspended" || session.state === "closed") {
      await resumeByWriting(sessionId, session, text, logged);
      return;
    }
    throw new Error(`sendMessage: session ${sessionId} has no live run`);
  }

  // #489: waits for the run that is ending (never a clock -- the run's own
  // run_ended handler resolves this, and it runs on the event queue, which
  // never takes the lifecycle lock this holds) and then sends again.
  async function deliverAfterRunEnd(
    sessionId: string,
    text: string,
    attempt: number,
    logged: boolean,
  ): Promise<void> {
    if (attempt + 1 >= MAX_DELIVERY_ATTEMPTS) {
      throw new Error(`sendMessage: session ${sessionId} keeps ending runs before the message can be delivered`);
    }
    await waitForRunToSettle(sessionId);
    await sendMessageLocked(sessionId, text, logged, attempt + 1);
  }

  // A thread is a session row from the moment it opens (#374, "the session
  // row exists from the moment the thread opens"): the first message is
  // what promotes a draft to running and starts its first run. v2 rule 5:
  // the runner/instance are the draft's own (chosen in the composer, or
  // the defaults written at creation); the resolution runs only for a
  // draft that has none, e.g. one created while no runner was logged in.
  async function promoteDraftAndStart(sessionId: string, text: string): Promise<void> {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`sendMessage: session ${sessionId} not found`);
    if (session.state !== "draft") throw new Error(`sendMessage: session ${sessionId} has no live run`);
    if (!session.node_id) throw new Error(`sendMessage: draft session ${sessionId} has no anchor node`);

    const { runner, instanceId } = session.runner
      ? { runner: session.runner, instanceId: session.instance_id }
      : await resolveTaskDefaults(session.node_id, resolveNodeOrgId);
    // Provisioned before the draft is touched: a run that cannot start
    // (#507) leaves the draft a draft, with the message still the user's.
    const provisioned = await provision({
      userId: session.user_id,
      nodeId: session.node_id,
      sessionId,
      resume: null,
    });
    // Content first, record second: the first message and the user_message
    // event below are the device's, the patch is the record's (#456).
    await content.setContent(sessionId, { brief: text });
    const updated = await store.patchSession(sessionId, {
      state: "running",
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
  // /sessions/:id/resume-info already used); otherwise a summary becomes
  // extra orientation, same as the old handoff-mode resume did (#497:
  // resumeSummary).
  async function resumeByWriting(
    sessionId: string,
    session: SessionRow,
    text: string,
    // #489: true when `text` is already in the transcript -- a message the
    // previous run refused while it was ending.
    logged = false,
  ): Promise<void> {
    if (!session.node_id) throw new Error(`sendMessage: session ${sessionId} has no anchor node`);
    const runner = session.runner;
    if (!runner) throw new Error(`sendMessage: session ${sessionId} has no runner to resume under`);

    const runs = await store.listRuns(sessionId);
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

    const provisioned = await provision({ userId: session.user_id, nodeId: session.node_id, sessionId, resume: null });

    // The instance's CLAUDE_CONFIG_DIR is where that profile's CLI keeps
    // its transcripts; without it the check reads the default location,
    // finds nothing for a session run under any other profile, and every
    // resume silently becomes a fresh agent holding only the summary.
    // instanceClaudeConfigDir is the same resolution the resume-info route
    // answers with (#508).
    const instanceId = session.instance_id;
    const instanceEnv = instanceId ? ((await getInstanceEnv(instanceId)) ?? {}) : {};
    // #508: the CLI that wrote the transcript is the last run's runner.
    // `sessions.cli` is filled in only once the run's own MCP connection
    // completes its handshake, which a run whose Portuni connection failed
    // (#507) or never reached this graph db never does -- a null there
    // turned every such resume into a summary start.
    const transcriptCli = session.cli ?? lastRun?.runner ?? null;
    const canResumeConversation =
      lastRun?.agent_session_id != null &&
      (await checkConversationResumable(
        transcriptCli,
        lastRun.agent_session_id,
        provisioned.cwd,
        undefined,
        instanceClaudeConfigDir(instanceEnv),
      ));

    let runStartResume: RunStart["resume"] = null;
    let runProvisioned = provisioned;
    if (canResumeConversation && lastRun?.agent_session_id) {
      runStartResume = { agentSessionId: lastRun.agent_session_id };
    } else {
      const summary = await resumeSummary(session, provisioned.cwd);
      // #497: nothing to continue from here -- no conversation, no Předat
      // file, no transcript and no content at all on this device. The same
      // refusals Předat gives: the transcript is on the device the thread
      // last ran on, or its download to this one has not finished. Refused
      // before any run is created or the record touched.
      if (!summary && !(await contentIsHere(sessionId))) await refuseForMissingContent(session);
      if (summary) {
        runProvisioned = {
          ...provisioned,
          orientation: `${provisioned.orientation}\n\n## Předání (obnovení ze shrnutí)\n\nKonverzace se neobnovuje přímo; pokračuješ z tohoto shrnutí:\n\n${summary}`,
        };
      }
    }

    const run = await store.createRun({
      session_id: sessionId,
      runner,
      instance_id: instanceId,
      host_id: localHostId(),
      resumed_from_run_id: lastRun?.id ?? null,
      agent_session_id: runStartResume?.agentSessionId ?? null,
    });
    const updated = await store.patchSession(sessionId, { state: "running" });

    // Same reason as promoteDraftAndStart's own state_changed: a window
    // other than this one showing the thread learns it woke up.
    await appendAndPublish(sessionId, null, [
      { kind: "state_changed", payload: { from: session.state, to: "running", waiting: false } },
    ]);

    await startRun(updated, run, runProvisioned, instanceEnv, {
      brief: text,
      runStartResume,
      resumeMode: runStartResume ? "conversation" : "handoff",
      policy: "default",
      logBrief: !logged,
    });
  }

  // #497: the summary a resume without a conversation continues from. A
  // file Předat wrote is what the user handed over (and may have edited),
  // so it wins; otherwise nothing was written at suspend and the summary is
  // built now, from this device's transcript, with the same builder a
  // handoff uses. With no transcript here either, an inline summary an
  // older sidecar left behind is the last resort, and with none of the
  // three the thread resumes on its orientation alone, as before.
  async function resumeSummary(session: SessionRow, cwd: string): Promise<string | null> {
    if (session.handoff_path) {
      const file = await readFile(join(cwd, session.handoff_path), "utf8").catch(() => null);
      if (file) return file;
    }
    if ((await content.listEvents(session.id, { limit: 1 })).length > 0) {
      return handoffs.summarize(session, "run_ended");
    }
    return (await content.getContent(session.id))?.handoff_inline ?? null;
  }

  // Same ordering rule: the answered question (and the waiting: false
  // state) is recorded before the adapter learns the decision.
  async function answerLocked(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void> {
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
  async function interruptLocked(sessionId: string): Promise<void> {
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

  async function renameSession(sessionId: string, name: string): Promise<SessionRow> {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error("renameSession: name must not be empty");
    const row = await store.patchSession(sessionId, { name: trimmed, name_is_custom: true });
    publish(sessionId, { type: "session_changed", session_id: sessionId });
    return row;
  }

  // #378: the only action that actually ends a live run's process (besides
  // continueSession and the idle sweep) -- close(), not interrupt(), so the
  // run genuinely stops instead of just cancelling the current turn.
  // Uzavřít is the one irreversible action, so closingSessions is set
  // first: the run_ended this produces must not ALSO trigger the auto-
  // summary/suspend path, since this function already owns the transition
  // to closed.
  async function closeSessionLocked(sessionId: string): Promise<SessionRow> {
    const live = liveRuns.get(sessionId);
    if (live) {
      closingSessions.add(sessionId);
      await live.handle.close();
      await drain(sessionId);
    }
    const before = await store.getSession(sessionId);
    const closed = await store.patchSession(sessionId, { state: "closed" });
    // Published so the live channel's session_state broadcast fires
    // (api/sessions-ws.ts reacts only to state_changed/question/run_ended):
    // a suspended session has no live run, so its close produces no
    // run_ended and without this the Relace row, the Práce sidebar and
    // Přehled would keep showing it as suspended until an unrelated refetch.
    if (before && before.state !== "closed") {
      await appendAndPublish(sessionId, null, [
        { kind: "state_changed", payload: { from: before.state, to: "closed", waiting: false } },
      ]);
    }
    return closed;
  }

  // #378: ends an idle live run (no activity for longer than idleMs) the
  // same way closeSession would, EXCEPT it does NOT add to closingSessions
  // -- the resulting run_ended is meant to fall through to the auto-
  // summary/suspend path in handleAdapterEvent, tagged "idle" specifically
  // (via pendingEndReason) rather than the generic "run_ended".
  async function endRunWithReason(sessionId: string, reason: ServerHandoffReason): Promise<boolean> {
    const live = liveRuns.get(sessionId);
    if (!live) return false;
    pendingEndReason.set(sessionId, reason);
    await live.handle.close();
    await drain(sessionId);
    return true;
  }

  async function endIdleRun(sessionId: string): Promise<void> {
    await endRunWithReason(sessionId, "idle");
  }

  // #459 "Předat". Every refusal comes BEFORE any side effect: nothing is
  // interrupted, ended or suspended unless the file can be written here.
  //   - a draft or closed thread: nothing to hand over;
  //   - no mirror of the node on this device: there is nowhere to write the
  //     file;
  //   - running, but the run is live on another device: only that device
  //     can end it and summarise it;
  //   - suspended with no file, and the transcript is on another device:
  //     the summary is built from it, so only that device can write it.
  // Running here: cancel the turn in flight first (the summary should
  // describe a finished thought, not one mid-sentence), let the queue
  // drain, then end the run -- the run_ended that follows falls through
  // handleAdapterEvent's auto-summary path, tagged "handoff", so the file,
  // its registration and the record patch are the one suspend
  // implementation, not a second copy. A running thread whose run was on
  // this device but has no live handle any more (the device restarted
  // under it) still gets its summary: the suspend path needs no adapter.
  // Suspended with no file: the same summary path writes the file now.
  async function handoffLocked(sessionId: string): Promise<{ session: SessionRow; handoff_path: string }> {
    const session = await mustGetSession(sessionId);
    if (session.state === "suspended" && session.handoff_path) {
      return { session, handoff_path: session.handoff_path };
    }
    if (session.state !== "running" && session.state !== "suspended") {
      throw new SessionHandoffError(
        "HANDOFF_NOT_ALLOWED",
        "Předat lze jen běžící nebo pozastavené vlákno.",
      );
    }
    if (!session.node_id || !(await getMirrorPath(session.user_id, session.node_id))) {
      throw noMirrorHandoffError();
    }

    if (session.state === "running") {
      if (!liveRuns.has(sessionId)) {
        const host = await runHostOf(session);
        if (host && host !== localHostId()) {
          throw new SessionHandoffError(
            "HANDOFF_RUN_ELSEWHERE",
            `Vlákno právě běží na zařízení ${resolveHostLabel(host) ?? host}; předat ho lze jen tam.`,
          );
        }
      }
      await interruptLocked(sessionId);
      if (!(await endRunWithReason(sessionId, "handoff"))) {
        await suspendFallback(sessionId, "handoff");
      }
    } else {
      if (!(await contentIsHere(sessionId))) {
        await refuseForMissingContent(session, "předat ho lze jen tam");
      }
      await suspendFallback(sessionId, "handoff", { writeFileIfSuspended: true });
    }
    const after = await mustGetSession(sessionId);
    if (!after.handoff_path) throw noMirrorHandoffError();
    return { session: after, handoff_path: after.handoff_path };
  }

  // The thread's content is not on this device. Always throws: the
  // transcript is on the device the thread last ran on, or -- it ran here,
  // or nowhere recorded -- the first-boot download from the central server
  // has not finished or failed. A summary built now would be empty and
  // would stand in for the real one, so nothing proceeds until the content
  // arrives.
  async function refuseForMissingContent(
    session: SessionRow,
    elsewhereTail = "pokračovat v něm lze jen tam",
  ): Promise<never> {
    const host = await runHostOf(session);
    if (host && host !== localHostId()) {
      throw new SessionHandoffError(
        "HANDOFF_TRANSCRIPT_ELSEWHERE",
        `Transkript vlákna je na zařízení ${resolveHostLabel(host) ?? host}; ${elsewhereTail}.`,
      );
    }
    throw new SessionHandoffError(
      "HANDOFF_NO_CONTENT",
      "Obsah vlákna na tomto zařízení zatím není; zkus to znovu, až se stáhne.",
    );
  }

  // Where the thread last ran: the host of its open run if it has one,
  // else of its latest run, else the record's own.
  async function runHostOf(session: SessionRow): Promise<string | null> {
    const runs = await store.listRuns(session.id);
    const open = runs.filter((r) => r.ended_at === null && r.host_id);
    if (open.length > 0) return open[open.length - 1].host_id;
    const withHost = runs.filter((r) => r.host_id);
    if (withHost.length > 0) return withHost[withHost.length - 1].host_id;
    return session.host_id;
  }

  // Whether this device holds any of the thread's content -- its
  // transcript or its content row.
  async function contentIsHere(sessionId: string): Promise<boolean> {
    if ((await content.listEvents(sessionId, { limit: 1 })).length > 0) return true;
    return (await content.getContent(sessionId)) !== null;
  }

  // #460 "Navázat na handoff". The file is read BEFORE anything is created,
  // so a handoff that has not reached this device yet leaves no half-made
  // thread behind. Everything after that is continueSession's shape minus
  // the close: a new record, the summary as extra orientation, a first run
  // that starts itself with no brief. The source thread is never read and
  // never written -- the file is the whole handover, which is what lets it
  // come from another machine.
  async function startFromHandoff(input: StartFromHandoffInput): Promise<{
    session: SessionRow;
    run: SessionRunRow;
  }> {
    if (!isHandoffRelativePath(input.handoffPath)) {
      throw new SessionHandoffError("HANDOFF_PATH_INVALID", "Cesta k souboru handoffu není platná.");
    }
    const summary = await readNodeHandoffFile(input.userId, input.nodeId, input.handoffPath);
    if (summary === null) {
      throw new SessionHandoffError("HANDOFF_FILE_NOT_HERE", "Soubor handoffu ještě není na tomto zařízení.");
    }

    const { runner, instanceId } = await resolveTaskDefaults(input.nodeId, resolveNodeOrgId);
    // Provisioned before the record is created, like startTask.
    const provisioned = await provision({
      userId: input.userId,
      nodeId: input.nodeId,
      sessionId: null,
      resume: null,
    });
    const created = await store.createSession({
      node_id: input.nodeId,
      user_id: input.userId,
      runner,
      instance_id: instanceId,
      host_id: localHostId(),
    });
    // name_is_custom stays 0: the title is the summary's, not the user's,
    // so this thread's own first summary may rename it later, exactly as a
    // thread named from its first message is left alone.
    const title = extractHandoffTitle(summary);
    const session = title ? await store.patchSession(created.id, { name: title }) : created;

    const seededProvisioned = {
      ...provisioned,
      orientation:
        `${provisioned.orientation}\n\n## Navázání na handoff\n\n` +
        `Navazuješ na vlákno z jiného zařízení; konverzace se nepřenáší, ` +
        `pokračuješ z tohoto shrnutí (\`${input.handoffPath}\`):\n\n${summary}`,
    };

    const run = await store.createRun({
      session_id: session.id,
      runner,
      instance_id: instanceId,
      host_id: localHostId(),
    });
    const instanceEnv = instanceId ? ((await getInstanceEnv(instanceId)) ?? {}) : {};

    await startRun(session, run, seededProvisioned, instanceEnv, {
      brief: null,
      runStartResume: null,
      resumeMode: "handoff",
      policy: input.policy ?? "default",
    });

    return { session: await mustGetSession(session.id), run };
  }

  function noMirrorHandoffError(): SessionHandoffError {
    return new SessionHandoffError(
      "HANDOFF_NO_MIRROR",
      "Uzel nemá na tomto zařízení zrcadlo, soubor s předáním nelze zapsat.",
    );
  }

  // A run is idle when no turn of it is in flight (an unanswered question is
  // the one turn that waits on the user, not on the agent) and nothing has
  // touched it since the sweep's cutoff.
  function isIdleRun(sessionId: string, idleMs: number, now: number): boolean {
    if (isTurnInFlight(sessionId) && !pendingQuestions.has(sessionId)) return false;
    return now - (lastActivityAt.get(sessionId) ?? now) > idleMs;
  }

  // #491: the list of idle runs is computed once, but ending one takes
  // seconds (the child process has to go and the suspend has to be
  // written), and a user who starts writing into the next session on the
  // list in the meantime must keep it running. So every session is checked
  // again the moment before it is ended, against the activity it had when
  // it was picked: a run that has been touched since -- a message, an
  // answer, an adapter event, a run that is already gone -- is skipped.
  async function checkIdleRunsOnce(idleMs: number, now: number = Date.now()): Promise<void> {
    const stale = [...liveRuns.keys()]
      .filter((id) => isIdleRun(id, idleMs, now))
      .map((id) => ({ id, tick: activityTicks.get(id) }));
    for (const { id, tick } of stale) {
      if (!liveRuns.has(id)) continue;
      if (activityTicks.get(id) !== tick) continue;
      if (!isIdleRun(id, idleMs, now)) continue;
      await endIdleRun(id);
    }
  }

  // #378: "Pokračovat v nové session" -- closes THIS session (summary built
  // from whatever's in its own log right now -- not the suspend path, since
  // this ends as closed, never suspended) and starts a fresh one, running,
  // on the same node, carrying the old summary as extra orientation. No
  // mode picker, no brief: the new thread starts itself. #497: the summary
  // is written as the old thread's handoff file (when this device has a
  // mirror of the node) and the new thread's orientation points at it, the
  // way Navázat na handoff's does.
  async function continueSessionLocked(sessionId: string): Promise<{ session: SessionRow; run: SessionRunRow }> {
    const oldSession = await mustGetSession(sessionId);
    if (!oldSession.node_id) throw new Error(`continueSession: session ${sessionId} has no anchor node`);
    const runner = oldSession.runner;
    if (!runner) throw new Error(`continueSession: session ${sessionId} has no runner to continue under`);

    // Provisioned before the old thread is closed: when the new run cannot
    // start (#507), the old one stays as it is.
    const provisioned = await provision({
      userId: oldSession.user_id,
      nodeId: oldSession.node_id,
      sessionId: null,
      resume: null,
    });

    const live = liveRuns.get(sessionId);
    if (live) {
      closingSessions.add(sessionId);
      await live.handle.close();
      await drain(sessionId);
    }

    const summary = await handoffs.summarize(oldSession, "continue");
    // The old run is already ended: a file that cannot be written (a full
    // disk, a mirror gone read-only) must not strand the old thread running
    // with no live run. The summary still seeds the new thread inline, the
    // way it does when there is no mirror.
    const written = await handoffs.writeFile(oldSession, summary).catch((err: unknown) => {
      console.error(`[portuni:runner] continueSession ${sessionId}: writing the handoff file failed:`, err);
      return null;
    });

    await store.patchSession(sessionId, {
      state: "closed",
      ...(written ? { handoff_path: written.handoffPath, handoff_hash: written.handoffHash } : {}),
    });
    await appendAndPublish(sessionId, null, [
      { kind: "state_changed", payload: { from: oldSession.state, to: "closed", waiting: false } },
    ]);

    const newSession = await store.createSession({
      node_id: oldSession.node_id,
      user_id: oldSession.user_id,
      runner,
      instance_id: oldSession.instance_id,
      host_id: localHostId(),
      model: oldSession.model,
      effort: oldSession.effort,
    });
    await store.patchSession(newSession.id, { name: oldSession.name, name_is_custom: true });

    const seededProvisioned = {
      ...provisioned,
      orientation: written
        ? `${provisioned.orientation}\n\n## Pokračování z předchozí session\n\n` +
          `Navazuješ na předchozí vlákno; konverzace se nepřenáší, ` +
          `pokračuješ z tohoto shrnutí (\`${written.handoffPath}\`):\n\n${summary}`
        : `${provisioned.orientation}\n\n## Pokračování z předchozí session\n\n${summary}`,
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

  function listEvents(sessionId: string, opts?: ListEventsOptions): Promise<SessionEventRow[]> {
    return content.listEvents(sessionId, opts);
  }

  // #488: the entry points that start a run, end one or act on the live
  // one take the session's lifecycle lock, so they can never observe liveRuns while
  // a start of the same session is still in flight. A second message
  // arriving during a start therefore finds the run that start produced and
  // goes to it as an ordinary message; Uzavřít and Předat wait for the
  // start and then end that run.
  function sendMessage(sessionId: string, text: string): Promise<void> {
    return withLifecycleLock(sessionId, () => sendMessageLocked(sessionId, text));
  }

  // Stop and an answer act on the live run too: during a start they wait
  // for the run it produces instead of finding none (Stop a silent no-op,
  // an answer "has no live run").
  function interrupt(sessionId: string): Promise<void> {
    return withLifecycleLock(sessionId, () => interruptLocked(sessionId));
  }

  function answer(sessionId: string, requestId: string, decision: QuestionDecision): Promise<void> {
    return withLifecycleLock(sessionId, () => answerLocked(sessionId, requestId, decision));
  }

  function closeSession(sessionId: string): Promise<SessionRow> {
    return withLifecycleLock(sessionId, () => closeSessionLocked(sessionId));
  }

  function handoff(sessionId: string): Promise<{ session: SessionRow; handoff_path: string }> {
    return withLifecycleLock(sessionId, () => handoffLocked(sessionId));
  }

  function continueSession(sessionId: string): Promise<{ session: SessionRow; run: SessionRunRow }> {
    return withLifecycleLock(sessionId, () => continueSessionLocked(sessionId));
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
    renameSession,
    closeSession,
    handoff,
    startFromHandoff,
    continueSession,
    pendingQuestion,
    subscriberCount,
    listEvents,
    subscribe,
    sessionSignals,
    checkIdleRunsOnce,
  };
}
