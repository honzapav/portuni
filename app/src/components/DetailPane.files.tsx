// File tree + sync display + ActionButtons. Split from DetailPane.tsx
// to give the file-browsing UI its own home. Components here render
// `node.files` as a collapsible tree, badge each file with its sync
// class, summarise pending sync state in a banner, and expose the
// "open in agent" / archive node action buttons.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Loader2,
  Play,
  RefreshCw,
} from "lucide-react";
import type {
  DetailFile,
  NodeDetail,
  SyncClass,
  SyncRunResponse,
  SyncStatusFile,
  UntrackedFile,
} from "../types";
import { buildAgentCommand } from "../lib/prompt";
import { agentDisplayName } from "../lib/settings";
import { createNodeMirror } from "../api";
import { isTauri } from "../lib/backend-url";
import { useDataMode } from "../lib/central";

// ---------------------------------------------------------------------------
// File tree (Files tab)
// ---------------------------------------------------------------------------

// Unified leaf model: registered DetailFile or an untracked disk file.
type TreeFile = {
  relative_path: string;
  filename: string;
  description: string | null;
  mime_type: string | null;
  fileId: string | null; // null = untracked (not in `files`)
};

type TreeNode = {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
  file?: TreeFile;
};

// Text-ish files are clickable to edit. Mirrors the backend editable rule.
export function isEditableFile(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return false;
}

function buildFileTree(files: TreeFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const rel = f.relative_path;
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

// Merge registered + untracked into one row list. Registered wins if a path
// appears in both (a freshly-adopted file may briefly show in both).
function toTreeFiles(files: DetailFile[], untracked: UntrackedFile[]): TreeFile[] {
  const byPath = new Map<string, TreeFile>();
  for (const u of untracked) {
    byPath.set(u.relative_path, {
      relative_path: u.relative_path,
      filename: u.filename,
      description: null,
      mime_type: u.mime_type,
      fileId: null,
    });
  }
  for (const f of files) {
    const rel = f.relative_path ?? f.filename;
    byPath.set(rel, {
      relative_path: rel,
      filename: f.filename,
      description: f.description,
      mime_type: f.mime_type,
      fileId: f.id,
    });
  }
  return Array.from(byPath.values());
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
      const sync = cur.file.fileId ? map.get(cur.file.fileId) : undefined;
      if (!sync) continue;
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

// Inline replacement for window.prompt on file creation -- the prompt is a
// silent no-op in the Tauri macOS webview, so the form lives in the pane.
export function NewFileForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch {
      /* error surfaced by the caller's error line; keep the form open */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-3 flex items-center gap-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Název nového souboru (např. poznamky.md)"
        className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]"
      />
      <button
        type="button"
        disabled={!name.trim() || busy}
        onClick={() => void submit()}
        className="shrink-0 rounded-md border border-[var(--color-accent-dim)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? "Vytvářím…" : "Vytvořit"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)]"
      >
        Zrušit
      </button>
    </div>
  );
}

export function FileTree({
  files,
  untracked,
  syncStatus,
  syncLoaded,
  onOpenFile,
  onRename,
  onDelete,
  readOnly,
}: {
  files: DetailFile[];
  untracked: UntrackedFile[];
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  // When true, hide rename/delete actions (e.g. central mode).
  readOnly?: boolean;
}) {
  const treeFiles = useMemo(() => toTreeFiles(files, untracked), [files, untracked]);
  const root = useMemo(() => buildFileTree(treeFiles), [treeFiles]);
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
          onOpenFile={onOpenFile}
          onRename={onRename}
          onDelete={onDelete}
          readOnly={readOnly}
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
  onOpenFile,
  onRename,
  onDelete,
  readOnly,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  readOnly?: boolean;
}) {
  const indent = depth * 14;
  if (node.file) {
    return (
      <FileRow
        file={node.file}
        indent={indent}
        syncStatus={syncStatus}
        onOpenFile={onOpenFile}
        onRename={onRename}
        onDelete={onDelete}
        readOnly={readOnly}
      />
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
              onOpenFile={onOpenFile}
              onRename={onRename}
              onDelete={onDelete}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One file row. Rename is an inline input (Enter saves, Escape cancels);
// delete is a two-step confirm that auto-resets after a few seconds. Both
// replace window.prompt/confirm, which are no-ops in the Tauri webview.
function FileRow({
  file: f,
  indent,
  syncStatus,
  onOpenFile,
  onRename,
  onDelete,
  readOnly,
}: {
  file: TreeFile;
  indent: number;
  syncStatus: Map<string, SyncStatusFile>;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  readOnly?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(f.filename);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const sync = f.fileId ? syncStatus.get(f.fileId) : undefined;
  const editable = isEditableFile(f.mime_type);

  const submitRename = async () => {
    const name = draft.trim();
    if (!name || name === f.filename) {
      setRenaming(false);
      setDraft(f.filename);
      return;
    }
    setBusy(true);
    try {
      await onRename(f.fileId!, name);
      setRenaming(false);
    } catch {
      /* error surfaced by the pane's error line; keep editing */
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteClick = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      confirmTimer.current = setTimeout(() => setConfirmingDelete(false), 4000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingDelete(false);
    setBusy(true);
    void onDelete(f.fileId!).finally(() => setBusy(false));
  };

  return (
    <div
      className="group flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface)]"
      style={{ paddingLeft: indent + 8 }}
    >
      <FileText size={12} className="mt-0.5 shrink-0 text-[var(--color-text-dim)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {renaming ? (
            <input
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setDraft(f.filename);
                }
              }}
              onBlur={() => void submitRename()}
              className="min-w-0 flex-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[13.5px] text-[var(--color-text)] outline-none"
            />
          ) : (
            <button
              type="button"
              disabled={!editable}
              onClick={() => editable && onOpenFile(f.relative_path)}
              title={editable ? "Otevřít v editoru" : "Tento soubor nelze editovat"}
              className={
                "truncate text-left text-[13.5px] text-[var(--color-text)] " +
                (editable ? "hover:underline" : "cursor-default opacity-70")
              }
            >
              {f.filename}
            </button>
          )}
          {sync && <SyncStatusBadge sync={sync} />}
          {!f.fileId && (
            <span
              title="Soubor je na disku, ale ještě není zaregistrovaný. Zaregistruje se při synchronizaci."
              className="rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
              style={{
                color: "var(--color-status-archived)",
                background:
                  "color-mix(in srgb, var(--color-status-archived) 12%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--color-status-archived) 25%, transparent)",
              }}
            >
              neregistrováno
            </span>
          )}
          {f.fileId && !renaming && !readOnly && (
            <span
              className={
                "ml-auto gap-1 " +
                (confirmingDelete ? "flex" : "hidden group-hover:flex")
              }
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(f.filename);
                  setRenaming(true);
                }}
                title="Přejmenovat"
                className="text-[11px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              >
                Přejmenovat
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleDeleteClick}
                title={
                  confirmingDelete
                    ? "Smaže soubor i z remote úložiště"
                    : "Smazat"
                }
                className={
                  "text-[11px] " +
                  (confirmingDelete
                    ? "font-medium text-[var(--color-danger)]"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-danger)]")
                }
              >
                {confirmingDelete ? "Opravdu smazat?" : "Smazat"}
              </button>
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
  // matches what the user sees. deleted_local and conflicts are reported
  // separately: the sync run never acts on them automatically (the local
  // deletion may be intentional; conflicts need a human).
  let pending = 0;
  let conflicts = 0;
  let deletedLocal = 0;
  for (const f of statusMap.values()) {
    if (f.sync_class === "push" || f.sync_class === "pull") {
      pending++;
    } else if (f.sync_class === "deleted_local") {
      deletedLocal++;
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
        {deletedLocal > 0 && (
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
            style={{
              color: "var(--color-status-archived)",
              background:
                "color-mix(in srgb, var(--color-status-archived) 12%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--color-status-archived) 25%, transparent)",
            }}
            title="Soubor byl smazán lokálně, ale na remote existuje. Obnov přes portuni_pull, nebo smaž všude přes portuni_delete_file -- synchronizace ho neobnovuje automaticky."
          >
            {deletedLocal} smazáno lokálně
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
          {result.adopted.length > 0 && (
            <div>Zaregistrováno: {result.adopted.length} souborů</div>
          )}
          {result.conflicts.length > 0 && (
            <div style={{ color: "var(--color-danger)" }}>
              Konflikty (přeskočeno): {result.conflicts.length}
            </div>
          )}
          {(result.deleted_local?.length ?? 0) > 0 && (
            <div>
              Smazáno lokálně (neobnovuje se):{" "}
              {result.deleted_local.map((f) => f.filename).join(", ")}
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
            result.adopted.length === 0 &&
            result.conflicts.length === 0 &&
            (result.deleted_local?.length ?? 0) === 0 &&
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

// Launch flow:
//   1. POST /nodes/:id/mirror — idempotent; creates the working folder
//      if missing and returns { local_path, ... } either way.
//   2. Refresh the node's local_mirror in-memory from the response so
//      buildAgentCommand prefixes `cd <path> && ...`.
//   3a. On Tauri: invoke `launch_claude_for_node` to spawn Terminal.app.
//       UNSUPPORTED_OS error → fall back to clipboard.
//   3b. In browser: copy to clipboard.
type LaunchState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "launched" }
  | { kind: "copied" }
  | { kind: "error"; message: string };

export function ActionButtons({
  node,
  agentCommand,
  terminalLaunch,
}: {
  node: NodeDetail;
  agentCommand: string;
  terminalLaunch: string;
}) {
  const [state, setState] = useState<LaunchState>({ kind: "idle" });
  const dataMode = useDataMode();
  const isCentral = dataMode?.mode === "central";

  // Organizations are workspace roots, not work locations -- nobody runs an
  // agent at org scope, so the launch command is pointless here.
  if (node.type === "organization") return null;

  // In central mode, mirror creation is not available — replace with a note.
  if (isCentral) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
        Dostupné jen v lokálním režimu (fáze B).
      </div>
    );
  }

  const handleLaunch = async () => {
    setState({ kind: "pending" });
    try {
      // Ensure the folder exists. Idempotent — fast path when the mirror
      // is already registered.
      const { local_path } = await createNodeMirror(node.id);
      // Splice the freshly known mirror onto the node so buildAgentCommand
      // produces the cd-prefixed form even on the first launch (when
      // node.local_mirror was still null).
      const enriched: NodeDetail = {
        ...node,
        local_mirror: node.local_mirror ?? {
          local_path,
          registered_at: new Date().toISOString(),
        },
      };
      const cmd = buildAgentCommand(enriched, agentCommand);

      if (isTauri()) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("launch_claude_for_node", {
            cwd: local_path,
            command: cmd,
            template: terminalLaunch,
          });
          setState({ kind: "launched" });
          setTimeout(() => setState({ kind: "idle" }), 2000);
          return;
        } catch (err) {
          const msg = String(err);
          if (msg.includes("UNSUPPORTED_OS")) {
            // Linux / Windows in Tauri build — fall through to clipboard.
          } else {
            setState({ kind: "error", message: msg });
            setTimeout(() => setState({ kind: "idle" }), 3500);
            return;
          }
        }
      }

      await navigator.clipboard.writeText(cmd);
      setState({ kind: "copied" });
      setTimeout(() => setState({ kind: "idle" }), 1800);
    } catch (err) {
      setState({ kind: "error", message: String(err) });
      setTimeout(() => setState({ kind: "idle" }), 3500);
    }
  };

  const agentName = agentDisplayName(agentCommand);
  const label = (() => {
    switch (state.kind) {
      case "pending":
        return "Spouštím…";
      case "launched":
        return "Spuštěno v Terminal.app";
      case "copied":
        return "Zkopírováno — paste do svého terminálu";
      case "error":
        return state.message;
      default:
        return `Spustit ${agentName}`;
    }
  })();

  const icon = (() => {
    switch (state.kind) {
      case "pending":
        return <Loader2 size={13} className="animate-spin" />;
      case "launched":
        return <Check size={13} />;
      case "copied":
        return <Copy size={13} />;
      case "error":
        return null;
      default:
        return <Play size={13} />;
    }
  })();

  return (
    <div className="flex gap-2">
      <button
        onClick={handleLaunch}
        disabled={state.kind === "pending"}
        title={
          isTauri()
            ? `Otevře Terminal.app v pracovní složce a spustí ${agentName}. Pracovní složka bude vytvořena, pokud ještě neexistuje.`
            : `Zkopíruje shell příkaz pro vstup do složky a spuštění ${agentName}. V desktopové aplikaci spustí Terminal.app přímo.`
        }
        className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-4 py-2.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-all hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)] disabled:opacity-60"
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
