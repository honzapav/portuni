// Přehled (overview) tab (#196, "Přehled (overview tab)" of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md): a
// read-only, deterministically composed dashboard fetched in one round
// trip (GET /overview). Four sections -- Relace, Vyžaduje pozornost,
// Poslední aktivita, Nové nody -- each a self-contained card; clicking a
// node reference selects it in Graf, clicking a session reference opens it
// in Práce. No auto-refresh; a manual "Obnovit" button matches
// SyncOverview's pattern.

import { displayError } from "../errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Clock, MessagesSquare, RefreshCw, Sparkles } from "lucide-react";
import { capRows, overviewCounters, splitThreadsAndCli } from "../lib/overview-view";
import type {
  AccessRequest,
  OverviewAttentionNode,
  OverviewDisconnectedJump,
  OverviewEvent,
  OverviewNewNode,
  OverviewPayload,
  OverviewSessionRow,
  OverviewSessionWrite,
  OverviewSyncIssue,
} from "../types";
import { HEALTH_COLORS, LIFECYCLE_COLORS } from "../types";
import { fetchOverview } from "../api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { SessionStateMessage } from "../lib/sessions-client";
import { mergeLiveSessionStates, sessionRowChip, sortInboxSessions } from "../lib/session-views";
import { formatDateTime } from "../lib/format";
import { useLocale } from "../lib/use-locale";
import { nodeTypeLabel } from "../lib/node-type-labels";

type Props = {
  onSelectNode: (nodeId: string) => void;
  onOpenSession: (nodeId: string, sessionId: string) => void;
  // The window's live session_state map (App.tsx, from the socket): the
  // Relace card's rows take state/waiting_since from it between loads,
  // and a change in the set of live sessions reloads the whole overview
  // (a new task shows up, a closed one leaves the inbox) -- no polling.
  liveStates?: Readonly<Record<string, SessionStateMessage>>;
  // The counter strip (v2 spec, "Přehled"): the unsynced total from
  // /sync/pending, and where each counter leads -- Práce for the first two,
  // Graf for attention, the Nesynchronizováno dialog for the last.
  unsyncedCount: number;
  onOpenWorkspace: () => void;
  onOpenGraph: () => void;
  onOpenSyncOverview: () => void;
};

export default function OverviewView({
  onSelectNode,
  onOpenSession,
  liveStates,
  unsyncedCount,
  onOpenWorkspace,
  onOpenGraph,
  onOpenSyncOverview,
}: Props) {
  const { t } = useTranslation("common");
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOverview());
    } catch (e) {
      setError(displayError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const liveStamp = useMemo(
    () =>
      Object.values(liveStates ?? {})
        .map((s) => `${s.session_id}:${s.state}`)
        .sort()
        .join(","),
    [liveStates],
  );
  useEffect(() => {
    void load();
  }, [load, liveStamp]);

  if (loading && !data) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-[14px] text-[var(--color-text-dim)]">
        {t(($) => $.overview.loading)}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-[18px] font-semibold text-[var(--color-text)]">{t(($) => $.overview.title)}</h1>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="text-muted-foreground">
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t(($) => $.overview.refresh)}
          </Button>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {data && (
          <CounterStrip
            counters={overviewCounters(
              liveStates ? mergeLiveSessionStates(data.sessions.running, liveStates) : data.sessions.running,
              liveStates ? mergeLiveSessionStates(data.sessions.suspended, liveStates) : data.sessions.suspended,
              data.attention.nodes.length + data.attention.access_requests.length + data.attention.sync_issues.length,
              unsyncedCount,
            )}
            onOpenWorkspace={onOpenWorkspace}
            onOpenGraph={onOpenGraph}
            onOpenSyncOverview={onOpenSyncOverview}
          />
        )}

        {data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SessionsCard
              running={liveStates ? mergeLiveSessionStates(data.sessions.running, liveStates) : data.sessions.running}
              suspended={liveStates ? mergeLiveSessionStates(data.sessions.suspended, liveStates) : data.sessions.suspended}
              disconnectedJumps={data.sessions.disconnected_jumps}
              onOpenSession={onOpenSession}
              onSelectNode={onSelectNode}
            />
            <AttentionCard
              nodes={data.attention.nodes}
              accessRequests={data.attention.access_requests}
              syncIssues={data.attention.sync_issues}
              onSelectNode={onSelectNode}
            />
            <ActivityCard
              events={data.activity.events}
              sessionWrites={data.activity.session_writes}
              onSelectNode={onSelectNode}
            />
            <NewNodesCard nodes={data.new_nodes} onSelectNode={onSelectNode} />
          </div>
        )}
      </div>
    </div>
  );
}

function Card({
  title,
  icon,
  children,
  footer,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]">
        {icon}
        {title}
      </div>
      {children}
      {footer && <div className="mt-3 border-t border-[var(--color-border)] pt-2">{footer}</div>}
    </section>
  );
}

// The strip on top (shadcn's dashboard block): a number with its label
// under it, the whole card a button to the place it counts.
function CounterStrip({
  counters,
  onOpenWorkspace,
  onOpenGraph,
  onOpenSyncOverview,
}: {
  counters: { waiting: number; running: number; attention: number; unsynced: number };
  onOpenWorkspace: () => void;
  onOpenGraph: () => void;
  onOpenSyncOverview: () => void;
}) {
  const { t } = useTranslation("common");
  // `id` is the React key: a label is translated text and never a key.
  const items: { id: keyof typeof counters; label: string; value: number; onClick: () => void; tone?: string }[] = [
    {
      id: "waiting",
      label: t(($) => $.overview.counter.waiting),
      value: counters.waiting,
      onClick: onOpenWorkspace,
      tone: "var(--color-node-process)",
    },
    {
      id: "running",
      label: t(($) => $.overview.counter.running),
      value: counters.running,
      onClick: onOpenWorkspace,
      tone: "var(--color-status-active)",
    },
    { id: "attention", label: t(($) => $.overview.counter.attention), value: counters.attention, onClick: onOpenGraph },
    { id: "unsynced", label: t(($) => $.overview.counter.unsynced), value: counters.unsynced, onClick: onOpenSyncOverview },
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={item.onClick}
          className="flex flex-col items-start gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-2)]"
        >
          <span
            className="text-[24px] font-semibold leading-none tabular-nums text-[var(--color-text)]"
            style={item.value > 0 && item.tone ? { color: item.tone } : undefined}
          >
            {item.value}
          </span>
          <span className="text-[12px] text-[var(--color-text-dim)]">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

// "Zobrazit všech N" under a capped list; expands the card in place.
function ShowAll({ hidden, total, onClick }: { hidden: number; total: number; onClick: () => void }) {
  const { t } = useTranslation("common");
  if (hidden <= 0) return null;
  return (
    <Button variant="link" size="xs" className="h-auto p-0 text-[12px]" onClick={onClick}>
      {t(($) => $.overview.show_all, { count: total })}
    </Button>
  );
}

function StateChip({ label, color, pulsing }: { label: string; color: string; pulsing: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px]" style={{ color }}>
      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${pulsing ? "animate-pulse" : ""}`} style={{ background: color }} />
      {label}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[12.5px] text-[var(--color-text-dim)]">{children}</div>;
}

function Row({
  onClick,
  children,
}: {
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`flex min-h-9 w-full flex-col justify-center gap-0.5 rounded-md px-2 py-1 text-left text-[12.5px] ${
        onClick ? "transition-colors hover:bg-[var(--color-bg)]" : ""
      }`}
    >
      {children}
    </Comp>
  );
}

function SessionsCard({
  running,
  suspended,
  disconnectedJumps,
  onOpenSession,
  onSelectNode,
}: {
  running: OverviewSessionRow[];
  suspended: OverviewSessionRow[];
  disconnectedJumps: OverviewDisconnectedJump[];
  onOpenSession: (nodeId: string, sessionId: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const { t } = useTranslation("common");
  const locale = useLocale();
  // The inbox: Čeká na mě first, then Běží, then Pozastaveno. Since #457
  // GET /overview carries the caller's own threads only, so there is nothing
  // to filter here. Threads only (v2 rule 7): a hand-opened CLI session is a
  // count in the footer, the node's Relace tab keeps it.
  const [expanded, setExpanded] = useState(false);
  const { threads, cli } = splitThreadsAndCli(sortInboxSessions(running, suspended));
  const { shown, hidden } = capRows(threads, expanded);
  const cliLine =
    cli.total > 0 ? t(($) => $.overview.threads.cli, { count: cli.total, running: cli.running }) : null;
  return (
    <Card
      title={t(($) => $.overview.threads.title)}
      icon={<MessagesSquare size={14} />}
      footer={
        hidden > 0 || cliLine ? (
          <div className="flex items-center justify-between gap-3 text-[12px] text-[var(--color-text-dim)]">
            <ShowAll hidden={hidden} total={threads.length} onClick={() => setExpanded(true)} />
            {cliLine && <span className="ml-auto">{cliLine}</span>}
          </div>
        ) : undefined
      }
    >
      {threads.length === 0 ? (
        <Empty>{t(($) => $.overview.threads.empty)}</Empty>
      ) : (
        <div className="space-y-0.5">
          {shown.map((s) => {
            const chip = sessionRowChip(s.state, s.waiting_since, t);
            return (
              <Row key={s.id} onClick={s.node_id ? () => onOpenSession(s.node_id!, s.id) : undefined}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] text-[var(--color-text)]">{s.name}</span>
                  <StateChip label={chip.label} color={chip.color} pulsing={chip.pulsing} />
                </div>
                <div className="text-[11.5px] text-[var(--color-text-dim)]">
                  {s.node_name ?? t(($) => $.overview.threads.no_node)} · {formatDateTime(locale, s.last_active_at)}
                </div>
              </Row>
            );
          })}
        </div>
      )}

      {disconnectedJumps.length > 0 && (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <div className="mb-1.5 text-[11.5px] font-medium text-[var(--color-text-dim)]">
            {t(($) => $.overview.threads.review_queue)}
          </div>
          <div className="space-y-0.5">
            {disconnectedJumps.map((j) => (
              <Row key={`${j.session_id}-${j.node_id}`} onClick={() => onSelectNode(j.node_id)}>
                <div className="text-[var(--color-text)]">
                  {j.session_name} → {j.node_name}
                </div>
                <div className="pl-0 text-[11px] text-[var(--color-text-dim)]">
                  {j.reason ?? t(($) => $.overview.threads.no_reason)} · {formatDateTime(locale, j.added_at)}
                </div>
              </Row>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function AttentionCard({
  nodes,
  accessRequests,
  syncIssues,
  onSelectNode,
}: {
  nodes: OverviewAttentionNode[];
  accessRequests: AccessRequest[];
  syncIssues: OverviewSyncIssue[];
  onSelectNode: (nodeId: string) => void;
}) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  type Item = { kind: "node"; data: OverviewAttentionNode } | { kind: "access"; data: AccessRequest } | { kind: "sync"; data: OverviewSyncIssue };
  const all: Item[] = [
    ...nodes.map((data): Item => ({ kind: "node", data })),
    ...accessRequests.map((data): Item => ({ kind: "access", data })),
    ...syncIssues.map((data): Item => ({ kind: "sync", data })),
  ];
  const { shown, hidden } = capRows(all, expanded);
  const shownNodes = shown.filter((i): i is Extract<Item, { kind: "node" }> => i.kind === "node").map((i) => i.data);
  const shownAccess = shown.filter((i): i is Extract<Item, { kind: "access" }> => i.kind === "access").map((i) => i.data);
  const shownSync = shown.filter((i): i is Extract<Item, { kind: "sync" }> => i.kind === "sync").map((i) => i.data);
  return (
    <Card
      title={t(($) => $.overview.attention.title)}
      icon={<AlertTriangle size={14} />}
      footer={hidden > 0 ? <ShowAll hidden={hidden} total={all.length} onClick={() => setExpanded(true)} /> : undefined}
    >
      {all.length === 0 ? (
        <Empty>{t(($) => $.overview.attention.empty)}</Empty>
      ) : (
        <div className="space-y-0.5">
          {shownNodes.map((n) => {
            const state = n.type === "project" ? n.health : (n.lifecycle_state ?? "");
            const color = n.type === "project" ? HEALTH_COLORS[n.health] : (LIFECYCLE_COLORS[state] ?? "gray");
            return (
              <Row key={n.id} onClick={() => onSelectNode(n.id)}>
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[var(--color-text)]">{n.name}</span>
                  <Badge className={`lifecycle-badge lifecycle-${color}`}>{state}</Badge>
                </div>
                <div className="text-[11px] text-[var(--color-text-dim)]">{nodeTypeLabel(n.type, t)}</div>
              </Row>
            );
          })}
          {shownAccess.map((r) => (
            <Row key={r.id} onClick={() => onSelectNode(r.node_id)}>
              <div className="text-[var(--color-text)]">
                {t(($) => $.overview.attention.access_request, { userName: r.user_name })}
              </div>
              <div className="text-[11px] text-[var(--color-text-dim)]">{r.node_name}</div>
            </Row>
          ))}
          {shownSync.map((s) => (
            <Row key={s.id} onClick={() => onSelectNode(s.node_id)}>
              <div className="text-[var(--color-text)]">
                {t(($) => $.overview.attention.sync_issue, { nodeName: s.node_name })}
              </div>
              <div className="truncate text-[11px] text-[var(--color-text-dim)]">{s.last_error}</div>
            </Row>
          ))}
        </div>
      )}
    </Card>
  );
}

function ActivityCard({
  events,
  sessionWrites,
  onSelectNode,
}: {
  events: OverviewEvent[];
  sessionWrites: OverviewSessionWrite[];
  onSelectNode: (nodeId: string) => void;
}) {
  const { t } = useTranslation("common");
  const locale = useLocale();
  // Merge and sort by timestamp so activity reads as one interleaved feed.
  type Item =
    | { kind: "event"; at: string; data: OverviewEvent }
    | { kind: "write"; at: string; data: OverviewSessionWrite };
  const items: Item[] = [
    ...events.map((e): Item => ({ kind: "event", at: e.created_at, data: e })),
    ...sessionWrites.map((w): Item => ({ kind: "write", at: w.added_at, data: w })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = capRows(items, expanded);

  return (
    <Card
      title={t(($) => $.overview.activity.title)}
      icon={<Clock size={14} />}
      footer={hidden > 0 ? <ShowAll hidden={hidden} total={items.length} onClick={() => setExpanded(true)} /> : undefined}
    >
      {items.length === 0 ? (
        <Empty>{t(($) => $.overview.activity.empty)}</Empty>
      ) : (
        <div className="space-y-0.5">
          {shown.map((item) =>
            item.kind === "event" ? (
              <Row key={`e-${item.data.id}`} onClick={() => onSelectNode(item.data.node_id)}>
                <div className="truncate text-[var(--color-text)]">{item.data.content}</div>
                <div className="text-[11px] text-[var(--color-text-dim)]">
                  {item.data.node_name} · {formatDateTime(locale, item.data.created_at)}
                </div>
              </Row>
            ) : (
              <Row key={`w-${item.data.session_id}-${item.data.node_id}`} onClick={() => onSelectNode(item.data.node_id)}>
                <div className="text-[var(--color-text)]">
                  {t(($) => $.overview.activity.session_write, {
                    sessionName: item.data.session_name,
                    nodeName: item.data.node_name,
                  })}
                </div>
                <div className="text-[11px] text-[var(--color-text-dim)]">{formatDateTime(locale, item.data.added_at)}</div>
              </Row>
            ),
          )}
        </div>
      )}
    </Card>
  );
}

function NewNodesCard({
  nodes,
  onSelectNode,
}: {
  nodes: OverviewNewNode[];
  onSelectNode: (nodeId: string) => void;
}) {
  const { t } = useTranslation("common");
  const locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = capRows(nodes, expanded);
  return (
    <Card
      title={t(($) => $.overview.new_nodes.title)}
      icon={<Sparkles size={14} />}
      footer={hidden > 0 ? <ShowAll hidden={hidden} total={nodes.length} onClick={() => setExpanded(true)} /> : undefined}
    >
      {nodes.length === 0 ? (
        <Empty>{t(($) => $.overview.new_nodes.empty)}</Empty>
      ) : (
        <div className="space-y-0.5">
          {shown.map((n) => (
            <Row key={n.id} onClick={() => onSelectNode(n.id)}>
              <div className="truncate text-[var(--color-text)]">{n.name}</div>
              <div className="text-[11px] text-[var(--color-text-dim)]">
                {nodeTypeLabel(n.type, t)} · {n.created_by_name} · {formatDateTime(locale, n.created_at)}
              </div>
            </Row>
          ))}
        </div>
      )}
    </Card>
  );
}
