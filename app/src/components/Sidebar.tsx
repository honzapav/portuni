import { Search, Sun, Moon, X, Users, Settings, Waypoints } from "lucide-react";
import type { GraphPayload, GraphNode } from "../types";
import { RELATION_TYPES } from "../types";
import { TYPE_ORDER } from "../lib/colors";
import type { Theme } from "../lib/theme";

export type AppView = "graph" | "actors";

type Props = {
  graph: GraphPayload;
  query: string;
  onQuery: (q: string) => void;
  disabledRelations: Set<string>;
  onToggleRelation: (relation: string) => void;
  disabledOrgs: Set<string>;
  onToggleOrg: (id: string) => void;
  disabledTypes: Set<string>;
  onToggleType: (type: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  theme: Theme;
  onThemeToggle: () => void;
  view: AppView;
  onViewChange: (view: AppView) => void;
  onOpenSettings: () => void;
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
  disabledOrgs,
  onToggleOrg,
  disabledTypes,
  onToggleType,
  selectedId,
  onSelect,
  theme,
  onThemeToggle,
  view,
  onViewChange,
  onOpenSettings,
}: Props) {
  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-5 py-5">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-md"
          style={{ background: "var(--color-accent-soft)" }}
        >
          <Waypoints size={18} className="text-[var(--color-accent)]" />
        </div>
        <div className="flex-1">
          <div className="text-[18px] font-semibold tracking-tight text-[var(--color-text)]">
            Portuni
          </div>
        </div>
        <button
          onClick={onOpenSettings}
          title="Nastavení"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          <Settings size={13} />
        </button>
        <button
          onClick={onThemeToggle}
          title={theme === "dark" ? "Přepnout na světlý režim" : "Přepnout na tmavý režim"}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
        </button>
      </div>

      {/* View toggle */}
      <div className="px-4 pt-4">
        <div className="flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          <ViewToggleButton
            label="Graf"
            icon={<Waypoints size={12} />}
            active={view === "graph"}
            onClick={() => onViewChange("graph")}
          />
          <ViewToggleButton
            label="Aktéři"
            icon={<Users size={12} />}
            active={view === "actors"}
            onClick={() => onViewChange("actors")}
          />
        </div>
      </div>

      {view === "actors" && (
        <div className="flex-1 px-5 py-5 text-[13px] leading-relaxed text-[var(--color-text-dim)]">
          Správa aktérů napříč organizacemi. Přidávejte, upravujte a mažte
          lidi i automatizace, které jsou přiřazovány úlohám.
        </div>
      )}

      {view === "graph" && (
        <GraphSidebarContent
          graph={graph}
          query={query}
          onQuery={onQuery}
          disabledRelations={disabledRelations}
          onToggleRelation={onToggleRelation}
          disabledOrgs={disabledOrgs}
          onToggleOrg={onToggleOrg}
          disabledTypes={disabledTypes}
          onToggleType={onToggleType}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}

      <div className="border-t border-[var(--color-border)] px-5 py-3 text-[11px] text-[var(--color-text-dim)]">
        {view === "graph"
          ? "Kliknutím na uzel otevřete detail. Tažením posunete pohled, kolečkem přibližujete."
          : "Klikněte na aktéra v tabulce pro úpravu."}
      </div>
    </aside>
  );
}

function ViewToggleButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-[13px] transition-colors ${
        active
          ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
          : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function GraphSidebarContent({
  graph,
  query,
  onQuery,
  disabledRelations,
  onToggleRelation,
  disabledOrgs,
  onToggleOrg,
  disabledTypes,
  onToggleType,
  selectedId,
  onSelect,
}: {
  graph: GraphPayload;
  query: string;
  onQuery: (q: string) => void;
  disabledRelations: Set<string>;
  onToggleRelation: (relation: string) => void;
  disabledOrgs: Set<string>;
  onToggleOrg: (id: string) => void;
  disabledTypes: Set<string>;
  onToggleType: (type: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
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
    <>
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
            placeholder="Hledat uzly..."
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-8 pr-8 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] transition-colors focus:border-[var(--color-accent-dim)]"
          />
          {query.length > 0 && (
            <button
              onClick={() => onQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Search results (only when querying) */}
      {q.length > 0 && (
        <div className="border-b border-[var(--color-border)] px-2 py-2">
          <div className="scroll-thin max-h-[280px] overflow-y-auto">
            {matches.length === 0 ? (
              <div className="px-3 py-4 text-center text-[13px] text-[var(--color-text-dim)]">
                Žádné výsledky
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
          <Section title="Organizace">
            <div className="space-y-1.5">
              {graph.nodes
                .filter((n) => n.type === "organization")
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((org) => {
                  const enabled = !disabledOrgs.has(org.id);
                  const childCount = graph.nodes.filter(
                    (n) =>
                      n.type !== "organization" &&
                      graph.edges.some(
                        (e) =>
                          e.source_id === n.id &&
                          e.target_id === org.id &&
                          e.relation === "belongs_to",
                      ),
                  ).length;
                  return (
                    <FilterRow
                      key={org.id}
                      enabled={enabled}
                      onClick={() => onToggleOrg(org.id)}
                      label={org.name}
                      count={childCount}
                    />
                  );
                })}
            </div>
          </Section>

          <Section title="Typy vazeb">
            <div className="space-y-1.5">
              {RELATION_TYPES.map((r) => {
                const enabled = !disabledRelations.has(r);
                return (
                  <FilterRow
                    key={r}
                    enabled={enabled}
                    onClick={() => onToggleRelation(r)}
                    label={r}
                  />
                );
              })}
            </div>
          </Section>

          <Section title="Typy uzlů">
            <div className="space-y-1.5">
              {orderedTypes.map((type) => {
                const count = typeCounts.get(type) ?? 0;
                const enabled = !disabledTypes.has(type);
                return (
                  <FilterRow
                    key={type}
                    enabled={enabled}
                    onClick={() => onToggleType(type)}
                    label={type}
                    count={count}
                    dotColor={nodeTypeVar(type)}
                    dotGlow={nodeTypeGlow(type, 0.4)}
                  />
                );
              })}
            </div>
          </Section>

          <Section title="Přehled">
            <div className="space-y-1.5 px-2">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-[var(--color-text-muted)]">Uzly</span>
                <span className="font-mono text-[12px] text-[var(--color-text)]">
                  {graph.nodes.length}
                </span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-[var(--color-text-muted)]">Vazby</span>
                <span className="font-mono text-[12px] text-[var(--color-text)]">
                  {graph.edges.length}
                </span>
              </div>
            </div>
          </Section>
        </div>
      )}
    </>
  );
}

// Unified filter row. Used for all three filter groups (orgs, relations,
// types) so every toggle in the sidebar shares the same shape and sizing.
function FilterRow({
  enabled,
  onClick,
  label,
  count,
  dotColor,
  dotGlow,
}: {
  enabled: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  dotColor?: string;
  dotGlow?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-2.5 rounded px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface)]"
    >
      {dotColor ? (
        <span
          className={`h-2.5 w-2.5 rounded-full transition-opacity ${enabled ? "" : "opacity-30"}`}
          style={{
            background: dotColor,
            boxShadow: dotGlow ? `0 0 10px ${dotGlow}` : undefined,
          }}
        />
      ) : (
        <div
          className={`h-3 w-3 rounded-sm border transition-all ${
            enabled
              ? "border-[var(--color-accent)] bg-[var(--color-accent-dim)]"
              : "border-[var(--color-border-strong)] bg-transparent"
          }`}
        />
      )}
      <span
        className={`flex-1 text-[13px] transition-colors ${
          enabled
            ? "text-[var(--color-text)]"
            : "text-[var(--color-text-dim)] line-through"
        }`}
      >
        {label}
      </span>
      {count !== undefined && (
        <span className="font-mono text-[12px] text-[var(--color-text-dim)]">
          {count}
        </span>
      )}
    </button>
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
      <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--color-text-dim)]">
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
        <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
          {node.name}
        </div>
        <div className="truncate text-[11px] text-[var(--color-text-dim)]">
          {node.type}
        </div>
      </div>
    </button>
  );
}
