import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, Sun, Moon, X, Settings, Waypoints, Terminal } from "lucide-react";
import type { GraphPayload, GraphNode } from "../types";
import { RELATION_TYPES } from "../types";
import { TYPE_ORDER } from "../lib/colors";
import type { Theme } from "../lib/theme";
import { foldForSearch } from "../lib/normalize";
import type { TerminalSession, WorkspaceNodeRow } from "../lib/sessions";
import WorkspaceNodeList from "./WorkspaceNodeList";

export type AppView = "graph" | "workspace" | "settings";

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
  disabledStatuses: Set<string>;
  onToggleStatus: (status: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  theme: Theme;
  onThemeToggle: () => void;
  view: AppView;
  onViewChange: (view: AppView) => void;
  onOpenSettings: () => void;
  // Open the "create node" modal. Always visible at the top of the
  // graph view so it's the first action a user sees.
  onCreateNode: () => void;
  workspaceBadge?: number;
  // Workspace state -- the left column of the workspace view (the list of
  // open nodes + their terminal tabs) lives here so the layout collapses to
  // "left column / terminal / right detail" without a separate aside in
  // WorkspaceView. `workspaceRows` is the open set (open nodes ∪ nodes with
  // sessions); `workspaceSessions` carries the per-node terminals.
  workspaceRows: WorkspaceNodeRow[];
  workspaceSessions: TerminalSession[];
  workspaceSelectedNodeId: string | null;
  workspaceActiveSessionIdByNode: Record<string, string>;
  onWorkspaceSelectNode: (id: string) => void;
  onWorkspaceSelectSession: (nodeId: string, sessionId: string) => void;
  onWorkspaceCloseSession: (sessionId: string) => void;
  onWorkspaceCloseNode: (nodeId: string) => void;
  onWorkspaceNewSession: (nodeId: string) => void;
  onWorkspaceRenameSession: (sessionId: string, label: string) => void;
  // Open an EXISTING node in the workspace (no terminal required -- the
  // primary workspace action). Driven by the inline search-first picker at
  // the top of the workspace column: type a node name, click it, it opens.
  onWorkspaceOpenNode: (nodeId: string) => void;
  // Create a brand-new node and open it in the workspace. The graph view has
  // its own "Nový uzel" button; the workspace view needs its own. Secondary
  // to the search-first picker -- a quiet "Nebo vytvoř nový uzel…" link.
  onWorkspaceCreateNode: () => void;
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

// Global shortcuts (Cmd+K, Cmd+T) must not steal focus while the user is
// typing -- in a DetailPane textarea, the CodeMirror editor (contenteditable)
// or the embedded terminal (xterm's hidden textarea). Cmd+T in a shell is a
// common readline binding, so the terminal case is not theoretical.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function nodeTypeGlow(type: string, alpha: number = 0.4): string {
  return `color-mix(in srgb, ${nodeTypeVar(type)} ${alpha * 100}%, transparent)`;
}

// Memoized: the sidebar renders org/type/status filter lists plus the
// workspace node list; App re-renders frequently (sessions state, editor)
// while these props rarely change. All handlers are useCallback-stable.
export default memo(Sidebar);

function Sidebar({
  graph,
  query,
  onQuery,
  disabledRelations,
  onToggleRelation,
  disabledOrgs,
  onToggleOrg,
  disabledTypes,
  onToggleType,
  disabledStatuses,
  onToggleStatus,
  selectedId,
  onSelect,
  theme,
  onThemeToggle,
  view,
  onViewChange,
  onOpenSettings,
  onCreateNode,
  workspaceBadge,
  workspaceRows,
  workspaceSessions,
  workspaceSelectedNodeId,
  workspaceActiveSessionIdByNode,
  onWorkspaceSelectNode,
  onWorkspaceSelectSession,
  onWorkspaceCloseSession,
  onWorkspaceCloseNode,
  onWorkspaceNewSession,
  onWorkspaceRenameSession,
  onWorkspaceOpenNode,
  onWorkspaceCreateNode,
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
            label="Práce"
            icon={<Terminal size={12} />}
            active={view === "workspace"}
            onClick={() => onViewChange("workspace")}
            badge={workspaceBadge}
          />
        </div>
      </div>

      {view === "settings" && (
        <div className="flex-1 px-5 py-5 text-[13px] leading-relaxed text-[var(--color-text-dim)]">
          Konfigurace Portuni: příkaz agenta pro spouštění z uzlů a
          parametry MCP serveru pro Claude Code a Codex.
        </div>
      )}

      {view === "workspace" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspaceActions
            graph={graph}
            onOpenNode={onWorkspaceOpenNode}
            onCreateNode={onWorkspaceCreateNode}
          />
          <div className="flex-1 overflow-y-auto scroll-thin">
            <WorkspaceNodeList
              rows={workspaceRows}
              sessions={workspaceSessions}
              selectedNodeId={workspaceSelectedNodeId}
              activeSessionIdByNode={workspaceActiveSessionIdByNode}
              onSelectNode={onWorkspaceSelectNode}
              onSelectSession={onWorkspaceSelectSession}
              onCloseSession={onWorkspaceCloseSession}
              onCloseNode={onWorkspaceCloseNode}
              onNewSession={onWorkspaceNewSession}
              onRenameSession={onWorkspaceRenameSession}
            />
          </div>
        </div>
      )}

      {view === "graph" && (
        <>
          <div className="px-4 pt-4">
            <button
              type="button"
              onClick={onCreateNode}
              title="Vytvořit nový uzel (organizace, projekt, proces, oblast, princip)"
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-3 py-2 text-[13px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)]"
            >
              <Plus size={13} />
              Nový uzel
            </button>
          </div>
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
            disabledStatuses={disabledStatuses}
            onToggleStatus={onToggleStatus}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </>
      )}

      <div className="border-t border-[var(--color-border)] px-5 py-3 text-[11px] text-[var(--color-text-dim)]">
        {view === "graph"
          ? "Kliknutím na uzel otevřete detail. Tažením posunete pohled, kolečkem přibližujete."
          : view === "workspace"
            ? "Otevři víc uzlů a přeskakuj mezi nimi. Terminály zůstávají naživu při přepnutí pohledu."
            : "Změny se ukládají automaticky."}
      </div>
    </aside>
  );
}

// Search-first workspace actions. The primary action is opening an EXISTING
// node in the workspace (no terminal required): type a name, the list filters
// inline, click (or Enter) opens the node. ⌘T focuses the field from anywhere
// in the workspace. Creating a brand-new node is the secondary, quiet
// "Nebo vytvoř nový uzel…" link below.
function WorkspaceActions({
  graph,
  onOpenNode,
  onCreateNode,
}: {
  graph: GraphPayload;
  onOpenNode: (nodeId: string) => void;
  onCreateNode: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  const isMac =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);

  // ⌘T (mac) / Ctrl+T elsewhere focuses the picker. preventDefault stops the
  // browser's new-tab during Vite dev; in the Tauri shell there's no conflict.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMac]);

  const q = foldForSearch(query.trim());
  // Any node type can be opened in the workspace now, organizations included
  // (they never had a terminal but can still be opened to view/edit).
  const matches = q
    ? graph.nodes
        .filter(
          (n) =>
            foldForSearch(n.name).includes(q) ||
            foldForSearch(n.description ?? "").includes(q) ||
            foldForSearch(n.type).includes(q),
        )
        .slice(0, 30)
    : [];

  const pick = (id: string) => {
    onOpenNode(id);
    setQuery("");
    inputRef.current?.blur();
  };

  return (
    <div className="px-4 pt-4">
      <div className="relative">
        <Search
          size={13}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
        />
        <input
          ref={inputRef}
          name="workspace-open-node"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              inputRef.current?.blur();
            } else if (e.key === "Enter" && matches.length > 0) {
              pick(matches[0].id);
            }
          }}
          placeholder="Hledat a otevřít uzel…"
          className="w-full rounded-lg border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] py-2.5 pl-8 pr-12 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)]"
        />
        {query.length > 0 ? (
          <button
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)]"
            title="Vymazat"
          >
            <X size={12} />
          </button>
        ) : (
          !focused && (
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-dim)]">
              {isMac ? "⌘T" : "Ctrl T"}
            </kbd>
          )
        )}
      </div>

      {q.length > 0 && (
        <ul className="scroll-thin mt-2 max-h-[280px] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
          {matches.length === 0 ? (
            <li className="px-3 py-4 text-center text-[12.5px] text-[var(--color-text-dim)]">
              Žádné výsledky
            </li>
          ) : (
            matches.map((n) => (
              <li
                key={n.id}
                className="border-b border-[var(--color-border)] last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => pick(n.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                >
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: nodeTypeVar(n.type) }}
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{n.name}</span>
                  <span className="font-mono text-[11px] text-[var(--color-text-dim)]">
                    {n.type}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      <button
        type="button"
        onClick={onCreateNode}
        title="Vytvoří nový uzel a otevře ho v Práci"
        className="mt-2 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[12.5px] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)]"
      >
        <Plus size={13} />
        Nebo vytvoř nový uzel…
      </button>
    </div>
  );
}

function ViewToggleButton({
  label,
  icon,
  active,
  onClick,
  badge,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
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
      {badge != null && badge > 0 && (
        <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent-soft)] px-1 text-[10px] font-medium text-[var(--color-accent)]">
          {badge}
        </span>
      )}
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
  disabledStatuses,
  onToggleStatus,
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
  disabledStatuses: Set<string>;
  onToggleStatus: (status: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const q = foldForSearch(query.trim());
  const matches = q
    ? graph.nodes
        .filter((n) => {
          if (n.type === "organization") return false;
          return (
            foldForSearch(n.name).includes(q) ||
            foldForSearch(n.description ?? "").includes(q) ||
            foldForSearch(n.type).includes(q)
          );
        })
        .slice(0, 60)
    : [];

  const typeCounts = new Map<string, number>();
  for (const n of graph.nodes) {
    typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
  }

  // Child count per organization in one pass over the edges. The previous
  // inline version was O(orgs * nodes * edges) on every render.
  const orgChildCounts = useMemo(() => {
    const nonOrg = new Set(
      graph.nodes.filter((n) => n.type !== "organization").map((n) => n.id),
    );
    const counts = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.relation === "belongs_to" && nonOrg.has(e.source_id)) {
        counts.set(e.target_id, (counts.get(e.target_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [graph]);

  const orderedTypes = [
    ...TYPE_ORDER.filter((t) => typeCounts.has(t)),
    ...Array.from(typeCounts.keys()).filter((t) => !TYPE_ORDER.includes(t)),
  ];

  return (
    <>
      {/* Search */}
      <SearchBox query={query} onQuery={onQuery} />

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
                  const childCount = orgChildCounts.get(org.id) ?? 0;
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

          <Section title="Stav">
            <div className="space-y-1.5">
              {(["active", "completed", "archived"] as const).map((s) => {
                const enabled = !disabledStatuses.has(s);
                const count = graph.nodes.filter((n) => n.status === s).length;
                const label =
                  s === "active"
                    ? "Aktivní"
                    : s === "completed"
                    ? "Dokončené"
                    : "Archivované";
                return (
                  <FilterRow
                    key={s}
                    enabled={enabled}
                    onClick={() => onToggleStatus(s)}
                    label={label}
                    count={count}
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

// Search box with global Cmd+K (mac) / Ctrl+K (Windows/Linux) shortcut to
// focus, plus Esc to clear+blur. Shows a small kbd hint inside the input
// when empty and unfocused.
function SearchBox({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (q: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  const isMac =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
  const shortcut = isMac ? "⌘K" : "Ctrl K";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMac]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (query) onQuery("");
      inputRef.current?.blur();
    }
  };

  return (
    <div className="px-4 pt-4">
      <div className="relative">
        <Search
          size={13}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
        />
        <input
          ref={inputRef}
          name="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder="Hledat uzly..."
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-8 pr-12 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] transition-colors focus:border-[var(--color-accent-dim)]"
        />
        {query.length > 0 ? (
          <button
            onClick={() => onQuery("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)]"
          >
            <X size={12} />
          </button>
        ) : (
          !focused && (
            <kbd
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-dim)]"
            >
              {shortcut}
            </kbd>
          )
        )}
      </div>
    </div>
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
