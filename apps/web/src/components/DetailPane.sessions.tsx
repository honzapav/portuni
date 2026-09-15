// Sessions section (Relace) for the node-detail pane (#192, "Naming & UI"
// of docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md):
// the persistent sessions anchored to this node -- running (open the
// chat), suspended (resume: continuation vs handoff, per the server's
// conversation-existence check), closed/archived (browse; archived behind
// a filter). Self-fetches on mount and whenever nodeId changes, same
// pattern as DetailPane.access.tsx's AccessSection.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { SessionSummary } from "../types";
import {
  fetchNodePersistentSessions,
  fetchPersistentSessionResumeInfo,
  fetchUsers,
  renamePersistentSession,
  resumeSession,
  transitionPersistentSessionState,
} from "../api";
import { mergeLiveSessionStates, sessionRowAccess, sessionRowChip, type SessionRowAccess } from "../lib/session-views";
import type { SessionStateMessage } from "../lib/sessions-client";

// #329: labels for a session the server suspended (dropped connection,
// idle GC, terminal exit, boot sweep) rather than the agent's own
// portuni_session_suspend -- see SessionResumeInfo's generated_by/reason.
const SERVER_SUSPEND_REASON_LABEL: Record<string, string> = {
  disconnect: "odpojení",
  idle: "nečinnost 30 min",
  terminal_exit: "ukončení terminálu",
  boot_sweep: "restart serveru",
  suspend_timeout: "agent nestihl předání",
  host_lost: "proces osiřel po restartu",
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
  onOpenFile?: (nodeId: string, relPath: string) => void;
  // "Otevřít chat" (#343) -- jumps to Práce with this section's node
  // selected, with THIS row's session as the one Práce shows -- a node
  // can have several running/suspended sessions, and the clicked row is
  // the selector (App.tsx's requestedChatSession). Absent in contexts
  // with no chat surface.
  onOpenChat?: (sessionId: string) => void;
  // #321's access table, echoed client-side for sessionRowAccess (useMe).
  canManage: boolean;
  meId: string | null;
  // The window's live session_state map (App.tsx, from the socket) --
  // overlaid onto the REST rows so state and "Čeká na mě" update without
  // a reload, and a change on THIS node's sessions (one started, one
  // closed) refetches the list so new rows appear. Absent where no socket
  // exists.
  liveStates?: Readonly<Record<string, SessionStateMessage>>;
};

export function SessionsSection({
  nodeId,
  onOpenFile,
  onOpenChat,
  canManage,
  meId,
  liveStates,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  // "owner name when not the caller" -- fetchUsers is manage-scope-gated
  // and degrades to [] for anyone below that (see its own doc comment), so
  // a plain teammate viewing this tab just never resolves a name; that's
  // fine, the row still works without one.
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void fetchUsers()
      .then((users) => {
        if (cancelled) return;
        setUserNames(Object.fromEntries(users.map((u) => [u.id, u.name])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Every session id + state the socket reports for this node; a change
  // means a row appeared or moved state, which the REST list must reflect.
  const liveStamp = useMemo(
    () =>
      Object.values(liveStates ?? {})
        .filter((s) => s.node_id === nodeId)
        .map((s) => `${s.session_id}:${s.state}`)
        .sort()
        .join(","),
    [liveStates, nodeId],
  );
  useEffect(() => {
    void load();
  }, [load, liveStamp]);

  const liveSessions = useMemo(
    () => (liveStates ? mergeLiveSessionStates(sessions, liveStates) : sessions),
    [sessions, liveStates],
  );

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

  const handleResume = async (id: string, mode: "conversation" | "handoff") => {
    try {
      await resumeSession(id, mode);
    } catch (e) {
      setError(String(e));
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
          {liveSessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              access={sessionRowAccess(s.user_id, meId, canManage)}
              ownerName={s.user_id !== meId ? (userNames[s.user_id] ?? null) : null}
              onRenamed={updateOne}
              onClose={() => void handleClose(s.id)}
              onOpenChat={onOpenChat}
              onResume={(mode) => void handleResume(s.id, mode)}
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
  access,
  ownerName,
  onRenamed,
  onClose,
  onOpenChat,
  onResume,
  onOpenHandoff,
}: {
  session: SessionSummary;
  access: SessionRowAccess;
  // Resolved display name of the owner, only when it's NOT the caller
  // (null either way otherwise) -- see SessionsSection's userNames map.
  ownerName: string | null;
  onRenamed: (updated: SessionSummary) => void;
  onClose: () => void;
  onOpenChat?: (sessionId: string) => void;
  onResume: (mode: "conversation" | "handoff") => void;
  onOpenHandoff?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const [saving, setSaving] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<{
    conversation_resumable: boolean;
    handoff_changed: boolean;
    handoff_checkable: boolean;
    generated_by: "server" | null;
    reason: "disconnect" | "idle" | "terminal_exit" | "boot_sweep" | "suspend_timeout" | "host_lost" | null;
  } | null>(null);

  // Resumability is only meaningful (and only worth the round trip) for a
  // suspended session -- fetched lazily per row rather than batched with
  // the list so opening the tab stays a single request.
  useEffect(() => {
    if (session.state !== "suspended") return;
    let cancelled = false;
    fetchPersistentSessionResumeInfo(session.id)
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

  const chip = sessionRowChip(session.state, session.waiting_since);

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${chip.pulsing ? "animate-pulse" : ""}`}
          style={{ background: chip.color }}
          title={chip.label}
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

      {session.brief && (
        <div className="mt-1 truncate text-[12px] text-[var(--color-text-muted)]" title={session.brief}>
          {session.brief.split("\n")[0]}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-text-dim)]">
        <span>{chip.label}</span>
        <span>{fmtDateTime(session.last_active_at)}</span>
        <span>
          {session.runner ?? session.cli ?? "neznámý"}
          {session.instance_id ? ` · ${session.instance_id}` : ""}
          {session.host_id ? ` · ${session.host_id}` : ""}
        </span>
        {ownerName && <span>Vlastník: {ownerName}</span>}
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
            {resumeInfo.generated_by === "server" ? ` (pozastaveno serverem${SERVER_SUSPEND_REASON_LABEL[resumeInfo.reason ?? ""] ? `, ${SERVER_SUSPEND_REASON_LABEL[resumeInfo.reason ?? ""]}` : ""})` : ""}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {(session.state === "running" || session.state === "suspended") && onOpenChat && (
          <RowButton onClick={() => onOpenChat(session.id)}>Otevřít chat</RowButton>
        )}
        {onOpenHandoff && <RowButton onClick={onOpenHandoff}>Zobrazit handoff</RowButton>}
        {session.state === "suspended" && access.canResume && resumeInfo && (
          <>
            {resumeInfo.conversation_resumable && (
              <RowButton onClick={() => onResume("conversation")}>Nahodit: pokračovat</RowButton>
            )}
            <RowButton onClick={() => onResume("handoff")}>Nahodit: předat a začít znovu</RowButton>
          </>
        )}
        {(session.state === "running" || session.state === "suspended") && access.canPauseOrClose && (
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
