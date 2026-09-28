// The node's handoff files, as the Relace tab lists them (#460 "Navázat na
// handoff"). A handoff file is an ordinary tracked file of the node at
// wip/sessions/<session id>-handoff.md, so it reaches every device the node
// is mirrored on -- including one whose owner never saw the thread that
// wrote it. This module is the pure mapping from the node's file records
// (plus whatever session records this user can see) to the rows; the
// component does nothing but render them.

import type { DetailFile, SessionSummary } from "../types";

// Same shape the server accepts in POST /sessions's handoff_path and writes
// in domain/session-handoff.ts's handoffRelativePath -- kept here as its own
// literal rather than imported so the web bundle carries no server code.
const HANDOFF_PATH_RE = /^wip\/sessions\/([A-Za-z0-9_-]+)-handoff\.md$/;

export type HandoffFileEntry = {
  file_id: string;
  // Node-relative, exactly what POST /sessions's handoff_path takes.
  relative_path: string;
  // The thread that wrote the file, read off the file name. It may live on
  // another machine, or belong to somebody else -- then no record matches
  // and only the file name is known.
  session_id: string;
  // The source thread's name when its record is one this user can see,
  // otherwise the file's own name.
  title: string;
  // The device the source thread ran on, and when it was last active --
  // both from the source record, both null when there is none here.
  host: string | null;
  last_active_at: string | null;
};

// Newest first. The session id is a ULID, so it orders by creation time on
// its own -- the tiebreak for files whose source record is not here.
export function handoffFileEntries(
  files: readonly DetailFile[],
  sessions: readonly SessionSummary[],
): HandoffFileEntry[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const entries: HandoffFileEntry[] = [];
  for (const file of files) {
    const relativePath = file.relative_path;
    if (!relativePath) continue;
    const match = relativePath.match(HANDOFF_PATH_RE);
    if (!match) continue;
    const sessionId = match[1];
    const source = byId.get(sessionId) ?? null;
    entries.push({
      file_id: file.id,
      relative_path: relativePath,
      session_id: sessionId,
      title: source?.name ?? file.filename,
      host: source?.host_label?.trim() || source?.host_id?.trim() || null,
      last_active_at: source?.last_active_at ?? null,
    });
  }
  return entries.sort((a, b) => {
    const byDate = (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "");
    return byDate !== 0 ? byDate : b.session_id.localeCompare(a.session_id);
  });
}
