// File tree + sync display + ActionButtons. Split from DetailPane.tsx
// to give the file-browsing UI its own home. Components here render
// `node.files` as a collapsible tree, badge each file with its sync
// class, summarise pending sync state in a banner, and expose the
// "open in agent" / archive node action buttons.

import { useEffect, useMemo, useRef, useState } from "react";
import { loadShowtimeEnabled } from "../lib/settings";
import { isShowtimePath, showtimeInstalled } from "../lib/showtime";
import { newFileMenu } from "../lib/new-file-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  DetailFile,
  NodeDetail,
  SessionRunRow,
  SessionSummary,
  SyncClass,
  SyncRunResponse,
  SyncStatusFile,
  UntrackedFile,
  WatcherErrorEntry,
} from "../types";
import { loadCollapsedFolders, saveCollapsedFolders } from "../lib/settings";
import { fetchNodeFileUrl } from "../api";
import type { ResolveAction } from "../api";
import { isTauri, openInFinder } from "../lib/backend-url";
import { listWorkspaces } from "../lib/workspaces";
import { copyText } from "../lib/clipboard";
import { summarizeSyncRun } from "../lib/sync-run-summary";
import { syncBarState } from "../lib/sync-bar-state";
import { startDraftThread } from "../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// File tree (Files tab)
// ---------------------------------------------------------------------------

// Unified leaf model: registered DetailFile or an untracked disk file.
type TreeFile = {
  relative_path: string;
  filename: string;
  mime_type: string | null;
  fileId: string | null; // null = untracked (not in `files`)
  local_path: string | null;
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
//
// Central mode serves node-detail without device-derived paths
// (relative_path/local_path null, because the central server has no device
// state). Recover them from the per-node sync-status entry + the device
// mirror: a file's relative_path is its path within the mirror, i.e. its
// absolute local_path minus the mirror-root prefix -- the same strip
// node-detail does server-side in local mode. Without this, central-mode
// registered files fall back to a bare filename and open at the wrong path.
function toTreeFiles(
  files: DetailFile[],
  untracked: UntrackedFile[],
  syncStatus: Map<string, SyncStatusFile>,
  mirrorPath: string | null,
): TreeFile[] {
  const byPath = new Map<string, TreeFile>();
  for (const u of untracked) {
    byPath.set(u.relative_path, {
      relative_path: u.relative_path,
      filename: u.filename,
      mime_type: u.mime_type,
      fileId: null,
      local_path: u.local_path,
    });
  }
  for (const f of files) {
    const st = syncStatus.get(f.id);
    const localPath = f.local_path ?? st?.local_path ?? null;
    let rel = f.relative_path;
    if (!rel && localPath && mirrorPath && localPath.startsWith(mirrorPath + "/")) {
      rel = localPath.slice(mirrorPath.length + 1);
    }
    const relative_path = rel ?? f.filename;
    byPath.set(relative_path, {
      relative_path,
      filename: f.filename,
      mime_type: f.mime_type,
      fileId: f.id,
      local_path: localPath,
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
  let hasRemoteMissing = false;
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
      } else if (sync.sync_class === "remote_missing") hasRemoteMissing = true;
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
  if (hasRemoteMissing)
    return {
      color: "var(--color-status-archived)",
      title: "Některé soubory chybí na remote",
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
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      // Stays with the form (#267), not a tab-level box: this is the
      // create action's own error, not a row's or the sync run's.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Název nového souboru (např. poznamky.md)"
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          disabled={!name.trim() || busy}
          onClick={() => void submit()}
          className="shrink-0"
        >
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Vytvářím…" : "Vytvořit"}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel} className="shrink-0">
          Zrušit
        </Button>
      </div>
      {error && (
        <div className="mt-1 text-[11px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

// "+ Nový soubor", and -- with the Showtime integration on and Showtime.app
// found -- a chevron with "Nový soubor" / "Nová prezentace". The second item
// starts a Showtime deck in the node's wip/ (spec: 2026-09-13-showtime-new-
// deck-design.md) and is disabled without a mirror, with the reason as its
// title. Its error is the caller's to
// show, inline under the toolbar (#267), never in a tab-level box.
//
// The installed probe always runs on mount, integration on or off: the
// component stays mounted across a trip to Settings (WorkspaceView), so a
// guard on loadShowtimeEnabled() here would freeze `installed` at whatever
// it was when the node was first opened -- turning the integration on
// would then never flip the button from plain to split. `menu`'s own
// loadShowtimeEnabled() read below stays live on every render either way.
export function NewFileSplitButton({
  hasMirror,
  onNewFile,
  onOpenNewFile,
  onNewPresentation,
}: {
  hasMirror: boolean;
  onNewFile: () => void;
  // Used by the menu's "Nový soubor" item only. onNewFile toggles the form
  // (the primary button's own behaviour); with the form already open, the
  // menu item must open it (stay open), not close it.
  onOpenNewFile: () => void;
  onNewPresentation: () => Promise<void>;
}) {
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void showtimeInstalled().then((ok) => {
      if (!cancelled) setInstalled(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const menu = newFileMenu({
    showtimeEnabled: loadShowtimeEnabled(),
    showtimeInstalled: installed,
    hasMirror,
  });

  if (menu.kind === "plain") {
    return (
      <Button variant="outline" size="sm" onClick={onNewFile} className="ml-2 shrink-0">
        <Plus />
        Nový soubor
      </Button>
    );
  }

  const startPresentation = async () => {
    setBusy(true);
    try {
      await onNewPresentation();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ButtonGroup className="ml-2 shrink-0">
      <Button variant="outline" size="sm" onClick={onNewFile} disabled={busy}>
        <Plus />
        Nový soubor
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={busy}
            title="Další možnosti"
            aria-label="Další možnosti"
          >
            {busy ? <Loader2 className="animate-spin" /> : <ChevronDown />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-[180px]">
          <DropdownMenuItem onSelect={onOpenNewFile}>Nový soubor</DropdownMenuItem>
          {/* data-disabled:pointer-events-auto keeps the reason readable as a
              tooltip on the disabled item; Radix's own disabled guard still
              blocks selection and hover highlight. */}
          <DropdownMenuItem
            onSelect={() => void startPresentation()}
            disabled={!menu.presentation.enabled}
            title={
              menu.presentation.enabled
                ? "Založí novou prezentaci v Showtime ve složce wip/ tohoto uzlu"
                : menu.presentation.reason
            }
            className="data-disabled:pointer-events-auto"
          >
            Nová prezentace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

export function FileTree({
  files,
  untracked,
  nodeId,
  syncStatus,
  syncLoaded,
  mirrorPath,
  onOpenFile,
  onRename,
  onDelete,
  onResolve,
  readOnly,
  runErrors,
  isCentralMode,
}: {
  files: DetailFile[];
  untracked: UntrackedFile[];
  nodeId: string;
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
  // The node's device mirror root, used to recover file relative paths in
  // central mode (node-detail omits them there). Null when unknown.
  mirrorPath: string | null;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  onResolve: (fileId: string, action: ResolveAction) => Promise<void>;
  // When true, hide rename/delete actions (e.g. central mode).
  readOnly?: boolean;
  // Per-file outcome of the last sync run (#267): a failed push/pull or a
  // still-pending repair is shown on the affected row, where the transient
  // toolbar line only carries a count. Cleared by the next run.
  runErrors?: Map<string, string>;
  // A local workspace has no remote (#310/#312) -- hides the "Obnovit"
  // (restore, i.e. pull) row action, which would otherwise only ever fail
  // with LOCAL_MODE_NO_REMOTE. Undefined/false hides it, same as unresolved.
  isCentralMode?: boolean;
}) {
  const treeFiles = useMemo(
    () => toTreeFiles(files, untracked, syncStatus, mirrorPath),
    [files, untracked, syncStatus, mirrorPath],
  );
  const root = useMemo(() => buildFileTree(treeFiles), [treeFiles]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedFolders(nodeId));
  useEffect(() => {
    setCollapsed(loadCollapsedFolders(nodeId));
  }, [nodeId]);
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveCollapsedFolders(nodeId, next);
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
          nodeId={nodeId}
          syncStatus={syncStatus}
          syncLoaded={syncLoaded}
          onOpenFile={onOpenFile}
          onRename={onRename}
          onDelete={onDelete}
          onResolve={onResolve}
          readOnly={readOnly}
          runErrors={runErrors}
          isCentralMode={isCentralMode}
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
  nodeId,
  syncStatus,
  syncLoaded,
  onOpenFile,
  onRename,
  onDelete,
  onResolve,
  readOnly,
  runErrors,
  isCentralMode,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  nodeId: string;
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  onResolve: (fileId: string, action: ResolveAction) => Promise<void>;
  readOnly?: boolean;
  runErrors?: Map<string, string>;
  isCentralMode?: boolean;
}) {
  const indent = depth * 14;
  if (node.file) {
    return (
      <FileRow
        file={node.file}
        indent={indent}
        nodeId={nodeId}
        syncStatus={syncStatus}
        onOpenFile={onOpenFile}
        onRename={onRename}
        onDelete={onDelete}
        onResolve={onResolve}
        readOnly={readOnly}
        runError={node.file.fileId ? (runErrors?.get(node.file.fileId) ?? null) : null}
        isCentralMode={isCentralMode}
      />
    );
  }
  const isCollapsed = collapsed.has(node.path);
  const dot = aggregateFolderSync(node, syncStatus);
  const childCount = node.children ? node.children.size : 0;
  return (
    <div>
      <div style={{ paddingLeft: indent }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onToggle(node.path)}
          className="w-full justify-start gap-1.5 font-normal"
        >
          {isCollapsed ? (
            <ChevronRight className="shrink-0 text-[var(--color-text-dim)]" />
          ) : (
            <ChevronDown className="shrink-0 text-[var(--color-text-dim)]" />
          )}
          <Folder className="shrink-0 text-[var(--color-text-dim)]" />
          <span className="min-w-0 truncate font-mono uppercase tracking-wider text-[var(--color-text-muted)]">
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
        </Button>
      </div>
      {!isCollapsed && node.children && (
        <div>
          {sortChildren(node, false).map((c) => (
            <FileTreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              nodeId={nodeId}
              syncStatus={syncStatus}
              syncLoaded={syncLoaded}
              onOpenFile={onOpenFile}
              onRename={onRename}
              onDelete={onDelete}
              onResolve={onResolve}
              readOnly={readOnly}
              runErrors={runErrors}
              isCentralMode={isCentralMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Click-to-copy with a brief check confirmation. stopPropagation so the
// click doesn't also open/select the file row.
function CopyPathButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await copyText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard write rejected; skip copied state */
        }
      }}
      className="text-muted-foreground"
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

// Fetches the file's Drive URL on demand (server resolves the opaque id)
// and copies it. Only meaningful for registered, synced files.
function CopyDriveLinkButton({ nodeId, fileId }: { nodeId: string; fileId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "none">("idle");
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={state === "none" ? "Soubor zatím není na Disku" : "Kopírovat odkaz na Disk"}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          const r = await fetchNodeFileUrl(nodeId, fileId);
          if (r.url) {
            await copyText(r.url);
            setState("copied");
          } else {
            setState("none");
          }
        } catch {
          setState("none");
        }
        setTimeout(() => setState("idle"), 1500);
      }}
      className="text-muted-foreground"
    >
      {state === "copied" ? <Check /> : <Link2 />}
    </Button>
  );
}

// While a row action runs, the row's sync badge is replaced by this one:
// the action's own verb plus a spinner. Without it the row went silently
// unresponsive -- the buttons were disabled, but nothing said so, and the
// action strip itself is hover-gated, so moving the mouse away hid even
// that. Rename/delete/resolve all wait on a server round trip plus the
// detail + sync-status refetch that follows it.
type RowBusy = "rename" | "delete" | ResolveAction;

const ROW_BUSY_LABEL: Record<RowBusy, string> = {
  rename: "přejmenovávám",
  delete: "mažu",
  restore: "obnovuji",
  keep_local: "nahrávám",
  take_remote: "stahuji",
};

function RowBusyBadge({ action }: { action: RowBusy }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 font-mono text-[8.5px] uppercase tracking-wider"
      style={{
        color: "var(--color-accent)",
        background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--color-accent) 25%, transparent)",
      }}
    >
      <Loader2 className="animate-spin" />
      {ROW_BUSY_LABEL[action]}
    </Badge>
  );
}

// One file row. Rename is an inline input (Enter saves, Escape cancels);
// delete is a two-step confirm that auto-resets after a few seconds. Both
// replace window.prompt/confirm, which are no-ops in the Tauri webview.
function FileRow({
  file: f,
  indent,
  nodeId,
  syncStatus,
  onOpenFile,
  onRename,
  onDelete,
  onResolve,
  readOnly,
  runError,
  isCentralMode,
}: {
  file: TreeFile;
  indent: number;
  nodeId: string;
  syncStatus: Map<string, SyncStatusFile>;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  onResolve: (fileId: string, action: ResolveAction) => Promise<void>;
  readOnly?: boolean;
  // This file's error from the last sync run, if any (see FileTree.runErrors).
  runError?: string | null;
  // A local workspace has no remote (#310/#312) -- hides "Obnovit" (restore,
  // i.e. pull), which would otherwise only ever fail with LOCAL_MODE_NO_REMOTE.
  isCentralMode?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(f.filename);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busyAction, setBusyAction] = useState<RowBusy | null>(null);
  const busy = busyAction !== null;
  // Row-scoped action error (#267): rename/delete/resolve failures show
  // here, under the filename, instead of a tab-level box -- dismissed by
  // the next action on this row or, failing that, a timeout.
  const [rowError, setRowError] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      if (rowErrorTimer.current) clearTimeout(rowErrorTimer.current);
    },
    [],
  );
  const showRowError = (e: unknown) => {
    setRowError(e instanceof Error ? e.message : String(e));
    if (rowErrorTimer.current) clearTimeout(rowErrorTimer.current);
    rowErrorTimer.current = setTimeout(() => setRowError(null), 6000);
  };

  const sync = f.fileId ? syncStatus.get(f.fileId) : undefined;
  // A Showtime deck is binary, but with the integration on it opens in the
  // rendered preview the bundle carries (Settings -> Integrace).
  const showtimeDeck = isShowtimePath(f.relative_path) && loadShowtimeEnabled();
  const editable = isEditableFile(f.mime_type) || showtimeDeck;

  const submitRename = async () => {
    const name = draft.trim();
    if (!name || name === f.filename) {
      setRenaming(false);
      setDraft(f.filename);
      return;
    }
    setRowError(null);
    setBusyAction("rename");
    try {
      await onRename(f.fileId!, name);
      setRenaming(false);
    } catch (e) {
      showRowError(e); // keep editing so the user can retry the name
    } finally {
      setBusyAction(null);
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
    setRowError(null);
    setBusyAction("delete");
    onDelete(f.fileId!)
      .catch(showRowError)
      .finally(() => setBusyAction(null));
  };

  const act = (action: ResolveAction) => {
    setRowError(null);
    setBusyAction(action);
    onResolve(f.fileId!, action)
      .catch(showRowError)
      .finally(() => setBusyAction(null));
  };

  return (
    <div
      aria-busy={busy}
      className="group flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface)]"
      style={{ paddingLeft: indent + 8 }}
    >
      <FileText size={12} className="mt-0.5 shrink-0 text-[var(--color-text-dim)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {renaming ? (
            <Input
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
              className="min-w-0 flex-1"
            />
          ) : (
            <Button
              variant="link"
              size="sm"
              disabled={!editable}
              onClick={() => editable && onOpenFile(f.relative_path)}
              title={
                showtimeDeck
                  ? "Otevřít náhled prezentace"
                  : editable
                    ? "Otevřít v editoru"
                    : "Tento soubor nelze editovat"
              }
              className="min-w-0 justify-start font-normal text-[var(--color-text)]"
              style={busy ? { opacity: 0.5 } : undefined}
            >
              <span className="truncate">{f.filename}</span>
            </Button>
          )}
          {f.local_path && (
            <span className="opacity-0 group-hover:opacity-100">
              <CopyPathButton value={f.local_path} title="Kopírovat cestu k souboru" />
            </span>
          )}
          {f.local_path && isTauri() && (
            <span className="opacity-0 group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon-xs"
                title="Otevřít na disku"
                onClick={(e) => {
                  e.stopPropagation();
                  void openInFinder(f.local_path!, true).catch(() => undefined);
                }}
                className="text-muted-foreground"
              >
                <FolderOpen />
              </Button>
            </span>
          )}
          {f.fileId && (
            <span className="opacity-0 group-hover:opacity-100">
              <CopyDriveLinkButton nodeId={nodeId} fileId={f.fileId} />
            </span>
          )}
          {busyAction ? (
            <RowBusyBadge action={busyAction} />
          ) : (
            sync && <SyncStatusBadge sync={sync} />
          )}
          {!f.fileId && (
            <Badge
              variant="outline"
              title="Soubor je na disku, ale ještě není zaregistrovaný. Zaregistruje se při synchronizaci."
              className="font-mono text-[8.5px] uppercase tracking-wider"
              style={{
                color: "var(--color-status-archived)",
                background:
                  "color-mix(in srgb, var(--color-status-archived) 12%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--color-status-archived) 25%, transparent)",
              }}
            >
              neregistrováno
            </Badge>
          )}
          {f.fileId && !renaming && !readOnly && (
            <span
              className={
                "ml-auto gap-1 " +
                (confirmingDelete || busy ? "flex" : "hidden group-hover:flex")
              }
            >
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => {
                  setDraft(f.filename);
                  setRenaming(true);
                }}
                title="Přejmenovat"
                className="text-muted-foreground"
              >
                Přejmenovat
              </Button>
              <Button
                variant="destructive"
                size="xs"
                disabled={busy}
                onClick={handleDeleteClick}
                title={
                  confirmingDelete
                    ? "Smaže soubor i z remote úložiště"
                    : "Smazat"
                }
                className={confirmingDelete ? "font-medium" : undefined}
              >
                {confirmingDelete ? "Opravdu smazat?" : "Smazat"}
              </Button>
              {sync?.sync_class === "conflict" && (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => act("keep_local")}
                    disabled={busy}
                    title="Nahrát lokální verzi na remote"
                    className="text-muted-foreground"
                  >
                    Ponechat lokální
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => act("take_remote")}
                    disabled={busy}
                    title="Přepsat lokální kopii verzí z remote"
                    className="text-muted-foreground"
                  >
                    Vzít z remote
                  </Button>
                </>
              )}
              {isCentralMode && sync?.sync_class === "deleted_local" && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => act("restore")}
                  disabled={busy}
                  title="Stáhnout znovu z remote"
                  className="text-muted-foreground"
                >
                  Obnovit
                </Button>
              )}
            </span>
          )}
        </div>
        {(rowError ?? runError) && (
          <div
            className="mt-0.5 truncate text-[11px]"
            title={rowError ?? runError ?? undefined}
            style={{ color: "var(--color-danger)" }}
          >
            {rowError ?? runError}
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

// Local-workspace hint for the Files tab. Rendered by DetailPane above the
// sync bar so it shows even on a node with zero files (where SyncBar is not
// mounted). A local workspace never holds a remote (#310), so this shows
// unconditionally for one; central mode syncs through the server and never
// shows it.
export function LocalWorkspaceFilesBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const ws = (await listWorkspaces()).find((w) => w.active);
      if (alive && ws && ws.data_mode !== "central") setShow(true);
    })().catch(() => {
      /* workspace lookup failed; leave the banner hidden */
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!show) return null;
  return (
    <div className="mb-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px] text-[var(--color-text-dim)]">
      Soubory se ukládají jen lokálně na tento počítač a nesdílejí se. Sdílení
      souborů vyžaduje připojení k týmu (centrální režim).
    </div>
  );
}

// Recent mirror-watcher failures for this node (#202). Rendered alongside
// LocalWorkspaceFilesBanner/NoMirrorBanner so it shows even on a node with
// zero tracked files -- that is exactly the state a registration failure
// (e.g. the #201 "no remote configured" bug) used to look like from the UI.
export function WatcherErrorBanner({ errors }: { errors: WatcherErrorEntry[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="mb-3 rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
      <div className="mb-1 font-medium">
        Sledování souborů hlásí {errors.length === 1 ? "chybu" : "chyby"} u tohoto uzlu:
      </div>
      <ul className="flex flex-col gap-0.5">
        {errors.map((e) => (
          <li key={e.path} className="min-w-0 truncate font-mono text-[11.5px]">
            {e.path}: {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Compact one-line outcome of a sync run for SyncBar's transient inline
// Per-file errors of a sync run, keyed by file id, for the rows themselves
// (FileTree.runErrors). Exported for the DetailPane wiring and tests.
export function syncRunErrorsByFile(result: SyncRunResponse | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!result) return out;
  for (const e of result.errors) out.set(e.file_id, e.error);
  for (const p of result.pending_repairs) {
    if (!out.has(p.file_id)) out.set(p.file_id, `Nedokončeno (${p.op}): ${p.last_error ?? "?"}`);
  }
  return out;
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
  const { pending, conflicts, deletedLocal, remoteMissing, noWork } = syncBarState(
    Array.from(statusMap.values(), (f) => f.sync_class),
    statusLoaded,
  );
  const ready = statusLoaded;

  const label = running
    ? "Synchronizuji..."
    : !ready
    ? "Synchronizovat soubory"
    : noWork
    // Nothing pending locally, but the button stays actionable (#313): a run's
    // remote sweep is the only way to discover a file that showed up on Drive
    // out of band, so a node with no records yet (or one that's fully clean)
    // must still be able to trigger one instead of reading as a dead end.
    ? "Zkontrolovat remote"
    : pending > 0
    ? `Synchronizovat (${syncPendingLabel(pending)})`
    : remoteMissing > 0
    // Nothing to push or pull, but these records' remote state has never been
    // established -- a run's reconcile pass is the only thing that asks.
    ? "Zkontrolovat na remote"
    : "Synchronizovat soubory";

  // Transient outcome line (#267): a run's result/error used to render as a
  // detached, permanent box under the toolbar. It now shows briefly inline,
  // next to the button, then fades -- driven off `result`/`error` reference
  // changes rather than their mere presence (the parent keeps the last run
  // around, this component decides how long it stays visible).
  const [showOutcome, setShowOutcome] = useState(false);
  const outcomeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outcome = error
    ? { text: `Chyba: ${error}`, hasError: true, detail: null }
    : result
      ? summarizeSyncRun(result)
      : null;
  useEffect(() => {
    if (!result && !error) return;
    setShowOutcome(true);
    if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    // A clean outcome fades; one with errors stays until the next run
    // starts (the parent resets result/error then), so what failed is not
    // gone from the screen after five seconds.
    if (!outcome?.hasError) {
      outcomeTimer.current = setTimeout(() => setShowOutcome(false), 5000);
    }
  }, [result, error]);
  useEffect(
    () => () => {
      if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    },
    [],
  );

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRun} disabled={running}>
          <RefreshCw className={running ? "animate-spin" : undefined} />
          {label}
        </Button>
        {conflicts > 0 && (
          <Badge
            variant="outline"
            className="font-mono text-[8.5px] uppercase tracking-wider"
            style={{
              color: "var(--color-danger)",
              background:
                "color-mix(in srgb, var(--color-danger) 12%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--color-danger) 25%, transparent)",
            }}
            title="Konflikt: vyber verzi u souboru (Ponechat lokální / Vzít z remote)."
          >
            {conflicts} konflikt{conflicts === 1 ? "" : "y"}
          </Badge>
        )}
        {deletedLocal > 0 && (
          <Badge
            variant="outline"
            className="font-mono text-[8.5px] uppercase tracking-wider"
            style={{
              color: "var(--color-status-archived)",
              background:
                "color-mix(in srgb, var(--color-status-archived) 12%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--color-status-archived) 25%, transparent)",
            }}
            title="Smazáno lokálně: Obnovit stáhne kopii znovu, Smazat odstraní soubor všude."
          >
            {deletedLocal} smazáno lokálně
          </Badge>
        )}
        {showOutcome && outcome && (
          <span
            className="flex min-w-0 items-center gap-1 text-[11.5px] transition-opacity duration-300"
            title={outcome.detail ?? undefined}
            style={{ color: outcome.hasError ? "var(--color-danger)" : "var(--color-text-dim)" }}
          >
            <span className="truncate">{outcome.text}</span>
            {/* A failing outcome does not fade, so without this its only way
                off the screen is starting another run -- which is exactly
                what a user who just resolved the rows by hand is not about
                to do. */}
            {outcome.hasError && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowOutcome(false)}
                title="Skrýt"
                aria-label="Skrýt výsledek synchronizace"
                className="shrink-0 opacity-60 hover:opacity-100"
              >
                <X />
              </Button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// Shown in the Files tab when the node has no local mirror on this device:
// there is nowhere to pull into, so SyncBar stays hidden and this offers the
// same createMirrorAndRefresh flow as the header's CreateMirrorButton
// (DetailPane.tsx) — create only, no implicit sync. Once the mirror exists
// SyncBar takes over and the user triggers the actual pull explicitly.
export function NoMirrorBanner({
  pending,
  error,
  onCreate,
}: {
  pending: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  return (
    <div className="mb-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px]">
      <div className="mb-1.5 text-[var(--color-text-dim)]">
        Tento uzel nemá na tomto počítači pracovní složku – soubory jsou
        zatím jen na vzdáleném úložišti.
      </div>
      <Button variant="outline" size="sm" onClick={onCreate} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Folder />}
        {pending ? "Vytvářím…" : "Vytvořit pracovní složku"}
      </Button>
      {error && (
        <div className="mt-1.5" style={{ color: "var(--color-danger)" }}>
          Chyba: {error}
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
    <Badge
      variant="outline"
      title={tip}
      className="font-mono text-[8.5px] uppercase tracking-wider"
      style={{
        color: cssVar,
        background: `color-mix(in srgb, ${cssVar} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${cssVar} 25%, transparent)`,
      }}
    >
      {SYNC_LABEL[sync.sync_class]}
    </Badge>
  );
}

const SYNC_LABEL: Record<SyncClass, string> = {
  clean: "synced",
  push: "push",
  pull: "pull",
  conflict: "conflict",
  remote_missing: "chybí na remote",
  remote_error: "remote nedostupný",
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
    case "remote_missing":
    case "remote_error":
      return "var(--color-status-archived)";
    case "native":
      return "var(--color-accent)";
  }
}

// "Nový úkol" (#374, "Starting a task"): one click, no modal -- opens an
// empty thread (POST /sessions with no brief, a draft) and hands it back
// through onSessionStarted with run: null. The composer's first message is
// what picks a runner/instance and starts the run (server-side,
// session-runtime.ts's promoteDraftAndStart); there is nothing left to ask
// up front. Renders nothing for organization nodes (no working-folder
// concept there).
export function NewTaskButton({
  node,
  onSessionStarted,
}: {
  node: NodeDetail;
  onSessionStarted?: (result: { session: SessionSummary; run: SessionRunRow | null }) => void;
}) {
  const [starting, setStarting] = useState(false);

  const handleClick = async () => {
    setStarting(true);
    try {
      const session = await startDraftThread(node.id);
      onSessionStarted?.({ session, run: null });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Button
      onClick={() => void handleClick()}
      disabled={starting}
      title="Otevře prázdné vlákno, kam agentovi zadáš úkol."
      className="w-full"
    >
      <Plus />
      Nový úkol
    </Button>
  );
}
