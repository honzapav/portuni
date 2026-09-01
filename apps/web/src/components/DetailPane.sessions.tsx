// Sessions section (Relace) for the node-detail pane (#192, "Naming & UI"
// of docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md):
// the persistent sessions anchored to this node -- running (open a
// terminal), suspended (resume: continuation vs handoff, per the server's
// conversation-existence check), closed/archived (browse; archived behind
// a filter). Distinct from lib/sessions.ts's ephemeral TerminalSession (a
// browser-local PTY tab) -- see the Persistent* naming in api.ts. Self-
// fetches on mount and whenever nodeId changes, same pattern as
// DetailPane.access.tsx's AccessSection.

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { SessionState, SessionSummary } from "../types";
import {
  fetchNodePersistentSessions,
  fetchPersistentSessionResumeInfo,
  renamePersistentSession,
  transitionPersistentSessionState,
} from "../api";

// Exported for reuse by OverviewView's workspace-wide session rows (#196).
export const STATE_LABEL: Record<SessionState, string> = {
  running: "Běží",
  suspended: "Pozastaveno",
  closed: "Uzavřeno",
  archived: "Archivováno",
};

export const STATE_COLOR: Record<SessionState, string> = {
  running: "var(--color-status-active)",
  suspended: "var(--color-node-process)",
  closed: "var(--color-text-dim)",
  archived: "var(--color-text-dim)",
};

export function fmtDateTime(value: string): string {
  // SQLite datetime('now') yields "YYYY-MM-DD HH:MM:SS" in UTC without a
  // zone marker; normalise so Date parses it as UTC, not local time.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  try {
    return new Date(iso).toLocaleString("cs-CZ", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

type Props = {
  nodeId: string;
  // No nodeId param: the caller (DetailPane's openEmbeddedTerminal) already
  // closes over this section's node -- see the profile-picker prop on
  // TerminalSplitButton for why this signature dropped it (a positional
  // nodeId would otherwise be misread as a profile id).
  onOpenTerminal: () => void | Promise<void>;
  onOpenFile?: (nodeId: string, relPath: string) => void;
};

export function SessionsSection({ nodeId, onOpenTerminal, onOpenFile }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchNodePersistentSessions(nodeId, includeArchived);
      setSessions(res.sessions);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [nodeId, includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateOne = (updated: SessionSummary) => {
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  };

  const handleClose = async (id: string) => {
    try {
      const updated = await transitionPersistentSessionState(id, "closed");
      updateOne(updated);
    } catch (e) {
      setError(String(e));
    }
  };

  if (loading && sessions.length === 0) {
    return (
      <div className="px-5 py-4 text-[14px] text-[var(--color-text-dim)]">
        Načítám relace...
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-text-dim)]">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Zobrazit archivované
        </label>
      </div>

      {error && (
        <div className="mb-3 text-[13px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="text-[14px] text-[var(--color-text-dim)]">Zatím žádné relace.</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              onRenamed={updateOne}
              onClose={() => void handleClose(s.id)}
              onOpenTerminal={() => void onOpenTerminal()}
              onOpenHandoff={
                onOpenFile && s.handoff_path
                  ? () => onOpenFile(nodeId, s.handoff_path!)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onRenamed,
  onClose,
  onOpenTerminal,
  onOpenHandoff,
}: {
  session: SessionSummary;
  onRenamed: (updated: SessionSummary) => void;
  onClose: () => void;
  onOpenTerminal: () => void;
  onOpenHandoff?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const [saving, setSaving] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<
    { conversation_resumable: boolean; handoff_changed: boolean } | null
  >(null);

  // Resumability is only meaningful (and only worth the round trip) for a
  // suspended session -- fetched lazily per row rather than batched with
  // the list so opening the tab stays a single request.
  useEffect(() => {
    if (session.state !== "suspended") return;
    let cancelled = false;
    void fetchPersistentSessionResumeInfo(session.id)
      .then((info) => {
        if (!cancelled) setResumeInfo(info);
      })
      .catch(() => {
        /* resumability is informational -- a failed fetch just hides the hint */
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.state]);

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === session.name) {
      setEditing(false);
      setDraft(session.name);
      return;
    }
    setSaving(true);
    try {
      const updated = await renamePersistentSession(session.id, trimmed);
      onRenamed(updated);
      setEditing(false);
    } catch {
      setDraft(session.name);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: STATE_COLOR[session.state] }}
          title={STATE_LABEL[session.state]}
        />
        {editing ? (
          <>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13.5px] text-[var(--color-text)]"
            />
            <button
              onClick={() => void save()}
              disabled={saving}
              title="Uložit název"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/15"
            >
              <Check size={12} />
            </button>
            <button
              onClick={() => {
                setDraft(session.name);
                setEditing(false);
              }}
              disabled={saving}
              title="Zrušit"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-bg)]"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-text)]">
              {session.name}
            </span>
            <button
              onClick={() => setEditing(true)}
              title="Přejmenovat"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            >
              <Pencil size={11} />
            </button>
          </>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-text-dim)]">
        <span>{STATE_LABEL[session.state]}</span>
        <span>{fmtDateTime(session.last_active_at)}</span>
        <span>{session.cli ?? "cli neznámé"}{session.profile_id ? ` · ${session.profile_id}` : ""}</span>
        <span title="Počet uzlů v zápisovém rozsahu této relace">
          Zápis: {session.write_count}
        </span>
        {session.state === "suspended" && resumeInfo && (
          <span>
            {resumeInfo.conversation_resumable
              ? "lze pokračovat v konverzaci"
              : "spustí se z handoffu"}
            {resumeInfo.handoff_changed ? " (handoff upraven od pozastavení)" : ""}
          </span>
        )}
      </div>

      <div className="mt-2 flex gap-2">
        {(session.state === "running" || session.state === "suspended") && (
          <RowButton onClick={onOpenTerminal}>Otevřít terminál</RowButton>
        )}
        {onOpenHandoff && <RowButton onClick={onOpenHandoff}>Zobrazit handoff</RowButton>}
        {(session.state === "running" || session.state === "suspended") && (
          <RowButton onClick={onClose}>Uzavřít</RowButton>
        )}
      </div>
    </div>
  );
}

function RowButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11.5px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}
