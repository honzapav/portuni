// Přehled (overview) tab (#196, "Přehled (overview tab)" of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md): a
// read-only, deterministically composed dashboard fetched in one round
// trip (GET /overview). Four sections -- Relace, Vyžaduje pozornost,
// Poslední aktivita, Nové nody -- each a self-contained card; clicking a
// node reference selects it in Graf, clicking a session reference opens it
// in Práce. No auto-refresh; a manual "Obnovit" button matches
// SyncOverview's pattern.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, RefreshCw, Sparkles, Terminal } from "lucide-react";
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
import { STATE_COLOR, STATE_LABEL, fmtDateTime } from "./DetailPane.sessions";

const TYPE_LABELS: Record<string, string> = {
  organization: "Organizace",
  project: "Projekt",
  process: "Proces",
  area: "Oblast",
  principle: "Princip",
};

type Props = {
  onSelectNode: (nodeId: string) => void;
  onOpenSession: (nodeId: string, sessionId: string) => void;
};

export default function OverviewView({ onSelectNode, onOpenSession }: Props) {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOverview());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-[14px] text-[var(--color-text-dim)]">
        Načítám přehled...
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-[18px] font-semibold text-[var(--color-text)]">Přehled</h1>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[12px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
            Obnovit
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[13px]" style={{ color: "var(--color-danger)" }}>
            {error}
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <SessionsCard
              running={data.sessions.running}
              suspended={data.sessions.suspended}
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
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]">
        {icon}
        {title}
      </div>
      {children}
    </section>
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
      className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-[12.5px] ${
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
  const sessions = [...running, ...suspended];
  return (
    <Card title="Relace" icon={<Terminal size={14} />}>
      {sessions.length === 0 ? (
        <Empty>Žádné běžící ani pozastavené relace.</Empty>
      ) : (
        <div className="space-y-0.5">
          {sessions.map((s) => (
            <Row key={s.id} onClick={s.node_id ? () => onOpenSession(s.node_id!, s.id) : undefined}>
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: STATE_COLOR[s.state] }}
                  title={STATE_LABEL[s.state]}
                />
                <span className="truncate text-[var(--color-text)]">{s.name}</span>
              </div>
              <div className="pl-3 text-[11px] text-[var(--color-text-dim)]">
                {s.node_name ?? "Chat"} · {fmtDateTime(s.last_active_at)}
              </div>
            </Row>
          ))}
        </div>
      )}

      {disconnectedJumps.length > 0 && (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <div className="mb-1.5 text-[11.5px] font-medium text-[var(--color-text-dim)]">
            Fronta ke kontrole (nesouvislé přeskoky)
          </div>
          <div className="space-y-0.5">
            {disconnectedJumps.map((j) => (
              <Row key={`${j.session_id}-${j.node_id}`} onClick={() => onSelectNode(j.node_id)}>
                <div className="text-[var(--color-text)]">
                  {j.session_name} → {j.node_name}
                </div>
                <div className="pl-0 text-[11px] text-[var(--color-text-dim)]">
                  {j.reason ?? "bez uvedeného důvodu"} · {fmtDateTime(j.added_at)}
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
  const empty = nodes.length === 0 && accessRequests.length === 0 && syncIssues.length === 0;
  return (
    <Card title="Vyžaduje pozornost" icon={<AlertTriangle size={14} />}>
      {empty ? (
        <Empty>Nic nevyžaduje pozornost.</Empty>
      ) : (
        <div className="space-y-0.5">
          {nodes.map((n) => {
            const state = n.type === "project" ? n.health : (n.lifecycle_state ?? "");
            const color = n.type === "project" ? HEALTH_COLORS[n.health] : (LIFECYCLE_COLORS[state] ?? "gray");
            return (
              <Row key={n.id} onClick={() => onSelectNode(n.id)}>
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[var(--color-text)]">{n.name}</span>
                  <span className={`lifecycle-badge lifecycle-${color}`}>{state}</span>
                </div>
                <div className="text-[11px] text-[var(--color-text-dim)]">{TYPE_LABELS[n.type] ?? n.type}</div>
              </Row>
            );
          })}
          {accessRequests.map((r) => (
            <Row key={r.id} onClick={() => onSelectNode(r.node_id)}>
              <div className="text-[var(--color-text)]">Žádost o přístup: {r.user_name}</div>
              <div className="text-[11px] text-[var(--color-text-dim)]">{r.node_name}</div>
            </Row>
          ))}
          {syncIssues.map((s) => (
            <Row key={s.id} onClick={() => onSelectNode(s.node_id)}>
              <div className="text-[var(--color-text)]">Problém se synchronizací: {s.node_name}</div>
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
  // Merge and sort by timestamp so activity reads as one interleaved feed.
  type Item =
    | { kind: "event"; at: string; data: OverviewEvent }
    | { kind: "write"; at: string; data: OverviewSessionWrite };
  const items: Item[] = [
    ...events.map((e): Item => ({ kind: "event", at: e.created_at, data: e })),
    ...sessionWrites.map((w): Item => ({ kind: "write", at: w.added_at, data: w })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <Card title="Poslední aktivita" icon={<Clock size={14} />}>
      {items.length === 0 ? (
        <Empty>Zatím žádná aktivita.</Empty>
      ) : (
        <div className="space-y-0.5">
          {items.slice(0, 30).map((item) =>
            item.kind === "event" ? (
              <Row key={`e-${item.data.id}`} onClick={() => onSelectNode(item.data.node_id)}>
                <div className="truncate text-[var(--color-text)]">{item.data.content}</div>
                <div className="text-[11px] text-[var(--color-text-dim)]">
                  {item.data.node_name} · {fmtDateTime(item.data.created_at)}
                </div>
              </Row>
            ) : (
              <Row key={`w-${item.data.session_id}-${item.data.node_id}`} onClick={() => onSelectNode(item.data.node_id)}>
                <div className="text-[var(--color-text)]">
                  {item.data.session_name} zapsala do {item.data.node_name}
                </div>
                <div className="text-[11px] text-[var(--color-text-dim)]">{fmtDateTime(item.data.added_at)}</div>
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
  return (
    <Card title="Nové nody" icon={<Sparkles size={14} />}>
      {nodes.length === 0 ? (
        <Empty>Žádné nedávno vytvořené nody.</Empty>
      ) : (
        <div className="space-y-0.5">
          {nodes.map((n) => (
            <Row key={n.id} onClick={() => onSelectNode(n.id)}>
              <div className="truncate text-[var(--color-text)]">{n.name}</div>
              <div className="text-[11px] text-[var(--color-text-dim)]">
                {TYPE_LABELS[n.type] ?? n.type} · {n.created_by_name} · {fmtDateTime(n.created_at)}
              </div>
            </Row>
          ))}
        </div>
      )}
    </Card>
  );
}
