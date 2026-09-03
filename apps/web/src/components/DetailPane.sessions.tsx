// Sessions section (Relace) for the node-detail pane (#192, "Naming & UI"
// of docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md):
// the persistent sessions anchored to this node -- running (open a
// terminal), suspended (resume: continuation vs handoff, per the server's
// conversation-existence check), closed/archived (browse; archived behind
// a filter). Distinct from lib/sessions.ts's ephemeral TerminalSession (a
// browser-local PTY tab) -- see the Persistent* naming in api.ts. Self-
// fetches on mount and whenever nodeId changes, same pattern as
// DetailPane.access.tsx's AccessSection.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { SessionState, SessionSummary } from "../types";
import {
  fetchNodePersistentSessions,
  fetchPersistentSessionResumeInfo,
  renamePersistentSession,
  transitionPersistentSessionState,
} from "../api";
import { getProfileConfigDir } from "../lib/profiles";
import type { TerminalSession } from "../lib/sessions";
import { isTauri } from "../lib/backend-url";
import {
  correlateSessions,
  suspendableTerminalIds,
  suspendTerminalsAndPoll,
} from "../lib/session-suspend";

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
  // This window's own live terminal tabs (#232), for correlating a
  // `running` row to a live agent terminal -- see suspendableTerminalIds.
  // Absent in contexts with no terminal concept (none today).
  terminalSessions?: TerminalSession[];
};

export function SessionsSection({
  nodeId,
  onOpenTerminal,
  onOpenFile,
  terminalSessions,
}: Props) {
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

  // Which rows show "Pozastavit" (#232): this node's terminals among the
  // window's own live tabs, correlated against the freshly-fetched
  // sessions -- same mechanism suspendableTerminalIds already drives for
  // the window close dialog (#231), just scoped to one node's rows.
  const nodeTerminals = useMemo(
    () => (terminalSessions ?? []).filter((t) => t.nodeId === nodeId),
    [terminalSessions, nodeId],
  );
  const suspendableIds = useMemo(
    () => new Set(suspendableTerminalIds(nodeTerminals, correlateSessions(sessions))),
    [nodeTerminals, sessions],
  );

  const handleSuspend = async (terminalId: string) => {
    try {
      // The poll's outcome (suspended vs. timed out) doesn't change what
      // happens next: either way the attempt is over, so the terminal goes
      // away and "Otevřít terminál" spawns a fresh one on demand -- same
      // as #231's close dialog treats a timeout.
      await suspendTerminalsAndPoll([terminalId], nodeTerminals);
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("pty_kill", { args: { session_id: terminalId } }).catch(() => undefined);
      }
    } finally {
      await load();
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
              suspendable={s.terminal_id !== null && suspendableIds.has(s.terminal_id)}
              onSuspend={s.terminal_id ? () => handleSuspend(s.terminal_id!) : undefined}
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
  suspendable,
  onSuspend,
}: {
  session: SessionSummary;
  onRenamed: (updated: SessionSummary) => void;
  onClose: () => void;
  onOpenTerminal: () => void;
  onOpenHandoff?: () => void;
  // #232: true when this row's terminal_id is a live, agent-launched
  // terminal in this window -- suspendableTerminalIds already narrowed it
  // to `running` rows too.
  suspendable: boolean;
  onSuspend?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const [saving, setSaving] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<{
    conversation_resumable: boolean;
    handoff_changed: boolean;
    handoff_checkable: boolean;
  } | null>(null);

  // Resumability is only meaningful (and only worth the round trip) for a
  // suspended session -- fetched lazily per row rather than batched with
  // the list so opening the tab stays a single request.
  useEffect(() => {
    if (session.state !== "suspended") return;
    let cancelled = false;
    void (async () => {
      // The profile's CLAUDE_CONFIG_DIR (#204) lets the server check
      // conversation-resumability at the right transcript location; no-op
      // outside Tauri or when the session used no profile. getProfileConfigDir
      // is a narrow, purpose-built command (#207) -- profile env values in
      // general never reach the webview, but this one well-known, never-
      // secret-shaped key is an explicit exception.
      let configDir: string | null = null;
      if (session.profile_id) {
        try {
          configDir = await getProfileConfigDir(session.profile_id);
        } catch {
          /* profiles registry is optional context -- fall back to the default location */
        }
      }
      return fetchPersistentSessionResumeInfo(session.id, configDir);
    })()
      .then((info) => {
        if (!cancelled) setResumeInfo(info);
      })
      .catch(() => {
        /* resumability is informational -- a failed fetch just hides the hint */
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.state, session.profile_id]);

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
            {!resumeInfo.handoff_checkable ? " (nelze ověřit handoff na tomto zařízení)" : ""}
          </span>
        )}
      </div>

      <div className="mt-2 flex gap-2">
        {(session.state === "running" || session.state === "suspended") && (
          <RowButton onClick={onOpenTerminal}>Otevřít terminál</RowButton>
        )}
        {onOpenHandoff && <RowButton onClick={onOpenHandoff}>Zobrazit handoff</RowButton>}
        {session.state === "running" && suspendable && onSuspend && (
          <RowButton
            disabled={suspending}
            onClick={() => {
              setSuspending(true);
              void onSuspend().finally(() => setSuspending(false));
            }}
          >
            {suspending ? "Pozastavuji…" : "Pozastavit"}
          </RowButton>
        )}
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
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11.5px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
