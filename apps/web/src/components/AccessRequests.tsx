// Access-request UI for access_mode='request' nodes (spec: "Rezim omezeni"
// in docs/archive/specs/2026-07-04-node-sharing-design.md). Three pieces:
//   RequestAccessControl  -- the "Request access" affordance on a locked
//                            chip in Propojení (non-member side).
//   AccessRequestList     -- pending requests with Approve / Deny,
//                            shared by the node's sharing section and the
//                            Settings tab (manager side).
//   SettingsAccessRequestsPanel -- Settings > Access requests: the
//                            caller's whole queue across visible nodes.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "../lib/format";
import { useLocale } from "../lib/use-locale";
import { useListLoad } from "../lib/use-list-load";

// --- Non-member side -------------------------------------------------------

type RequestState =
  | { kind: "idle" }
  | { kind: "form" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "visible" }
  | { kind: "error"; reason: string };

// Tiny inline form on a locked chip: click "Request access", optionally
// type a message, send. "Request sent" persists for the chip's lifetime
// (the chip remounts with the node detail, and the server answers 409
// already_pending on a repeat, which lands in the same state).
export function RequestAccessControl({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation("settings");
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
      setState({ kind: "error", reason: t(($) => $.access_requests.request.send_failed) });
    }
  };

  if (state.kind === "sent") {
    return (
      <span className="shrink-0 text-[12px] text-[var(--color-text-dim)]">{t(($) => $.access_requests.request.sent)}</span>
    );
  }
  if (state.kind === "visible") {
    return (
      <span className="shrink-0 text-[12px] text-[var(--color-text-dim)]">
        {t(($) => $.access_requests.request.already_visible)}
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
        <Input
          ref={inputRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
            if (e.key === "Escape") setState({ kind: "idle" });
          }}
          disabled={busy}
          placeholder={t(($) => $.access_requests.request.message_placeholder)}
          maxLength={1000}
          className="w-[160px]"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => void send()}
          disabled={busy}
          title={t(($) => $.access_requests.request.send_title)}
          className="text-[var(--color-accent)]"
        >
          <Check />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setState({ kind: "idle" })}
          disabled={busy}
          title={t(($) => $.access_requests.request.cancel_title)}
          className="text-muted-foreground"
        >
          <X />
        </Button>
        {state.kind === "error" && (
          <span className="text-[11px]" style={{ color: "var(--color-danger)" }}>
            {state.reason}
          </span>
        )}
      </span>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={(e) => {
        e.stopPropagation();
        setState({ kind: "form" });
      }}
      className="shrink-0 text-muted-foreground"
    >
      <KeyRound />
      {t(($) => $.access_requests.request.button)}
    </Button>
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
  const locale = useLocale();
  const { t } = useTranslation("settings");
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
                <span className="text-[11.5px] text-[var(--color-text-dim)]">{formatDateTime(locale, r.created_at)}</span>
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
                  {t(($) => $.access_requests.list.resolve_failed)}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="sm" onClick={() => void resolve(r, "approve")} disabled={busy}>
                {busy ? t(($) => $.access_requests.list.approving) : t(($) => $.access_requests.list.approve)}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void resolve(r, "deny")}
                disabled={busy}
                className="text-muted-foreground hover:text-[var(--color-danger)]"
              >
                {t(($) => $.access_requests.list.deny)}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const fetchPendingRequests = async () => ({
  requests: await fetchAccessRequests("pending"),
});

// Settings > Access requests. Visible gating (manage/admin) happens in
// SettingsPage.tsx; the list itself is already filtered server-side to
// nodes the caller can see.
export default function SettingsAccessRequestsPanel({
  onChanged,
}: {
  // Fired after every approve/deny so the tab badge can refresh.
  onChanged?: () => void;
}) {
  const { t } = useTranslation("settings");
  const { state, setState, load } = useListLoad(fetchPendingRequests);

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.access_requests.panel.title)}
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {t(($) => $.access_requests.panel.description)}
      </p>

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">{t(($) => $.access_requests.panel.loading)}</div>
      )}

      {state.kind === "error" && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          <span className="min-w-0 break-words">{state.reason}</span>
          <Button
            variant="link"
            size="sm"
            onClick={() => void load()}
            className="shrink-0 text-red-400 hover:text-red-200"
          >
            {t(($) => $.access_requests.panel.retry)}
          </Button>
        </div>
      )}

      {state.kind === "ok" && state.requests.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.access_requests.panel.empty)}
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
