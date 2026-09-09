// File tree + sync display + ActionButtons. Split from DetailPane.tsx
// to give the file-browsing UI its own home. Components here render
// `node.files` as a collapsible tree, badge each file with its sync
// class, summarise pending sync state in a banner, and expose the
// "open in agent" / archive node action buttons.

import { useEffect, useMemo, useRef, useState } from "react";
import { loadShowtimeEnabled } from "../lib/settings";
import { isShowtimePath } from "../lib/showtime";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type {
  DetailFile,
  NodeDetail,
  SyncClass,
  SyncRunResponse,
  SyncStatusFile,
  UntrackedFile,
  WatcherErrorEntry,
} from "../types";
import { buildAgentCommand } from "../lib/prompt";
import { agentDisplayName, loadCollapsedFolders, saveCollapsedFolders } from "../lib/settings";
import { createNodeMirror, fetchNodeFileUrl } from "../api";
import type { ResolveAction } from "../api";
import { isTauri, openInFinder } from "../lib/backend-url";
import { getCachedDriveStatus } from "../lib/sync-drive";
import { listWorkspaces } from "../lib/workspaces";
import { listProfiles, type ProfileInfo } from "../lib/profiles";
import { copyText } from "../lib/clipboard";

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
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-50"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
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
      {error && (
        <div className="mt-1 text-[11px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </div>
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
              nodeId={nodeId}
              syncStatus={syncStatus}
              syncLoaded={syncLoaded}
              onOpenFile={onOpenFile}
              onRename={onRename}
              onDelete={onDelete}
              onResolve={onResolve}
              readOnly={readOnly}
              runErrors={runErrors}
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
    <button
      type="button"
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
      className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

// Fetches the file's Drive URL on demand (server resolves the opaque id)
// and copies it. Only meaningful for registered, synced files.
function CopyDriveLinkButton({ nodeId, fileId }: { nodeId: string; fileId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "none">("idle");
  return (
    <button
      type="button"
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
      className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
    >
      {state === "copied" ? <Check size={11} /> : <Link2 size={11} />}
    </button>
  );
}

// Shared class for the row's plain (non-destructive) text actions --
// Přejmenovat's class, reused for the resolve buttons below.
const ACTION_BTN =
  "text-[11px] text-[var(--color-text-dim)] hover:text-[var(--color-text)] disabled:opacity-50";

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
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
      style={{
        color: "var(--color-accent)",
        background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--color-accent) 25%, transparent)",
      }}
    >
      <Loader2 size={9} className="animate-spin" />
      {ROW_BUSY_LABEL[action]}
    </span>
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
              title={
                showtimeDeck
                  ? "Otevřít náhled prezentace"
                  : editable
                    ? "Otevřít v editoru"
                    : "Tento soubor nelze editovat"
              }
              className={
                "truncate text-left text-[13.5px] text-[var(--color-text)] " +
                (editable ? "hover:underline" : "cursor-default opacity-70")
              }
              style={busy ? { opacity: 0.5 } : undefined}
            >
              {f.filename}
            </button>
          )}
          {f.local_path && (
            <span className="opacity-0 group-hover:opacity-100">
              <CopyPathButton value={f.local_path} title="Kopírovat cestu k souboru" />
            </span>
          )}
          {f.local_path && isTauri() && (
            <span className="opacity-0 group-hover:opacity-100">
              <button
                type="button"
                title="Otevřít na disku"
                onClick={(e) => {
                  e.stopPropagation();
                  void openInFinder(f.local_path!, true).catch(() => undefined);
                }}
                className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              >
                <FolderOpen size={11} />
              </button>
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
                (confirmingDelete || busy ? "flex" : "hidden group-hover:flex")
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
                className={ACTION_BTN}
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
                  "text-[11px] disabled:opacity-50 " +
                  (confirmingDelete
                    ? "font-medium text-[var(--color-danger)]"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-danger)]")
                }
              >
                {confirmingDelete ? "Opravdu smazat?" : "Smazat"}
              </button>
              {sync?.sync_class === "conflict" && (
                <>
                  <button
                    type="button"
                    onClick={() => act("keep_local")}
                    disabled={busy}
                    title="Nahrát lokální verzi na remote"
                    className={ACTION_BTN}
                  >
                    Ponechat lokální
                  </button>
                  <button
                    type="button"
                    onClick={() => act("take_remote")}
                    disabled={busy}
                    title="Přepsat lokální kopii verzí z remote"
                    className={ACTION_BTN}
                  >
                    Vzít z remote
                  </button>
                </>
              )}
              {sync?.sync_class === "deleted_local" && (
                <button
                  type="button"
                  onClick={() => act("restore")}
                  disabled={busy}
                  title="Stáhnout znovu z remote"
                  className={ACTION_BTN}
                >
                  Obnovit
                </button>
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

// Local-only hint for the Files tab. Rendered by DetailPane above the sync
// bar so it shows even on a node with zero files (where SyncBar is not
// mounted) — that empty state is exactly when the "connect Drive first"
// nudge is most useful. Only for local-mode workspaces that have never
// connected Google Drive; central-mode syncs through the server. Cached per
// session (getCachedDriveStatus) so every node's Files tab shares one fetch.
export function DriveNotConfiguredBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const ws = (await listWorkspaces()).find((w) => w.active);
      if (!ws || ws.data_mode === "central") return;
      const s = await getCachedDriveStatus();
      if (alive && s && !s.configured) setShow(true);
    })().catch(() => {
      /* workspace/status lookup failed; leave the banner hidden */
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!show) return null;
  return (
    <div className="mb-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px] text-[var(--color-text-dim)]">
      Soubory se ukládají jen lokálně – propoj Google Drive v{" "}
      <a
        href="/?settingsTab=sync"
        className="text-[var(--color-accent)] hover:underline"
      >
        Nastavení → Synchronizace
      </a>
      .
    </div>
  );
}

// Recent mirror-watcher failures for this node (#202). Rendered alongside
// DriveNotConfiguredBanner/NoMirrorBanner so it shows even on a node with
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
// status (#267) -- deliberately short (counts only, no filename lists):
// this fades after a few seconds, it is not the place for a full report.
// Persistent state (conflicts, deleted_local) already has its own pill next
// to the button, so it is not repeated here as a permanent element -- only
// as part of this transient line, which is fine since it disappears too.
function summarizeSyncRun(result: SyncRunResponse): {
  text: string;
  hasError: boolean;
  detail: string | null;
} {
  const parts: string[] = [];
  if (result.pushed.length > 0) parts.push(`Push ${result.pushed.length}`);
  if (result.pulled.length > 0) parts.push(`Pull ${result.pulled.length}`);
  if (result.adopted.length > 0) parts.push(`Zaregistrováno ${result.adopted.length}`);
  if (result.adopted_remote.length > 0) parts.push(`Nové z remote ${result.adopted_remote.length}`);
  if (result.conflicts.length > 0) {
    parts.push(`${result.conflicts.length} konflikt${result.conflicts.length === 1 ? "" : "y"}`);
  }
  if (result.deleted_local.length > 0) parts.push(`smazáno lokálně ${result.deleted_local.length}`);
  if (result.deleted_remote.length > 0) parts.push(`uklizeno ${result.deleted_remote.length}`);
  if (result.deleted_on_remote.length > 0) {
    parts.push(`smazáno na remote ${result.deleted_on_remote.length}`);
  }
  if (result.repaired.length > 0) parts.push(`opraveno ${result.repaired.length}`);
  const hasError =
    result.errors.length > 0 || result.sweep_errors.length > 0 || result.pending_repairs.length > 0;
  if (result.pending_repairs.length > 0) parts.push(`nedokončeno ${result.pending_repairs.length}`);
  if (result.sweep_errors.length > 0) parts.push(`kontrola remote selhala (${result.sweep_errors.length})`);
  if (result.errors.length > 0) parts.push(`chyby ${result.errors.length}`);
  // Full per-item detail for the title tooltip: the line above is counts
  // only, and the sync-run errors that have no row of their own (sweep
  // errors are keyed by remote path) would otherwise be lost.
  const detail = [
    ...result.errors.map((e) => `${e.filename}: ${e.error}`),
    ...result.pending_repairs.map((p) => `${p.op} (${p.attempts}x): ${p.last_error ?? "?"}`),
    ...result.sweep_errors.map((e) => `${e.remote_path}: ${e.error}`),
  ];
  if (parts.length === 0) return { text: "Vše synchronizováno", hasError: false, detail: null };
  return { text: parts.join(" · "), hasError, detail: detail.length > 0 ? detail.join("\n") : null };
}

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
            title="Konflikt: vyber verzi u souboru (Ponechat lokální / Vzít z remote)."
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
            title="Smazáno lokálně: Obnovit stáhne kopii znovu, Smazat odstraní soubor všude."
          >
            {deletedLocal} smazáno lokálně
          </span>
        )}
        {showOutcome && outcome && (
          <span
            className="truncate text-[11.5px] transition-opacity duration-300"
            title={outcome.detail ?? undefined}
            style={{ color: outcome.hasError ? "var(--color-danger)" : "var(--color-text-dim)" }}
          >
            {outcome.text}
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
      <button
        type="button"
        onClick={onCreate}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] text-[var(--color-text)] transition-colors hover:border-[var(--color-border-strong)] disabled:cursor-default disabled:opacity-60"
      >
        {pending ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Folder size={12} />
        )}
        {pending ? "Vytvářím…" : "Vytvořit pracovní složku"}
      </button>
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

// Split button that merges two terminal-launch controls into one:
//   - Left (primary): opens an embedded terminal inside Portuni.
//   - Right (chevron): dropdown with "Otevřít v externím terminálu" that
//     triggers the same external-launch flow as ActionButtons.
// Renders nothing for organization nodes (no working-folder concept there).
//
// selectedProfileId only reaches the embedded launch (onEmbeddedOpen) --
// handleExternalLaunch's launch_claude_for_node command has no profile_id
// parameter at all today, so picking a profile and then choosing "Otevřít v
// externím terminálu" silently spawns without it (#207). Deliberately not
// fixed here: profile threading is Claude-only for now (the same scope cut
// as X-Portuni-Profile, write-scope.ts's buildClaudeMcpJson -- Codex/Vibe
// have no equivalent per-spawn config-expansion mechanism), and the
// external-launch path doesn't inject even the existing MCP-token/
// PORTUNI_PROFILE_ID env pty_spawn does, so wiring just the profile through
// would be an inconsistent half-fix. Extending profile support to Codex/
// Vibe and to this external-launch path is future work.
export function TerminalSplitButton({
  node,
  agentCommand,
  terminalLaunch,
  onEmbeddedOpen,
  embeddedPending,
}: {
  node: NodeDetail;
  agentCommand: string;
  terminalLaunch: string;
  onEmbeddedOpen: (profileId?: string | null) => void | Promise<void>;
  embeddedPending: boolean;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [externalState, setExternalState] = useState<LaunchState>({ kind: "idle" });
  const containerRef = useRef<HTMLDivElement>(null);

  // CLI spawn profiles (phase 3, spawn UX): self-fetched, same convention as
  // AccessSection/SessionsSection. Zero registered profiles keeps this
  // whole block invisible; the picker itself only renders with >=2, per
  // spec -- with exactly one, the org default (if set) still applies
  // silently, there just isn't a UI to override it per spawn.
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const orgId = node.edges.find(
    (e) => e.relation === "belongs_to" && e.direction === "outgoing" && e.peer_type === "organization",
  )?.peer_id;
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listProfiles()
        .then((data) => {
          if (cancelled) return;
          setProfiles(data.profiles);
          const def = orgId ? (data.default_by_org[orgId] ?? null) : null;
          setSelectedProfileId(def && data.profiles.some((p) => p.id === def) ? def : null);
        })
        .catch(() => {
          // No profiles registered (or outside Tauri) -- the picker stays hidden.
        });
    };
    load();
    window.addEventListener("portuni:profiles-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("portuni:profiles-changed", load);
    };
  }, [orgId]);

  // Close dropdown when user clicks outside the split button.
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // Close dropdown on Escape key.
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [dropdownOpen]);

  const handleExternalLaunch = async () => {
    setDropdownOpen(false);
    setExternalState({ kind: "pending" });
    try {
      const { local_path } = await createNodeMirror(node.id);
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
          setExternalState({ kind: "launched" });
          setTimeout(() => setExternalState({ kind: "idle" }), 2000);
          return;
        } catch (err) {
          const msg = String(err);
          if (msg.includes("UNSUPPORTED_OS")) {
            // Linux / Windows in Tauri build — fall through to clipboard.
          } else {
            setExternalState({ kind: "error", message: msg });
            setTimeout(() => setExternalState({ kind: "idle" }), 3500);
            return;
          }
        }
      }

      await copyText(cmd);
      setExternalState({ kind: "copied" });
      setTimeout(() => setExternalState({ kind: "idle" }), 1800);
    } catch (err) {
      setExternalState({ kind: "error", message: String(err) });
      setTimeout(() => setExternalState({ kind: "idle" }), 3500);
    }
  };

  const agentName = agentDisplayName(agentCommand);

  const externalLabel = (() => {
    switch (externalState.kind) {
      case "pending":
        return "Spouštím…";
      case "launched":
        return "Spuštěno v Terminal.app";
      case "copied":
        return "Zkopírováno — paste do svého terminálu";
      case "error":
        return externalState.message;
      default:
        return "Otevřít v externím terminálu";
    }
  })();

  const externalIcon = (() => {
    switch (externalState.kind) {
      case "pending":
        return <Loader2 size={12} className="animate-spin" />;
      case "launched":
        return <Check size={12} />;
      case "copied":
        return <Copy size={12} />;
      default:
        return <ExternalLink size={12} />;
    }
  })();

  const primaryDisabled = embeddedPending || externalState.kind === "pending";

  return (
    <div ref={containerRef} className="relative">
      <div className="flex">
        {/* Primary action: open embedded terminal inside Portuni */}
        <button
          type="button"
          onClick={() => void onEmbeddedOpen(selectedProfileId)}
          disabled={primaryDisabled}
          title={`Otevře terminál v Práci a spustí v něm ${agentName}. Pracovní složka bude vytvořena, pokud ještě neexistuje.${
            selectedProfileId
              ? ` Profil: ${profiles.find((p) => p.id === selectedProfileId)?.label ?? selectedProfileId}.`
              : ""
          }`}
          className="flex flex-1 items-center justify-center gap-2 rounded-l-md border border-r-0 border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-4 py-2.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-all hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--color-accent-dim)] disabled:hover:bg-[var(--color-accent-dim)]/15"
        >
          {embeddedPending ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              Spouštím terminál…
            </>
          ) : (
            "Otevřít terminál v Portuni"
          )}
        </button>
        {/* Chevron trigger for the external-launch dropdown */}
        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          disabled={primaryDisabled}
          title="Další možnosti spuštění"
          aria-label="Další možnosti spuštění"
          className="flex items-center justify-center rounded-r-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-2.5 text-[var(--color-accent)] transition-all hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)] disabled:cursor-default disabled:opacity-60"
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {/* Dropdown: positioned above the button bar */}
      {dropdownOpen && (
        <div className="absolute bottom-full left-0 mb-1 min-w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
          {profiles.length >= 2 && (
            <div className="border-b border-[var(--color-border)] px-3 py-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                Profil pro spuštění
              </div>
              <select
                value={selectedProfileId ?? ""}
                onChange={(e) => setSelectedProfileId(e.target.value || null)}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
              >
                <option value="">(bez profilu)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleExternalLaunch()}
            disabled={externalState.kind === "pending"}
            title={
              isTauri()
                ? `Otevře Terminal.app v pracovní složce a spustí ${agentName}.`
                : `Zkopíruje shell příkaz pro vstup do složky a spuštění ${agentName}.`
            }
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-text)] hover:bg-[var(--color-surface)] disabled:opacity-60"
          >
            <span className="text-[var(--color-text-dim)]">{externalIcon}</span>
            <span className="truncate">{externalLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}
