// Access-request UI for access_mode='request' nodes (spec: "Rezim omezeni"
// in docs/archive/specs/2026-07-04-node-sharing-design.md). Three pieces:
//   RequestAccessControl  -- the "Požádat o přístup" affordance on a locked
//                            chip in Propojení (non-member side).
//   AccessRequestList     -- pending requests with Schválit / Zamítnout,
//                            shared by the node's sharing section and the
//                            Settings tab (manager side).
//   SettingsAccessRequestsPanel -- Nastavení > Žádosti o přístup: the
//                            caller's whole queue across visible nodes.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, KeyRound, X } from "lucide-react";
import type { AccessRequest } from "../types";
import {
  approveAccessRequest,
  denyAccessRequest,
  fetchAccessRequests,
  requestNodeAccess,
  AccessAlreadyVisibleError,
  AccessRequestPendingError,
} from "../api";

// --- Non-member side -------------------------------------------------------

type RequestState =
  | { kind: "idle" }
  | { kind: "form" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "visible" }
  | { kind: "error"; reason: string };

// Tiny inline form on a locked chip: click "Požádat o přístup", optionally
// type a message, send. "Žádost odeslána" persists for the chip's lifetime
// (the chip remounts with the node detail, and the server answers 409
// already_pending on a repeat, which lands in the same state).
export function RequestAccessControl({ nodeId }: { nodeId: string }) {
  const [state, setState] = useState<RequestState>({ kind: "idle" });
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.kind === "form") inputRef.current?.focus();
  }, [state.kind]);

  const send = async () => {
    setState({ kind: "sending" });
    try {
      await requestNodeAccess(nodeId, message);
      setState({ kind: "sent" });
    } catch (e) {
      if (e instanceof AccessRequestPendingError) {
        setState({ kind: "sent" });
        return;
      }
      if (e instanceof AccessAlreadyVisibleError) {
        setState({ kind: "visible" });
        return;
      }
      console.error(e);
      setState({ kind: "error", reason: "Odeslání se nepovedlo." });
    }
  };

  if (state.kind === "sent") {
    return (
      <span className="shrink-0 text-[12px] text-[var(--color-text-dim)]">Žádost odeslána</span>
    );
  }
  if (state.kind === "visible") {
    return (
      <span className="shrink-0 text-[12px] text-[var(--color-text-dim)]">
        Přístup už máš – obnov detail
      </span>
    );
  }
  if (state.kind === "form" || state.kind === "sending" || state.kind === "error") {
    const busy = state.kind === "sending";
    return (
      <span
        className="flex shrink-0 items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
            if (e.key === "Escape") setState({ kind: "idle" });
          }}
          disabled={busy}
          placeholder="Zpráva (volitelné)"
          maxLength={1000}
          className="w-[160px] rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          title="Odeslat žádost"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/15 disabled:pointer-events-none disabled:opacity-40"
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          disabled={busy}
          title="Zrušit"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] disabled:pointer-events-none"
        >
          <X size={12} />
        </button>
        {state.kind === "error" && (
          <span className="text-[11px]" style={{ color: "var(--color-danger)" }}>
            {state.reason}
          </span>
        )}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setState({ kind: "form" });
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
    >
      <KeyRound size={10} />
      Požádat o přístup
    </button>
  );
}

// --- Manager side ----------------------------------------------------------

// Rows with approve/deny. The row disappears once resolved (the parent is
// told via onResolved so it can refetch whatever depends on the grant --
// the access view, the settings badge). `showNode` adds the node column
// for the cross-node Settings queue.
export function AccessRequestList({
  requests,
  showNode,
  onResolved,
}: {
  requests: AccessRequest[];
  showNode?: boolean;
  onResolved: (request: AccessRequest, decision: "approve" | "deny") => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const resolve = async (request: AccessRequest, decision: "approve" | "deny") => {
    setBusyId(request.id);
    setErrorId(null);
    try {
      const updated =
        decision === "approve"
          ? await approveAccessRequest(request.id)
          : await denyAccessRequest(request.id);
      onResolved(updated, decision);
    } catch (e) {
      console.error(e);
      setErrorId(request.id);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-1.5">
      {requests.map((r) => {
        const busy = busyId === r.id;
        return (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          >
            {r.user_avatar_url ? (
              <img
                src={r.user_avatar_url}
                alt={r.user_name}
                className="h-6 w-6 shrink-0 rounded-full border border-[var(--color-border)]"
              />
            ) : (
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-accent-soft)] text-[10px] font-semibold text-[var(--color-accent)]">
                {initials(r.user_name)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-medium text-[var(--color-text)]">{r.user_name}</span>
                <span className="text-[12px] text-[var(--color-text-dim)]">{r.user_email}</span>
                <span className="text-[11.5px] text-[var(--color-text-dim)]">{fmtDateTime(r.created_at)}</span>
              </div>
              {showNode && (
                <div className="text-[12px] text-[var(--color-text-muted)]">
                  {r.node_name}
                  <span className="ml-1.5 font-mono text-[11px] text-[var(--color-text-dim)]">{r.node_type}</span>
                </div>
              )}
              {r.message && (
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-[var(--color-text-muted)]">
                  {r.message}
                </div>
              )}
              {errorId === r.id && (
                <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-danger)" }}>
                  Vyřízení se nepovedlo. Zkus to znovu.
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => void resolve(r, "approve")}
                disabled={busy}
                className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-2.5 py-1 text-[12.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-50"
              >
                {busy ? "…" : "Schválit"}
              </button>
              <button
                type="button"
                onClick={() => void resolve(r, "deny")}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:border-[color:var(--color-danger-border)] hover:text-[var(--color-danger)] disabled:opacity-50"
              >
                Zamítnout
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type QueueState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; requests: AccessRequest[] };

// Nastavení > Žádosti o přístup. Visible gating (manage/admin) happens in
// SettingsPage.tsx; the list itself is already filtered server-side to
// nodes the caller can see.
export default function SettingsAccessRequestsPanel({
  onChanged,
}: {
  // Fired after every approve/deny so the tab badge can refresh.
  onChanged?: () => void;
}) {
  const [state, setState] = useState<QueueState>({ kind: "loading" });
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    setState({ kind: "loading" });
    try {
      const requests = await fetchAccessRequests("pending");
      if (mountedRef.current) setState({ kind: "ok", requests });
    } catch (e) {
      if (mountedRef.current) {
        setState({ kind: "error", reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Žádosti o přístup
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        Čekající žádosti o přístup k uzlům v režimu „Na vyžádání". Schválením
        se žadatel přidá mezi příjemce sdílení uzlu (u zděděného omezení
        nadřazeného uzlu).
      </p>

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">Načítám žádosti…</div>
      )}

      {state.kind === "error" && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          <span className="min-w-0 break-words">{state.reason}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 text-red-400 hover:text-red-200"
          >
            Zkusit znovu
          </button>
        </div>
      )}

      {state.kind === "ok" && state.requests.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
          Žádné čekající žádosti.
        </div>
      )}

      {state.kind === "ok" && state.requests.length > 0 && (
        <AccessRequestList
          requests={state.requests}
          showNode
          onResolved={(resolved) => {
            setState((prev) =>
              prev.kind === "ok"
                ? { kind: "ok", requests: prev.requests.filter((r) => r.id !== resolved.id) }
                : prev,
            );
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function fmtDateTime(value: string): string {
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
