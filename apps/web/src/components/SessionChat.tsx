// Live chat view of a runner-batch session (#342, docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md "Web: Práce, New task"; rebuilt
// on AI Elements by #373, docs/superpowers/specs/2026-09-15-task-surface-
// design.md "The chat is AI Elements"). Replaces the terminal canvas in
// Práce's center pane when the selected node has an open (running/
// suspended) persistent session. The whole log comes over the live
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
import { fetchSessionSignals, fetchPersistentSessionResumeInfo, resumeSession, type SessionSignals } from "../api";
import { sessionRowAccess } from "../lib/session-views";
import { useMe } from "../lib/use-me";
import type { SessionsClient } from "../lib/sessions-client";
import {
  toCanonicalEvent,
  sessionStatusChip,
  latestQuestionEvent,
  appendDelta,
  clearDeltaBuffer,
  collapseToolCalls,
  formatRestartHint,
  type ChatEvent,
  insertBySeq,
  type CanonicalEvent,
  type DeltaBuffers,
} from "../lib/session-chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { sessionDrafts } from "../lib/session-drafts";

// Floor between two restart-indicator reads (see the signals effect).
const SIGNALS_MIN_INTERVAL_MS = 10_000;
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
  const [deltaBuffers, setDeltaBuffers] = useState<DeltaBuffers>({});
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ state: SessionState; waiting_since: string | null }>({
    state: session.state,
    waiting_since: session.waiting_since,
  });
  const [signals, setSignals] = useState<SessionSignals | null>(null);
  // The composer's draft belongs to the session, not to this component --
  // see lib/session-drafts.ts. Seeded once per mount (the caller keys this
  // component on session.id, so a different session is a different instance)
  // and written through on every keystroke, so it survives both switching
  // sessions and the surface being unmounted when a terminal opens.
  const [composerText, setComposerTextState] = useState(() => sessionDrafts.get(session.id));
  const setComposerText = (text: string) => {
    sessionDrafts.set(session.id, text);
    setComposerTextState(text);
  };
  const [sending, setSending] = useState(false);
  const [actionPending, setActionPending] = useState<"interrupt" | "suspend" | "close" | "resume" | "restart" | null>(null);
  // Whether the CLI conversation can still be picked up (GET
  // /sessions/:id/resume-info); "Předat a začít znovu" is always offered.
  const [conversationResumable, setConversationResumable] = useState(false);
  const { meId, canManage } = useMe();
  const access = sessionRowAccess(session.user_id, meId, canManage);

  // Backfill + subscribe. Re-runs whenever the selected session itself
  // changes (switching nodes in Práce mounts the same component fresh with
  // a new session id).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEvents([]);
    setDeltaBuffers({});
    setLiveRunId(null);
    setLive({ state: session.state, waiting_since: session.waiting_since });

    // Live run detection rides on the replayed/streamed events themselves
    // (run_started without a later run_ended), so one code path covers
    // both the backfill and everything after it.
    const offEvent = sessionsClient.onEvent(session.id, (envelope) => {
      const event = toCanonicalEvent(envelope.kind, envelope.payload);
      setEvents((prev) => insertBySeq(prev, { seq: envelope.seq, event }));
      if (event.kind === "run_started") {
        setLiveRunId(event.payload.run_id);
      } else if (event.kind === "run_ended") {
        setDeltaBuffers((prev) => clearDeltaBuffer(prev, event.payload.run_id));
        setLiveRunId(null);
      } else if (event.kind === "assistant_message" || event.kind === "reasoning") {
        setLiveRunId((current) => {
          if (current) setDeltaBuffers((prev) => clearDeltaBuffer(prev, current));
          return current;
        });
      }
    });
    const offDelta = sessionsClient.onDelta(session.id, (delta) => {
      setDeltaBuffers((prev) => appendDelta(prev, delta.run_id, delta.text));
    });
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
      offEvent();
      offDelta();
      offState();
      sessionsClient.unsubscribe(session.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session.state/
    // waiting_since intentionally excluded: they're seeded once at mount,
    // then owned by `live` (updated via onSessionState) from here on.
  }, [session.id, sessionsClient]);

  // Restart indicator (run age, write/read-set size, expansions since the
  // run started): a REST read, refreshed when something happened on the
  // session -- a new event arrived, or its state changed -- and at most
  // once per SIGNALS_MIN_INTERVAL_MS, never on a timer of its own. The
  // socket replaced polling; the indicator must not bring it back.
  const lastSignalsAtRef = useRef(0);
  const signalsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (live.state !== "running") {
      setSignals(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      lastSignalsAtRef.current = Date.now();
      void fetchSessionSignals(session.id)
        .then((s) => {
          if (!cancelled) setSignals(s);
        })
        .catch(() => undefined);
    };
    const schedule = () => {
      if (signalsTimerRef.current) return;
      const wait = Math.max(0, SIGNALS_MIN_INTERVAL_MS - (Date.now() - lastSignalsAtRef.current));
      signalsTimerRef.current = setTimeout(() => {
        signalsTimerRef.current = null;
        if (!cancelled) refresh();
      }, wait);
    };
    refresh();
    const offEvent = sessionsClient.onEvent(session.id, () => schedule());
    return () => {
      cancelled = true;
      offEvent();
      if (signalsTimerRef.current) {
        clearTimeout(signalsTimerRef.current);
        signalsTimerRef.current = null;
      }
    };
  }, [session.id, live.state, sessionsClient]);

  // Resume-mode offer, fetched once the session is suspended.
  useEffect(() => {
    if (live.state !== "suspended") {
      setConversationResumable(false);
      return;
    }
    let cancelled = false;
    void fetchPersistentSessionResumeInfo(session.id)
      .then((info) => {
        if (!cancelled) setConversationResumable(info.conversation_resumable);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.id, live.state]);

  const displayEvents = useMemo(() => collapseToolCalls(events), [events]);
  const openQuestion = latestQuestionEvent(events);
  const isWaiting = live.state === "running" && live.waiting_since !== null;
  const streamingText = liveRunId ? deltaBuffers[liveRunId] : undefined;
  const chip = sessionStatusChip(live.state, live.waiting_since);
  const restartHint = signals ? formatRestartHint(signals) : null;

  const runAction = async (action: "interrupt" | "suspend" | "close") => {
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

  const handleResume = async (mode: "conversation" | "handoff") => {
    setActionPending("resume");
    setError(null);
    try {
      await resumeSession(session.id, mode);
    } catch (e) {
      setError(String(e));
    } finally {
      setActionPending(null);
    }
  };

  // The restart indicator's own action (spec, "Suspend and resume"):
  // hand the context over and start a fresh run from the handoff --
  // a suspend (which writes the handoff) followed by a handoff-mode
  // resume, as one click.
  const handleRestartFromHandoff = async () => {
    setActionPending("restart");
    setError(null);
    try {
      await sessionsClient.suspend(session.id);
      await resumeSession(session.id, "handoff");
    } catch (e) {
      setError(String(e));
    } finally {
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
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${chip.pulsing ? "animate-pulse" : ""}`}
            style={{ background: chip.color }}
          />
          <span className="truncate text-[13.5px] font-medium text-[var(--color-text)]">{session.name}</span>
          <span className="shrink-0 text-[12px] text-[var(--color-text-dim)]">{chip.label}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-[var(--color-text-dim)]">
          <span>
            {session.runner ?? "runner neznámý"}
            {session.instance_id ? ` · ${session.instance_id}` : ""}
            {session.host_id ? ` · ${session.host_id}` : ""}
          </span>
          {live.state === "running" && access.canPauseOrClose && (
            <>
              <HeaderButton disabled={actionPending !== null} onClick={() => void runAction("interrupt")}>
                {actionPending === "interrupt" ? "Přerušuji…" : "Přerušit"}
              </HeaderButton>
              <HeaderButton disabled={actionPending !== null} onClick={() => void runAction("suspend")}>
                {actionPending === "suspend" ? "Pozastavuji…" : "Pozastavit"}
              </HeaderButton>
            </>
          )}
          {live.state === "suspended" && access.canResume && (
            <>
              {conversationResumable && (
                <HeaderButton disabled={actionPending !== null} onClick={() => void handleResume("conversation")}>
                  {actionPending === "resume" ? "Nahazuji…" : "Pokračovat"}
                </HeaderButton>
              )}
              <HeaderButton disabled={actionPending !== null} onClick={() => void handleResume("handoff")}>
                {actionPending === "resume" ? "Nahazuji…" : "Předat a začít znovu"}
              </HeaderButton>
            </>
          )}
          {(live.state === "running" || live.state === "suspended") && access.canPauseOrClose && (
            <HeaderButton disabled={actionPending !== null} onClick={() => void runAction("close")}>
              {actionPending === "close" ? "Zavírám…" : "Uzavřít"}
            </HeaderButton>
          )}
        </div>
      </div>

      {restartHint && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-1 text-[11px] text-[var(--color-text-dim)]">
          <span>{restartHint}</span>
          {access.canResume && (
            <HeaderButton disabled={actionPending !== null} onClick={() => void handleRestartFromHandoff()}>
              {actionPending === "restart" ? "Předávám…" : "Předat a začít znovu"}
            </HeaderButton>
          )}
        </div>
      )}

      {error && (
        <div className="border-b border-[var(--color-border)] px-4 py-1.5 text-[12.5px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      <Conversation>
        <ConversationContent>
          {loading ? (
            <Shimmer duration={1.5}>Načítám konverzaci…</Shimmer>
          ) : displayEvents.length === 0 ? (
            <ConversationEmptyState title="Zatím žádné zprávy" description="Napiš první zprávu níže." />
          ) : (
            <>
              {displayEvents.map((item) => (
                <EventRow key={item.seq} item={item} onOpenFile={onOpenFile} />
              ))}
              {streamingText && (
                <Message from="assistant">
                  <MessageContent>
                    <MessageResponse isAnimating>{streamingText}</MessageResponse>
                  </MessageContent>
                </Message>
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {openQuestion && isWaiting && access.canResume && (
        <QuestionConfirmation question={openQuestion} onAnswer={(v) => void handleAnswer(v)} />
      )}

      <div className="border-t border-[var(--color-border)] p-3">
        <PromptInput onSubmit={(message) => void handlePromptSubmit(message)}>
          <PromptInputBody>
            <PromptInputTextarea
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              disabled={composerDisabled || sending}
              placeholder={
                !access.canResume
                  ? "Zprávy může posílat jen vlastník relace."
                  : isWaiting
                    ? "Relace čeká na odpověď na otázku výše."
                    : live.state === "suspended"
                      ? "Relace je pozastavena — nejdřív ji nahoď."
                      : live.state === "closed" || live.state === "archived"
                        ? "Relace je uzavřená."
                        : "Napiš zprávu…"
              }
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit
              disabled={composerDisabled || sending || !composerText.trim()}
              status={sending ? "submitted" : undefined}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

function HeaderButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button variant="outline" size="sm" className="h-6 px-2 text-[11.5px]" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

function SystemMarker({ children }: { children: React.ReactNode }) {
  return <div className="text-center text-[11px] text-[var(--color-text-dim)]">{children}</div>;
}

function EventRow({
  item,
  onOpenFile,
}: {
  item: ChatEvent;
  onOpenFile?: (relPath: string) => void;
}) {
  const event: CanonicalEvent = item.event;
  switch (event.kind) {
    case "user_message":
      return (
        <Message from="user">
          <MessageContent>
            <MessageResponse>{event.payload.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    case "assistant_message":
      return (
        <Message from="assistant">
          <MessageContent>
            <MessageResponse>{event.payload.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    case "reasoning":
      return (
        <Reasoning isStreaming={false} defaultOpen={false}>
          <ReasoningTrigger />
          <ReasoningContent>{event.payload.summary}</ReasoningContent>
        </Reasoning>
      );
    case "tool_call": {
      const p = event.payload;
      const failed = p.status === "failed";
      return (
        <Tool defaultOpen={false}>
          <ToolHeader title={p.title || undefined} tool={p.tool} state={p.status} />
          <ToolContent>
            {p.input_summary && <ToolInput input={p.input_summary} />}
            <ToolOutput output={failed ? null : p.output_excerpt} errorText={failed ? p.output_excerpt : null} />
          </ToolContent>
        </Tool>
      );
    }
    case "file_change":
      return (
        <SystemMarker>
          {onOpenFile ? (
            <button className="underline hover:text-[var(--color-text)]" onClick={() => onOpenFile(event.payload.path)}>
              {event.payload.path}
            </button>
          ) : (
            event.payload.path
          )}{" "}
          ({fileChangeOpLabel(event.payload.op)})
        </SystemMarker>
      );
    case "question":
      return <SystemMarker>Otázka: {event.payload.title}</SystemMarker>;
    case "compaction":
      return (
        <Checkpoint className="justify-center text-[11px]">
          <CheckpointIcon className="size-3.5" />
          Komprese kontextu
        </Checkpoint>
      );
    case "handoff":
      return <SystemMarker>Handoff uložen{event.payload.generated_by === "server" ? " (serverem)" : ""}</SystemMarker>;
    case "state_changed":
      return (
        <SystemMarker>
          Stav: {event.payload.from} → {event.payload.to}
          {event.payload.by ? ` (ukončil/a ${event.payload.by})` : ""}
        </SystemMarker>
      );
    case "run_started":
      return <SystemMarker>Běh spuštěn</SystemMarker>;
    case "run_ended":
      return <SystemMarker>Běh ukončen ({runEndReasonLabel(event.payload.reason)})</SystemMarker>;
    case "error":
      return (
        <SystemMarker>
          <span style={{ color: "var(--color-danger)" }}>{event.payload.message}</span>
        </SystemMarker>
      );
    default:
      return null;
  }
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
    <div className="border-t border-[var(--color-border)] px-4 py-2.5">
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

function runEndReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    completed: "dokončeno",
    interrupted: "přerušeno",
    suspended: "pozastaveno",
    error: "chyba",
    limit: "limit",
    host_lost: "proces osiřel",
  };
  return labels[reason] ?? reason;
}
