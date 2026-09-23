import { memo, useEffect, useMemo, useState } from "react";
import { Plus, Search, Sun, Moon, Settings, Waypoints, MessagesSquare, LayoutDashboard } from "lucide-react";
import type { GraphPayload, SessionSummary } from "../types";
import { RELATION_TYPES } from "../types";
import { TYPE_ORDER } from "../lib/colors";
import type { Theme } from "../lib/theme";
import type { WorkspaceNodeRow } from "../lib/sessions";
import { isTauri } from "../lib/backend-url";
import { listWorkspaces, openWorkspaceWindow, type WorkspaceInfo } from "../lib/workspaces";
import { currentWorkspaceId } from "../lib/workspace-storage";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import WorkspaceNodeList from "./WorkspaceNodeList";
import NodeCommandPalette from "./NodeCommandPalette";

// Shown on disabled create-node buttons (global scope below POST /nodes).
const CREATE_NODE_DENIED_TITLE = "Vytváření uzlů vyžaduje vyšší roli";

export type AppView = "overview" | "graph" | "workspace" | "settings";

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
  // Still passed by App for the graph; the sidebar itself no longer
  // highlights a hit list (the ⌘K palette replaced it).
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
  // False when the caller's global scope is below what POST /nodes needs;
  // both create-node buttons render disabled with an explanatory title.
  canCreateNode: boolean;
  workspaceBadge?: number;
  // Workspace state -- the left column of the workspace view (the list of
  // open nodes + their live sessions) lives here so the layout collapses to
  // "left column / canvas / right detail" without a separate aside in
  // WorkspaceView. `workspaceRows` is the open-node set.
  workspaceRows: WorkspaceNodeRow[];
  workspaceSelectedNodeId: string | null;
  onWorkspaceSelectNode: (id: string) => void;
  onWorkspaceCloseNode: (nodeId: string) => void;
  // "+" on a node row: start a new task on that node.
  onWorkspaceNewTask: (nodeId: string) => void;
  // #343: each open node's own running/suspended persistent sessions, for
  // WorkspaceNodeList's sub-rows.
  workspaceThreadsByNode: Record<string, SessionSummary[]>;
  // #412: the thread the canvas is currently showing, highlighted in the
  // list the same way its node row is.
  workspaceActiveSessionId: string | null;
  onWorkspaceOpenSessionChat: (nodeId: string, sessionId: string) => void;
  // Inline rename / close on a thread's own sub-row (#374).
  onWorkspaceRenameTask: (session: SessionSummary, name: string) => void;
  onWorkspaceCloseTask: (session: SessionSummary) => void;
  // #459: "Předat" on a thread's sub-row.
  onWorkspaceHandoffTask: (session: SessionSummary) => void;
  // Open an EXISTING node in the workspace (the primary workspace action). Driven by the inline search-first picker at
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
// typing -- in a DetailPane textarea, the chat composer or the CodeMirror
// editor (contenteditable).
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
// workspace node list; App re-renders frequently (session state, editor)
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
  onSelect,
  theme,
  onThemeToggle,
  view,
  onViewChange,
  onOpenSettings,
  onCreateNode,
  canCreateNode,
  workspaceBadge,
  workspaceRows,
  workspaceSelectedNodeId,
  onWorkspaceSelectNode,
  onWorkspaceCloseNode,
  onWorkspaceNewTask,
  onWorkspaceOpenNode,
  onWorkspaceCreateNode,
  workspaceThreadsByNode,
  workspaceActiveSessionId,
  onWorkspaceOpenSessionChat,
  onWorkspaceRenameTask,
  onWorkspaceCloseTask,
  onWorkspaceHandoffTask,
}: Props) {
  const isMac =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
  const shortcut = isMac ? "⌘K" : "Ctrl K";

  // One palette for every tab. ⌘K / Ctrl+K opens it from anywhere (the old
  // per-tab ⌘K graph search and ⌘T workspace picker both collapse into it).
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMac]);

  // What picking and creating mean depends on the tab: Graf selects in the
  // graph (and the live query keeps highlighting matches behind the dialog
  // while it is open); every other tab opens the node in Práce, which is
  // also where a freshly created node lands.
  const pickNode = (id: string) => {
    if (view === "graph") onSelect(id);
    else onWorkspaceOpenNode(id);
  };
  const createNode = view === "graph" ? onCreateNode : onWorkspaceCreateNode;

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-4">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--color-accent-soft)" }}
        >
          <Waypoints size={16} className="text-[var(--color-accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight tracking-tight text-[var(--color-text)]">
            Portuni
          </div>
          <WorkspaceSwitcher onOpenSettings={onOpenSettings} />
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onOpenSettings} title="Nastavení" aria-label="Nastavení" className="text-muted-foreground">
          <Settings />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onThemeToggle}
          title={theme === "dark" ? "Přepnout na světlý režim" : "Přepnout na tmavý režim"}
          aria-label={theme === "dark" ? "Přepnout na světlý režim" : "Přepnout na tmavý režim"}
          className="text-muted-foreground"
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>

      {/* Common block: view toggle, search, create -- identical on every tab */}
      <div className="flex flex-col gap-2.5 px-4 pt-4">
        <ButtonGroup className="w-full" aria-label="Pohled">
          <ViewToggleButton
            label="Přehled"
            icon={<LayoutDashboard />}
            active={view === "overview"}
            onClick={() => onViewChange("overview")}
          />
          <ViewToggleButton
            label="Graf"
            icon={<Waypoints />}
            active={view === "graph"}
            onClick={() => onViewChange("graph")}
          />
          <ViewToggleButton
            label="Práce"
            icon={<MessagesSquare />}
            active={view === "workspace"}
            onClick={() => onViewChange("workspace")}
            badge={workspaceBadge}
          />
        </ButtonGroup>
        <Button
          variant="outline"
          onClick={() => setPaletteOpen(true)}
          className="w-full justify-start font-normal text-muted-foreground"
          title={`Hledat uzel (${shortcut})`}
        >
          <Search />
          Hledat uzel…
          <kbd className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {shortcut}
          </kbd>
        </Button>
        <Button
          variant="outline"
          onClick={createNode}
          disabled={!canCreateNode}
          title={
            canCreateNode
              ? view === "graph"
                ? "Vytvořit nový uzel (organizace, projekt, proces, oblast, princip)"
                : "Vytvoří nový uzel a otevře ho v Práci"
              : CREATE_NODE_DENIED_TITLE
          }
          className="w-full"
        >
          <Plus />
          Nový uzel
        </Button>
      </div>

      <NodeCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        nodes={graph.nodes}
        onPick={pickNode}
        onQueryChange={view === "graph" ? onQuery : undefined}
      />

      {view === "settings" && (
        <div className="flex-1 px-5 py-6 text-[13px] leading-relaxed text-[var(--color-text-dim)]">
          Konfigurace Portuni: příkaz agenta pro spouštění z uzlů a
          parametry MCP serveru pro Claude Code a Codex.
        </div>
      )}

      {view === "overview" && (
        <div className="flex-1 px-5 py-6 text-[13px] leading-relaxed text-[var(--color-text-dim)]">
          Souhrn celého workspace: běžící relace, nody vyžadující pozornost,
          poslední aktivita a nově vytvořené nody.
        </div>
      )}

      {view === "workspace" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-x-hidden overflow-y-auto scroll-thin">
            <WorkspaceNodeList
              rows={workspaceRows}
              selectedNodeId={workspaceSelectedNodeId}
              onSelectNode={onWorkspaceSelectNode}
              onCloseNode={onWorkspaceCloseNode}
              onNewTask={onWorkspaceNewTask}
              threadsByNode={workspaceThreadsByNode}
              activeSessionId={workspaceActiveSessionId}
              onOpenSessionChat={onWorkspaceOpenSessionChat}
              onRenameTask={onWorkspaceRenameTask}
              onCloseTask={onWorkspaceCloseTask}
              onHandoffTask={onWorkspaceHandoffTask}
            />
          </div>
        </div>
      )}

      {view === "graph" && (
        <GraphSidebarContent
          graph={graph}
          query={query}
          disabledRelations={disabledRelations}
          onToggleRelation={onToggleRelation}
          disabledOrgs={disabledOrgs}
          onToggleOrg={onToggleOrg}
          disabledTypes={disabledTypes}
          onToggleType={onToggleType}
          disabledStatuses={disabledStatuses}
          onToggleStatus={onToggleStatus}
        />
      )}

      {(view === "graph" || view === "settings") && (
        <div className="border-t border-[var(--color-border)] px-5 py-3 text-[11px] text-[var(--color-text-dim)]">
          {view === "graph"
            ? "Kliknutím na uzel otevřete detail. Tažením posunete pohled, kolečkem přibližujete."
            : "Změny se ukládají automaticky."}
        </div>
      )}
    </aside>
  );
}

const MANAGE_WORKSPACES = "__manage__";

// Workspace switcher under the brand name: a shadcn Select styled as a
// quiet ghost trigger showing THIS window's workspace. Rendered whenever the
// Tauri workspace list is available -- with a single workspace too, so the
// window always says which one it is. Still a jump target, not a selection
// (#226, one window per workspace): picking an entry opens or focuses ITS
// OWN window and the select stays on its placeholder, since no single
// "current" value could reflect several windows at once.
function WorkspaceSwitcher({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const fetchWorkspaces = () => {
      listWorkspaces()
        .then((ws) => {
          if (!cancelled) setWorkspaces(ws);
        })
        .catch((e) => console.error("listWorkspaces failed:", e));
    };
    fetchWorkspaces();
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        // Rust broadcasts this after every config mutation (create,
        // delete, enable/disable) and every window open/close, so a
        // change made in ANY window appears here.
        unlisten = await listen("workspaces-changed", fetchWorkspaces);
      } catch {
        /* not running in Tauri */
      }
    })();
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {
        /* window already gone */
      }
    };
  }, []);

  if (!isTauri() || workspaces.length === 0) return null;
  const currentId = currentWorkspaceId();
  const current = workspaces.find((w) => w.id === currentId);

  return (
    <Select
      value=""
      onValueChange={(id) => {
        if (id === MANAGE_WORKSPACES) onOpenSettings();
        else if (id) void openWorkspaceWindow(id);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Workspace"
        title="Otevřít jiný workspace"
        className="-ml-1.5 mt-0.5 h-6 max-w-full gap-1 border-transparent bg-transparent py-0 pr-1 pl-1.5 text-[12px] shadow-none hover:bg-muted data-placeholder:text-muted-foreground dark:bg-transparent dark:hover:bg-muted [&_svg]:size-3"
      >
        <SelectValue placeholder={current?.label ?? "Workspace"} />
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((w) => {
          const unavailable = !w.running && !w.deferred && w.enabled;
          const hint = w.id === currentId
            ? "toto okno"
            : w.window_open
              ? "otevřeno"
              : unavailable
                ? "nedostupný"
                : !w.enabled
                  ? "vypnutý"
                  : null;
          return (
            <SelectItem key={w.id} value={w.id} disabled={!w.enabled}>
              <span className="min-w-0 flex-1 truncate">{w.label}</span>
              {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
            </SelectItem>
          );
        })}
        <SelectSeparator />
        <SelectItem value={MANAGE_WORKSPACES}>
          <Settings className="text-muted-foreground" />
          Spravovat workspaces…
        </SelectItem>
      </SelectContent>
    </Select>
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
    <Button
      variant="outline"
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="flex-1 aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:font-medium dark:aria-pressed:bg-muted"
    >
      {icon}
      {label}
      {badge != null && badge > 0 && (
        <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent-soft)] px-1 text-[10px] font-semibold text-[var(--color-accent)]">
          {badge}
        </span>
      )}
    </Button>
  );
}

function GraphSidebarContent({
  graph,
  query,
  disabledRelations,
  onToggleRelation,
  disabledOrgs,
  onToggleOrg,
  disabledTypes,
  onToggleType,
  disabledStatuses,
  onToggleStatus,
}: {
  graph: GraphPayload;
  // The live palette query, only so the filter list can step aside while
  // the graph is being searched (matches are highlighted in the graph).
  query: string;
  disabledRelations: Set<string>;
  onToggleRelation: (relation: string) => void;
  disabledOrgs: Set<string>;
  onToggleOrg: (id: string) => void;
  disabledTypes: Set<string>;
  onToggleType: (type: string) => void;
  disabledStatuses: Set<string>;
  onToggleStatus: (status: string) => void;
}) {
  const q = query.trim();

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
      {/* Filters */}
      {q.length === 0 && (
        <div className="flex-1 overflow-y-auto scroll-thin px-5 py-6">
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
  const text = (
    <span
      className={`flex-1 text-left text-[13px] transition-colors ${
        enabled ? "text-[var(--color-text)]" : "text-[var(--color-text-dim)] line-through"
      }`}
    >
      {label}
    </span>
  );
  const counter =
    count !== undefined ? (
      <span className="font-mono text-[12px] text-[var(--color-text-dim)]">{count}</span>
    ) : null;
  if (dotColor) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        aria-pressed={enabled}
        className="w-full justify-start gap-2.5 px-2 font-normal"
      >
        <span
          className={`h-2.5 w-2.5 rounded-full transition-opacity ${enabled ? "" : "opacity-30"}`}
          style={{
            background: dotColor,
            boxShadow: dotGlow ? `0 0 10px ${dotGlow}` : undefined,
          }}
        />
        {text}
        {counter}
      </Button>
    );
  }
  return (
    <Label className="flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 font-normal hover:bg-muted">
      <Checkbox checked={enabled} onCheckedChange={() => onClick()} />
      {text}
      {counter}
    </Label>
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
