// Sessions section (Relace) for the node-detail pane (#192, "Naming & UI"
// of docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md):
// the persistent sessions anchored to this node -- running (open the
// chat), suspended (resume: continuation vs handoff, per the server's
// conversation-existence check), closed (open the chat; writing reopens
// it, #498), archived (browse, behind a filter). Self-fetches on mount and whenever nodeId changes, same
// pattern as DetailPane.access.tsx's AccessSection.

import { displayError } from "../errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleX, FileText, GitPullRequestArrow, MessageSquare, Pencil, X } from "lucide-react";
import type { DetailFile, SessionResumeInfo, SessionRunRow, SessionSummary } from "../types";
import {
  fetchNodePersistentSessions,
  fetchPersistentSessionResumeInfo,
  closePersistentSession,
  deleteDraftSession,
  renamePersistentSession,
  startSessionFromHandoff,
} from "../api";
import { handoffFileEntries, type HandoffFileEntry } from "../lib/handoff-files";
import {
  hostDisplayName,
  mergeLiveSessionStates,
  sessionRowChip,
  sessionRowOpensChat,
  threadCloseAction,
} from "../lib/session-views";
import type { SessionStateMessage } from "../lib/sessions-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "../lib/format";
import { useLocale } from "../lib/use-locale";

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
  // #459: the owner asked for it -- Předat wrote this summary on purpose.
  handoff: "předání na jiné zařízení",
};

type Props = {
  nodeId: string;
  // #460 "Navázat na handoff": the node's tracked files, the records the
  // handoff list is built from (the node detail already has them, so the
  // tab needs no fetch of its own). Absent where the caller has none.
  files?: readonly DetailFile[];
  onOpenFile?: (nodeId: string, relPath: string) => void;
  // "Otevřít chat" (#343) -- jumps to Práce with this section's node
  // selected, with THIS row's session as the one Práce shows -- a node
  // can have several running/suspended sessions, and the clicked row is
  // the selector (App.tsx's requestedChatSession). Absent in contexts
  // with no chat surface.
  onOpenChat?: (sessionId: string) => void;
  // #412/#460: "Navázat na handoff" starts a real, running thread --
  // handed to the app the same way "Nový úkol" hands over the draft it
  // opens, so the Práce sidebar gets the row at once instead of waiting
  // for something else to refetch the node.
  onSessionStarted?: (result: { session: SessionSummary; run: SessionRunRow | null }) => void;
  // The window's live session_state map (App.tsx, from the socket) --
  // overlaid onto the REST rows so state and "Čeká na mě" update without
  // a reload, and a change on THIS node's sessions (one started, one
  // closed) refetches the list so new rows appear. Absent where no socket
  // exists.
  liveStates?: Readonly<Record<string, SessionStateMessage>>;
};

export function SessionsSection({
  nodeId,
  files,
  onOpenFile,
  onOpenChat,
  onSessionStarted,
  liveStates,
}: Props) {
  const locale = useLocale();
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
      setError(displayError(e));
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

  // Uzavřít asks nothing (#498): a closed thread reopens by writing into it.
  const handleClose = async (id: string) => {
    try {
      const updated = await closePersistentSession(id);
      updateOne(updated);
    } catch (e) {
      setError(displayError(e));
    }
  };

  // #460 "Navázat na handoff": the handoff files of this node, whoever
  // wrote them -- a file another machine's thread wrote arrives here as an
  // ordinary tracked file, which is exactly the point.
  const handoffs = useMemo(() => handoffFileEntries(files ?? [], sessions), [files, sessions]);
  const [startingHandoff, setStartingHandoff] = useState<string | null>(null);
  const handleStartFromHandoff = async (entry: HandoffFileEntry) => {
    setStartingHandoff(entry.relative_path);
    setError(null);
    try {
      const { session, run } = await startSessionFromHandoff(nodeId, entry.relative_path);
      onSessionStarted?.({ session, run });
      onOpenChat?.(session.id);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setStartingHandoff(null);
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
        <Label className="gap-1.5 text-[12.5px] font-normal text-[var(--color-text-dim)]">
          <Checkbox
            checked={includeArchived}
            onCheckedChange={(checked) => setIncludeArchived(checked === true)}
          />
          Zobrazit archivované
        </Label>
      </div>

      {error && (
        <div className="mb-3 text-[13px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {handoffs.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-[12.5px] text-[var(--color-text-dim)]">Předání k navázání</div>
          <div className="space-y-2">
            {handoffs.map((entry) => (
              <div
                key={entry.file_id}
                className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] text-[var(--color-text)]">{entry.title}</div>
                  <div className="truncate text-[12px] text-[var(--color-text-dim)]">
                    {[entry.host, entry.last_active_at ? formatDateTime(locale, entry.last_active_at) : null]
                      .filter(Boolean)
                      .join(" · ") || entry.relative_path}
                  </div>
                </div>
                {onOpenFile && (
                  <RowIcon onClick={() => onOpenFile(nodeId, entry.relative_path)} title="Zobrazit handoff">
                    <FileText />
                  </RowIcon>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={startingHandoff !== null}
                  onClick={() => void handleStartFromHandoff(entry)}
                >
                  <GitPullRequestArrow />
                  {startingHandoff === entry.relative_path ? "Navazuji..." : "Navázat na handoff"}
                </Button>
              </div>
            ))}
          </div>
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
              onRenamed={updateOne}
              onClose={() => {
                // #506: a draft is deleted outright, the same deletion as
                // the sidebar's ×; this list is its own copy, so the row
                // leaves it here too.
                if (threadCloseAction(s.state) === "delete") {
                  deleteDraftSession(s.id);
                  setSessions((prev) => prev.filter((x) => x.id !== s.id));
                } else {
                  void handleClose(s.id);
                }
              }}
              onOpenChat={onOpenChat}
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
  onOpenChat,
  onOpenHandoff,
}: {
  session: SessionSummary;
  onRenamed: (updated: SessionSummary) => void;
  onClose: () => void;
  onOpenChat?: (sessionId: string) => void;
  onOpenHandoff?: () => void;
}) {
  const { t: tCommon } = useTranslation("common");
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const [saving, setSaving] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<SessionResumeInfo | null>(null);

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

  const chip = sessionRowChip(session.state, session.waiting_since, tCommon);
  const host = hostDisplayName(session);

  // Row actions are icon buttons on the right of the title line, shown on
  // hover or keyboard focus (the list stays quiet); rename is one of them.
  // Uzavřít sits last behind a separator. #498: a closed thread opens its
  // chat like a suspended one -- writing into it reopens it, so there is no
  // Navázat anymore.
  // #457: the list carries the caller's own threads only, so every action
  // here is the owner's and nothing is gated beyond the state.
  const showChat = sessionRowOpensChat(session.state) && !!onOpenChat;
  // #506: a draft gets the same Uzavřít, which deletes it without asking.
  const showClose = threadCloseAction(session.state) !== null;

  return (
    <div className="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${chip.pulsing ? "animate-pulse" : ""}`}
          style={{ background: chip.color }}
          title={chip.label}
        />
        {editing ? (
          <>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(session.name);
                  setEditing(false);
                }
              }}
              autoFocus
              className="min-w-0 flex-1"
            />
            <RowIcon
              onClick={() => void save()}
              disabled={saving}
              title="Uložit název"
              className="text-[var(--color-accent)]"
            >
              <Check />
            </RowIcon>
            <RowIcon
              onClick={() => {
                setDraft(session.name);
                setEditing(false);
              }}
              disabled={saving}
              title="Zrušit"
            >
              <X />
            </RowIcon>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-text)]">
              {session.name}
            </span>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              {showChat && (
                <RowIcon onClick={() => onOpenChat!(session.id)} title="Otevřít chat">
                  <MessageSquare />
                </RowIcon>
              )}
              {onOpenHandoff && (
                <RowIcon onClick={onOpenHandoff} title="Zobrazit handoff">
                  <FileText />
                </RowIcon>
              )}
              <RowIcon onClick={() => setEditing(true)} title="Přejmenovat">
                <Pencil />
              </RowIcon>
              {showClose && <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--color-border)]" />}
              {showClose && (
                <RowIcon
                  onClick={onClose}
                  title="Uzavřít"
                  className="hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
                >
                  <CircleX />
                </RowIcon>
              )}
            </div>
          </>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-text-dim)]">
        <span>{chip.label}</span>
        <span>{formatDateTime(locale, session.last_active_at)}</span>
        <span>
          {session.runner ?? session.cli ?? "neznámý"}
          {session.instance_id ? ` · ${session.instance_id}` : ""}
          {/* #428: which host ran it -- the label when central knows one,
              otherwise the host id. Hidden when neither exists. */}
          {host ? ` · ${host}` : ""}
        </span>
        <span title="Počet uzlů v zápisovém rozsahu této relace">
          Zápis: {session.write_count}
        </span>
        {session.state === "suspended" && resumeInfo && (
          // #378: resuming is no longer a picked action -- the next message
          // just does one or the other. This is purely informational now.
          <span>
            {resumeInfo.conversation_resumable
              ? "další zpráva naváže na konverzaci"
              : "další zpráva ji spustí ze shrnutí"}
            {resumeInfo.handoff_changed ? " (handoff upraven od pozastavení)" : ""}
            {!resumeInfo.handoff_checkable ? " (nelze ověřit handoff na tomto zařízení)" : ""}
            {resumeInfo.generated_by === "server" ? ` (pozastaveno serverem${SERVER_SUSPEND_REASON_LABEL[resumeInfo.reason ?? ""] ? `, ${SERVER_SUSPEND_REASON_LABEL[resumeInfo.reason ?? ""]}` : ""})` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function RowIcon({
  onClick,
  children,
  disabled,
  title,
  className,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title: string;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`text-muted-foreground ${className ?? ""}`}
    >
      {children}
    </Button>
  );
}
