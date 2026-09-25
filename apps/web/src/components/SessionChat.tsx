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

import { displayError } from "../errors";
import { useTranslation } from "react-i18next";
import {
  modelDescriptionText,
  questionDetailIsContent,
  questionDetailText,
  questionTitleText,
  runErrorText,
  toolOutputText,
} from "../lib/chat-event-text";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { composerStatePlaceholder, hostDisplayName, threadAcceptsMessages, threadCloseAction } from "../lib/session-views";
import type { SessionStore } from "../lib/session-store";
import { selectSession } from "../lib/session-selectors";
import { useSessionStore } from "../lib/use-session-store";
import {
  decodeRunnerChoice,
  encodeRunnerChoice,
  runnerChoiceLabel,
  runnerPickerGroups,
} from "../lib/runner-picker";
import type { SessionsClient } from "../lib/sessions-client";
import {
  toCanonicalEvent,
  sessionStatusChip,
  latestQuestionEvent,
  approvalChoices,
  askPrompts,
  togglePick,
  picksComplete,
  askAnswer,
  createAnswerGate,
  type AskPicks,
  type QuestionAnswer,
  appendDelta,
  deltaBuffersAfter,
  createDeltaCoalescer,
  deriveTranscriptRows,
  activitySummary,
  workingPhase,
  runIsLiveFor,
  turnInFlight,
  nextSentAt,
  transcriptElsewhere,
  WORKING_LABEL,
  type ActivityItem,
  type ActivityRow,
  type ChatEvent,
  insertManyBySeq,
  type CanonicalEvent,
  type DeltaBuffers,
  type TranscriptRow,
  type WorkingPhase,
} from "../lib/session-chat";
import { HandoffRefusedError } from "../lib/handoff-refusal";
import { useNowTick } from "../lib/use-now-tick";
import { contextRingState, latestContextUsage } from "../lib/context-ring";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectGroup, SelectLabel } from "@/components/ui/select";
import { BrainIcon, Check, CircleX, Pencil, Redo2, Share2, X } from "lucide-react";
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
import {
  deleteDraftSession,
  fetchTranscriptHost,
  handoffSession,
  patchSessionModelEffort,
  patchSessionRunnerInstance,
  renamePersistentSession,
} from "../api";
import {
  fetchRunnerModels,
  listRunnerInstances,
  listRunners,
  type RunnerInfo,
  type RunnerInstanceSummary,
  type RunnerModel,
} from "../lib/runners";
import { useLocale } from "../lib/use-locale";

// Spec rule 3 (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md):
// transcript, notice bar, question panel and composer share one centred
// column -- 10 % gutters each side, never wider than 768 px. The scroll
// container stays full-width so the scrollbar keeps its edge.
const THREAD_COLUMN = "mx-auto w-[min(80%,768px)]";
// #466 (spec docs/superpowers/specs/2026-09-22-web-session-state-design.md,
// "`SessionChat`"): this component takes the thread's id, never a row. The
// row comes from the store -- the window's only copy -- and every change to
// it is written there, so no callback hands a spread-together session
// object back to App and there is no local copy of state and waiting for a
// frame to keep in step. What the component does own is its
// transcript: the events, the delta buffers, the live run, the send clock,
// the composer and its dialogs.
export default function SessionChat({
  sessionId,
  sessionStore,
  sessionsClient,
  onOpenFile,
}: {
  sessionId: string;
  sessionStore: SessionStore;
  sessionsClient: SessionsClient;
  onOpenFile?: (relPath: string) => void;
}) {
  const { t } = useTranslation("chat");
  const locale = useLocale();
  const session = useSessionStore(
    sessionStore,
    useCallback((store: SessionStore) => selectSession(store, sessionId), [sessionId]),
  );
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [textDeltaBuffers, setTextDeltaBuffers] = useState<DeltaBuffers>({});
  const [reasoningDeltaBuffers, setReasoningDeltaBuffers] = useState<DeltaBuffers>({});
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  // When the last message was sent, until its run_started arrives -- what
  // the working row shows as "Spouštím…" (rule 2: something is always on
  // screen while a run is live, and the run is live from the send). The
  // rule for when it is set and cleared is lib/session-chat.ts's pure
  // `nextSentAt`; every write below goes through it.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // #461: the label the events route answers with when the conversation is
  // on another machine -- null while it is here, or not known yet.
  const [transcriptHost, setTranscriptHost] = useState<string | null>(null);
  // The composer's draft belongs to the session, not to this component --
  // see lib/session-drafts.ts. Seeded once per mount (the caller keys this
  // component on the session id, so a different session is a different
  // instance) and written through on every keystroke, so it survives
  // switching sessions and the surface being unmounted.
  const [composerText, setComposerTextState] = useState(() => sessionDrafts.get(sessionId));
  const setComposerText = (text: string) => {
    sessionDrafts.set(sessionId, text);
    setComposerTextState(text);
  };
  const [sending, setSending] = useState(false);
  const [actionPending, setActionPending] = useState<"interrupt" | "close" | "continue" | "handoff" | null>(null);
  // #459: the file Předat wrote, shown as a notice until the thread moves
  // on -- the path is the whole point of the action (it is what the other
  // machine opens), so it does not vanish with the request.
  const [handoffPath, setHandoffPath] = useState<string | null>(null);
  // Once the server said Předat cannot work from here (no mirror of the
  // node, the run or the transcript on another device), the action is not
  // offered again in this view; the reason stays on screen.
  const [handoffUnavailable, setHandoffUnavailable] = useState(false);
  // Inline rename in the header (same affordance as the Relace row): the
  // rename goes through POST /sessions/:id/rename, and api.ts writes the
  // row it answers with into the store -- the sidebar, this header and the
  // Relace tab then read the same record.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(session?.name ?? "");
  const [renameSaving, setRenameSaving] = useState(false);
  // #378: a new run starting is "the thread woken again" -- the notice bar
  // (below) is dismissible per-occurrence.
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  // Composer row 2 (v2 rule 5): the runner/instance choice, open while the
  // thread is a draft. The lists come from the device (both routes are
  // device-local), the draft's initial value is what the organisation's
  // default resolved to, so it is what the picker marks as "(výchozí)".
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [instances, setInstances] = useState<RunnerInstanceSummary[]>([]);
  const initialChoiceRef = useRef({ runner: session?.runner ?? null, instanceId: session?.instance_id ?? null });
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

  // #376: the model picker's list, for the thread's runner. A draft on a
  // device with no logged-in runner falls back to "claude", the only
  // runner this codebase registers today.
  const [models, setModels] = useState<RunnerModel[]>([]);
  const runner = session?.runner ?? null;
  useEffect(() => {
    let cancelled = false;
    fetchRunnerModels(runner ?? "claude")
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [runner]);

  // Backfill + subscribe. Keyed on the thread id alone: state and waiting
  // come from the store's record now, so nothing in here reads a session
  // field and the effect never re-runs for one changing.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEvents([]);
    setTextDeltaBuffers({});
    setReasoningDeltaBuffers({});
    setLiveRunId(null);
    setTranscriptHost(null);
    setSentAt((current) => nextSentAt(current, { kind: "reset" }));

    // #461: where the transcript is, asked of the device that would serve
    // it. One row is enough -- the replay below comes over the live
    // channel, this call is only here for the header. A failure says
    // nothing (the replay is the thing that matters), so it is swallowed.
    void fetchTranscriptHost(sessionId)
      .then((host) => {
        if (!cancelled) setTranscriptHost(host);
      })
      .catch(() => undefined);

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
    // both the backfill and everything after it. `runId` mirrors the
    // liveRunId state for the handler's own synchronous use: an
    // assistant_message/reasoning event carries no run id of its own, and
    // the state value is a render value this closure never sees updated.
    let runId: string | null = null;
    // A batch (a replay page, or one live event) is one pass: the list is
    // extended once, and the per-event bookkeeping below runs in the same
    // handler, so React renders it once.
    const offEvent = sessionsClient.onEvents(sessionId, (envelopes) => {
      const batch = envelopes.map((envelope) => ({ seq: envelope.seq, event: toCanonicalEvent(envelope.kind, envelope.payload) }));
      setEvents((prev) => insertManyBySeq(prev, batch));
      for (const { event } of batch) handleEvent(event);
    });
    function handleEvent(event: CanonicalEvent): void {
      // run_started and run_ended (an error at start included) both stop
      // the send clock; every other event leaves it alone.
      setSentAt((current) => nextSentAt(current, { kind: "event", event }));
      if (event.kind === "run_started") {
        runId = event.payload.run_id;
        setLiveRunId(event.payload.run_id);
      } else if (event.kind === "run_ended") {
        runId = null;
        coalescer.flush();
        setLiveRunId(null);
      } else if (event.kind === "turn_ended") {
        // #495: frames still waiting for the tick belong to the turn that
        // just ended; delivered after the clear, they would prefix the
        // next turn's answer.
        coalescer.drop(event.payload.run_id, "text");
        coalescer.drop(event.payload.run_id, "reasoning");
      } else if (runId && (event.kind === "assistant_message" || event.kind === "reasoning")) {
        // The finalized block supersedes what streamed: drop its still
        // buffered frames before clearing, or the tick delivers the
        // block's tail into the buffer the clear just emptied and that
        // fragment renders as a streaming bubble until the run ends.
        coalescer.drop(runId, event.kind === "reasoning" ? "reasoning" : "text");
      }
      // run_ended, turn_ended and the finalized blocks clear the buffers
      // (deltaBuffersAfter); every other event leaves them as they are.
      const id = runId;
      setTextDeltaBuffers((prev) => deltaBuffersAfter(prev, "text", event, id));
      setReasoningDeltaBuffers((prev) => deltaBuffersAfter(prev, "reasoning", event, id));
    }
    const offDelta = sessionsClient.onDelta(sessionId, (delta) => coalescer.push(delta));
    // No onSessionStates handler here: App binds the live channel to the
    // store once (#465), so a frame folds into the record this component
    // already reads (spec principle 3).

    void sessionsClient
      .subscribe(sessionId, 0)
      .catch((e) => {
        if (!cancelled) setError(displayError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      coalescer.clear();
      offEvent();
      offDelta();
      sessionsClient.unsubscribe(sessionId);
    };
  }, [sessionId, sessionsClient]);

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

  // #492: one answer per question -- a second click or Enter while the
  // first is on its way is dropped, not sent into a NO_PENDING_QUESTION.
  const [answerGate] = useState(createAnswerGate);

  // Every hook has run; from here the record is what the component reads.
  // It is missing only in the moment between its removal from the store (a
  // deleted draft) and the parent dropping this pane, so there is nothing
  // to show and nothing to say. A record known only from a live frame
  // (`partial`) is the same case: the parent never mounts a chat for one,
  // and half a record would render a nameless header.
  if (!session || session.partial) return null;

  const host = hostDisplayName(session);
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
      // api.ts puts the answered row into the store; nothing to hand on.
      await renamePersistentSession(sessionId, trimmed);
      setRenaming(false);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setRenameSaving(false);
    }
  };

  // Spec "Writing": an optimistic put, the server's answer replaces the
  // record (api.ts folds what it answers with), a refusal puts the previous
  // record back and the composer says why. No object is ever handed to a
  // parent.
  const handleRunnerChange = (value: string) => {
    const { runner: picked, instanceId } = decodeRunnerChoice(value);
    const before = session;
    sessionStore.put({ ...before, runner: picked, instance_id: instanceId });
    void patchSessionRunnerInstance(sessionId, { runner: picked, instance_id: instanceId }).catch((e) => {
      sessionStore.put(before);
      setError(`Runner a instanci se nepodařilo uložit: ${displayError(e)}`);
    });
  };

  const selectedModel = models.find((m) => m.id === session.model) ?? null;

  const handleModelChange = (value: string) => {
    const model = value === "" ? null : value;
    const before = session;
    sessionStore.put({ ...before, model });
    void patchSessionModelEffort(sessionId, { model }).catch((e) => {
      sessionStore.put(before);
      setError(`Model se nepodařilo uložit: ${displayError(e)}`);
    });
  };
  const handleEffortChange = (value: string) => {
    const effort = value === "" ? null : value;
    const before = session;
    sessionStore.put({ ...before, effort });
    void patchSessionModelEffort(sessionId, { effort }).catch((e) => {
      sessionStore.put(before);
      setError(`Úsilí se nepodařilo uložit: ${displayError(e)}`);
    });
  };

  const ring = contextRingState(
    liveUsage?.used ?? session.context_used_tokens,
    liveUsage?.max ?? session.context_max_tokens,
    locale,
  );
  const openQuestion = latestQuestionEvent(events);
  const isWaiting = session.state === "running" && session.waiting_since !== null;
  const runIsLive = runIsLiveFor(liveRunId, session.state);
  // A live run between turns only waits for the next message: the composer
  // sends, nothing to stop, nothing "working".
  const turnActive = runIsLive && turnInFlight(events, liveRunId);
  const streamingText = liveRunId ? textDeltaBuffers[liveRunId] : undefined;
  const streamingReasoning = liveRunId ? reasoningDeltaBuffers[liveRunId] : undefined;
  // The working row (rule 2): shown while a run is live (or a send is in
  // flight) and nothing else at the transcript end says what is happening.
  const phase = runIsLive || sentAt !== null ? workingPhase(events, liveRunId, sentAt) : null;
  const showWorking = phase !== null && !streamingText && !streamingReasoning && !isWaiting;
  const chip = sessionStatusChip(session.state, session.waiting_since);
  // #461: the conversation is on another machine and this one holds only
  // the record. Nothing to replay, nothing to send -- the chat says where
  // the transcript is and how to pick the thread up here (Předat there).
  const elsewhere = transcriptElsewhere(transcriptHost, events.length);
  // #378: an open thread with a run that ended other than by Uzavřít --
  // the next message replays the whole conversation from the summary.
  const showNotice = session.state === "suspended" && !noticeDismissed;

  const runAction = async (action: "interrupt" | "close") => {
    setActionPending(action);
    setError(null);
    try {
      await sessionsClient[action](sessionId);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setActionPending(null);
    }
  };

  // #459 "Předat": POST /sessions/:id/handoff ends the turn and the run and
  // writes the thread's summary into the node's mirror; api.ts puts the
  // suspended record into the store, so the header, the sidebar and Relace
  // all follow. The answered path stays on screen as the notice below --
  // it is what the other machine opens (Navázat na handoff there).
  const handleHandoff = async () => {
    setActionPending("handoff");
    setError(null);
    try {
      const { handoff_path } = await handoffSession(sessionId);
      setHandoffPath(handoff_path);
      setNoticeDismissed(false);
    } catch (e) {
      setError(displayError(e));
      // HANDOFF_NO_CONTENT passes once the content downloads; keep offering it.
      if (
        e instanceof HandoffRefusedError &&
        e.code !== "HANDOFF_NOT_ALLOWED" &&
        e.code !== "HANDOFF_NO_CONTENT"
      )
        setHandoffUnavailable(true);
    } finally {
      setActionPending(null);
    }
  };

  // "Pokračovat v nové session" (running or suspended): POST
  // /sessions/:id/continue closes this session (its summary
  // seeds the new one) and starts a fresh, running one on the same node --
  // the new row goes into the store, which is what makes it this node's
  // shown thread (the old one is closed, so it leaves the selectors).
  const handleContinue = async () => {
    setActionPending("continue");
    setError(null);
    try {
      const { session: newSession } = await sessionsClient.continueSession(sessionId);
      sessionStore.put(newSession);
    } catch (e) {
      setError(displayError(e));
      setActionPending(null);
    }
  };

  const handlePromptSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    // Until run_started lands (a promotion or a resume starts a process
    // first), the working row says "Spouštím…". A live run's own message
    // needs none: its run_started already happened. Set before the send is
    // awaited: run_started (and a run_ended right behind it) can arrive
    // while the reply is still in flight, and each clears this -- set
    // afterwards it would outlive the run it was announcing.
    setSentAt((current) => nextSentAt(current, { kind: "send", liveRunId, now: Date.now() }));
    try {
      await sessionsClient.message(sessionId, text);
      setComposerText("");
    } catch (e) {
      setSentAt((current) => nextSentAt(current, { kind: "send_failed" }));
      setError(displayError(e));
    } finally {
      setSending(false);
    }
  };

  const handleAnswer = async (value: QuestionAnswer) => {
    if (!openQuestion) return;
    const requestId = openQuestion.payload.request_id;
    if (!answerGate.claim(requestId)) return;
    try {
      await sessionsClient.answer(sessionId, requestId, value);
    } catch (e) {
      answerGate.release(requestId);
      setError(displayError(e));
    }
  };

  // #457: every thread the app can show is the caller's own, so there is no
  // access echo left here -- only the state decides.
  // #498: a closed thread takes a message too -- it reopens on it.
  const composerDisabled = !threadAcceptsMessages(session.state) || isWaiting || elsewhere !== null;

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
              <HeaderIcon onClick={startRename} disabled={actionPending !== null} title="Přejmenovat">
                <Pencil />
              </HeaderIcon>
              {/* #459: Předat -- hands the thread to another machine
                  through its handoff file. Running and suspended only:
                  a draft has nothing to summarise, a closed thread is
                  done. #461: and only where the conversation is -- the
                  summary is written from the transcript, so a device that
                  holds none of it cannot hand the thread anywhere. */}
              {(session.state === "running" || session.state === "suspended") && !elsewhere && !handoffUnavailable && (
                <HeaderIcon
                  onClick={() => void handleHandoff()}
                  disabled={actionPending !== null}
                  title={actionPending === "handoff" ? "Předávám…" : "Předat na jiné zařízení"}
                >
                  <Share2 />
                </HeaderIcon>
              )}
              {(session.state === "running" || session.state === "suspended") && (
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
              {/* #506: a draft gets the same Uzavřít, which deletes it
                  without asking; removing the record closes this chat the
                  way the sidebar's × does. */}
              {threadCloseAction(session.state) !== null && (
                <>
                  <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--color-border)]" />
                  <HeaderIcon
                    onClick={() => {
                      // #498: Uzavřít asks nothing -- a closed thread
                      // reopens by writing into it.
                      if (threadCloseAction(session.state) === "delete") deleteDraftSession(session.id);
                      else void runAction("close");
                    }}
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
            {handoffPath ? (
              <>
                Vlákno je předané. Shrnutí je v souboru <code>{handoffPath}</code>; po synchronizaci na něj na druhém
                zařízení navážeš v záložce Relace.
              </>
            ) : (
              <>
                Proces byl ukončen. Další zpráva konverzaci nastartuje znovu — dosavadní kontext půjde do modelu ještě
                jednou.
              </>
            )}
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

      {error && (
        <div className="border-b border-[var(--color-border)] px-4 py-1.5 text-[12.5px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      <Conversation>
        <ConversationContent className={`${THREAD_COLUMN} gap-5`}>
          {loading ? (
            <Shimmer duration={1.5}>Načítám konverzaci…</Shimmer>
          ) : elsewhere ? (
            <ConversationEmptyState title={elsewhere.title} description={elsewhere.hint} />
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

      {openQuestion && isWaiting && (
        <QuestionConfirmation key={openQuestion.payload.request_id} question={openQuestion} onAnswer={(v) => void handleAnswer(v)} />
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
                if (e.key === "Escape" && turnActive) {
                  e.preventDefault();
                  void runAction("interrupt");
                }
              }}
              placeholder={
                elsewhere
                  ? `Transkript je na zařízení ${elsewhere.host}; pokračuj tam, nebo si vlákno nech předat.`
                  : isWaiting
                    ? "Relace čeká na odpověď na otázku výše."
                    : composerStatePlaceholder(session.state)
              }
            />
          </PromptInputBody>
          {/* Two rows under the textarea (spec, "The composer"): row 1 the
              run's choices and send/stop, row 2 where it runs, dimmer. */}
          <PromptInputFooter className="flex-col items-stretch gap-1">
            <div className="flex items-center justify-between gap-2">
            <PromptInputTools>
              <PromptInputSelect value={session.model ?? ""} onValueChange={handleModelChange}>
                <PromptInputSelectTrigger className="w-auto min-w-0" title="Model">
                  <PromptInputSelectValue placeholder="Model (výchozí)" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {models.map((m) => (
                    <PromptInputSelectItem key={m.id} value={m.id} title={modelDescriptionText(m, t)}>
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
            </PromptInputTools>
            <PromptInputSubmit
              // #378: while a run is live, the button IS the stop control
              // (a stop square, click -> interrupt()) -- Enter in the
              // textarea still submits normally either way, since that goes
              // through the form's own onSubmit, not this button's click.
              disabled={turnActive ? actionPending !== null : composerDisabled || sending || !composerText.trim()}
              status={sending ? "submitted" : turnActive ? "streaming" : undefined}
              onStop={turnActive ? () => void runAction("interrupt") : undefined}
            />
            </div>
            <div className="flex min-h-6 items-center gap-1.5 px-1 text-[11.5px] text-[var(--color-text-dim)]">
              {session.state === "draft" && session.runner ? (
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
  const { t } = useTranslation("chat");
  switch (row.kind) {
    case "prompt":
      return (
        <Message from="user">
          <MessageContent translate="no" className="group-[.is-user]:border group-[.is-user]:border-[var(--color-border)] group-[.is-user]:bg-[var(--color-accent-soft)]">
            <MessageResponse>{row.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    case "answer":
      return (
        <Message from="assistant">
          <MessageContent translate="no">
            <MessageResponse>{row.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    case "activity":
      return <ActivityGroupRow row={row} onOpenFile={onOpenFile} />;
    case "question":
      return (
        <SystemMarker>
          Otázka: <span translate={row.code ? undefined : "no"}>{questionTitleText(row, t)}</span>
        </SystemMarker>
      );
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
          <span style={{ color: "var(--color-danger)" }} translate={row.content ? "no" : undefined}>
            {row.code ? runErrorText(row, t) : row.message}
          </span>
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
  const { t } = useTranslation("chat");
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
  // A denial of the runner's own is shown in the UI language; any other
  // output is the tool's and stays as it came.
  const output = toolOutputText(p, t);
  return (
    <ChainOfThoughtStep label={p.title || p.tool} status={p.status === "started" ? "active" : "complete"}>
      <Tool defaultOpen={false} className="mb-0 bg-[var(--color-surface)]">
        <ToolHeader title={p.title || undefined} tool={p.tool} state={p.status} className="p-2.5" />
        <ToolContent>
          {p.input_summary && <ToolInput input={p.input_summary} />}
          <ToolOutput
            output={failed ? null : output}
            errorText={failed ? output : null}
            translate={p.output_code ? undefined : "no"}
          />
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
  onAnswer: (value: QuestionAnswer) => void;
}) {
  const { t } = useTranslation("chat");
  const [text, setText] = useState("");
  const [picks, setPicks] = useState<AskPicks>({});
  const prompts = question.payload.type === "input" ? askPrompts(question.payload) : [];
  // Several dotazy: each one's text stands where the detail does today.
  const perQuestion = prompts.length > 1;
  const submitText = () => {
    const value = askAnswer(prompts, picks, text);
    if (value !== null) onAnswer(value);
  };
  const pick = (prompt: (typeof prompts)[number], label: string) => {
    const next = togglePick(picks, prompt, label);
    setPicks(next);
    if (picksComplete(prompts, next)) {
      const value = askAnswer(prompts, next, "");
      if (value !== null) onAnswer(value);
    }
  };
  return (
    <div className="border-t border-[var(--color-border)]">
      <div className={`${THREAD_COLUMN} py-2.5`}>
      <Confirmation state="requested" className="border-none bg-[var(--color-surface)] p-0">
        <ConfirmationTitle
          className="text-[13px] font-medium text-[var(--color-text)]"
          translate={question.payload.code ? undefined : "no"}
        >
          {questionTitleText(question.payload, t)}
        </ConfirmationTitle>
        {question.payload.detail && !perQuestion && (
          <p
            className="whitespace-pre-wrap text-[12px] text-[var(--color-text-dim)]"
            translate={questionDetailIsContent(question.payload) ? "no" : undefined}
          >
            {questionDetailText(question.payload, t)}
          </p>
        )}
        <ConfirmationRequest>
          {question.payload.type === "approval" ? (
            <ConfirmationActions>
              {approvalChoices(question.payload.options).map((choice) => (
                <ConfirmationAction key={choice.label} onClick={() => onAnswer(choice.value)}>
                  {choice.label}
                </ConfirmationAction>
              ))}
            </ConfirmationActions>
          ) : (
            <>
              {prompts.map((prompt) => (
                <Fragment key={prompt.question}>
                  {perQuestion && (
                    <p className="whitespace-pre-wrap text-[12px] text-[var(--color-text-dim)]" translate="no">
                      {prompt.question}
                    </p>
                  )}
                  {prompt.options.length > 0 && (
                    <ConfirmationActions>
                      {prompt.options.map((label) => (
                        <ConfirmationAction
                          key={label}
                          translate="no"
                          // One single-choice dotaz answers on the click,
                          // like approval; otherwise a pick is shown until
                          // the rest is answered.
                          variant={
                            (prompts.length === 1 && !prompt.multi_select) ||
                            (picks[prompt.question] ?? []).includes(label)
                              ? "default"
                              : "outline"
                          }
                          onClick={() => pick(prompt, label)}
                        >
                          {label}
                        </ConfirmationAction>
                      ))}
                    </ConfirmationActions>
                  )}
                </Fragment>
              ))}
              <ConfirmationActions className="w-full">
                <Input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    // An IME composition's Enter confirms the composition,
                    // it is not a send.
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) submitText();
                  }}
                  placeholder="Odpověď…"
                  className="min-w-0 flex-1"
                />
                <ConfirmationAction onClick={submitText}>Odeslat</ConfirmationAction>
              </ConfirmationActions>
            </>
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
