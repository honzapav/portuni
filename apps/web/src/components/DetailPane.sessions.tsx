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
import type { SessionSummary } from "../types";
import {
  fetchNodePersistentSessions,
  fetchPersistentSessionResumeInfo,
  fetchUsers,
  renamePersistentSession,
  resumeSession,
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
import { sessionRowAccess, sessionRowChip, type SessionRowAccess } from "../lib/session-views";

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
  // "Otevřít chat" (#343) -- jumps to Práce with this section's node
  // selected. No session id: only one persistent session shows as a
  // node's open chat at a time (#342's workspaceOpenSession), so the row
  // clicked is a hint, not a selector. Absent in contexts with no chat
  // surface.
  onOpenChat?: () => void;
  // #321's access table, echoed client-side for sessionRowAccess -- see
  // DetailPane.tsx's own fetchMe() call.
  canManage: boolean;
  meId: string | null;
};

export function SessionsSection({
  nodeId,
  onOpenTerminal,
  onOpenFile,
  terminalSessions,
  onOpenChat,
  canManage,
  meId,
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

  const handleResume = async (id: string, mode: "conversation" | "handoff") => {
    try {
      await resumeSession(id, mode);
    } catch (e) {
      setError(String(e));
    } finally {
      await load();
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
              access={sessionRowAccess(s.user_id, meId, canManage)}
              ownerName={s.user_id !== meId ? (userNames[s.user_id] ?? null) : null}
              onRenamed={updateOne}
              onClose={() => void handleClose(s.id)}
              onOpenTerminal={() => void onOpenTerminal()}
              onOpenChat={onOpenChat}
              onResume={(mode) => void handleResume(s.id, mode)}
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
  access,
  ownerName,
  onRenamed,
  onClose,
  onOpenTerminal,
  onOpenChat,
  onResume,
  onOpenHandoff,
  suspendable,
  onSuspend,
}: {
  session: SessionSummary;
  access: SessionRowAccess;
  // Resolved display name of the owner, only when it's NOT the caller
  // (null either way otherwise) -- see SessionsSection's userNames map.
  ownerName: string | null;
  onRenamed: (updated: SessionSummary) => void;
  onClose: () => void;
  onOpenTerminal: () => void;
  onOpenChat?: () => void;
  onResume: (mode: "conversation" | "handoff") => void;
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
    generated_by: "server" | null;
    reason: "disconnect" | "idle" | "terminal_exit" | "boot_sweep" | "suspend_timeout" | "host_lost" | null;
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
      if (session.instance_id) {
        try {
          configDir = await getProfileConfigDir(session.instance_id);
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
  }, [session.id, session.state, session.instance_id]);

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
          <RowButton onClick={onOpenChat}>Otevřít chat</RowButton>
        )}
        {(session.state === "running" || session.state === "suspended") && (
          <RowButton onClick={onOpenTerminal}>Otevřít terminál</RowButton>
        )}
        {onOpenHandoff && <RowButton onClick={onOpenHandoff}>Zobrazit handoff</RowButton>}
        {session.state === "suspended" && access.canResume && resumeInfo && (
          <RowButton onClick={() => onResume(resumeInfo.conversation_resumable ? "conversation" : "handoff")}>
            {resumeInfo.conversation_resumable ? "Nahodit (pokračovat)" : "Nahodit (z handoffu)"}
          </RowButton>
        )}
        {session.state === "running" && suspendable && onSuspend && access.canPauseOrClose && (
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
