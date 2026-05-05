// File tree + sync display + ActionButtons. Split from DetailPane.tsx
// to give the file-browsing UI its own home. Components here render
// `node.files` as a collapsible tree, badge each file with its sync
// class, summarise pending sync state in a banner, and expose the
// "open in agent" / archive node action buttons.

import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type {
  DetailFile,
  NodeDetail,
  SyncClass,
  SyncRunResponse,
  SyncStatusFile,
} from "../types";
import { buildAgentCommand } from "../lib/prompt";

// ---------------------------------------------------------------------------
// File tree (Files tab)
// ---------------------------------------------------------------------------

type TreeNode = {
  name: string;
  // Full path from the mirror root, used as React key + collapse map key.
  // For the synthetic top-level "(root)" wrapper, this is "".
  path: string;
  // A folder node has children; a file node has file.
  children?: Map<string, TreeNode>;
  file?: DetailFile;
};

function buildFileTree(files: DetailFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    // Files without a derivable in-mirror path land at the root with just
    // their filename, so they stay visible instead of disappearing.
    const rel = f.relative_path ?? f.filename;
    const parts = rel.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const childPath = parts.slice(0, i + 1).join("/");
      let child = cur.children!.get(seg);
      if (!child) {
        child = { name: seg, path: childPath, children: new Map() };
        cur.children!.set(seg, child);
      }
      cur = child;
    }
    const leafName = parts[parts.length - 1];
    cur.children!.set(leafName, { name: leafName, path: rel, file: f });
  }
  return root;
}

// Walk a folder subtree and aggregate sync classes of all files inside.
// Returns the worst color, mirroring the per-tab dot logic. Returns null
// if no file inside is mapped yet (so the folder shows no dot during
// initial load instead of misleading green).
function aggregateFolderSync(
  node: TreeNode,
  map: Map<string, SyncStatusFile>,
): { color: string; title: string } | null {
  let hasConflict = false;
  let hasPending = false;
  let hasOrphan = false;
  let hasClean = false;
  let any = false;
  const stack: TreeNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.file) {
      const sync = map.get(cur.file.id);
      if (sync) {
        any = true;
        if (sync.sync_class === "conflict") hasConflict = true;
        else if (
          sync.sync_class === "push" ||
          sync.sync_class === "pull" ||
          sync.sync_class === "deleted_local"
        ) {
          hasPending = true;
        } else if (sync.sync_class === "orphan") hasOrphan = true;
        else if (sync.sync_class === "clean") hasClean = true;
      }
    } else if (cur.children) {
      for (const c of cur.children.values()) stack.push(c);
    }
  }
  if (!any) return null;
  if (hasConflict)
    return { color: "var(--color-danger)", title: "Konflikt uvnitř" };
  if (hasPending)
    return {
      color: "var(--color-node-process)",
      title: "Soubory čekají na synchronizaci",
    };
  if (hasOrphan)
    return {
      color: "var(--color-status-archived)",
      title: "Některé soubory jsou orphan",
    };
  if (hasClean)
    return {
      color: "var(--color-status-active)",
      title: "Vše synchronizováno",
    };
  return null;
}

// Order folder children: directories first (alphabetical), then files
// (alphabetical). Top-level wrapper enforces section order wip / outputs
// / resources / others to match how authors think about the workspace.
const SECTION_ORDER = ["wip", "outputs", "resources"];
function sortChildren(node: TreeNode, isRoot: boolean): TreeNode[] {
  const arr = Array.from(node.children!.values());
  if (isRoot) {
    return arr.sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.name);
      const bi = SECTION_ORDER.indexOf(b.name);
      const aw = ai === -1 ? SECTION_ORDER.length : ai;
      const bw = bi === -1 ? SECTION_ORDER.length : bi;
      if (aw !== bw) return aw - bw;
      return a.name.localeCompare(b.name);
    });
  }
  return arr.sort((a, b) => {
    const aDir = !!a.children;
    const bDir = !!b.children;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function FileTree({
  files,
  syncStatus,
  syncLoaded,
}: {
  files: DetailFile[];
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
}) {
  const root = useMemo(() => buildFileTree(files), [files]);
  // Collapsed folder paths. Default = everything expanded; the user
  // collapses what they don't want to see. Using "collapsed" rather than
  // "expanded" means a freshly-added folder is visible by default.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const topChildren = sortChildren(root, true);
  return (
    <div className="space-y-0.5">
      {topChildren.map((c) => (
        <FileTreeNode
          key={c.path}
          node={c}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
          syncStatus={syncStatus}
          syncLoaded={syncLoaded}
        />
      ))}
    </div>
  );
}

function FileTreeNode({
  node,
  depth,
  collapsed,
  onToggle,
  syncStatus,
  syncLoaded,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
}) {
  const indent = depth * 14;
  if (node.file) {
    const f = node.file;
    const sync = syncStatus.get(f.id);
    return (
      <div
        className="flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface)]"
        style={{ paddingLeft: indent + 8 }}
      >
        <FileText
          size={12}
          className="mt-0.5 shrink-0 text-[var(--color-text-dim)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] text-[var(--color-text)]">
              {f.filename}
            </span>
            {sync && <SyncStatusBadge sync={sync} />}
            {!sync && !syncLoaded && (
              <span className="font-mono text-[8.5px] uppercase tracking-wider text-[var(--color-text-dim)]">
                ...
              </span>
            )}
          </div>
          {f.description && (
            <div className="mt-0.5 line-clamp-2 text-[13.5px] leading-relaxed text-[var(--color-text-dim)]">
              {f.description}
            </div>
          )}
        </div>
      </div>
    );
  }
  const isCollapsed = collapsed.has(node.path);
  const dot = aggregateFolderSync(node, syncStatus);
  const childCount = node.children ? node.children.size : 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-[var(--color-surface)]"
        style={{ paddingLeft: indent + 4 }}
      >
        {isCollapsed ? (
          <ChevronRight size={12} className="shrink-0 text-[var(--color-text-dim)]" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-[var(--color-text-dim)]" />
        )}
        <Folder size={12} className="shrink-0 text-[var(--color-text-dim)]" />
        <span className="truncate font-mono text-[12.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
          {node.name}
        </span>
        <span className="text-[11px] text-[var(--color-text-dim)]">
          {childCount}
        </span>
        {dot && (
          <span
            title={dot.title}
            className="ml-auto h-1.5 w-1.5 rounded-full"
            style={{
              background: dot.color,
              boxShadow: `0 0 6px color-mix(in srgb, ${dot.color} 70%, transparent)`,
            }}
          />
        )}
      </button>
      {!isCollapsed && node.children && (
        <div>
          {sortChildren(node, false).map((c) => (
            <FileTreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              syncStatus={syncStatus}
              syncLoaded={syncLoaded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Pluralization for the work-pending counter ("3 soubory ke synchronizaci"
// vs. "1 soubor ke synchronizaci"). Czech grammar: 1 -> singular,
// 2-4 -> few, 5+ -> many. Used to label the action button.
function syncPendingLabel(count: number): string {
  if (count === 1) return "1 soubor ke synchronizaci";
  if (count >= 2 && count <= 4) return `${count} soubory ke synchronizaci`;
  return `${count} souborů ke synchronizaci`;
}

export function SyncBar({
  running,
  result,
  error,
  statusLoaded,
  statusMap,
  onRun,
}: {
  running: boolean;
  result: SyncRunResponse | null;
  error: string | null;
  statusLoaded: boolean;
  statusMap: Map<string, SyncStatusFile>;
  onRun: () => void;
}) {
  // Count work-to-do straight from the badge map, so the button label
  // matches what the user sees. deleted_local is pull-restorable, so it
  // counts as pending work; conflicts are reported separately because
  // they need manual resolve.
  let pending = 0;
  let conflicts = 0;
  for (const f of statusMap.values()) {
    if (
      f.sync_class === "push" ||
      f.sync_class === "pull" ||
      f.sync_class === "deleted_local"
    ) {
      pending++;
    } else if (f.sync_class === "conflict") {
      conflicts++;
    }
  }
  const noWork = statusLoaded && pending === 0 && conflicts === 0;
  const ready = statusLoaded;

  const label = running
    ? "Synchronizuji..."
    : !ready
    ? "Synchronizovat soubory"
    : noWork
    ? "Vše synchronizováno"
    : pending > 0
    ? `Synchronizovat (${syncPendingLabel(pending)})`
    : "Synchronizovat soubory";

  return (
    <div className="mb-3 space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={onRun}
          disabled={running || noWork}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] text-[var(--color-text)] transition-colors hover:border-[var(--color-border-strong)] disabled:cursor-default disabled:opacity-60"
        >
          <RefreshCw
            size={12}
            className={running ? "animate-spin" : undefined}
          />
          {label}
        </button>
        {conflicts > 0 && (
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
            style={{
              color: "var(--color-danger)",
              background:
                "color-mix(in srgb, var(--color-danger) 12%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--color-danger) 25%, transparent)",
            }}
            title="Konflikty se neresolvují automaticky -- vyřešte ručně přes shell."
          >
            {conflicts} konflikt{conflicts === 1 ? "" : "y"}
          </span>
        )}
      </div>
      {result && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px] text-[var(--color-text-dim)]">
          {result.pushed.length > 0 && (
            <div>Push: {result.pushed.length} souborů</div>
          )}
          {result.pulled.length > 0 && (
            <div>Pull: {result.pulled.length} souborů</div>
          )}
          {result.conflicts.length > 0 && (
            <div style={{ color: "var(--color-danger)" }}>
              Konflikty (přeskočeno): {result.conflicts.length}
            </div>
          )}
          {result.errors.length > 0 && (
            <div style={{ color: "var(--color-danger)" }}>
              Chyby: {result.errors.length} (
              {result.errors.map((e) => e.filename).join(", ")})
            </div>
          )}
          {result.pushed.length === 0 &&
            result.pulled.length === 0 &&
            result.conflicts.length === 0 &&
            result.errors.length === 0 && <div>Nic k synchronizaci.</div>}
        </div>
      )}
      {error && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px]">
          <span style={{ color: "var(--color-danger)" }}>Chyba: {error}</span>
        </div>
      )}
    </div>
  );
}

function SyncStatusBadge({ sync }: { sync: SyncStatusFile }) {
  const cssVar = syncCssVar(sync.sync_class);
  const tip = [
    `class: ${sync.sync_class}`,
    sync.local_hash ? `local: ${sync.local_hash.slice(0, 8)}` : null,
    sync.remote_hash ? `remote: ${sync.remote_hash.slice(0, 8)}` : null,
    sync.last_synced_hash
      ? `synced: ${sync.last_synced_hash.slice(0, 8)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      title={tip}
      className="rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
      style={{
        color: cssVar,
        background: `color-mix(in srgb, ${cssVar} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${cssVar} 25%, transparent)`,
      }}
    >
      {SYNC_LABEL[sync.sync_class]}
    </span>
  );
}

const SYNC_LABEL: Record<SyncClass, string> = {
  clean: "synced",
  push: "push",
  pull: "pull",
  conflict: "conflict",
  orphan: "orphan",
  native: "native",
  deleted_local: "missing",
};

function syncCssVar(c: SyncClass): string {
  switch (c) {
    case "clean":
      return "var(--color-status-active)";
    case "push":
    case "pull":
    case "deleted_local":
      return "var(--color-node-process)";
    case "conflict":
      return "var(--color-danger)";
    case "orphan":
      return "var(--color-status-archived)";
    case "native":
      return "var(--color-accent)";
  }
}

export function ActionButtons({
  node,
  agentCommand,
}: {
  node: NodeDetail;
  agentCommand: string;
}) {
  const [copiedLaunch, setCopiedLaunch] = useState(false);

  // Organizations are workspace roots, not work locations -- nobody runs an
  // agent at org scope, so the launch command is pointless here.
  if (node.type === "organization") return null;

  const handleCopyLaunch = async () => {
    const cmd = buildAgentCommand(node, agentCommand);
    await navigator.clipboard.writeText(cmd);
    setCopiedLaunch(true);
    setTimeout(() => setCopiedLaunch(false), 1500);
  };

  const agentLabel = agentCommand.trim().split(/\s+/)[0] || "agent";

  return (
    <div className="flex gap-2">
      <button
        onClick={handleCopyLaunch}
        title="Zkopíruje shell příkaz, který vstoupí do složky uzlu a spustí nakonfigurovaného agenta s promptem"
        className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-4 py-2.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-all hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)]"
      >
        {copiedLaunch ? (
          <>
            <Check size={13} />
            Zkopírováno
          </>
        ) : (
          <>
            <Sparkles size={13} />
            Spouštěcí příkaz ({agentLabel})
          </>
        )}
      </button>
    </div>
  );
}
