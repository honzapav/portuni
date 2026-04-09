import { Search, Network, Sun, Moon } from "lucide-react";
import type { GraphPayload, GraphNode } from "../types";
import { RELATION_TYPES } from "../types";
import { TYPE_ORDER } from "../lib/colors";
import type { Theme } from "../lib/theme";

type Props = {
  graph: GraphPayload;
  query: string;
  onQuery: (q: string) => void;
  disabledRelations: Set<string>;
  onToggleRelation: (relation: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  theme: Theme;
  onThemeToggle: () => void;
};

function nodeTypeVar(type: string): string {
  const known = [
    "organization",
    "project",
    "process",
    "area",
    "principle",
  ];
  if (known.includes(type)) return `var(--color-node-${type})`;
  return "var(--color-node-default)";
}

function nodeTypeGlow(type: string, alpha: number = 0.4): string {
  return `color-mix(in srgb, ${nodeTypeVar(type)} ${alpha * 100}%, transparent)`;
}

export default function Sidebar({
  graph,
  query,
  onQuery,
  disabledRelations,
  onToggleRelation,
  selectedId,
  onSelect,
  theme,
  onThemeToggle,
}: Props) {
  const q = query.trim().toLowerCase();
  const matches = q
    ? graph.nodes
        .filter((n) => {
          if (n.type === "organization") return false;
          return (
            n.name.toLowerCase().includes(q) ||
            (n.description ?? "").toLowerCase().includes(q) ||
            n.type.toLowerCase().includes(q)
          );
        })
        .slice(0, 60)
    : [];

  const typeCounts = new Map<string, number>();
  for (const n of graph.nodes) {
    typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
  }

  const orderedTypes = [
    ...TYPE_ORDER.filter((t) => typeCounts.has(t)),
    ...Array.from(typeCounts.keys()).filter((t) => !TYPE_ORDER.includes(t)),
  ];

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-5">
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--color-accent-soft)" }}
        >
          <Network size={15} className="text-[var(--color-accent)]" />
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-semibold tracking-tight text-[var(--color-text)]">
            Portuni
          </div>
          <div className="text-[10px] uppercase tracking-widest text-[var(--color-text-dim)]">
            Knowledge graph
          </div>
        </div>
        <button
          onClick={onThemeToggle}
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
        </button>
      </div>

      {/* Search */}
      <div className="px-4 pt-4">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
          />
          <input
            name="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-8 pr-3 text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] transition-colors focus:border-[var(--color-accent-dim)]"
          />
        </div>
      </div>

      {/* Search results (only when querying) */}
      {q.length > 0 && (
        <div className="border-b border-[var(--color-border)] px-2 py-2">
          <div className="scroll-thin max-h-[280px] overflow-y-auto">
            {matches.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-[var(--color-text-dim)]">
                No matches
              </div>
            ) : (
              matches.map((n) => (
                <SearchHit
                  key={n.id}
                  node={n}
                  active={selectedId === n.id}
                  onClick={() => onSelect(n.id)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      {q.length === 0 && (
        <div className="flex-1 overflow-y-auto scroll-thin px-5 py-5">
          <Section title="Edge types">
            <div className="space-y-1.5">
              {RELATION_TYPES.map((r) => {
                const enabled = !disabledRelations.has(r);
                return (
                  <button
                    key={r}
                    onClick={() => onToggleRelation(r)}
                    className="group flex w-full items-center gap-2.5 rounded px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface)]"
                  >
                    <div
                      className={`h-3 w-3 rounded-sm border transition-all ${
                        enabled
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-dim)]"
                          : "border-[var(--color-border-strong)] bg-transparent"
                      }`}
                    />
                    <span
                      className={`font-mono text-[11px] transition-colors ${
                        enabled
                          ? "text-[var(--color-text)]"
                          : "text-[var(--color-text-dim)] line-through"
                      }`}
                    >
                      {r}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Node types">
            <div className="space-y-1.5">
              {orderedTypes.map((type) => {
                const count = typeCounts.get(type) ?? 0;
                return (
                  <div
                    key={type}
                    className="flex items-center justify-between px-2 py-1"
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{
                          background: nodeTypeVar(type),
                          boxShadow: `0 0 10px ${nodeTypeGlow(type, 0.4)}`,
                        }}
                      />
                      <span className="text-[11.5px] text-[var(--color-text)]">
                        {type}
                      </span>
                    </div>
                    <span className="font-mono text-[10.5px] text-[var(--color-text-dim)]">
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Overview">
            <div className="space-y-1.5 px-2">
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-[var(--color-text-muted)]">Nodes</span>
                <span className="font-mono text-[var(--color-text)]">
                  {graph.nodes.length}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-[var(--color-text-muted)]">Edges</span>
                <span className="font-mono text-[var(--color-text)]">
                  {graph.edges.length}
                </span>
              </div>
            </div>
          </Section>
        </div>
      )}

      <div className="border-t border-[var(--color-border)] px-5 py-3 text-[10px] text-[var(--color-text-dim)]">
        Click any node to open detail. Drag to pan, scroll to zoom.
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-2 px-2 text-[9.5px] font-semibold uppercase tracking-widest text-[var(--color-text-dim)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function SearchHit({
  node,
  active,
  onClick,
}: {
  node: GraphNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded px-3 py-2 text-left transition-colors ${
        active
          ? "bg-[var(--color-surface-2)]"
          : "hover:bg-[var(--color-surface)]"
      }`}
    >
      <span
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{
          background: nodeTypeVar(node.type),
          boxShadow: `0 0 8px ${nodeTypeGlow(node.type, 0.4)}`,
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
          {node.name}
        </div>
        <div className="truncate text-[10px] text-[var(--color-text-dim)]">
          {node.type}
        </div>
      </div>
    </button>
  );
}
