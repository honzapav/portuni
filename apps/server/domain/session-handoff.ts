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
import type { Client } from "@libsql/client";
import { sha256Buffer } from "./sync/hash.js";
import { storeFile } from "./sync/engine.js";
import { suspendSession } from "./sessions.js";
import type { SessionRow } from "../shared/types.js";

// Fixed synced-path convention for a session's handoff -- a pure function
// of the session id so both the write path here and any future reader
// (REST/UI, #192) compute the identical relative path.
export function handoffRelativePath(sessionId: string): string {
  return `wip/sessions/${sessionId}-handoff.md`;
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
  db: Client,
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

  try {
    await storeFile(db, {
      userId: actorUserId,
      nodeId: session.nodeId,
      localPath: absPath,
      subpath: "sessions",
      status: "wip",
    });
  } catch (err) {
    console.error(
      `[portuni:session-handoff] storeFile failed for ${absPath}; the session is suspended and the handoff is written locally, but not yet uploaded:`,
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
// session's profile_id to a config dir and passing it through -- null (the
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
}

// mirrorRoot is the absolute path of the session's home node mirror on THIS
// machine (getMirrorPath), when one exists -- also the cwd the CLI was
// spawned in, so it doubles as the conversation-resumability check's input.
export async function getResumeInfo(
  session: SessionRow,
  mirrorRoot: string | null,
  homeDir: string = homedir(),
  configDir: string | null = null,
): Promise<ResumeInfo> {
  const handoffCheckable = mirrorRoot !== null;
  let currentHandoffHash: string | null = null;
  if (session.handoff_path && mirrorRoot) {
    try {
      const buf = await readFile(join(mirrorRoot, session.handoff_path));
      currentHandoffHash = sha256Buffer(buf);
    } catch {
      currentHandoffHash = null;
    }
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

  return {
    session,
    handoffPath: session.handoff_path,
    storedHandoffHash: session.handoff_hash,
    currentHandoffHash,
    handoffChanged,
    handoffCheckable,
    conversationResumable,
  };
}
