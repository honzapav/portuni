// Live chat view of a runner-batch session (#342, docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md "Web: Práce, New task"). Replaces
// the terminal canvas in Práce's center pane when the selected node has an
// open (running/suspended) persistent session. Backfills the canonical
// event log once (GET /sessions/:id/events), then switches to the live
// WebSocket (lib/sessions-client.ts) for anything after -- streamed
// assistant text arrives as `delta` frames (never persisted, buffered here
// until the matching canonical event lands), everything else as `event`
// frames already carrying a monotonic `seq`.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionState, SessionSummary } from "../types";
import {
  fetchSessionEvents,
  fetchSessionSignals,
  fetchPersistentSessionResumeInfo,
  resumeSession,
  type SessionSignals,
} from "../api";
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
  type CanonicalEvent,
  type DeltaBuffers,
} from "../lib/session-chat";
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
  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [actionPending, setActionPending] = useState<"interrupt" | "suspend" | "close" | "resume" | null>(null);
  const [resumeMode, setResumeMode] = useState<"conversation" | "handoff" | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

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

    void fetchSessionEvents(session.id)
      .then((res) => {
        if (cancelled) return;
        const chatEvents = res.events.map((e) => ({ seq: e.seq, event: toCanonicalEvent(e.kind, e.payload) }));
        setEvents(chatEvents);
        const lastRunStarted = [...chatEvents].reverse().find((e) => e.event.kind === "run_started");
        const lastRunEnded = [...chatEvents].reverse().find((e) => e.event.kind === "run_ended");
        if (
          lastRunStarted &&
          (!lastRunEnded || lastRunEnded.seq < lastRunStarted.seq) &&
          lastRunStarted.event.kind === "run_started"
        ) {
          setLiveRunId(lastRunStarted.event.payload.run_id);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const offEvent = sessionsClient.onEvent(session.id, (envelope) => {
      const event = toCanonicalEvent(envelope.kind, envelope.payload);
      setEvents((prev) => (prev.some((p) => p.seq === envelope.seq) ? prev : [...prev, { seq: envelope.seq, event }]));
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

    void sessionsClient.subscribe(session.id);

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

  // Restart indicator: polled lazily, not pushed live -- cheap enough to
  // refresh on a plain interval while a run is live.
  useEffect(() => {
    if (live.state !== "running") {
      setSignals(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      void fetchSessionSignals(session.id).then((s) => {
        if (!cancelled) setSignals(s);
      }).catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session.id, live.state]);

  // Resume-mode offer, fetched once the session is suspended.
  useEffect(() => {
    if (live.state !== "suspended") {
      setResumeMode(null);
      return;
    }
    let cancelled = false;
    void fetchPersistentSessionResumeInfo(session.id)
      .then((info) => {
        if (!cancelled) setResumeMode(info.conversation_resumable ? "conversation" : "handoff");
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

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [displayEvents.length, streamingText]);

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

  const handleResume = async () => {
    if (!resumeMode) return;
    setActionPending("resume");
    setError(null);
    try {
      await resumeSession(session.id, resumeMode);
    } catch (e) {
      setError(String(e));
    } finally {
      setActionPending(null);
    }
  };

  const handleSend = async () => {
    const text = composerText.trim();
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

  const composerDisabled = live.state === "closed" || live.state === "archived" || isWaiting;

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
          </span>
          {live.state === "running" && (
            <>
              <ChatButton disabled={actionPending !== null} onClick={() => void runAction("interrupt")}>
                {actionPending === "interrupt" ? "Přerušuji…" : "Přerušit"}
              </ChatButton>
              <ChatButton disabled={actionPending !== null} onClick={() => void runAction("suspend")}>
                {actionPending === "suspend" ? "Pozastavuji…" : "Pozastavit"}
              </ChatButton>
            </>
          )}
          {live.state === "suspended" && resumeMode && (
            <ChatButton disabled={actionPending !== null} onClick={() => void handleResume()}>
              {actionPending === "resume"
                ? "Nahazuji…"
                : resumeMode === "conversation"
                  ? "Nahodit (pokračovat)"
                  : "Nahodit (z handoffu)"}
            </ChatButton>
          )}
          {(live.state === "running" || live.state === "suspended") && (
            <ChatButton disabled={actionPending !== null} onClick={() => void runAction("close")}>
              {actionPending === "close" ? "Zavírám…" : "Uzavřít"}
            </ChatButton>
          )}
        </div>
      </div>

      {restartHint && (
        <div className="border-b border-[var(--color-border)] px-4 py-1 text-[11px] text-[var(--color-text-dim)]">
          {restartHint}
        </div>
      )}

      {error && (
        <div className="border-b border-[var(--color-border)] px-4 py-1.5 text-[12.5px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="text-[13px] text-[var(--color-text-dim)]">Načítám konverzaci…</div>
        ) : displayEvents.length === 0 ? (
          <div className="text-[13px] text-[var(--color-text-dim)]">Zatím žádné zprávy.</div>
        ) : (
          <div className="space-y-2">
            {displayEvents.map((item) => (
              <EventRow key={item.seq} item={item} onOpenFile={onOpenFile} />
            ))}
            {streamingText && (
              <ChatBubble align="left" muted>
                {streamingText}
              </ChatBubble>
            )}
          </div>
        )}
      </div>

      {openQuestion && isWaiting && (
        <QuestionPanel question={openQuestion} onAnswer={(v) => void handleAnswer(v)} />
      )}

      <div className="border-t border-[var(--color-border)] p-3">
        <div className="flex gap-2">
          <textarea
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            disabled={composerDisabled || sending}
            placeholder={
              isWaiting
                ? "Relace čeká na odpověď na otázku výše."
                : live.state === "suspended"
                  ? "Relace je pozastavena — nejdřív ji nahoď."
                  : live.state === "closed" || live.state === "archived"
                    ? "Relace je uzavřená."
                    : "Napiš zprávu…"
            }
            rows={2}
            className="min-w-0 flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)] disabled:opacity-50"
          />
          <button
            onClick={() => void handleSend()}
            disabled={composerDisabled || sending || !composerText.trim()}
            className="shrink-0 self-end rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Odesílám…" : "Odeslat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
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

function ChatBubble({
  align,
  muted,
  children,
}: {
  align: "left" | "right";
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex ${align === "right" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-md px-3 py-1.5 text-[13px] ${
          align === "right"
            ? "bg-[var(--color-accent-dim)]/20 text-[var(--color-text)]"
            : muted
              ? "text-[var(--color-text-dim)]"
              : "bg-[var(--color-surface)] text-[var(--color-text)]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function SystemMarker({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-center text-[11px] text-[var(--color-text-dim)]">{children}</div>
  );
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
      return <ChatBubble align="right">{event.payload.text}</ChatBubble>;
    case "assistant_message":
      return <ChatBubble align="left">{event.payload.text}</ChatBubble>;
    case "reasoning":
      return (
        <ChatBubble align="left" muted>
          {event.payload.summary}
        </ChatBubble>
      );
    case "tool_call": {
      const p = event.payload;
      const statusLabel = p.status === "started" ? "běží" : p.status === "completed" ? "hotovo" : "selhalo";
      return (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--color-text)]">{p.title}</span>
            <span className="text-[var(--color-text-dim)]">({statusLabel})</span>
          </div>
          {p.output_excerpt && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-dim)]">
              {p.output_excerpt}
              {p.truncated ? "\n…" : ""}
            </pre>
          )}
        </div>
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
      return <SystemMarker>Komprese kontextu</SystemMarker>;
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

function QuestionPanel({
  question,
  onAnswer,
}: {
  question: Extract<CanonicalEvent, { kind: "question" }>;
  onAnswer: (value: string | boolean) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="text-[13px] font-medium text-[var(--color-text)]">{question.payload.title}</div>
      {question.payload.detail && (
        <div className="mt-0.5 whitespace-pre-wrap text-[12px] text-[var(--color-text-dim)]">{question.payload.detail}</div>
      )}
      {question.payload.type === "approval" ? (
        <div className="mt-2 flex gap-2">
          {(question.payload.options ?? ["Ano", "Ne"]).map((opt) => (
            <ChatButton key={opt} onClick={() => onAnswer(opt)}>
              {opt}
            </ChatButton>
          ))}
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAnswer(text);
            }}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12.5px] text-[var(--color-text)]"
            placeholder="Odpověď…"
          />
          <ChatButton onClick={() => onAnswer(text)}>Odeslat</ChatButton>
        </div>
      )}
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
