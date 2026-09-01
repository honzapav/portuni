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

  await storeFile(db, {
    userId: actorUserId,
    nodeId: session.nodeId,
    localPath: absPath,
    subpath: "sessions",
    status: "wip",
  });

  const handoffHash = sha256Buffer(Buffer.from(content, "utf8"));
  const row = await suspendSession(db, actorUserId, session.id, {
    handoffPath: relPath,
    handoffHash,
    agentSessionId,
    handoffTitle: extractHandoffTitle(content),
  });
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
export async function checkConversationResumable(
  cli: string | null,
  agentSessionId: string | null,
  cwd: string | null,
  homeDir: string = homedir(),
): Promise<boolean> {
  if (cli !== "claude" || !agentSessionId || !cwd) return false;
  const jsonlPath = join(
    homeDir,
    ".claude",
    "projects",
    claudeProjectSlug(cwd),
    `${agentSessionId}.jsonl`,
  );
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
  // True when the on-disk handoff no longer matches what was stored at
  // suspend time (edited, or now missing/unreadable) -- spec: "a differing
  // hash is surfaced ('handoff edited since suspend') and the edited
  // version is used". This function only surfaces the fact; using the
  // edited content is the caller's job (it already has the file).
  handoffChanged: boolean;
  conversationResumable: boolean;
}

// mirrorRoot is the absolute path of the session's home node mirror on THIS
// machine (getMirrorPath), when one exists -- also the cwd the CLI was
// spawned in, so it doubles as the conversation-resumability check's input.
export async function getResumeInfo(
  session: SessionRow,
  mirrorRoot: string | null,
  homeDir: string = homedir(),
): Promise<ResumeInfo> {
  let currentHandoffHash: string | null = null;
  if (session.handoff_path && mirrorRoot) {
    try {
      const buf = await readFile(join(mirrorRoot, session.handoff_path));
      currentHandoffHash = sha256Buffer(buf);
    } catch {
      currentHandoffHash = null;
    }
  }
  const handoffChanged = session.handoff_hash !== null && currentHandoffHash !== session.handoff_hash;

  const conversationResumable = await checkConversationResumable(
    session.cli,
    session.agent_session_id,
    mirrorRoot,
    homeDir,
  );

  return {
    session,
    handoffPath: session.handoff_path,
    storedHandoffHash: session.handoff_hash,
    currentHandoffHash,
    handoffChanged,
    conversationResumable,
  };
}
