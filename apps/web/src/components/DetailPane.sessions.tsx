// Sessions section (Relace) for the node-detail pane (#192, "Naming & UI"
// of docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md):
// the persistent sessions anchored to this node -- running (open the
// chat), suspended (resume: continuation vs handoff, per the server's
// conversation-existence check), closed (open the chat; writing reopens
// it, #498), archived (browse, behind a filter). One REST fetch on mount,
// on a node change and on the archived toggle fills the session store; the
// rows are read from the store (selectNodeSessionRows), so a frame, a
// rename or a close lands in the list without a refetch (client traffic
// contract, rule 3).

import { displayError } from "../errors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, CircleX, FileText, GitPullRequestArrow, MessageSquare, Pencil, Redo2, X } from "lucide-react";
import type { DetailFile, SessionResumeInfo, SessionRunRow, SessionState, SessionSummary } from "../types";
import {
  fetchNodePersistentSessions,
  fetchSessionsResumeInfo,
  closePersistentSession,
  continueSession,
  deleteDraftSession,
  renamePersistentSession,
  startSessionFromHandoff,
} from "../api";
import { handoffFileEntries, type HandoffFileEntry } from "../lib/handoff-files";
import { peekResumeInfo, primeResumeInfo, resumeInfoIdsToAsk } from "../lib/resume-info-cache";
import { useLocalHost } from "../lib/use-local-host";
import {
  hostDisplayName,
  sessionRowChip,
  sessionRowContinues,
  sessionRowOpensChat,
  threadCloseAction,
} from "../lib/session-views";
import { refreshNodeSessions } from "../lib/node-sessions-refresh";
import { selectNodeSessionRows, selectNodeStubStamp } from "../lib/session-selectors";
import type { SessionStore } from "../lib/session-store";
import { useSessionStore } from "../lib/use-session-store";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "../lib/format";
import { useLocale } from "../lib/use-locale";

// #329: the note for a session the server suspended (dropped connection,
// idle GC, terminal exit, boot sweep) rather than the agent's own
// portuni_session_suspend -- see SessionResumeInfo's generated_by/reason.
// A complete Record over the reason (spec: Catalog, rule 7): a reason added
// to shared/api-types.ts fails the typecheck until it has a note. Reasons
// with no specific wording ("run_ended", "continue") say only that the
// server suspended it.
type NodeT = TFunction<"node">;
type ServerSuspendReason = NonNullable<SessionResumeInfo["reason"]>;
const SERVER_SUSPEND_REASON_LABEL: Record<ServerSuspendReason, (t: NodeT) => string> = {
  disconnect: (t) => t(($) => $.sessions.resume.server_suspended.disconnect, { ns: "node" }),
  idle: (t) => t(($) => $.sessions.resume.server_suspended.idle, { ns: "node" }),
  terminal_exit: (t) => t(($) => $.sessions.resume.server_suspended.terminal_exit, { ns: "node" }),
  boot_sweep: (t) => t(($) => $.sessions.resume.server_suspended.boot_sweep, { ns: "node" }),
  suspend_timeout: (t) => t(($) => $.sessions.resume.server_suspended.suspend_timeout, { ns: "node" }),
  host_lost: (t) => t(($) => $.sessions.resume.server_suspended.host_lost, { ns: "node" }),
  // #459: the owner asked for it -- Předat wrote this summary on purpose.
  handoff: (t) => t(($) => $.sessions.resume.server_suspended.handoff, { ns: "node" }),
  run_ended: (t) => t(($) => $.sessions.resume.server_suspended.no_reason, { ns: "node" }),
  continue: (t) => t(($) => $.sessions.resume.server_suspended.no_reason, { ns: "node" }),
};

function serverSuspendNote(reason: SessionResumeInfo["reason"], t: NodeT): string {
  return reason ? SERVER_SUSPEND_REASON_LABEL[reason](t) : t(($) => $.sessions.resume.server_suspended.no_reason, { ns: "node" });
}

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
  // The window's one record per thread (#466): the rows are read from it
  // and every answer api.ts gets (rename, close, continue) is written back
  // into it, so nothing here keeps a copy.
  sessionStore: SessionStore;
};

export function SessionsSection({
  nodeId,
  files,
  onOpenFile,
  onOpenChat,
  onSessionStarted,
  sessionStore,
}: Props) {
  const { t } = useTranslation("node");
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  // One fetch fills the store (fetchNodePersistentSessions puts its rows);
  // the list below is the store's view of this node.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await fetchNodePersistentSessions(nodeId, includeArchived);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setLoading(false);
    }
  }, [nodeId, includeArchived]);
  useEffect(() => {
    void load();
  }, [load]);

  const sessions = useSessionStore(
    sessionStore,
    useCallback((s: SessionStore) => selectNodeSessionRows(s, nodeId, includeArchived), [nodeId, includeArchived]),
  );
  // Resume-info for every suspended row without a fresh answer, in one
  // request (lib/resume-info-cache.ts); `resumeInfoVersion` re-renders the
  // rows once the cache is primed.
  const [resumeInfoVersion, setResumeInfoVersion] = useState(0);
  const askingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = resumeInfoIdsToAsk(sessions).filter((id) => !askingRef.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) askingRef.current.add(id);
    fetchSessionsResumeInfo(ids)
      .then(({ infos }) => {
        primeResumeInfo(infos);
        setResumeInfoVersion((v) => v + 1);
      })
      .catch(() => {
        /* resumability is informational -- a failed fetch just hides the hint */
      })
      .finally(() => {
        for (const id of ids) askingRef.current.delete(id);
      });
  }, [sessions]);

  // A thread started elsewhere reaches this node as a frame, which leaves
  // a stub the rows above skip. App.tsx completes stubs of the nodes open
  // in Práce; this tab may show a node that is not (Graf), so it asks for
  // the list itself when a stub appears -- through the same coalesced
  // refresh, so a node open in both places still costs one request.
  const stubStamp = useSessionStore(
    sessionStore,
    useCallback((s: SessionStore) => selectNodeStubStamp(s, nodeId), [nodeId]),
  );
  useEffect(() => {
    if (stubStamp === "") return;
    refreshNodeSessions(nodeId).catch(() => undefined);
  }, [stubStamp, nodeId]);

  // Uzavřít asks nothing (#498): a closed thread reopens by writing into it.
  // api.ts puts the answered row into the store; the row updates itself.
  const handleClose = async (id: string) => {
    try {
      await closePersistentSession(id);
    } catch (e) {
      setError(displayError(e));
    }
  };

  // "Pokračovat v nové session" on a done row (closed or archived): the same
  // POST /sessions/:id/continue as the chat header's -- this thread keeps
  // its state and lends its summary to a new, running thread on the node,
  // which the app then shows (onSessionStarted, as Navázat na handoff).
  // One at a time: every row's action is disabled while a request is on
  // the wire, so no click can start a second successor. The state the row
  // showed goes with the request: the server refuses when the thread was
  // reopened meanwhile, instead of ending the run that reopened it.
  const [continuingId, setContinuingId] = useState<string | null>(null);
  const handleContinue = async (id: string, state: SessionState) => {
    setContinuingId(id);
    setError(null);
    try {
      const { session, run } = await continueSession(id, state);
      onSessionStarted?.({ session, run });
    } catch (e) {
      setError(displayError(e));
    } finally {
      setContinuingId(null);
    }
  };

  // #460 "Navázat na handoff": the handoff files of this node, whoever
  // wrote them -- a file another machine's thread wrote arrives here as an
  // ordinary tracked file, which is exactly the point.
  const localHost = useLocalHost();
  const handoffs = useMemo(
    () => handoffFileEntries(files ?? [], sessions, localHost),
    [files, sessions, localHost],
  );
  const [startingHandoff, setStartingHandoff] = useState<string | null>(null);
  const handleStartFromHandoff = async (entry: HandoffFileEntry) => {
    setStartingHandoff(entry.relative_path);
    setError(null);
    try {
      const { session, run } = await startSessionFromHandoff(nodeId, entry.relative_path);
      // The new thread's row is the answer itself; no list refetch.
      sessionStore.put(session);
      onSessionStarted?.({ session, run });
      onOpenChat?.(session.id);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setStartingHandoff(null);
    }
  };

  if (loading && sessions.length === 0) {
    return (
      <div className="px-5 py-4 text-[14px] text-[var(--color-text-dim)]">
        {t(($) => $.sessions.list.loading)}
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
          {t(($) => $.sessions.list.show_archived)}
        </Label>
      </div>

      {error && (
        <div className="mb-3 text-[13px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {handoffs.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-[12.5px] text-[var(--color-text-dim)]">{t(($) => $.sessions.handoffs.heading)}</div>
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
                  <RowIcon onClick={() => onOpenFile(nodeId, entry.relative_path)} title={t(($) => $.sessions.handoffs.view)}>
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
                  {startingHandoff === entry.relative_path ? t(($) => $.sessions.handoffs.continuing) : t(($) => $.sessions.handoffs.continue)}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="text-[14px] text-[var(--color-text-dim)]">{t(($) => $.sessions.list.empty)}</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              resumeInfo={resumeInfoVersion >= 0 ? peekResumeInfo(s.id) : null}
              onContinue={onSessionStarted ? () => void handleContinue(s.id, s.state) : undefined}
              continuing={continuingId === s.id}
              continueDisabled={continuingId !== null}
              onClose={() => {
                // #506: a draft is deleted outright, the same deletion as
                // the sidebar's ×; api.ts removes it from the store, which
                // is where this list reads from.
                if (threadCloseAction(s.state) === "delete") {
                  deleteDraftSession(s.id);
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
  resumeInfo,
  onContinue,
  continuing,
  continueDisabled,
  onClose,
  onOpenChat,
  onOpenHandoff,
}: {
  session: SessionSummary;
  // The section's batched answer for this row (null while unknown).
  resumeInfo: SessionResumeInfo | null;
  // "Pokračovat v nové session" on a closed or archived row; absent where
  // the caller has no chat surface to show the new thread in.
  onContinue?: () => void;
  continuing?: boolean;
  continueDisabled?: boolean;
  onClose: () => void;
  onOpenChat?: (sessionId: string) => void;
  onOpenHandoff?: () => void;
}) {
  const { t } = useTranslation("node");
  const { t: tCommon } = useTranslation("common");
  const locale = useLocale();
  const localHost = useLocalHost();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === session.name) {
      setEditing(false);
      setDraft(session.name);
      return;
    }
    setSaving(true);
    try {
      // api.ts puts the renamed row into the store; the row re-renders.
      await renamePersistentSession(session.id, trimmed);
      setEditing(false);
    } catch {
      setDraft(session.name);
    } finally {
      setSaving(false);
    }
  };

  const chip = sessionRowChip(session.state, session.waiting_since, tCommon);
  const host = hostDisplayName(session, localHost);

  // Row actions are icon buttons on the right of the title line, shown on
  // hover or keyboard focus (the list stays quiet); rename is one of them.
  // Uzavřít sits last behind a separator. #498: a closed thread opens its
  // chat like a suspended one -- writing into it reopens it. A done row
  // (closed or archived) also offers Pokračovat v nové session: a new
  // thread seeded with this one's summary, this one left as it is.
  // #457: the list carries the caller's own threads only, so every action
  // here is the owner's and nothing is gated beyond the state.
  const showChat = sessionRowOpensChat(session.state) && !!onOpenChat;
  const showContinue = sessionRowContinues(session) && !!onContinue;
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
              title={t(($) => $.sessions.row.save_name)}
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
              title={t(($) => $.sessions.row.cancel_rename)}
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
                <RowIcon onClick={() => onOpenChat!(session.id)} title={t(($) => $.sessions.row.open_chat)}>
                  <MessageSquare />
                </RowIcon>
              )}
              {onOpenHandoff && (
                <RowIcon onClick={onOpenHandoff} title={t(($) => $.sessions.row.view_handoff)}>
                  <FileText />
                </RowIcon>
              )}
              <RowIcon onClick={() => setEditing(true)} title={t(($) => $.sessions.row.rename)}>
                <Pencil />
              </RowIcon>
              {showContinue && (
                <RowIcon
                  onClick={onContinue!}
                  disabled={continueDisabled}
                  title={continuing ? t(($) => $.sessions.row.continuing) : t(($) => $.sessions.row.continue)}
                  className="text-[var(--color-accent)]"
                >
                  <Redo2 />
                </RowIcon>
              )}
              {showClose && <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--color-border)]" />}
              {showClose && (
                <RowIcon
                  onClick={onClose}
                  title={t(($) => $.sessions.row.close)}
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
          {session.runner ?? session.cli ?? t(($) => $.sessions.row.runner_unknown)}
          {session.instance_id ? ` · ${session.instance_id}` : ""}
          {/* #428: which host ran it -- the label when central knows one,
              otherwise the host id. Hidden when neither exists. */}
          {host ? ` · ${host}` : ""}
        </span>
        <span title={t(($) => $.sessions.row.write_scope_title)}>
          {t(($) => $.sessions.row.write_scope, { writeCount: session.write_count })}
        </span>
        {session.state === "suspended" && resumeInfo && (
          // #378: resuming is no longer a picked action -- the next message
          // just does one or the other. This is purely informational now.
          <span>
            {resumeInfo.conversation_resumable
              ? t(($) => $.sessions.resume.continues_conversation)
              : t(($) => $.sessions.resume.starts_from_summary)}
            {resumeInfo.handoff_changed ? ` ${t(($) => $.sessions.resume.handoff_changed)}` : ""}
            {!resumeInfo.handoff_checkable ? ` ${t(($) => $.sessions.resume.handoff_uncheckable)}` : ""}
            {resumeInfo.generated_by === "server" ? ` ${serverSuspendNote(resumeInfo.reason, t)}` : ""}
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
