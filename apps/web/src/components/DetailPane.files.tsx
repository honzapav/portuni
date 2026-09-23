// File tree + sync display + ActionButtons. Split from DetailPane.tsx
// to give the file-browsing UI its own home. Components here render
// `node.files` as a collapsible tree, badge each file with its sync
// class, summarise pending sync state in a banner, and expose the
// "open in agent" / archive node action buttons.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  FolderPlus,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { DragEvent as ReactDragEvent } from "react";
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
import {
  applyPlan,
  planFolderMove,
  planFolderRename,
  planMove,
  orderMoves,
  planApplyCount,
  planChangeCount,
  pruneEmptyFolders,
  EMPTY_PLAN,
  type FilePlan,
  type MoveTarget,
  type PlanResult,
} from "../lib/file-plan";
import {
  applyMoves,
  createHoverExpand,
  dropTargetFolder,
  fileDragCheck,
  folderActionCheck,
  NO_MIRROR_REASON,
  folderDragCheck,
  type FolderActions,
} from "../lib/file-drag";
import { pluralChanges } from "../lib/plural";
import {
  aggregateFolderSync,
  buildFileTree,
  isSectionRoot,
  sortChildren,
  type TreeFile,
  type TreeNode,
} from "../lib/file-tree";
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

// Text-ish files are clickable to edit. Mirrors the backend editable rule.
export function isEditableFile(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return false;
}

// Merge registered + untracked into one row list. Registered wins if a path
// appears in both (a freshly-adopted file may briefly show in both).
//
// A team workspace serves node-detail without device-derived paths
// (relative_path/local_path null, because the central server has no device
// state). Recover them from the per-node sync-status entry + the device
// mirror: a file's relative_path is its path within the mirror, i.e. its
// absolute local_path minus the mirror-root prefix -- the same strip
// node-detail does server-side in a personal workspace. Without this,
// registered files fall back to a bare filename and open at the wrong path.
export function toTreeFiles(
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

// "Nová složka" / "Nová podsložka" (#448): the same inline form as
// NewFileForm, with a path instead of a filename. It creates nothing
// anywhere -- a valid path is a virtual folder in the plan, a row in the
// tree and nothing else until an applied move puts a file in it (rule 4).
// Validation is planFolder's: onSubmit returns its refusal, or null when the
// path was taken into the plan.
export function NewFolderForm({
  initialPath,
  onSubmit,
  onCancel,
}: {
  // "wip/" from the toolbar, "<folder>/" from a folder row's "Nová
  // podsložka".
  initialPath: string;
  onSubmit: (path: string) => string | null;
  onCancel: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const refusal = onSubmit(path.trim());
    setError(refusal);
  };
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Cesta nové složky (např. wip/archiv)"
          className="min-w-0 flex-1"
        />
        <Button size="sm" disabled={!path.trim()} onClick={submit} className="shrink-0">
          Vytvořit
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

// The toolbar button beside "Nový soubor" that opens the form above
// (mockup, frame 5). Disabled without a mirror on this device (rule 9):
// there is nowhere for the folder to ever become real.
export function NewFolderButton({
  hasMirror,
  onClick,
}: {
  hasMirror: boolean;
  onClick: () => void;
}) {
  const reason = hasMirror ? undefined : NO_MIRROR_REASON;
  return (
    // The title lives on the wrapper: a disabled button gets no pointer
    // events, so its own title never shows.
    <span title={reason} className="shrink-0">
      <Button variant="outline" size="sm" disabled={!hasMirror} onClick={onClick} title={reason}>
        <FolderPlus />
        Nová složka
      </Button>
    </span>
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

// --- The move plan's UI (#447) ---------------------------------------------
//
// Dragging, the plan bar and "Použít" all live in the tree: the plan is the
// node's own state on this device (rule 8), laid over freshly polled detail
// on every render through applyPlan (rule 3). What a drop is allowed to do
// is decided by the pure helpers in lib/file-plan.ts and lib/file-drag.ts.

// What the drag source is while a row is being dragged. Held in state, not
// in dataTransfer: getData() is unreadable during dragover, which is exactly
// where the target has to decide whether it accepts the drop.
type DragSource =
  | { kind: "file"; fileId: string }
  | { kind: "folder"; path: string };

// Everything a row needs to take part in a drag, built per row by FileTree.
type RowDrag = {
  draggable: boolean;
  // Why the row cannot be dragged (rules 5 and 9), shown as its title.
  dragTitle: string | null;
  dragging: boolean;
  // This row is the target under the cursor and the drop is allowed.
  highlighted: boolean;
  // The refusal to show as this row's title while it is under the cursor.
  refusal: string | null;
  onDragStart?: (e: ReactDragEvent) => void;
  onDragEnd?: () => void;
  onDragOver: (e: ReactDragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent) => void;
};

const NO_DRAG: RowDrag = {
  draggable: false,
  dragTitle: null,
  dragging: false,
  highlighted: false,
  refusal: null,
  onDragOver: () => undefined,
  onDragLeave: () => undefined,
  onDrop: () => undefined,
};

// The plan's per-row facts, passed down the tree as one prop.
type PlanUi = {
  rowDrag: (node: TreeNode, kind: "file" | "folder" | "section") => RowDrag;
  isVirtual: (path: string) => boolean;
  moveState: (fileId: string | null) => "moving" | "error" | null;
  moveError: (fileId: string | null) => string | null;
  // The hover strip on a folder row (#448): what it offers and what each
  // action does. `onRename` plans the rename and answers with the refusal to
  // show under the row, or null when it was taken into the plan.
  folderActions: (path: string) => FolderActions;
  onFolderRename: (path: string, newName: string) => string | null;
  onNewSubfolder: (path: string) => void;
};

const NO_FOLDER_ACTIONS: FolderActions = {
  visible: false,
  rename: { enabled: false, reason: null },
  subfolder: { enabled: false, reason: null },
};

const NO_PLAN_UI: PlanUi = {
  rowDrag: () => NO_DRAG,
  isVirtual: () => false,
  moveState: () => null,
  moveError: () => null,
  folderActions: () => NO_FOLDER_ACTIONS,
  onFolderRename: () => null,
  onNewSubfolder: () => undefined,
};

// The accent-soft fill plus the 1 px accent inset ring a valid drop target
// wears while the cursor is over it (spec, Dragging).
const DROP_TARGET_CLASS =
  "bg-[var(--color-accent-soft)] shadow-[inset_0_0_0_1px_var(--color-accent)]";

const DRAG_IMAGE_ICON = {
  file: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>',
  folder:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
};

// A small label with the icon and the name instead of the browser's own
// screenshot of the row, which in a tree of full-width rows is a smear.
function setDragImage(e: ReactDragEvent, kind: "file" | "folder", name: string): void {
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "top:-1000px",
    "left:-1000px",
    "display:inline-flex",
    "align-items:center",
    "gap:6px",
    "padding:4px 8px",
    "border-radius:6px",
    "font-size:12px",
    "background:var(--color-surface)",
    "color:var(--color-text)",
    "border:1px solid var(--color-accent)",
  ].join(";");
  el.innerHTML = DRAG_IMAGE_ICON[kind];
  el.appendChild(document.createTextNode(name));
  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, 8, 12);
  // The browser snapshots the element synchronously; a task later it is only
  // in the way.
  setTimeout(() => el.remove(), 0);
}

type ApplyState =
  | { phase: "idle" }
  | { phase: "applying"; index: number; total: number; fileId: string | null }
  | { phase: "failed"; fileId: string; filename: string; message: string };

const IDLE_APPLY: ApplyState = { phase: "idle" };

// The bar between the toolbar and the tree, up while the plan holds anything
// -- a planned move or a virtual folder (rule 1, #452): the count and
// "Zahodit" / "Použít", the progress while applying, and the danger colours
// with "Použít znovu" after a failure (mockup, frames 4 and 6). "Použít" is
// disabled while there is no move to run.
function PlanBar({
  count,
  canApply,
  state,
  onDiscard,
  onApply,
}: {
  count: number;
  canApply: boolean;
  state: ApplyState;
  onDiscard: () => void;
  onApply: () => void;
}) {
  const applying = state.phase === "applying";
  const failed = state.phase === "failed";
  const noun = pluralChanges(count);
  const waits = count >= 2 && count <= 4 ? "čekají" : "čeká";
  const stays = count >= 2 && count <= 4 ? "zůstávají" : "zůstává";
  return (
    <div
      className="mb-3 flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px]"
      style={
        failed
          ? {
              background: "var(--color-danger-bg)",
              borderColor: "var(--color-danger-border)",
            }
          : {
              background: "var(--color-accent-soft)",
              borderColor: "color-mix(in srgb, var(--color-accent) 30%, transparent)",
            }
      }
    >
      <span className="min-w-0 flex-1 text-[var(--color-text)]">
        {applying ? (
          <>
            Přesouvám{" "}
            <b className="font-medium">
              {state.index + 1} / {state.total}
            </b>
          </>
        ) : failed ? (
          <>
            Použití se zastavilo u <b className="font-medium">{state.filename}</b>.{" "}
            <b className="font-medium">
              {count} {noun}
            </b>{" "}
            {stays} v plánu.
          </>
        ) : (
          <>
            <b className="font-medium">
              {count} {noun}
            </b>{" "}
            {waits} na použití
          </>
        )}
      </span>
      <Button variant="ghost" size="sm" disabled={applying} onClick={onDiscard}>
        Zahodit
      </Button>
      <Button
        size="sm"
        disabled={applying || !canApply}
        title={canApply ? undefined : "Nová složka vznikne s prvním souborem, který do ní přesuneš"}
        onClick={onApply}
      >
        {applying && <Loader2 className="animate-spin" />}
        {applying ? "Používám" : failed ? "Použít znovu" : "Použít"}
      </Button>
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
  hasMirror,
  onOpenFile,
  onRename,
  onDelete,
  onResolve,
  onMove,
  onApplied,
  plan,
  onPlanChange,
  onNewSubfolder,
  readOnly,
  runErrors,
  isCentralMode,
}: {
  files: DetailFile[];
  untracked: UntrackedFile[];
  nodeId: string;
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
  // The node's device mirror root, used to recover file relative paths in a
  // team workspace (node-detail omits them there). Null when unknown.
  mirrorPath: string | null;
  // Rule 9: without a mirror on this device nothing can be relocated, so no
  // row is draggable and every one says why in its title.
  hasMirror?: boolean;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  onResolve: (fileId: string, action: ResolveAction) => Promise<void>;
  // One planned file, one call to the move route (rule 2).
  onMove?: (fileId: string, target: MoveTarget) => Promise<unknown>;
  // Detail + sync status refetch after "Použít", as rename does.
  onApplied?: () => Promise<void>;
  // The move plan (#448): owned by the Files tab, because "Nová složka" in
  // the toolbar writes to the same plan this tree renders.
  plan: FilePlan;
  onPlanChange: (next: FilePlan) => void;
  // A folder row's "Nová podsložka" opens the toolbar's form prefilled with
  // that folder's path.
  onNewSubfolder?: (folderPath: string) => void;
  // When true, hide rename/delete actions (e.g. a team workspace).
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
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedFolders(nodeId));
  const [applyState, setApplyState] = useState<ApplyState>(IDLE_APPLY);
  const [source, setSource] = useState<DragSource | null>(null);
  // The row under the cursor, the folder its drop would land in, and the
  // refusal when there is one.
  const [hover, setHover] = useState<
    { rowPath: string; targetFolder: string; ok: boolean; reason: string | null } | null
  >(null);
  useEffect(() => {
    setCollapsed(loadCollapsedFolders(nodeId));
    setApplyState(IDLE_APPLY);
    setSource(null);
    setHover(null);
  }, [nodeId]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveCollapsedFolders(nodeId, next);
      return next;
    });

  // Rule 3: the tree is rebuilt from fresh detail on every poll and the plan
  // is laid over it; what applyPlan leaves of the plan is what is saved.
  const planned = useMemo(() => applyPlan(treeFiles, plan), [treeFiles, plan]);
  useEffect(() => {
    if (JSON.stringify(planned.plan) === JSON.stringify(plan)) return;
    onPlanChange(planned.plan);
  }, [planned, plan, onPlanChange]);

  const updatePlan = (next: FilePlan) => onPlanChange(next);
  // A plan edit that moves files also empties the folders they left: a
  // virtual one the edit emptied leaves the plan (rule 4).
  const updateMoves = (next: FilePlan) =>
    onPlanChange(pruneEmptyFolders(plan, next, treeFiles));

  const root = useMemo(
    () => buildFileTree(planned.files, planned.folders),
    [planned],
  );
  // Effective paths of every row, so a target a real or an already planned
  // file occupies is refused at the drop (rule 6).
  const occupied = useMemo(
    () => new Set(planned.files.map((f) => f.relative_path)),
    [planned],
  );
  const virtualFolders = useMemo(() => new Set(planned.folders), [planned]);
  // The plan is keyed by file id and planMove reads the path the file really
  // has today, so the drag works from the original rows, never the planned
  // ones (applying the plan twice would move a file home again).
  const originals = useMemo(() => {
    const map = new Map<string, TreeFile>();
    for (const f of treeFiles) if (f.fileId) map.set(f.fileId, f);
    return map;
  }, [treeFiles]);

  // A collapsed folder expands after the cursor rests on it (spec, Dragging).
  // The callback goes through a ref so the timer is created once.
  const expandLatest = useRef<(path: string) => void>(() => undefined);
  useEffect(() => {
    expandLatest.current = (path: string) =>
      setCollapsed((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        saveCollapsedFolders(nodeId, next);
        return next;
      });
  });
  const hoverExpand = useMemo(() => createHoverExpand((p) => expandLatest.current(p)), []);
  useEffect(() => () => hoverExpand.cancel(), [hoverExpand]);

  const applying = applyState.phase === "applying";

  const evaluate = useCallback(
    (src: DragSource, targetFolder: string): PlanResult => {
      if (src.kind === "file") {
        const file = originals.get(src.fileId);
        if (!file) return { ok: false, reason: "Soubor už neexistuje" };
        return planMove(plan, file, targetFolder, occupied);
      }
      return planFolderMove(plan, src.path, targetFolder, treeFiles, occupied);
    },
    [originals, plan, occupied, treeFiles],
  );

  const endDrag = () => {
    hoverExpand.cancel();
    setSource(null);
    setHover(null);
  };

  const rowDrag = (node: TreeNode, kind: "file" | "folder" | "section"): RowDrag => {
    const isFile = kind === "file";
    const file = node.file;
    const original = file?.fileId ? originals.get(file.fileId) : undefined;
    const check =
      kind === "section"
        ? { draggable: false, reason: null }
        : isFile
          ? fileDragCheck(original ?? file!, hasMirror !== false)
          : folderDragCheck(node.path, planned.files, hasMirror !== false);
    const targetFolder = dropTargetFolder({ path: node.path, isFile });
    const dragging =
      source !== null &&
      (isFile
        ? source.kind === "file" && source.fileId === file?.fileId
        : source.kind === "folder" && source.path === node.path);
    const highlighted =
      !isFile && hover !== null && hover.ok && hover.targetFolder === node.path;
    const refusal = hover !== null && !hover.ok && hover.rowPath === node.path ? hover.reason : null;

    const start = (kind: "file" | "folder", name: string, src: DragSource) => (e: ReactDragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", node.path);
      setDragImage(e, kind, name);
      setSource(src);
    };

    return {
      draggable: check.draggable && !applying,
      dragTitle: check.reason,
      dragging,
      highlighted,
      refusal,
      onDragStart:
        kind === "section" || !check.draggable
          ? undefined
          : isFile
            ? start("file", file!.filename, { kind: "file", fileId: file!.fileId! })
            : start("folder", node.name, { kind: "folder", path: node.path }),
      onDragEnd: endDrag,
      onDragOver: (e: ReactDragEvent) => {
        if (!source || applying) return;
        const result = evaluate(source, targetFolder);
        if (result.ok) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
        e.stopPropagation();
        setHover((prev) =>
          prev && prev.rowPath === node.path && prev.ok === result.ok
            ? prev
            : {
                rowPath: node.path,
                targetFolder,
                ok: result.ok,
                reason: result.ok ? null : result.reason,
              },
        );
        if (result.ok && !isFile && collapsed.has(node.path)) hoverExpand.over(node.path);
        else hoverExpand.cancel();
      },
      onDragLeave: () => {
        hoverExpand.cancel();
        setHover((prev) => (prev && prev.rowPath === node.path ? null : prev));
      },
      onDrop: (e: ReactDragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const src = source;
        endDrag();
        if (!src || applying) return;
        const result = evaluate(src, targetFolder);
        if (result.ok) updateMoves(result.plan);
      },
    };
  };

  // The bar counts every entry waiting to be used (rule 1); „Použít" runs the
  // moves only, so a plan of virtual folders alone keeps the bar -- and with it
  // „Zahodit" -- reachable with „Použít" disabled (#452).
  const planCount = planChangeCount(plan);
  const applyCount = planApplyCount(plan);

  const runApply = async () => {
    if (!onMove || applying || applyCount === 0) return;
    const total = orderMoves(plan).length;
    setApplyState({ phase: "applying", index: 0, total, fileId: null });
    const outcome = await applyMoves(plan, onMove, (progress) =>
      setApplyState({
        phase: "applying",
        index: progress.index,
        total: progress.total,
        fileId: progress.fileId,
      }),
    );
    updatePlan(outcome.plan);
    if (outcome.failure) {
      const failed = originals.get(outcome.failure.fileId);
      setApplyState({
        phase: "failed",
        fileId: outcome.failure.fileId,
        filename: failed?.filename ?? outcome.failure.fileId,
        message: outcome.failure.message,
      });
    } else {
      setApplyState(IDLE_APPLY);
    }
    // Both endings moved files, so the detail and the sync status are stale.
    if (onApplied) await onApplied();
  };

  const planUi: PlanUi = onMove
    ? {
        rowDrag,
        folderActions: (path) => {
          const actions = folderActionCheck(path, planned.files, hasMirror !== false);
          // Nothing edits the plan while it is being applied.
          if (!applying) return actions;
          return {
            visible: actions.visible,
            rename: { enabled: false, reason: null },
            subfolder: { enabled: false, reason: null },
          };
        },
        // A real folder's rename is one planned move per file under it
        // (rule 10); a virtual one is renamed in the plan's folders.
        onFolderRename: (path, newName) => {
          if (applying) return null;
          const result = planFolderRename(plan, path, newName, treeFiles, occupied);
          if (!result.ok) return result.reason;
          updateMoves(result.plan);
          return null;
        },
        onNewSubfolder: (path) => onNewSubfolder?.(path),
        isVirtual: (path) => virtualFolders.has(path),
        moveState: (fileId) => {
          if (!fileId) return null;
          if (applyState.phase === "applying" && applyState.fileId === fileId) return "moving";
          if (applyState.phase === "failed" && applyState.fileId === fileId) return "error";
          return null;
        },
        moveError: (fileId) =>
          fileId && applyState.phase === "failed" && applyState.fileId === fileId
            ? applyState.message
            : null,
      }
    : NO_PLAN_UI;

  const topChildren = sortChildren(root, true);
  return (
    <div>
      {planCount > 0 && onMove && (
        <PlanBar
          count={planCount}
          canApply={applyCount > 0}
          state={applyState}
          onDiscard={() => {
            updatePlan(EMPTY_PLAN);
            setApplyState(IDLE_APPLY);
          }}
          onApply={() => void runApply()}
        />
      )}
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
            planUi={planUi}
          />
        ))}
      </div>
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
  planUi,
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
  planUi: PlanUi;
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
        drag={planUi.rowDrag(node, "file")}
        moveState={planUi.moveState(node.file.fileId)}
        moveError={planUi.moveError(node.file.fileId)}
      />
    );
  }
  const isCollapsed = collapsed.has(node.path);
  const dot = aggregateFolderSync(node, syncStatus);
  const childCount = node.children ? node.children.size : 0;
  const isSection = isSectionRoot(node, depth);
  return (
    <div className={isSection ? "mt-2.5 first:mt-0" : undefined}>
      {isSection ? (
        <SectionHeading
          name={node.name}
          count={childCount}
          isCollapsed={isCollapsed}
          dot={dot}
          onToggle={() => onToggle(node.path)}
          drag={planUi.rowDrag(node, "section")}
        />
      ) : (
        <FolderRow
          name={node.name}
          count={childCount}
          indent={indent}
          isCollapsed={isCollapsed}
          dot={dot}
          onToggle={() => onToggle(node.path)}
          drag={planUi.rowDrag(node, "folder")}
          virtual={planUi.isVirtual(node.path)}
          actions={planUi.folderActions(node.path)}
          onRename={(newName) => planUi.onFolderRename(node.path, newName)}
          onNewSubfolder={() => planUi.onNewSubfolder(node.path)}
        />
      )}
      {!isCollapsed && node.children && (
        <div className="relative">
          {/* Depth is the indent plus a 1 px guide line down the left of a
              folder's children (#446). Section roots are group headings, so
              their files are not fenced by one. */}
          {!isSection && (
            <span
              aria-hidden
              className="absolute top-0.5 bottom-0.5 w-px bg-[var(--color-border)]"
              style={{ left: indent + 15 }}
            />
          )}
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
              planUi={planUi}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type FolderDot = { color: string; title: string } | null;

function SyncDot({ dot }: { dot: NonNullable<FolderDot> }) {
  return (
    <span
      title={dot.title}
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{
        background: dot.color,
        boxShadow: `0 0 6px color-mix(in srgb, ${dot.color} 70%, transparent)`,
      }}
    />
  );
}

// The one-word description each section heading carries after its count.
const SECTION_DESC: Record<string, string> = {
  wip: "rozpracované",
  outputs: "výstupy",
  resources: "podklady",
};

// A section root (wip / outputs / resources) is a group heading, not a
// folder row (#446): body face, weight 500, count then the description, a
// hairline under it, the chevron only for collapsing, the sync dot at the
// right. It cannot be renamed or dragged, so it has no hover actions.
function SectionHeading({
  name,
  count,
  isCollapsed,
  dot,
  onToggle,
  drag,
}: {
  name: string;
  count: number;
  isCollapsed: boolean;
  dot: FolderDot;
  onToggle: () => void;
  // A section root takes drops (it is a folder in the plan's sense) but is
  // never dragged itself.
  drag: RowDrag;
}) {
  return (
    <div
      title={drag.refusal ?? undefined}
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
      className={
        "relative flex items-center rounded px-2 py-1 hover:bg-[var(--color-surface)] " +
        (drag.highlighted ? DROP_TARGET_CLASS : "")
      }
    >
      <button
        type="button"
        onClick={onToggle}
        title={isCollapsed ? "Rozbalit" : "Sbalit"}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {isCollapsed ? (
          <ChevronRight size={12} className="shrink-0 text-[var(--color-text-dim)]" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-[var(--color-text-dim)]" />
        )}
        <span className="min-w-0 truncate font-medium text-[var(--color-text-muted)]">
          {name}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-dim)]">
          {count}
        </span>
        {SECTION_DESC[name] && (
          <span className="shrink-0 text-[11px] text-[var(--color-text-dim)]">
            {SECTION_DESC[name]}
          </span>
        )}
        <span className="flex-1" />
        {dot && <SyncDot dot={dot} />}
      </button>
      <span
        aria-hidden
        className="absolute inset-x-2 -bottom-px h-px bg-[var(--color-border)]"
      />
    </div>
  );
}

// A folder row: the same face and size as a file row (no uppercase, no
// monospace, no tracking), chevron, folder icon, name, count, sync dot,
// then the hover-gated action strip with "Přejmenovat" and "Nová podsložka"
// (#448). Both edit the plan only; a refusal shows under the row.
function FolderRow({
  name,
  count,
  indent,
  isCollapsed,
  dot,
  onToggle,
  drag,
  virtual,
  actions,
  onRename,
  onNewSubfolder,
}: {
  name: string;
  count: number;
  indent: number;
  isCollapsed: boolean;
  dot: FolderDot;
  onToggle: () => void;
  drag: RowDrag;
  // A folder that exists only in the plan (rule 4): dashed icon, dim name,
  // the tag "nová" after the count. It becomes real with its first file.
  virtual: boolean;
  // What the strip offers; a section root has none (it is a group heading).
  actions: FolderActions;
  // Plans the rename; answers with the refusal to show under the row, or
  // null when it was taken into the plan.
  onRename: (newName: string) => string | null;
  onNewSubfolder: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  const startRename = () => {
    setDraft(name);
    setError(null);
    setRenaming(true);
  };
  const cancelRename = () => {
    setRenaming(false);
    setDraft(name);
    setError(null);
  };
  const submitRename = () => {
    const next = draft.trim();
    if (!next || next === name) {
      cancelRename();
      return;
    }
    const refusal = onRename(next);
    if (refusal) {
      setError(refusal); // keep editing so the user can pick another name
      return;
    }
    setRenaming(false);
    setError(null);
  };

  return (
    <div>
      <div
        draggable={drag.draggable && !renaming}
        title={drag.refusal ?? drag.dragTitle ?? undefined}
        onDragStart={drag.onDragStart}
        onDragEnd={drag.onDragEnd}
        onDragOver={drag.onDragOver}
        onDragLeave={drag.onDragLeave}
        onDrop={drag.onDrop}
        className={
          "group flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface)] " +
          (drag.highlighted ? DROP_TARGET_CLASS : "")
        }
        style={{ paddingLeft: indent + 8, opacity: drag.dragging ? 0.45 : undefined }}
      >
        <button
          type="button"
          onClick={onToggle}
          title={isCollapsed ? "Rozbalit" : "Sbalit"}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {isCollapsed ? (
            <ChevronRight size={12} className="shrink-0 text-[var(--color-text-dim)]" />
          ) : (
            <ChevronDown size={12} className="shrink-0 text-[var(--color-text-dim)]" />
          )}
          {virtual ? (
            <Folder
              size={14}
              style={{ strokeDasharray: "3 2" }}
              className="shrink-0 text-[var(--color-accent-dim)]"
            />
          ) : isCollapsed ? (
            <Folder size={14} className="shrink-0 text-[var(--color-text-dim)]" />
          ) : (
            <FolderOpen size={14} className="shrink-0 text-[var(--color-text-dim)]" />
          )}
          {!renaming && (
            <>
              <span
                className={
                  "min-w-0 truncate " +
                  (virtual ? "text-[var(--color-text-dim)]" : "text-[var(--color-text)]")
                }
              >
                {name}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-dim)]">
                {count}
              </span>
              {virtual && (
                <span
                  title="Složka zatím existuje jen v plánu. Vznikne, až v ní po použití bude soubor."
                  className="shrink-0 rounded px-1.5 text-[11px] text-[var(--color-accent)]"
                  style={{ background: "var(--color-accent-soft)" }}
                >
                  nová
                </span>
              )}
              {dot && <SyncDot dot={dot} />}
            </>
          )}
          <span className="flex-1" />
        </button>
        {renaming && (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") cancelRename();
            }}
            className="min-w-0 flex-1"
          />
        )}
        {actions.visible && !renaming && (
          <span className="hidden shrink-0 gap-1 group-hover:flex">
            {/* The title lives on the wrapper: a disabled button gets no
                pointer events, so its own title never shows. */}
            <span title={actions.rename.reason ?? undefined}>
              <Button
                variant="ghost"
                size="xs"
                disabled={!actions.rename.enabled}
                title={actions.rename.reason ?? undefined}
                onClick={startRename}
              >
                Přejmenovat
              </Button>
            </span>
            <span title={actions.subfolder.reason ?? undefined}>
              <Button
                variant="ghost"
                size="xs"
                disabled={!actions.subfolder.enabled}
                title={actions.subfolder.reason ?? undefined}
                onClick={onNewSubfolder}
              >
                Nová podsložka
              </Button>
            </span>
          </span>
        )}
      </div>
      {error && (
        <div
          className="pb-1 text-[11px]"
          style={{ color: "var(--color-danger)", paddingLeft: indent + 30 }}
        >
          {error}
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
type RowBusy = "rename" | "delete" | "move" | ResolveAction;

const ROW_BUSY_LABEL: Record<RowBusy, string> = {
  rename: "přejmenovávám",
  delete: "mažu",
  move: "přesouvám",
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

// The sync badge's slot while a file is part of the plan: "přesun" before
// "Použít", "chyba" on the file a failed apply stopped at (mockup, frames 4
// and 6).
function PlanBadge({ kind }: { kind: "move" | "error" }) {
  const color = kind === "move" ? "var(--color-accent)" : "var(--color-danger)";
  return (
    <Badge
      variant="outline"
      title={kind === "move" ? "Přesun čeká na použití" : "Přesun se nepovedl"}
      className="shrink-0 font-mono text-[8.5px] uppercase tracking-wider"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      {kind === "move" ? "přesun" : "chyba"}
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
  drag,
  moveState,
  moveError,
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
  // Dragging (#447): a registered file inside one of the three sections is
  // draggable, every other row says why it is not. A drop on this row lands
  // in the folder it sits in.
  drag: RowDrag;
  // "přesouvám" while apply is on this file, "chyba" when it stopped here.
  moveState: "moving" | "error" | null;
  moveError: string | null;
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

  const planned = f.planned_from ?? null;
  return (
    <div
      aria-busy={busy}
      draggable={drag.draggable && !renaming}
      title={drag.refusal ?? drag.dragTitle ?? undefined}
      onDragStart={drag.onDragStart}
      onDragEnd={drag.onDragEnd}
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
      className="group relative flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface)]"
      style={{ paddingLeft: indent + 8, opacity: drag.dragging ? 0.45 : undefined }}
    >
      {/* A planned file wears a 2 px accent bar at the row's left edge. */}
      {planned !== null && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--color-accent)]"
        />
      )}
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
          {planned !== null && (
            <span className="shrink-0 text-[11px] whitespace-nowrap text-[var(--color-text-dim)]">
              <s className="decoration-[var(--color-border-strong)]">{planned}</s>
            </span>
          )}
          {busyAction ? (
            <RowBusyBadge action={busyAction} />
          ) : moveState === "moving" ? (
            <RowBusyBadge action="move" />
          ) : moveState === "error" ? (
            <PlanBadge kind="error" />
          ) : planned !== null ? (
            <PlanBadge kind="move" />
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
        {(rowError ?? moveError ?? runError) && (
          <div
            className="mt-0.5 truncate text-[11px]"
            title={rowError ?? moveError ?? runError ?? undefined}
            style={{ color: "var(--color-danger)" }}
          >
            {rowError ?? moveError ?? runError}
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

// Personal-workspace hint for the Files tab. Rendered by DetailPane above the
// sync bar so it shows even on a node with zero files (where SyncBar is not
// mounted). A personal workspace never holds a remote (#310), so this shows
// unconditionally for one; a team workspace syncs through the central server
// and never shows it.
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
      Soubory se ukládají jen na tento počítač a nesdílejí se. Sdílení
      souborů vyžaduje týmový workspace (připojení k týmu).
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
    // No margin of its own: the Files action row (DetailPane.tsx) owns the
    // spacing, so this and "Nový soubor" sit on one line. A column, so the
    // badges/outcome line stay under the button rather than widening the row.
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
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
// empty thread (POST /sessions with no first message, a draft) and hands it back
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
