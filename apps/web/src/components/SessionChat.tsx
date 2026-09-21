// Live chat view of a runner-batch session (#342, docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md "Web: Práce, New task"; rebuilt
// on AI Elements by #373, docs/superpowers/specs/2026-09-15-task-surface-
// design.md "The chat is AI Elements"). Fills Práce's center pane when the
// selected node has an open (running/suspended) persistent session. The whole log comes over the live
// WebSocket (lib/sessions-client.ts): `subscribe(id, 0)` makes the server
// replay the persisted events (it subscribes its own runtime listener
// first and buffers, so nothing published during the replay is lost --
// api/sessions-ws.ts's handleSubscribe) and then stream anything after.
// Streamed assistant text arrives as `delta` frames (never persisted,
// buffered here until the matching canonical event lands), everything
// else as `event` frames already carrying a monotonic `seq`, which is what
// de-duplicates a replay against a frame that raced it.
//
// This file is the CanonicalEvent -> component props adapter the spec
// calls for: AI Elements supplies the transcript chrome (bubbles,
// collapsible tool rows, streaming markdown, the "thinking" affordance,
// stick-to-bottom scrolling); everything about sessions -- subscribe,
// suspend/resume, handoffs, access control -- stays ours.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionState, SessionSummary } from "../types";
import { hostDisplayName, sessionRowAccess } from "../lib/session-views";
import {
  decodeRunnerChoice,
  encodeRunnerChoice,
  runnerChoiceLabel,
  runnerPickerGroups,
} from "../lib/runner-picker";
import { useMe } from "../lib/use-me";
import type { SessionsClient } from "../lib/sessions-client";
import {
  toCanonicalEvent,
  sessionStatusChip,
  latestQuestionEvent,
  appendDelta,
  clearDeltaBuffer,
  createDeltaCoalescer,
  deriveTranscriptRows,
  activitySummary,
  workingPhase,
  runIsLiveFor,
  WORKING_LABEL,
  type ActivityItem,
  type ActivityRow,
  type ChatEvent,
  insertBySeq,
  type CanonicalEvent,
  type DeltaBuffers,
  type TranscriptRow,
  type WorkingPhase,
} from "../lib/session-chat";
import { useNowTick } from "../lib/use-now-tick";
import { contextRingState, latestContextUsage } from "../lib/context-ring";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectGroup, SelectLabel } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BrainIcon, Check, CircleX, Pencil, Redo2, X } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Checkpoint, CheckpointIcon } from "@/components/ai-elements/checkpoint";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Loader } from "@/components/ai-elements/loader";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { sessionDrafts } from "../lib/session-drafts";
import { patchSessionModelEffort, patchSessionRunnerInstance, renamePersistentSession } from "../api";
import {
  fetchRunnerModels,
  listRunnerInstances,
  listRunners,
  type RunnerInfo,
  type RunnerInstanceSummary,
  type RunnerModel,
} from "../lib/runners";

// Spec rule 3 (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md):
// transcript, notice bar, question panel and composer share one centred
// column -- 10 % gutters each side, never wider than 768 px. The scroll
// container stays full-width so the scrollbar keeps its edge.
const THREAD_COLUMN = "mx-auto w-[min(80%,768px)]";
export default function SessionChat({
  session,
  onSessionUpdated,
  sessionsClient,
  onOpenFile,
}: {
  session: SessionSummary;
  onSessionUpdated: (updated: SessionSummary) => void;
  sessionsClient: SessionsClient;
  onOpenFile?: (relPath: string) => void;
}) {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [textDeltaBuffers, setTextDeltaBuffers] = useState<DeltaBuffers>({});
  const [reasoningDeltaBuffers, setReasoningDeltaBuffers] = useState<DeltaBuffers>({});
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  // When the last message was sent, until its run_started arrives -- what
  // the working row shows as "Spouštím…" (rule 2: something is always on
  // screen while a run is live, and the run is live from the send).
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ state: SessionState; waiting_since: string | null }>({
    state: session.state,
    waiting_since: session.waiting_since,
  });
  // The composer's draft belongs to the session, not to this component --
  // see lib/session-drafts.ts. Seeded once per mount (the caller keys this
  // component on session.id, so a different session is a different instance)
  // and written through on every keystroke, so it survives switching
  // sessions and the surface being unmounted.
  const [composerText, setComposerTextState] = useState(() => sessionDrafts.get(session.id));
  const setComposerText = (text: string) => {
    sessionDrafts.set(session.id, text);
    setComposerTextState(text);
  };
  const [sending, setSending] = useState(false);
  const [actionPending, setActionPending] = useState<"interrupt" | "close" | "continue" | null>(null);
  // #378: "Uzavřít" is the one irreversible action, so it's the only one
  // that asks -- confirmed via this dialog, not window.confirm (a no-op in
  // the Tauri webview).
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  // Inline rename in the header (same affordance as the Relace row): the
  // rename goes through POST /sessions/:id/rename, whose live frame is what
  // updates the sidebar and the Relace tab; onSessionUpdated only refreshes
  // the shown thread's own object.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(session.name);
  const [renameSaving, setRenameSaving] = useState(false);
  const startRename = () => {
    setNameDraft(session.name);
    setRenaming(true);
  };
  const cancelRename = () => {
    setNameDraft(session.name);
    setRenaming(false);
  };
  const saveRename = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === session.name) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    try {
      const updated = await renamePersistentSession(session.id, trimmed);
      onSessionUpdated(updated);
      setRenaming(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setRenameSaving(false);
    }
  };
  // The notice bar (#378, "the process was ended, the next message
  // replays the conversation") is dismissible per-occurrence: dismissing
  // hides THIS bar, but the next run that ends up here (liveRunId flips
  // non-null again, meaning a new run started) shows a fresh one.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const { meId, canManage } = useMe();
  const access = sessionRowAccess(session.user_id, meId, canManage);

  // Composer row 2 (v2 rule 5): the runner/instance choice, open while the
  // thread is a draft. The lists come from the device (both routes are
  // device-local), the draft's initial value is what the organisation's
  // default resolved to, so it is what the picker marks as "(výchozí)".
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [instances, setInstances] = useState<RunnerInstanceSummary[]>([]);
  const initialChoiceRef = useRef({ runner: session.runner, instanceId: session.instance_id });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([listRunners(), listRunnerInstances()])
      .then(([r, i]) => {
        if (cancelled) return;
        setRunners(r.filter((x) => x.availability.installed && x.availability.logged_in));
        setInstances(i);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const handleRunnerChange = (value: string) => {
    const { runner, instanceId } = decodeRunnerChoice(value);
    onSessionUpdated({ ...session, runner, instance_id: instanceId });
    void patchSessionRunnerInstance(session.id, { runner, instance_id: instanceId }).catch((e) => setError(String(e)));
  };
  const host = hostDisplayName(session);

  // #376: the model picker's list, for the thread's runner. A draft on a
  // device with no logged-in runner falls back to "claude", the only
  // runner this codebase registers today.
  const [models, setModels] = useState<RunnerModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchRunnerModels(session.runner ?? "claude")
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session.runner]);
  const selectedModel = models.find((m) => m.id === session.model) ?? null;

  const handleModelChange = (value: string) => {
    const model = value === "" ? null : value;
    onSessionUpdated({ ...session, model });
    void patchSessionModelEffort(session.id, { model }).catch(() => undefined);
  };
  const handleEffortChange = (value: string) => {
    const effort = value === "" ? null : value;
    onSessionUpdated({ ...session, effort });
    void patchSessionModelEffort(session.id, { effort }).catch(() => undefined);
  };

  // Backfill + subscribe. Re-runs whenever the selected session itself
  // changes (switching nodes in Práce mounts the same component fresh with
  // a new session id).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEvents([]);
    setTextDeltaBuffers({});
    setReasoningDeltaBuffers({});
    setLiveRunId(null);
    setSentAt(null);
    setLive({ state: session.state, waiting_since: session.waiting_since });

    // Deltas are coalesced (spec, "Streaming"): a burst of frames becomes
    // one state update per animation frame. Flushed on run end so nothing
    // in flight is lost before the buffers clear.
    const coalescer = createDeltaCoalescer(
      (batch) => {
        for (const d of batch) {
          if (d.channel === "reasoning") setReasoningDeltaBuffers((prev) => appendDelta(prev, d.run_id, d.text));
          else setTextDeltaBuffers((prev) => appendDelta(prev, d.run_id, d.text));
        }
      },
      (cb) => {
        const id = requestAnimationFrame(cb);
        return () => cancelAnimationFrame(id);
      },
    );

    // Live run detection rides on the replayed/streamed events themselves
    // (run_started without a later run_ended), so one code path covers
    // both the backfill and everything after it.
    const offEvent = sessionsClient.onEvent(session.id, (envelope) => {
      const event = toCanonicalEvent(envelope.kind, envelope.payload);
      setEvents((prev) => insertBySeq(prev, { seq: envelope.seq, event }));
      if (event.kind === "run_started") {
        setLiveRunId(event.payload.run_id);
        setSentAt(null);
      } else if (event.kind === "run_ended") {
        coalescer.flush();
        setTextDeltaBuffers((prev) => clearDeltaBuffer(prev, event.payload.run_id));
        setReasoningDeltaBuffers((prev) => clearDeltaBuffer(prev, event.payload.run_id));
        setLiveRunId(null);
      } else if (event.kind === "assistant_message") {
        setLiveRunId((current) => {
          if (current) setTextDeltaBuffers((prev) => clearDeltaBuffer(prev, current));
          return current;
        });
      } else if (event.kind === "reasoning") {
        setLiveRunId((current) => {
          if (current) setReasoningDeltaBuffers((prev) => clearDeltaBuffer(prev, current));
          return current;
        });
      }
    });
    const offDelta = sessionsClient.onDelta(session.id, (delta) => coalescer.push(delta));
    const offState = sessionsClient.onSessionState((s) => {
      if (s.session_id !== session.id) return;
      setLive({ state: s.state, waiting_since: s.waiting_since });
      onSessionUpdated({ ...session, state: s.state, waiting_since: s.waiting_since });
    });

    void sessionsClient
      .subscribe(session.id, 0)
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      coalescer.clear();
      offEvent();
      offDelta();
      offState();
      sessionsClient.unsubscribe(session.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session.state/
    // waiting_since intentionally excluded: they're seeded once at mount,
    // then owned by `live` (updated via onSessionState) from here on.
  }, [session.id, sessionsClient]);

  // #378: a new run starting is "the thread woken again" -- clear a
  // previous dismissal so the NEXT time this run ends up with nothing
  // live (idle, error, natural completion), the notice shows fresh.
  useEffect(() => {
    if (liveRunId !== null) setNoticeDismissed(false);
  }, [liveRunId]);

  const rows = useMemo(() => deriveTranscriptRows(events, liveRunId), [events, liveRunId]);
  // The context ring: the transcript's latest context_usage while the log
  // is here, else the summary's counters (a list row, a reload before the
  // replay). Absent entirely for a draft or a session that never reported.
  const liveUsage = useMemo(() => latestContextUsage(events), [events]);
  const ring = contextRingState(
    liveUsage?.used ?? session.context_used_tokens,
    liveUsage?.max ?? session.context_max_tokens,
  );
  const openQuestion = latestQuestionEvent(events);
  const isWaiting = live.state === "running" && live.waiting_since !== null;
  const runIsLive = runIsLiveFor(liveRunId, live.state);
  const streamingText = liveRunId ? textDeltaBuffers[liveRunId] : undefined;
  const streamingReasoning = liveRunId ? reasoningDeltaBuffers[liveRunId] : undefined;
  // The working row (rule 2): shown while a run is live (or a send is in
  // flight) and nothing else at the transcript end says what is happening.
  const phase = runIsLive || sentAt !== null ? workingPhase(events, liveRunId, sentAt) : null;
  const showWorking = phase !== null && !streamingText && !streamingReasoning && !isWaiting;
  const chip = sessionStatusChip(live.state, live.waiting_since);
  // #378: an open thread with a run that ended other than by Uzavřít --
  // the next message replays the whole conversation from the summary.
  const showNotice = live.state === "suspended" && !noticeDismissed;

  const runAction = async (action: "interrupt" | "close") => {
    setActionPending(action);
    setError(null);
    try {
      await sessionsClient[action](session.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setActionPending(null);
    }
  };

  // "Pokračovat v nové session" (offered any time) / "Navázat" (a closed
  // thread): POST /sessions/:id/continue closes this session (its summary
  // seeds the new one) and starts a fresh, running one on the same node --
  // the new row becomes the active thread (WorkspaceView keys SessionChat
  // on the session id, so this swap remounts it).
  const handleContinue = async () => {
    setActionPending("continue");
    setError(null);
    try {
      const { session: newSession } = await sessionsClient.continueSession(session.id);
      onSessionUpdated(newSession);
    } catch (e) {
      setError(String(e));
      setActionPending(null);
    }
  };

  const handlePromptSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      await sessionsClient.message(session.id, text);
      setComposerText("");
      // Until run_started lands (a promotion or a resume starts a process
      // first), the working row says "Spouštím…". A live run's own
      // message needs none: its run_started already happened.
      if (liveRunId === null) setSentAt(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const handleAnswer = async (value: string | boolean) => {
    if (!openQuestion) return;
    try {
      await sessionsClient.answer(session.id, openQuestion.payload.request_id, value);
    } catch (e) {
      setError(String(e));
    }
  };

  // Messages and answers are owner-only (#321's access table); a
  // non-owner who can see the node reads the chat but cannot type into it.
  const composerDisabled = live.state === "closed" || live.state === "archived" || isWaiting || !access.canResume;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-[42px] items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${chip.pulsing ? "animate-pulse" : ""}`}
            style={{ background: chip.color }}
          />
          {renaming ? (
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              autoFocus
              disabled={renameSaving}
              className="h-7 min-w-0 flex-1 text-[13.5px]"
            />
          ) : (
            <>
              <span className="truncate text-[13.5px] font-medium text-[var(--color-text)]">{session.name}</span>
              <span className="shrink-0 text-[12px] text-[var(--color-text-dim)]">{chip.label}</span>
            </>
          )}
        </div>
        {/* Spec rule 4: facts in the header -- the status, the context ring
            (phase 4) and the thread actions. Runner, instance, host, model
            and effort live in the composer's rows. Actions are icons on the
            right, the same set and order as a Relace row: rename, then
            Pokračovat v nové session, then Uzavřít behind a separator;
            always visible, this is one line, not a list. #378:
            Přerušit/Pozastavit are gone -- stopping a turn is the
            composer's own stop button (+ Esc) below, and a run no longer
            needs an explicit suspend, ever. */}
        <div className="flex shrink-0 items-center gap-0.5 text-[12px] text-[var(--color-text-dim)]">
          {renaming ? (
            <>
              <HeaderIcon
                onClick={() => void saveRename()}
                disabled={renameSaving}
                title="Uložit název"
                className="text-[var(--color-accent)]"
              >
                <Check />
              </HeaderIcon>
              <HeaderIcon onClick={cancelRename} disabled={renameSaving} title="Zrušit">
                <X />
              </HeaderIcon>
            </>
          ) : (
            <>
              {ring && (
                <Context
                  usedTokens={ring.used}
                  maxTokens={ring.max}
                  label={ring.label}
                  usage={
                    liveUsage
                      ? { inputTokens: liveUsage.input, cachedInputTokens: liveUsage.cached, outputTokens: liveUsage.output }
                      : undefined
                  }
                >
                  <ContextTrigger
                    className="mr-1 h-7 gap-1.5 px-1.5 text-[12px]"
                    style={{ color: ring.warn ? "var(--color-node-process)" : "var(--color-text-dim)" }}
                    title="Využití kontextového okna"
                  />
                  <ContextContent align="end">
                    <ContextContentHeader />
                    {liveUsage && (
                      <ContextContentBody className="space-y-1">
                        <ContextInputUsage />
                        <ContextCacheUsage />
                        <ContextOutputUsage />
                      </ContextContentBody>
                    )}
                  </ContextContent>
                </Context>
              )}
              {access.canResume && (
                <HeaderIcon onClick={startRename} disabled={actionPending !== null} title="Přejmenovat">
                  <Pencil />
                </HeaderIcon>
              )}
              {(live.state === "running" || live.state === "suspended") && access.canResume && (
                <HeaderIcon
                  onClick={() => void handleContinue()}
                  disabled={actionPending !== null}
                  title={actionPending === "continue" ? "Pokračuji…" : "Pokračovat v nové session"}
                  // From 80 % of the window the fresh session is the advice,
                  // so the icon steps up to the accent colour.
                  className={ring?.warn ? "text-[var(--color-accent)]" : undefined}
                >
                  <Redo2 />
                </HeaderIcon>
              )}
              {(live.state === "running" || live.state === "suspended") && access.canPauseOrClose && (
                <>
                  <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--color-border)]" />
                  <HeaderIcon
                    onClick={() => setCloseConfirmOpen(true)}
                    disabled={actionPending !== null}
                    title={actionPending === "close" ? "Zavírám…" : "Uzavřít"}
                    className="hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
                  >
                    <CircleX />
                  </HeaderIcon>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {showNotice && (
        <div className={`${THREAD_COLUMN} mt-2 flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] text-[var(--color-text-muted)]`}>
          <span className="flex-1 leading-[1.5]">
            Proces byl ukončen. Další zpráva konverzaci nastartuje znovu — dosavadní kontext půjde do modelu ještě
            jednou.
          </span>
          <button
            type="button"
            onClick={() => setNoticeDismissed(true)}
            className="shrink-0 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            aria-label="Skrýt"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {closeConfirmOpen && (
        <Dialog open onOpenChange={(open) => !open && setCloseConfirmOpen(false)}>
          <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>Uzavřít vlákno?</DialogTitle>
              <DialogDescription>
                Vlákno „{session.name}“ se uzavře. Server napřed uloží shrnutí konverzace.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCloseConfirmOpen(false)}>
                Zpět
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setCloseConfirmOpen(false);
                  void runAction("close");
                }}
              >
                Uzavřít
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {error && (
        <div className="border-b border-[var(--color-border)] px-4 py-1.5 text-[12.5px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      <Conversation>
        <ConversationContent className={`${THREAD_COLUMN} gap-5`}>
          {loading ? (
            <Shimmer duration={1.5}>Načítám konverzaci…</Shimmer>
          ) : rows.length === 0 && !showWorking ? (
            <ConversationEmptyState title="Zatím žádné zprávy" description="Napiš první zprávu níže." />
          ) : (
            <>
              {rows.map((row) => (
                <TranscriptRowView key={row.key} row={row} onOpenFile={onOpenFile} />
              ))}
              {streamingReasoning && (
                <Reasoning isStreaming defaultOpen>
                  <ReasoningTrigger getThinkingMessage={reasoningTriggerMessage} />
                  <ReasoningContent>{streamingReasoning}</ReasoningContent>
                </Reasoning>
              )}
              {streamingText && (
                <Message from="assistant">
                  <MessageContent>
                    <MessageResponse isAnimating>{streamingText}</MessageResponse>
                  </MessageContent>
                </Message>
              )}
              {showWorking && phase && <WorkingRow phase={phase} />}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {openQuestion && isWaiting && access.canResume && (
        <QuestionConfirmation question={openQuestion} onAnswer={(v) => void handleAnswer(v)} />
      )}

      <div className="border-t border-[var(--color-border)] py-3">
        <div className={THREAD_COLUMN}>
        <PromptInput
          onSubmit={(message) => void handlePromptSubmit(message)}
          className="[&_[data-slot=input-group]]:border-[var(--color-border-strong)] [&_[data-slot=input-group]]:bg-[var(--color-surface)] dark:[&_[data-slot=input-group]]:bg-[var(--color-surface)]"
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              disabled={composerDisabled || sending}
              // #378: Esc stops the current turn the same way the composer's
              // own stop button does -- a no-op when nothing is live, so
              // this is safe to fire regardless of runIsLive.
              onKeyDown={(e) => {
                if (e.key === "Escape" && runIsLive) {
                  e.preventDefault();
                  void runAction("interrupt");
                }
              }}
              placeholder={
                !access.canResume
                  ? "Zprávy může posílat jen vlastník relace."
                  : isWaiting
                    ? "Relace čeká na odpověď na otázku výše."
                    : live.state === "closed" || live.state === "archived"
                      ? "Relace je uzavřená."
                      : "Napiš zprávu…"
              }
            />
          </PromptInputBody>
          {/* Two rows under the textarea (spec, "The composer"): row 1 the
              run's choices and send/stop, row 2 where it runs, dimmer. */}
          <PromptInputFooter className="flex-col items-stretch gap-1">
            <div className="flex items-center justify-between gap-2">
            <PromptInputTools>
              {access.canResume && (
                <>
                  <PromptInputSelect value={session.model ?? ""} onValueChange={handleModelChange}>
                    <PromptInputSelectTrigger className="w-auto min-w-0" title="Model">
                      <PromptInputSelectValue placeholder="Model (výchozí)" />
                    </PromptInputSelectTrigger>
                    <PromptInputSelectContent>
                      {models.map((m) => (
                        <PromptInputSelectItem key={m.id} value={m.id} title={m.description}>
                          {m.displayName}
                        </PromptInputSelectItem>
                      ))}
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                  {selectedModel?.supportsEffort && (
                    <PromptInputSelect value={session.effort ?? ""} onValueChange={handleEffortChange}>
                      <PromptInputSelectTrigger
                        className="w-auto min-w-0"
                        title="Úsilí uvažování — projeví se od příštího běhu"
                      >
                        <PromptInputSelectValue placeholder="Úsilí (výchozí)" />
                      </PromptInputSelectTrigger>
                      <PromptInputSelectContent>
                        {selectedModel.effortLevels.map((e) => (
                          <PromptInputSelectItem key={e} value={e}>
                            {e}
                          </PromptInputSelectItem>
                        ))}
                      </PromptInputSelectContent>
                    </PromptInputSelect>
                  )}
                </>
              )}
            </PromptInputTools>
            <PromptInputSubmit
              // #378: while a run is live, the button IS the stop control
              // (a stop square, click -> interrupt()) -- Enter in the
              // textarea still submits normally either way, since that goes
              // through the form's own onSubmit, not this button's click.
              disabled={runIsLive ? actionPending !== null : composerDisabled || sending || !composerText.trim()}
              status={sending ? "submitted" : runIsLive ? "streaming" : undefined}
              onStop={runIsLive ? () => void runAction("interrupt") : undefined}
            />
            </div>
            <div className="flex min-h-6 items-center gap-1.5 px-1 text-[11.5px] text-[var(--color-text-dim)]">
              {live.state === "draft" && access.canResume && session.runner ? (
                <PromptInputSelect
                  value={encodeRunnerChoice(session.runner, session.instance_id)}
                  onValueChange={handleRunnerChange}
                >
                  <PromptInputSelectTrigger
                    className="h-6 w-auto min-w-0 px-1.5 text-[11.5px] font-normal"
                    title="Runner a instance — platí pro celé vlákno, mění se jen u nového"
                  >
                    {/* The trigger names the pair ("claude · Work"); the
                        list's own items name the instance under its
                        runner's heading. */}
                    <PromptInputSelectValue>{runnerChoiceLabel(session, instances)}</PromptInputSelectValue>
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {runnerPickerGroups(runners, instances, initialChoiceRef.current).map((g) => (
                      <SelectGroup key={g.runner}>
                        <SelectLabel>{g.label}</SelectLabel>
                        {g.options.map((o) => (
                          <PromptInputSelectItem key={o.value} value={o.value}>
                            {o.label}
                            {o.isDefault ? " (výchozí)" : ""}
                          </PromptInputSelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              ) : (
                <span className="px-1.5">{runnerChoiceLabel(session, instances)}</span>
              )}
              {/* #428: the host whose sidecar runs the thread -- a label,
                  never a choice, hidden when unknown. */}
              {host && <span>· {host}</span>}
            </div>
          </PromptInputFooter>
        </PromptInput>
        </div>
      </div>
    </div>
  );
}

function HeaderIcon({
  onClick,
  disabled,
  title,
  className,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  className?: string;
  children: React.ReactNode;
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

// Czech trigger text for the Reasoning kit's default English wording:
// "Přemýšlím…" while streaming, "Uvažoval N s" once the block is done.
function reasoningTriggerMessage(isStreaming: boolean, duration?: number): React.ReactNode {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Přemýšlím…</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Uvažoval několik sekund</p>;
  }
  return <p>Uvažoval {duration} s</p>;
}

function SystemMarker({ children }: { children: React.ReactNode }) {
  return <div className="text-center text-[11px] text-[var(--color-text-dim)]">{children}</div>;
}

// Rule 1: the prompt and the answer are the only rows at full weight;
// activity is one folded group per turn, bookkeeping is no row at all
// (lib/session-chat.ts's deriveTranscriptRows decides).
function TranscriptRowView({ row, onOpenFile }: { row: TranscriptRow; onOpenFile?: (relPath: string) => void }) {
  switch (row.kind) {
    case "prompt":
      return (
        <Message from="user">
          <MessageContent className="group-[.is-user]:border group-[.is-user]:border-[var(--color-border)] group-[.is-user]:bg-[var(--color-accent-soft)]">
            <MessageResponse>{row.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    case "answer":
      return (
        <Message from="assistant">
          <MessageContent>
            <MessageResponse>{row.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    case "activity":
      return <ActivityGroupRow row={row} onOpenFile={onOpenFile} />;
    case "question":
      return <SystemMarker>Otázka: {row.title}</SystemMarker>;
    case "compaction":
      return (
        <Checkpoint className="justify-center text-[11px]">
          <CheckpointIcon className="size-3.5" />
          Komprese kontextu
        </Checkpoint>
      );
    case "summary":
      return <SystemMarker>Shrnutí uloženo</SystemMarker>;
    case "note":
      return <SystemMarker>{row.text}</SystemMarker>;
    case "error":
      return (
        <SystemMarker>
          <span style={{ color: "var(--color-danger)" }}>{row.message}</span>
        </SystemMarker>
      );
    default:
      return null;
  }
}

// One turn's activity: collapsed to its sentence, expanded to a
// ChainOfThought with one Tool per call. The live group (the current
// run's open one) stays expanded on the tool that is running; a
// historical group expands only by hand, per mount.
function ActivityGroupRow({ row, onOpenFile }: { row: ActivityRow; onOpenFile?: (relPath: string) => void }) {
  const [open, setOpen] = useState(false);
  const running = row.live ? row.items.find((i) => i.kind === "tool" && i.call.status === "started") : undefined;
  const summary = activitySummary(row.items);
  const headerText = summary.text || (row.live ? "Pracuji…" : "Aktivita");
  return (
    <ChainOfThought open={row.live || open} onOpenChange={setOpen} className="text-[12.5px]">
      <ChainOfThoughtHeader
        className="text-[12.5px]"
        style={summary.failed > 0 ? { color: "var(--color-danger)" } : undefined}
      >
        {row.live ? <Shimmer duration={1.5}>{headerText}</Shimmer> : headerText}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {row.live && !open && running ? (
          <ToolStep item={running} onOpenFile={onOpenFile} />
        ) : (
          row.items.map((item) => <ToolStep key={item.seq} item={item} onOpenFile={onOpenFile} />)
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function ToolStep({ item, onOpenFile }: { item: ActivityItem; onOpenFile?: (relPath: string) => void }) {
  if (item.kind === "reasoning") {
    return (
      <ChainOfThoughtStep label="Uvažování" icon={BrainIcon}>
        <Reasoning
          isStreaming={false}
          defaultOpen={false}
          duration={item.durationMs === null ? undefined : Math.max(1, Math.round(item.durationMs / 1000))}
        >
          <ReasoningTrigger getThinkingMessage={reasoningTriggerMessage} />
          <ReasoningContent>{item.summary}</ReasoningContent>
        </Reasoning>
      </ChainOfThoughtStep>
    );
  }
  if (item.kind === "file_change") {
    return (
      <ChainOfThoughtStep
        label={
          onOpenFile ? (
            <Button variant="link" size="xs" className="h-auto p-0 text-inherit" onClick={() => onOpenFile(item.path)}>
              {item.path}
            </Button>
          ) : (
            item.path
          )
        }
        description={fileChangeOpLabel(item.op)}
      />
    );
  }
  const p = item.call;
  const failed = p.status === "failed";
  return (
    <ChainOfThoughtStep label={p.title || p.tool} status={p.status === "started" ? "active" : "complete"}>
      <Tool defaultOpen={false} className="mb-0 bg-[var(--color-surface)]">
        <ToolHeader title={p.title || undefined} tool={p.tool} state={p.status} className="p-2.5" />
        <ToolContent>
          {p.input_summary && <ToolInput input={p.input_summary} />}
          <ToolOutput output={failed ? null : p.output_excerpt} errorText={failed ? p.output_excerpt : null} />
        </ToolContent>
      </Tool>
    </ChainOfThoughtStep>
  );
}

// Rule 2: a live run with an empty transcript end is a bug -- this row is
// what fills it, with a label for the last thing that happened and the
// seconds since it appeared.
function WorkingRow({ phase }: { phase: WorkingPhase }) {
  const [since] = useState(() => Date.now());
  const now = useNowTick(1000);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-dim)]" role="status">
      <Loader size={14} />
      <Shimmer duration={1.5}>{WORKING_LABEL[phase]}</Shimmer>
      <span className="tabular-nums">{seconds} s</span>
    </div>
  );
}

// The open-question interactive panel (spec: "the question panel becomes
// Confirmation"). Only ever rendered for the current open question, while
// the session is actually waiting on it -- a `question` event's own
// history entry (EventRow above) stays a plain marker, since a persisted
// event's `decision` never mutates in place (rule: "the canonical log is
// append-only").
function QuestionConfirmation({
  question,
  onAnswer,
}: {
  question: Extract<CanonicalEvent, { kind: "question" }>;
  onAnswer: (value: string | boolean) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="border-t border-[var(--color-border)]">
      <div className={`${THREAD_COLUMN} py-2.5`}>
      <Confirmation state="requested" className="border-none bg-[var(--color-surface)] p-0">
        <ConfirmationTitle className="text-[13px] font-medium text-[var(--color-text)]">
          {question.payload.title}
        </ConfirmationTitle>
        {question.payload.detail && (
          <p className="whitespace-pre-wrap text-[12px] text-[var(--color-text-dim)]">{question.payload.detail}</p>
        )}
        <ConfirmationRequest>
          {question.payload.type === "approval" ? (
            <ConfirmationActions>
              {(question.payload.options ?? ["Ano", "Ne"]).map((opt) => (
                <ConfirmationAction key={opt} onClick={() => onAnswer(opt)}>
                  {opt}
                </ConfirmationAction>
              ))}
            </ConfirmationActions>
          ) : (
            <ConfirmationActions className="w-full">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAnswer(text);
                }}
                placeholder="Odpověď…"
                className="min-w-0 flex-1"
              />
              <ConfirmationAction onClick={() => onAnswer(text)}>Odeslat</ConfirmationAction>
            </ConfirmationActions>
          )}
        </ConfirmationRequest>
      </Confirmation>
      </div>
    </div>
  );
}

function fileChangeOpLabel(op: "create" | "edit" | "delete" | "rename"): string {
  switch (op) {
    case "create":
      return "vytvořen";
    case "edit":
      return "upraven";
    case "delete":
      return "smazán";
    case "rename":
      return "přejmenován";
  }
}
