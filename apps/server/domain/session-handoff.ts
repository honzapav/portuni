// Domain: session handoff file lifecycle (write + hash at suspend, resume
// readiness at resume). Touches the filesystem directly (writing the
// handoff file, hashing it, and -- for Claude Code specifically -- checking
// whether the underlying CLI conversation still exists), unlike sessions.ts
// which stays DB-only; domain/sync/* already mixes fs + DB the same way for
// the same reason (this IS the disk-sync boundary). See
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md,
// "Lifecycle" / "Handoff".

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { DbClient } from "../infra/db.js";
import { sha256Buffer } from "./sync/hash.js";
import { registerLocalFile, storeFile } from "./sync/engine.js";
import { getMirrorPath } from "./sync/mirror-registry.js";
import { isLocalWorkspace } from "../infra/server-config.js";
import { getSession, getSessionScope, suspendSession } from "./sessions.js";
import type { SessionRow } from "../shared/types.js";
import type { SessionContentStore } from "./runner/store-content.js";
import type { RunEndReason } from "./runner/types.js";

// Fixed synced-path convention for a session's handoff -- a pure function
// of the session id so both the write path here and any future reader
// (REST/UI, #192) compute the identical relative path.
export function handoffRelativePath(sessionId: string): string {
  return `wip/sessions/${sessionId}-handoff.md`;
}

// #460 "Navázat na handoff": the only shape POST /sessions accepts as the
// handoff a new thread continues from -- exactly what handoffRelativePath
// writes, so a request can never point a new thread's orientation at an
// arbitrary file of the mirror.
const HANDOFF_RELATIVE_PATH_RE = /^wip\/sessions\/[A-Za-z0-9_-]+-handoff\.md$/;

export function isHandoffRelativePath(relPath: string): boolean {
  return HANDOFF_RELATIVE_PATH_RE.test(relPath);
}

// The session a handoff file belongs to, read off its name alone -- the
// source thread may live on another machine (and its record may belong to
// someone else), so this is a hint for the UI, never an access decision.
export function handoffPathSessionId(relPath: string): string | null {
  const match = relPath.match(/^wip\/sessions\/(.+)-handoff\.md$/);
  return match && isHandoffRelativePath(relPath) ? match[1] : null;
}

// Reads a node's handoff file from THIS device's mirror. Null when the path
// is not a handoff path, when the node has no mirror here, or when the file
// has not arrived yet -- the caller (SessionRuntime.startFromHandoff) turns
// all three into the same refusal: there is nothing on this device to
// continue from. Device-local in both workspaces: the mirror registry is
// this device's sync.db and the bytes are its own copy, so a sync agent
// answers it without reaching central.
export async function readNodeHandoffFile(
  userId: string,
  nodeId: string,
  relPath: string,
): Promise<string | null> {
  if (!isHandoffRelativePath(relPath)) return null;
  const mirrorRoot = await getMirrorPath(userId, nodeId);
  if (!mirrorRoot) return null;
  return await readFile(join(mirrorRoot, relPath), "utf8").catch(() => null);
}

export interface WriteHandoffResult {
  session: SessionRow;
  handoffPath: string;
  handoffHash: string;
}

// Writes `content` to the session's home mirror at the fixed handoff path,
// registers it through the normal sync machinery (so it lands on the
// routed remote like any other tracked file, visible to the team), and
// suspends the session with the resulting pointer.
//
// The stored hash is computed here (sha256 of the exact content written),
// deliberately NOT storeFile's returned hash: that one reflects whatever
// the routed remote's adapter reports (sha256 normally, but Drive reports
// its own md5 checksum -- see engine.ts's storeFile), so relying on it
// would make a later "did the handoff change" comparison algorithm-
// dependent on which remote happens to be configured. Hashing the content
// ourselves keeps "stored" and "current" (getResumeInfo, reading the file
// straight off disk) always comparable.
// Suspend atomicity (#204: "Suspend is not atomic"): the state transition is
// tied to the LOCAL write succeeding, not to the upload. A session's
// suspended-ness is defined by "the agent wrote a handoff and the server
// recorded its hash" (spec, "Lifecycle": "agent writes a handoff ... state ->
// suspended") -- the routed remote may not exist yet (no routing configured)
// or be briefly unreachable, and that must not leave the session stuck
// 'running' with an orphaned local handoff nobody can resume from. The
// upload is therefore best-effort: a failure is logged, never thrown. The
// file already exists on disk and (if the mirror watcher is running) is
// picked up and tracked the same way as any other file per the deterministic
// file-state model (root CLAUDE.md, "File state is deterministic" gotcha);
// a later deliberate sync run or portuni_store still pushes it once routing
// exists. `PendingOp` (domain/sync/pending-ops.ts) only models move/delete
// today, not a first store -- extending it is out of scope here.
export async function writeHandoffAndSuspend(
  db: DbClient,
  actorUserId: string,
  session: { id: string; nodeId: string; mirrorRoot: string },
  content: string,
  agentSessionId?: string | null,
): Promise<WriteHandoffResult> {
  const relPath = handoffRelativePath(session.id);
  const absPath = join(session.mirrorRoot, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, "utf8");

  const handoffHash = sha256Buffer(Buffer.from(content, "utf8"));
  const row = await suspendSession(db, actorUserId, session.id, {
    handoffPath: relPath,
    handoffHash,
    agentSessionId,
    handoffTitle: extractHandoffTitle(content),
  });

  // A local workspace has no remote (#310): the handoff is registered as a
  // tracked file, same as the watcher would do, and never pushed anywhere.
  const track = isLocalWorkspace() ? registerLocalFile : storeFile;
  try {
    await track(db, {
      userId: actorUserId,
      nodeId: session.nodeId,
      localPath: absPath,
      subpath: "sessions",
      status: "wip",
    });
  } catch (err) {
    console.error(
      `[portuni:session-handoff] ${track.name} failed for ${absPath}; the session is suspended and the handoff is written locally, but not yet tracked:`,
      err,
    );
  }

  return { session: row, handoffPath: relPath, handoffHash };
}

// Spec: "Default name `node · date`, enriched from the handoff's title at
// suspend". Handoffs are free-form markdown; the only convention assumed is
// a leading H1 (`# ...`) as the title, matching how the agent is prompted to
// write one. No H1 -> null -> suspendSession leaves the existing name alone.
// Capped so a runaway heading can't blow out the sessions list's row height.
const MAX_HANDOFF_TITLE_LENGTH = 200;

export function extractHandoffTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  if (!match) return null;
  const title = match[1].trim();
  if (title.length === 0) return null;
  return title.slice(0, MAX_HANDOFF_TITLE_LENGTH);
}

// --- Server-generated handoff (#329) ---------------------------------
//
// Every path that used to CLOSE a 'running' session out from under it
// (a dropped MCP connection, the transport's idle GC, a PTY exit, the boot
// sweep) now suspends it instead, with a minimal handoff the server writes
// itself -- closed is terminal (no resume), and none of these are the
// agent's own deliberate portuni_session_suspend. The runner runtime's
// suspend() (session-runtime.ts, #320) calls this too, with reason
// suspend_timeout, when the agent never wrote its own handoff in time.

// host_lost: the boot orphaned-run sweep (domain/runner/run-sweep.ts, #325)
// found a run whose child process this device can no longer be tracking
// after a sidecar restart/crash.
// run_ended (#378): a runner-driven thread's run ended for any reason other
// than an explicit Uzavřít/continue (session-runtime.ts's own
// handleAdapterEvent) -- the generic case; "idle" is the more specific one
// below, still reported separately so the Relace row can say "nečinnost"
// rather than the generic wording. suspend_timeout is retired along with
// the agent-cooperative suspend handshake it belonged to (#378), and
// terminal_exit along with the embedded terminal itself (#345/#346) -- no
// runtime code produces either anymore, but both values stay in this union
// so an old row's already-written reason marker still parses.
// handoff (#459): the owner asked for it -- Předat ends the turn and the
// run deliberately so the summary can travel to another machine, the one
// reason in this union a person chose rather than the runtime noticing.
export type ServerHandoffReason =
  | "disconnect"
  | "idle"
  | "terminal_exit"
  | "boot_sweep"
  | "suspend_timeout"
  | "host_lost"
  | "run_ended"
  | "continue"
  | "handoff";

const SERVER_HANDOFF_REASONS: readonly ServerHandoffReason[] = [
  "disconnect",
  "idle",
  "terminal_exit",
  "boot_sweep",
  "suspend_timeout",
  "host_lost",
  "run_ended",
  "continue",
  "handoff",
];

// A leading HTML-comment marker rather than a new column for `generated_by`/
// `reason`: it travels with the content itself (on disk or in
// handoff_inline) instead of needing yet another pair of session columns,
// and getResumeInfo already has the content in hand from its own
// handoff-changed check.
function serverHandoffMarker(reason: ServerHandoffReason): string {
  return `<!-- portuni:server-handoff reason=${reason} -->`;
}

export function parseServerHandoffReason(content: string | null): ServerHandoffReason | null {
  if (!content) return null;
  const match = content.match(/^<!-- portuni:server-handoff reason=(\w+) -->/);
  const reason = match?.[1];
  return reason && (SERVER_HANDOFF_REASONS as readonly string[]).includes(reason)
    ? (reason as ServerHandoffReason)
    : null;
}

// #378 ("the deterministic thread lifecycle"): the minimal shape a summary
// needs from a canonical event -- deliberately NOT domain/runner/types.ts's
// own CanonicalEvent union, so this file (and its pure builder below) has no
// dependency on the runner layer; a plain { kind, payload } pair is exactly
// what a session_events row already carries once its payload is parsed.
export interface SummaryEvent {
  kind: string;
  payload: unknown;
}

const MAX_SUMMARY_MESSAGES = 6;
const MAX_MESSAGE_PREVIEW_LENGTH = 200;

function isTextPayload(payload: unknown): payload is { text: string } {
  return typeof payload === "object" && payload !== null && typeof (payload as { text?: unknown }).text === "string";
}

function isFileChangePayload(payload: unknown): payload is { path: string; op: string } {
  const p = payload as { path?: unknown; op?: unknown };
  return typeof p?.path === "string" && typeof p?.op === "string";
}

function isQuestionPayload(payload: unknown): payload is { request_id: string; title: string; decision: unknown } {
  const p = payload as { request_id?: unknown; title?: unknown };
  return typeof p?.request_id === "string" && typeof p?.title === "string";
}

// Exported because createSuspendServerSide below builds every summary with
// it, in both workspaces -- a summary written by either mode is identical
// by construction.
//
// #378: "the summary replaces the suspend handshake" -- mechanical, built
// entirely from session_events and session_scope, no agent cooperation
// needed: the last few messages, any files changed, any question left open
// (the LATEST payload per request_id wins, since an answered question
// re-appends with `decision` filled in -- "open" means that latest payload
// still has none), and the write/read set. Renamed from
// buildServerHandoffContent (the write/read-set-only shape #329 introduced)
// -- this is what it always meant to grow into once nothing had to wait on
// the agent for the rest of it.
export function buildRunSummaryContent(input: {
  nodeName: string | null;
  sessionName: string;
  reason: ServerHandoffReason;
  events: readonly SummaryEvent[];
  writeSet: readonly string[];
  readSet: readonly string[];
  lastActiveAt: string;
}): string {
  const messages = input.events
    .filter((e) => (e.kind === "user_message" || e.kind === "assistant_message") && isTextPayload(e.payload))
    .slice(-MAX_SUMMARY_MESSAGES)
    .map((e) => {
      const text = (e.payload as { text: string }).text;
      const firstLine = text.split("\n")[0].slice(0, MAX_MESSAGE_PREVIEW_LENGTH);
      return `- **${e.kind === "user_message" ? "Uživatel" : "Agent"}:** ${firstLine}`;
    });

  const filesChanged = new Map<string, string>();
  for (const e of input.events) {
    if (e.kind === "file_change" && isFileChangePayload(e.payload)) filesChanged.set(e.payload.path, e.payload.op);
  }

  const questionsByRequestId = new Map<string, { title: string; decision: unknown }>();
  for (const e of input.events) {
    if (e.kind === "question" && isQuestionPayload(e.payload)) {
      questionsByRequestId.set(e.payload.request_id, { title: e.payload.title, decision: e.payload.decision });
    }
  }
  const openQuestion = [...questionsByRequestId.values()].find((q) => q.decision == null);

  return [
    serverHandoffMarker(input.reason),
    `# ${input.sessionName}`,
    "",
    `Uzel: ${input.nodeName ?? "(bez uzlu)"}`,
    `Poslední aktivita: ${input.lastActiveAt}`,
    "",
    "## Poslední zprávy",
    messages.length > 0 ? messages.join("\n") : "(žádné)",
    "",
    "## Změněné soubory",
    filesChanged.size > 0 ? [...filesChanged.entries()].map(([path, op]) => `- ${path} (${op})`).join("\n") : "(žádné)",
    "",
    "## Otevřená otázka",
    openQuestion ? openQuestion.title : "(žádná)",
    "",
    "## Zápisový rozsah",
    input.writeSet.length > 0 ? input.writeSet.map((id) => `- ${id}`).join("\n") : "(žádný)",
    "",
    "## Čtecí rozsah",
    input.readSet.length > 0 ? input.readSet.map((id) => `- ${id}`).join("\n") : "(žádný)",
    "",
    "Konverzace nebyla uložena; pokračuj z tohoto shrnutí.",
  ].join("\n");
}

async function nodeNameForHandoff(db: DbClient, nodeId: string): Promise<string | null> {
  const res = await db.execute({ sql: "SELECT name FROM nodes WHERE id = ?", args: [nodeId] });
  return res.rows.length > 0 ? String(res.rows[0].name) : null;
}

// The summary builder's own input shape, straight off the device's
// transcript (#456: session_events lives in content.db, in both
// workspaces, never on the record).
async function listSummaryEvents(content: SessionContentStore, sessionId: string): Promise<SummaryEvent[]> {
  const rows = await content.listEvents(sessionId);
  return rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
}

// The name a suspend gives the thread: the handoff's own title, unless the
// user named it themselves. One rule, two record writers -- the local
// UPDATE in domain/sessions.ts's suspendSession and the record patch a
// team-workspace sidecar sends over REST (boot/session-runtime.ts).
export function handoffEnrichedName(
  session: { name: string; name_is_custom: number },
  handoffTitle: string | null,
): string {
  const title = handoffTitle?.trim();
  return session.name_is_custom === 0 && title ? title : session.name;
}

// --- The one server-side suspend (#458) ----------------------------------
//
// Writing the summary needs four things the two workspaces reach
// differently: the record (state, runs), the node name and scope sections,
// the record write itself, and tracking the written file. Everything else --
// what the summary contains, where the file goes, what happens when this
// device has no mirror for the node -- is the same code in both, which is
// the point: #458 deleted the second implementation a team-workspace
// sidecar used to carry and left these seams in its place (rule 1,
// "written once"). The local bindings are below (localSuspendDeps); the
// team-workspace ones are built in boot/session-runtime.ts, where the
// CentralClient lives.

export interface SuspendSummaryScope {
  node_name: string | null;
  write_set: readonly string[];
  read_set: readonly string[];
}

const EMPTY_SUMMARY_SCOPE: SuspendSummaryScope = { node_name: null, write_set: [], read_set: [] };

// The record reads/writes the suspend needs, narrower than SessionStore on
// purpose: both SessionStore implementations satisfy it structurally, and a
// test can hand it a two-method object.
export interface SuspendRecordReader {
  getSession(id: string): Promise<SessionRow | null>;
  listRuns(sessionId: string): Promise<{ id: string; ended_at: string | null }[]>;
  patchRun(runId: string, patch: { ended_at: string; end_reason: RunEndReason }): Promise<unknown>;
}

export interface SuspendRecordInput {
  handoffPath: string | null;
  handoffHash: string;
  handoffTitle: string | null;
}

export interface SuspendServerSideDeps {
  record: SuspendRecordReader;
  // The transcript the summary is built from, and where the summary itself
  // lands when this device has no mirror: the device's content.db in both
  // workspaces (#456), never the record.
  content: SessionContentStore;
  // Node name + write/read set for the summary's sections.
  scope(sessionId: string, session: SessionRow): Promise<SuspendSummaryScope>;
  // Records the suspend on the record store.
  suspendRecord(session: SessionRow, input: SuspendRecordInput): Promise<SessionRow | null>;
  // Best-effort: makes the written handoff a tracked file of the node.
  trackHandoff(input: { userId: string; nodeId: string; localPath: string }): Promise<void>;
}

export interface SuspendServerSideOptions {
  // #459 Předat on a thread that is already suspended but has no handoff
  // FILE (it was suspended where the node had no mirror, so its summary is
  // handoff_inline in this device's content.db, or it has none yet): write
  // the file now, into the mirror this device has, and record its path.
  // The caller has already checked that the mirror and the content are here.
  writeFileIfSuspended?: boolean;
}

export type SuspendServerSide = (
  sessionId: string,
  reason: ServerHandoffReason,
  opts?: SuspendServerSideOptions,
) => Promise<SessionRow | null>;

// Suspends a 'running' session with a summary the SERVER writes, not the
// agent -- a real file in the mirror when one exists on this device (same
// path writeHandoffAndSuspend uses), or handoff_inline when it doesn't
// (no mirror for the node here). A no-op (returns the row unchanged) for
// any state other than 'running': already-suspended or terminal sessions
// have nothing for this to do -- except a suspended one with no file when
// the caller asks for it (writeFileIfSuspended).
export function createSuspendServerSide(deps: SuspendServerSideDeps): SuspendServerSide {
  return async function suspendServerSide(sessionId, reason, opts = {}) {
    const session = await deps.record.getSession(sessionId);
    if (opts.writeFileIfSuspended && session?.state === "suspended" && !session.handoff_path) {
      return writeFileForSuspended(deps, session, reason);
    }
    if (session?.state !== "running") return session;

    // A suspend that does not come from the run's own end (a boot sweep after
    // a restart, a dropped transport, a lost host) leaves the run row open and
    // the event log on a run_started with no run_ended -- and every client
    // replaying that log then treats the run as live: working row, stop
    // button, no composer, on a session the server says is suspended. End
    // the dangling runs here and say so in the log, the way the runtime's
    // own run_ended does. A run the runtime already ended (ended_at set) is
    // left alone, so its path appends nothing twice.
    const endedRuns = await endDanglingRuns(deps, sessionId, reason);
    const suspended = await suspendWithSummary(deps, session, reason);
    // Only when THIS call ended a run: the runtime's own path (run_ended
    // already in the log, run row already ended) appends nothing here, so
    // its event sequence stays exactly what it was.
    if (endedRuns.length > 0 && suspended?.state === "suspended") {
      await deps.content.appendEvents(sessionId, null, [
        { kind: "state_changed", payload: { from: "running", to: "suspended", waiting: false } },
      ]);
    }
    return suspended;
  };
}

export async function suspendSessionServerSide(
  db: DbClient,
  content: SessionContentStore,
  sessionId: string,
  reason: ServerHandoffReason,
): Promise<SessionRow | null> {
  return createSuspendServerSide(localSuspendDeps(db, content))(sessionId, reason);
}

// The personal-workspace bindings: the graph db is right here, so every
// seam is a direct query.
export function localSuspendDeps(db: DbClient, content: SessionContentStore): SuspendServerSideDeps {
  return {
    record: {
      getSession: (id) => getSession(db, id),
      listRuns: async (sessionId) => {
        const res = await db.execute({
          sql: "SELECT id, ended_at FROM session_runs WHERE session_id = ?",
          args: [sessionId],
        });
        return res.rows.map((r) => ({
          id: String(r.id),
          ended_at: r.ended_at === null ? null : String(r.ended_at),
        }));
      },
      patchRun: (runId, patch) =>
        db.execute({
          sql: "UPDATE session_runs SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
          args: [patch.ended_at, patch.end_reason, runId],
        }),
    },
    content,
    scope: async (sessionId, session) => {
      const rows = await getSessionScope(db, sessionId);
      return {
        node_name: session.node_id ? await nodeNameForHandoff(db, session.node_id) : null,
        write_set: rows.filter((s) => s.writable === 1).map((s) => s.node_id),
        read_set: rows.map((s) => s.node_id),
      };
    },
    suspendRecord: (session, input) =>
      suspendSession(db, session.user_id, session.id, {
        handoffPath: input.handoffPath,
        handoffHash: input.handoffHash,
        handoffTitle: input.handoffTitle,
      }),
    // A local workspace has no remote (#310): the handoff is registered as
    // a tracked file, same as the watcher would do, and never pushed
    // anywhere.
    trackHandoff: async (input) => {
      const track = isLocalWorkspace() ? registerLocalFile : storeFile;
      await track(db, {
        userId: input.userId,
        nodeId: input.nodeId,
        localPath: input.localPath,
        subpath: "sessions",
        status: "wip",
      });
    },
  };
}

function runEndReasonFor(reason: ServerHandoffReason): RunEndReason {
  return reason === "host_lost" ? "host_lost" : "suspended";
}

async function endDanglingRuns(
  deps: SuspendServerSideDeps,
  sessionId: string,
  reason: ServerHandoffReason,
): Promise<string[]> {
  const open = (await deps.record.listRuns(sessionId)).filter((r) => r.ended_at === null);
  if (open.length === 0) return [];
  const now = new Date().toISOString();
  const endReason = runEndReasonFor(reason);
  for (const run of open) {
    await deps.record.patchRun(run.id, { ended_at: now, end_reason: endReason });
    await deps.content.appendEvents(sessionId, run.id, [
      { kind: "run_ended", payload: { run_id: run.id, reason: endReason, usage: null } },
    ]);
  }
  return open.map((r) => r.id);
}

// The summary a server-side suspend writes, built from this device's
// transcript and the session's scope.
async function buildSuspendSummary(
  deps: SuspendServerSideDeps,
  session: SessionRow,
  reason: ServerHandoffReason,
): Promise<string> {
  const sessionId = session.id;
  // A scope read that fails must not cost the session its suspend: the
  // summary is still worth writing without its scope sections, and the
  // alternative is a thread left 'running' with no handoff at all.
  const scope = await deps.scope(sessionId, session).catch((err) => {
    console.error(`[portuni:session-handoff] scope read failed for session ${sessionId}:`, err);
    return EMPTY_SUMMARY_SCOPE;
  });
  const events = await listSummaryEvents(deps.content, sessionId);
  return buildRunSummaryContent({
    nodeName: scope.node_name,
    sessionName: session.name,
    reason,
    events,
    writeSet: scope.write_set,
    readSet: scope.read_set,
    lastActiveAt: session.last_active_at,
  });
}

// Writes `summary` as the thread's handoff file into the node's mirror,
// records it (state suspended, path, hash) and tracks the file. The inline
// copy on the device is cleared: the file is now the handoff.
async function writeSummaryFileAndRecord(
  deps: SuspendServerSideDeps,
  session: SessionRow & { node_id: string },
  mirrorRoot: string,
  summary: string,
): Promise<SessionRow | null> {
  const relPath = handoffRelativePath(session.id);
  const absPath = join(mirrorRoot, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, summary, "utf8");
  await deps.content.setContent(session.id, { handoff_inline: null });
  const row = await deps.suspendRecord(session, {
    handoffPath: relPath,
    handoffHash: sha256Buffer(Buffer.from(summary, "utf8")),
    handoffTitle: extractHandoffTitle(summary),
  });

  // Record-only in a personal workspace, a push in a team one -- either
  // way best-effort: the file is on disk and the session IS suspended;
  // a tracking failure must undo neither.
  try {
    await deps.trackHandoff({ userId: session.user_id, nodeId: session.node_id, localPath: absPath });
  } catch (err) {
    console.error(
      `[portuni:session-handoff] tracking ${absPath} failed; the session is suspended and the handoff is written locally, but not yet tracked:`,
      err,
    );
  }
  return row;
}

async function suspendWithSummary(
  deps: SuspendServerSideDeps,
  session: SessionRow,
  reason: ServerHandoffReason,
): Promise<SessionRow | null> {
  const summary = await buildSuspendSummary(deps, session, reason);
  const mirrorRoot = session.node_id ? await getMirrorPath(session.user_id, session.node_id) : null;
  if (mirrorRoot && session.node_id) {
    return writeSummaryFileAndRecord(deps, { ...session, node_id: session.node_id }, mirrorRoot, summary);
  }

  // No mirror here: the summary itself is the handoff, and it is content --
  // the device holds it, the record keeps only the hash (#456).
  await deps.content.setContent(session.id, { handoff_inline: summary });
  return deps.suspendRecord(session, {
    handoffPath: null,
    handoffHash: sha256Buffer(Buffer.from(summary, "utf8")),
    handoffTitle: extractHandoffTitle(summary),
  });
}

// #459 Předat on a suspended thread with no handoff file. The summary is
// the one its suspend already wrote when there was one (handoff_inline on
// this device), otherwise the same summary a suspend writes, built from
// this device's transcript now. No mirror here: nothing to write into, the
// row comes back unchanged (the caller refuses before it gets here).
async function writeFileForSuspended(
  deps: SuspendServerSideDeps,
  session: SessionRow,
  reason: ServerHandoffReason,
): Promise<SessionRow | null> {
  const mirrorRoot = session.node_id ? await getMirrorPath(session.user_id, session.node_id) : null;
  if (!mirrorRoot || !session.node_id) return session;
  const inline = (await deps.content.getContent(session.id))?.handoff_inline ?? null;
  const summary = inline ?? (await buildSuspendSummary(deps, session, reason));
  return writeSummaryFileAndRecord(deps, { ...session, node_id: session.node_id }, mirrorRoot, summary);
}

// Claude Code's local conversation-transcript layout: one directory per
// working directory under ~/.claude/projects, named by replacing path
// separators (and dots, which would otherwise collide with the directory
// separator once slashes are substituted) with dashes; one <session-id>.jsonl
// file per conversation inside it. This repo has no prior reference for
// this convention -- it is not verified against a live Claude Code install,
// only implemented to the documented/observed shape. Flagged here so a
// human can spot-check it; `checkConversationResumable` degrades to
// "not resumable" (handoff-resume) rather than throwing either way, so a
// wrong slug just means a session that WAS conversation-resumable looks
// like it isn't -- never the reverse.
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// Spec: "Explicitly out of scope: Codex/Vibe/Gemini resume pointers
// (per-CLI capability; Claude first)" -- every other `cli` value (including
// null, e.g. a session created before #194's profiles/CLI tracking lands)
// always resolves false. A missing agentSessionId/cwd, or a filesystem this
// process cannot see (e.g. a remote central server with no access to the
// user's machine), also resolve false rather than throwing: whether the
// conversation is genuinely gone or merely unreachable from here, the
// correct outcome is identical -- degrade to handoff-resume.
//
// configDir is the profile's CLAUDE_CONFIG_DIR (#204, "conversationResumable
// ignores profile_id"): when the session was spawned under a profile setting
// that env var, Claude Code stores its transcripts directly under it instead
// of under `<homeDir>/.claude` -- checking the default location always
// reports false for such a session. The profiles registry itself lives in
// the desktop app's config.json (Rust, apps/desktop/src/workspace.rs), not
// reachable from this server process, so the caller (api/sessions.ts, via an
// optional `config_dir` query param) is responsible for resolving the
// session's instance_id to a config dir and passing it through -- null (the
// default) means "resolve the default location", not "no profile exists".
export async function checkConversationResumable(
  cli: string | null,
  agentSessionId: string | null,
  cwd: string | null,
  homeDir: string = homedir(),
  configDir: string | null = null,
): Promise<boolean> {
  if (cli !== "claude" || !agentSessionId || !cwd) return false;
  const base = configDir ?? join(homeDir, ".claude");
  const jsonlPath = join(base, "projects", claudeProjectSlug(cwd), `${agentSessionId}.jsonl`);
  try {
    await access(jsonlPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResumeInfo {
  session: SessionRow;
  handoffPath: string | null;
  storedHandoffHash: string | null;
  currentHandoffHash: string | null;
  // True only when this device HAS a local mirror for the session's node AND
  // the on-disk handoff no longer matches what was stored at suspend time
  // (edited, or now missing/unreadable) -- spec: "a differing hash is
  // surfaced ('handoff edited since suspend') and the edited version is
  // used". This function only surfaces the fact; using the edited content is
  // the caller's job (it already has the file). False both when nothing
  // changed AND when there is no local mirror to check from -- see
  // handoffCheckable to tell those two apart. A remote edit that has not yet
  // synced down to THIS mirror is invisible either way: detection reads only
  // the local mirror (#204).
  handoffChanged: boolean;
  // False when this device has no local mirror for the session's node, so
  // handoffChanged could not be evaluated at all -- as opposed to being
  // evaluated and found unchanged. Lets callers distinguish "confirmed
  // unchanged" from "cannot tell from this device" instead of the previous
  // behavior, which reported a missing mirror as changed (a false positive).
  handoffCheckable: boolean;
  conversationResumable: boolean;
  // #329: set when the handoff (file or handoff_inline) carries the
  // server-generated marker -- null for an ordinary agent-written handoff,
  // or when there is no handoff at all.
  generatedBy: "server" | null;
  reason: ServerHandoffReason | null;
}

// mirrorRoot is the absolute path of the session's home node mirror on THIS
// machine (getMirrorPath), when one exists -- also the cwd the CLI was
// spawned in, so it doubles as the conversation-resumability check's input.
export interface ResumeInfoOptions {
  homeDir?: string;
  configDir?: string | null;
  // #456: the inline handoff summary, read by the caller off this device's
  // content store (it is content, so it is never on the record). Only used
  // when the session has no handoff file to read instead.
  handoffInline?: string | null;
}

export async function getResumeInfo(
  session: SessionRow,
  mirrorRoot: string | null,
  opts: ResumeInfoOptions = {},
): Promise<ResumeInfo> {
  const homeDir = opts.homeDir ?? homedir();
  const configDir = opts.configDir ?? null;
  const handoffCheckable = mirrorRoot !== null;
  let currentHandoffHash: string | null = null;
  let handoffContent: string | null = null;
  if (session.handoff_path && mirrorRoot) {
    try {
      const buf = await readFile(join(mirrorRoot, session.handoff_path));
      currentHandoffHash = sha256Buffer(buf);
      handoffContent = buf.toString("utf8");
    } catch {
      currentHandoffHash = null;
    }
  } else if (!session.handoff_path) {
    handoffContent = opts.handoffInline ?? null;
  }
  const handoffChanged =
    handoffCheckable && session.handoff_hash !== null && currentHandoffHash !== session.handoff_hash;

  const conversationResumable = await checkConversationResumable(
    session.cli,
    session.agent_session_id,
    mirrorRoot,
    homeDir,
    configDir,
  );

  // #329: a server-generated handoff (either a real file or handoff_inline)
  // carries its own reason marker, read back here so the Relace row can say
  // e.g. "pozastaveno serverem (nečinnost 30 min)" instead of looking like
  // an ordinary agent-written one.
  const serverHandoffReason = parseServerHandoffReason(handoffContent);

  return {
    session,
    handoffPath: session.handoff_path,
    storedHandoffHash: session.handoff_hash,
    currentHandoffHash,
    handoffChanged,
    handoffCheckable,
    conversationResumable,
    generatedBy: serverHandoffReason ? "server" : null,
    reason: serverHandoffReason,
  };
}
