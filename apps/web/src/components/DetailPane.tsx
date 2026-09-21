import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowRight,
  ArrowLeft,
  Copy,
  Folder,
  FolderOpen,
  X,
  Check,
  Pencil,
  Trash2,
  Plus,
  Archive,
  Save,
  Search,
  User,
  Lock,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Building2,
  Info,
  ExternalLink,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { GoogleDriveIcon } from "./icons/GoogleDriveIcon";
import type {
  NodeDetail,
  DetailEdge,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
  GraphPayload,
  SyncStatusFile,
  SyncRunResponse,
  WatcherErrorEntry,
  UntrackedFile,
  SessionSummary,
  SessionRunRow,
} from "../types";
import {
  RELATION_TYPES,
  LIFECYCLE_COLORS,
  LIFECYCLE_STATES_BY_TYPE,
  HEALTH_COLORS,
  HEALTH_STATES,
} from "../types";
import { safeHref } from "../lib/safe-url";
import { useMe } from "../lib/use-me";
import type { SessionStateMessage } from "../lib/sessions-client";
import { groupEventsByDate } from "../lib/events";
import { isTauri, openInFinder } from "../lib/backend-url";
import { externalLinkProps } from "../lib/external-link";
import type { Actor } from "../api";
import {
  updateNode,
  archiveNode,
  moveNode,
  createEdge,
  deleteEdge,
  fetchActors,
  createResponsibility,
  updateResponsibility,
  deleteResponsibility,
  assignResponsibility,
  unassignResponsibility,
  addDataSource,
  updateDataSource,
  removeDataSource,
  addTool,
  updateTool,
  removeTool,
  fetchNodeSyncStatus,
  runNodeSync,
  createNodeMirror,
  fetchNodeFolderUrl,
  createFile,
  renameFile,
  deleteFile,
  resolveFileSync,
  SyncAgentDownError,
} from "../api";
import type { ResolveAction } from "../api";
// Sub-modules: file-tree + sync UI and event card live in sibling files;
// DetailPane composes them with its own state.
import { EventCard, AddEventForm } from "./DetailPane.events";
import {
  LocalWorkspaceFilesBanner,
  FileTree,
  NewFileForm,
  NewFileSplitButton,
  SyncBar,
  NoMirrorBanner,
  NewTaskButton,
  WatcherErrorBanner,
  syncRunErrorsByFile,
} from "./DetailPane.files";
import { newInShowtime } from "../lib/showtime";
import { AccessSection } from "./DetailPane.access";
import { SessionsSection } from "./DetailPane.sessions";
import { RequestAccessControl } from "./AccessRequests";
import { copyText } from "../lib/clipboard";
import { useDataMode } from "../lib/central";

// Module-level cache of the per-node sync-status map, so revisiting a
// node shows the last-known badges instantly while the background
// refresh runs. Lives outside the component tree because DetailPane
// unmounts whenever no node is selected. The backend's `fast` mode is
// already DB-only, but caching here also avoids the network round-trip
// for repeat visits during a single session.
const SYNC_STATUS_CACHE = new Map<string, Map<string, SyncStatusFile>>();
// Same caching rationale, for sync-status's watcher_errors field (#202).
const SYNC_WATCHER_ERRORS_CACHE = new Map<string, WatcherErrorEntry[]>();

type DetailTab = "overview" | "events" | "files" | "connections" | "sessions" | "sharing";
// Survives the DetailPane unmount that happens when the editor takes over
// the right slot (Option C). Without this, closing a file remounts the
// pane and resets the tab to "overview" -- the bug in ukol 9.
const TAB_CACHE = new Map<string, DetailTab>();

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

type Props = {
  node: NodeDetail | null;
  graph: GraphPayload | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string | null) => void;
  canGoBack: boolean;
  onBack: () => void;
  onMutate: () => Promise<void>;
  // True when this pane is rendered inside another column (e.g. the
  // workspace's right-side detail). Drops the slide-in animation, the
  // 40vw / min-w-440 sizing, and the left border so the parent's layout
  // controls the geometry.
  embedded?: boolean;
  // Optional collapse handler for embedded mode. When provided, the
  // PaneShell header renders a chevron-right button on the LEFT so the
  // parent can hide the pane without overlapping the Upravit button.
  onCollapse?: () => void;
  // Open a file (mirror-relative path) in the editor. Provided by the
  // workspace; absent in contexts without an editor surface.
  onOpenFile?: (nodeId: string, relPath: string) => void;
  // NewTaskButton's "Nový úkol" success (#342) -- provided by the
  // workspace, which owns the open-session state SessionChat renders from.
  // Absent in contexts with no chat surface (none today).
  onSessionStarted?: (result: { session: SessionSummary; run: SessionRunRow | null }) => void;
  // Relace tab's "Otevřít chat" (#343) -- jumps to Práce with this node
  // selected; #342's own workspaceOpenSession fetch then picks up the
  // session automatically, so this needs no session id. Provided by App
  // (works from both the graph and workspace views); absent nowhere today,
  // but optional for the same reason onSessionStarted is.
  onOpenChat?: (nodeId: string, sessionId: string) => void;
  // Live session_state map for the Relace tab (see SessionsSection).
  liveSessionStates?: Readonly<Record<string, SessionStateMessage>>;
};

// Memoized: 3.5k lines of pane re-rendered wholesale on every App render
// (editor keystrokes, session state) even when its props are unchanged.
export default memo(DetailPane);

function DetailPane({
  node,
  graph,
  loading,
  error,
  onSelect,
  canGoBack,
  onBack,
  onMutate,
  embedded,
  onCollapse,
  onOpenFile,
  onSessionStarted,
  onOpenChat,
  liveSessionStates,
}: Props) {
  // Drives whether the sharing section is editable, and (canManage + meId
  // together) the Relace tab's #321 action gating (sessionRowAccess).
  const { meId, canManage } = useMe();

  if (loading && !node) {
    return (
      <PaneShell
        onClose={() => onSelect(null)}
        canGoBack={false}
        onBack={onBack}
        embedded={embedded}
        onCollapse={onCollapse}
      >
        <div className="flex h-full items-center justify-center text-[13.5px] text-[var(--color-text-dim)]">
          Načítám...
        </div>
      </PaneShell>
    );
  }

  if (error) {
    return (
      <PaneShell
        onClose={() => onSelect(null)}
        canGoBack={false}
        onBack={onBack}
        embedded={embedded}
        onCollapse={onCollapse}
      >
        <div
          className="flex h-full items-center justify-center text-[13.5px]"
          style={{ color: "var(--color-danger)" }}
        >
          {error}
        </div>
      </PaneShell>
    );
  }

  if (!node) return null;

  return (
    <DetailPaneBody
      node={node}
      graph={graph}
      canManage={canManage}
      meId={meId}
      onSelect={onSelect}
      canGoBack={canGoBack}
      onBack={onBack}
      onMutate={onMutate}
      embedded={embedded}
      onCollapse={onCollapse}
      onOpenFile={onOpenFile}
      onSessionStarted={onSessionStarted}
      onOpenChat={onOpenChat}
      liveSessionStates={liveSessionStates}
    />
  );
}

function DetailPaneBody({
  node,
  graph,
  canManage,
  meId,
  onSelect,
  canGoBack,
  onBack,
  onMutate,
  embedded,
  onCollapse,
  onOpenFile,
  onSessionStarted,
  onOpenChat,
  liveSessionStates,
}: {
  node: NodeDetail;
  graph: GraphPayload | null;
  canManage: boolean;
  meId: string | null;
  onSelect: (id: string | null) => void;
  canGoBack: boolean;
  onBack: () => void;
  onMutate: () => Promise<void>;
  embedded?: boolean;
  onCollapse?: () => void;
  onOpenFile?: (nodeId: string, relPath: string) => void;
  onSessionStarted?: (result: { session: SessionSummary; run: SessionRunRow | null }) => void;
  onOpenChat?: (nodeId: string, sessionId: string) => void;
  // Live session_state map for the Relace tab (see SessionsSection).
  liveSessionStates?: Readonly<Record<string, SessionStateMessage>>;
}) {

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // A local workspace has no remote at all (#310/#312) -- push/pull/resolve
  // never apply, so SyncBar (and FileRow's "Obnovit") stay hidden rather than
  // rendering an action that would only ever fail with LOCAL_MODE_NO_REMOTE.
  // Optimistically hidden while loading, same as other data-mode-gated UI.
  const dataMode = useDataMode();
  const isCentralMode = dataMode?.mode === "central";
  const [tab, setTabState] = useState<DetailTab>(
    () => TAB_CACHE.get(node.id) ?? "overview",
  );
  // Wrap setTab so the choice is remembered across an editor open/close
  // (which unmounts this pane). Keyed by node id.
  const setTab = useCallback(
    (t: DetailTab) => {
      TAB_CACHE.set(node.id, t);
      setTabState(t);
    },
    [node.id],
  );
  const [syncStatus, setSyncStatus] = useState<Map<string, SyncStatusFile>>(
    () => SYNC_STATUS_CACHE.get(node.id) ?? new Map(),
  );
  // Flips to true after the read-only fetch finishes (success or error).
  // Used to gate the SyncBar button label and the Files-tab dot indicator
  // -- both should stay neutral until we actually know the per-file
  // classification.
  const [syncLoaded, setSyncLoaded] = useState(
    () => SYNC_STATUS_CACHE.has(node.id),
  );
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncRunResult, setSyncRunResult] = useState<SyncRunResponse | null>(
    null,
  );
  const [untracked, setUntracked] = useState<UntrackedFile[]>([]);
  // Recent mirror-watcher failures for this node (#202) -- rides along on
  // the same sync-status fetch, no separate poll.
  const [watcherErrors, setWatcherErrors] = useState<WatcherErrorEntry[]>(
    () => SYNC_WATCHER_ERRORS_CACHE.get(node.id) ?? [],
  );
  // Inline new-file form. window.prompt/confirm/alert are silent no-ops in
  // the Tauri macOS webview (commit d229d84), so all file operations use
  // inline UI. Create/rename/delete/resolve errors are NOT tracked here
  // (#267) -- each surfaces contextually where the action happened (the
  // create form itself, or the affected file's own row), via the handlers
  // below rethrowing instead of setting shared pane state.
  const [creatingFile, setCreatingFile] = useState(false);
  // „Nová prezentace" failed: shown under the toolbar, where NewFileForm's
  // own error would be (#267). Cleared by the next attempt or a new file.
  const [presentationError, setPresentationError] = useState<string | null>(null);
  // Header/Files-tab "create the local mirror" action -- shared pending +
  // error state so both entry points (header button, and the Files tab
  // banner from the follow-up issue) render the same feedback.
  const [creatingMirror, setCreatingMirror] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);

  // Reset edit drafts whenever we switch to a different node.
  const lastIdRef = useRef(node.id);
  useEffect(() => {
    if (lastIdRef.current !== node.id) {
      lastIdRef.current = node.id;
      setEditing(false);
      setDraftName(node.name);
      setErrorMsg(null);
      TAB_CACHE.set(node.id, "overview");
      setTabState("overview");
      // Seed sync state from the module cache so revisits feel instant.
      // The background refetch below will update cache + state when the
      // server responds.
      const cached = SYNC_STATUS_CACHE.get(node.id);
      setSyncStatus(cached ?? new Map());
      setSyncLoaded(cached !== undefined);
      setSyncError(null);
      setWatcherErrors(SYNC_WATCHER_ERRORS_CACHE.get(node.id) ?? []);
      setSyncRunning(false);
      setSyncRunResult(null);
      // Untracked files belong to the previous node until the new node's
      // status fetch lands; leaving them painted would let a click open a
      // wrong-node path (404 in the editor).
      setUntracked([]);
      setCreatingFile(false);
      setCreatingMirror(false);
      setMirrorError(null);
    }
  }, [node.id, node.name]);

  // Trigger node-wide sync. Pushes push_candidates, pulls pull_candidates,
  // surfaces conflicts/errors. Refreshes the per-file status map after.
  // The lastIdRef gate ignores responses that arrive after the user has
  // already navigated away, so a slow sync on node A does not paint
  // results into node B's pane.
  // In a team workspace the device's sync agent serves this route (teammate
  // mirrors), so no gate on the kind of workspace — a 501 sync_agent_down
  // just means the agent is not running yet (pre-login) and surfaces as a
  // sync error.
  const handleRunSync = async () => {
    setSyncRunning(true);
    setSyncError(null);
    setSyncRunResult(null);
    const requestNodeId = node.id;
    try {
      const result = await runNodeSync(requestNodeId);
      if (lastIdRef.current !== requestNodeId) return;
      setSyncRunResult(result);
      try {
        const fresh = await fetchNodeSyncStatus(requestNodeId);
        if (lastIdRef.current !== requestNodeId) return;
        const m = new Map<string, SyncStatusFile>();
        for (const f of fresh.files) m.set(f.file_id, f);
        SYNC_STATUS_CACHE.set(requestNodeId, m);
        setSyncStatus(m);
        setSyncLoaded(true);
        SYNC_WATCHER_ERRORS_CACHE.set(requestNodeId, fresh.watcher_errors ?? []);
        setWatcherErrors(fresh.watcher_errors ?? []);
      } catch {
        /* keep stale badges */
      }
      void onMutate();
    } catch (e) {
      if (lastIdRef.current !== requestNodeId) return;
      setSyncError(String(e));
    } finally {
      if (lastIdRef.current === requestNodeId) {
        setSyncRunning(false);
      }
    }
  };

  // Create the local mirror for this node.
  // Shared by the header button (this issue) and the Files tab banner
  // (follow-up issue): both just call this and read creatingMirror/
  // mirrorError back. Mirrors handleRunSync's refresh so the Files tab
  // SyncBar shows pull candidates immediately, without running an actual
  // sync (the user still triggers that explicitly).
  const createMirrorAndRefresh = async () => {
    if (creatingMirror) return;
    setCreatingMirror(true);
    setMirrorError(null);
    const requestNodeId = node.id;
    try {
      await createNodeMirror(requestNodeId);
      if (lastIdRef.current !== requestNodeId) return;
      await onMutate();
      try {
        const fresh = await fetchNodeSyncStatus(requestNodeId);
        if (lastIdRef.current !== requestNodeId) return;
        const m = new Map<string, SyncStatusFile>();
        for (const f of fresh.files) m.set(f.file_id, f);
        SYNC_STATUS_CACHE.set(requestNodeId, m);
        setSyncStatus(m);
        setSyncLoaded(true);
        SYNC_WATCHER_ERRORS_CACHE.set(requestNodeId, fresh.watcher_errors ?? []);
        setWatcherErrors(fresh.watcher_errors ?? []);
      } catch {
        /* keep stale badges */
      }
    } catch (e) {
      if (lastIdRef.current !== requestNodeId) return;
      setMirrorError(e instanceof SyncAgentDownError ? e.message : String(e));
    } finally {
      if (lastIdRef.current === requestNodeId) {
        setCreatingMirror(false);
      }
    }
  };

  // Auto-load per-file sync classification as soon as the node is
  // selected, so the Files tab badges are ready when the user looks at
  // them. statusScan does I/O (file hashing + 30s-cached remote stat)
  // but it runs in parallel with the detail fetch and never blocks
  // rendering. Errors fall back silently to "no badge".
  //
  // Only node.id is in the deps. Adding syncLoading would re-fire the
  // effect on the very setState below, the previous run's cleanup would
  // mark its own response cancelled, and nothing would ever land.
  const loadSyncStatus = useCallback(async () => {
    const requestNodeId = node.id;
    try {
      const res = await fetchNodeSyncStatus(requestNodeId);
      if (lastIdRef.current !== requestNodeId) return;
      const m = new Map<string, SyncStatusFile>();
      for (const f of res.files) m.set(f.file_id, f);
      SYNC_STATUS_CACHE.set(requestNodeId, m);
      setSyncStatus(m);
      setUntracked(res.untracked ?? []);
      setSyncLoaded(true);
      setSyncError(null);
      SYNC_WATCHER_ERRORS_CACHE.set(requestNodeId, res.watcher_errors ?? []);
      setWatcherErrors(res.watcher_errors ?? []);
    } catch (e) {
      if (lastIdRef.current !== requestNodeId) return;
      // Team workspace before login: the sync agent is not up yet and the
      // proxy answers 501 sync_agent_down. Not an error worth a banner — badges
      // simply stay absent until the agent is running.
      if (e instanceof SyncAgentDownError) {
        setSyncLoaded(true);
        return;
      }
      setSyncError(String(e));
      setSyncLoaded(true);
    }
  }, [node.id]);

  useEffect(() => {
    let cancelled = false;
    void loadSyncStatus();
    // Poll while visible so agent-written (untracked) and MCP-registered
    // files appear without a manual refresh. ~5s; paused when hidden.
    const id = setInterval(() => {
      if (!document.hidden && !cancelled) void loadSyncStatus();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loadSyncStatus]);

  const startEdit = () => {
    setDraftName(node.name);
    setEditing(true);
    setErrorMsg(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftName(node.name);
    setErrorMsg(null);
  };

  const saveEdit = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      await updateNode(node.id, {
        name: draftName.trim(),
      });
      await onMutate();
      setEditing(false);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    // window.confirm() is a no-op in the Tauri webview on macOS (commit
    // d229d84). The button lives in the
    // "Nebezpečná oblast" section in edit mode, so a click is already a
    // deliberate gesture, and archive is reversible from the DB.
    setBusy(true);
    setErrorMsg(null);
    try {
      await archiveNode(node.id);
      await onMutate();
      onSelect(null);
    } catch (e) {
      setErrorMsg(String(e));
      setBusy(false);
    }
  };

  const handleRemoveEdge = async (edgeId: string) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await deleteEdge(edgeId);
      await onMutate();
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleAddEdge = async (
    relation: string,
    targetId: string,
    direction: "outgoing" | "incoming",
  ) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await createEdge({
        source_id: direction === "outgoing" ? node.id : targetId,
        target_id: direction === "outgoing" ? targetId : node.id,
        relation,
      });
      await onMutate();
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Change an edge's relation type. The schema treats (source, target,
  // relation) as the identity of an edge, so "edit" is really POST new +
  // DELETE old. We POST first so a failed insert (duplicate-with-different-
  // relation, missing node, trigger rejection) leaves the original edge
  // intact; if the DELETE then fails the user sees both edges and can
  // reconcile. Reverse order would risk losing the edge entirely.
  const handleChangeEdgeRelation = async (
    edge: DetailEdge,
    newRelation: string,
  ) => {
    if (newRelation === edge.relation) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const sourceId = edge.direction === "outgoing" ? node.id : edge.peer_id;
      const targetId = edge.direction === "outgoing" ? edge.peer_id : node.id;
      await createEdge({
        source_id: sourceId,
        target_id: targetId,
        relation: newRelation,
      });
      await deleteEdge(edge.id);
      await onMutate();
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Each handler below rethrows on failure instead of setting shared pane
  // state (#267): the caller renders the error contextually -- NewFileForm
  // for create, the affected FileRow for rename/delete/resolve -- never a
  // detached tab-level box.
  const handleCreateFile = async (name: string) => {
    try {
      const f = await createFile(node.id, { filename: name, section: "wip" });
      await Promise.all([onMutate(), loadSyncStatus()]);
      setCreatingFile(false);
      if (onOpenFile && f.relative_path) onOpenFile(node.id, f.relative_path);
    } catch (e) {
      throw new Error(`Soubor se nepodařilo vytvořit: ${String(e)}`);
    }
  };

  const handleNewPresentation = async () => {
    setPresentationError(null);
    setCreatingFile(false);
    try {
      await newInShowtime(node.id);
    } catch (e) {
      setPresentationError(`Prezentaci se nepodařilo založit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRenameFile = async (fileId: string, name: string) => {
    try {
      await renameFile(node.id, fileId, name);
      await Promise.all([onMutate(), loadSyncStatus()]);
    } catch (e) {
      throw new Error(`Přejmenování selhalo: ${String(e)}`);
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    // deleteFile returns 200 even when the remote delete failed; in that
    // case the body is { status: "repair_needed", repair_hint } and the
    // DB row + local copy are intentionally kept. Surface that so the user
    // knows the file was NOT fully removed.
    let res: unknown;
    try {
      res = await deleteFile(node.id, fileId);
    } catch (e) {
      throw new Error(`Smazání selhalo: ${String(e)}`);
    }
    await Promise.all([onMutate(), loadSyncStatus()]);
    if (
      typeof res === "object" &&
      res !== null &&
      (res as { status?: unknown }).status === "repair_needed"
    ) {
      const hint = (res as { repair_hint?: unknown }).repair_hint;
      throw new Error(
        typeof hint === "string" && hint
          ? hint
          : "Soubor se nepodařilo smazat z remote úložiště. Lokální kopie i záznam zůstaly zachovány.",
      );
    }
  };

  // Human decision on a conflict or deleted_local file (see resolveFileSync).
  // The 409 case carries a human-readable message from the server -- let it
  // propagate as-is rather than wrapping it in a generic failure line.
  const handleResolveFile = async (fileId: string, action: ResolveAction) => {
    await resolveFileSync(node.id, fileId, action);
    await Promise.all([onMutate(), loadSyncStatus()]);
  };

  const grouped = new Map<string, DetailEdge[]>();
  for (const edge of node.edges) {
    if (!grouped.has(edge.relation)) grouped.set(edge.relation, []);
    grouped.get(edge.relation)!.push(edge);
  }

  // Aggregate sync state across all files for the Files-tab indicator.
  // Worst-class wins: conflict > pending (push/pull/missing) > remote_missing
  // > clean. Native is treated as benign (no dot needed). Returns null
  // until the read-only fetch finishes, so the user does not see a
  // misleading green before the data arrives.
  const syncDot: { color: string; title: string } | null = (() => {
    if (!syncLoaded || node.files.length === 0) return null;
    let hasConflict = false;
    let hasPending = false;
    let hasRemoteMissing = false;
    let hasClean = false;
    for (const f of syncStatus.values()) {
      if (f.sync_class === "conflict") hasConflict = true;
      else if (
        f.sync_class === "push" ||
        f.sync_class === "pull" ||
        f.sync_class === "deleted_local"
      ) {
        hasPending = true;
      } else if (f.sync_class === "remote_missing") hasRemoteMissing = true;
      else if (f.sync_class === "clean") hasClean = true;
    }
    if (hasConflict)
      return { color: "var(--color-danger)", title: "Konflikt v souborech" };
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
  })();

  return (
    <PaneShell
      canGoBack={canGoBack}
      onBack={onBack}
      onClose={() => onSelect(null)}
      editing={editing}
      onEdit={startEdit}
      embedded={embedded}
      onCollapse={onCollapse}
    >
      {/* Header */}
      <div className="border-b border-[var(--color-border)] px-6 py-5">
        <div className="mb-3 flex items-center gap-2">
          <span
            className="inline-flex h-1.5 w-1.5 rounded-full"
            style={{
              background: nodeTypeVar(node.type),
              boxShadow: `0 0 10px ${nodeTypeGlow(node.type, 0.8)}`,
            }}
          />
          <span
            className="font-mono text-[14px] uppercase tracking-[0.14em]"
            style={{ color: nodeTypeVar(node.type) }}
          >
            {node.type}
          </span>
          <LifecycleDropdown
            nodeId={node.id}
            nodeType={node.type}
            value={node.lifecycle_state}
            onMutate={onMutate}
            onError={setErrorMsg}
          />
          {node.type === "project" && (
            <HealthDropdown
              nodeId={node.id}
              value={node.health}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          )}
        </div>
        {editing ? (
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            autoFocus
            className="mb-1 h-auto px-2 py-1.5 text-[22px] font-semibold leading-tight tracking-tight md:text-[22px]"
          />
        ) : (
          <h1 className="mb-1 text-[22px] font-semibold leading-tight tracking-tight text-[var(--color-text)]">
            {node.name}
          </h1>
        )}
        {/* Identity row, left-packed: ID · local path · folder · remote
            (copy link, open). Order and content per the 2026-09-15 header
            redesign -- the path is truncated from the LEFT so the leaf
            folder is always readable; the full path is in the tooltip. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <IdCopy id={node.id} />
          {node.type !== "organization" && (
            <>
              <span className="shrink-0 text-[var(--color-border-strong)]">·</span>
              {node.local_mirror ? (
                <>
                  <PathCopy path={node.local_mirror.local_path} />
                  <span className="ml-0.5 inline-flex shrink-0 items-center gap-0.5">
                    {isTauri() && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Otevřít složku ve Finderu"
                        aria-label="Otevřít složku ve Finderu"
                        className="text-muted-foreground"
                        onClick={() => void openInFinder(node.local_mirror!.local_path, false).catch(() => undefined)}
                      >
                        <FolderOpen />
                      </Button>
                    )}
                    <RemoteFolderActions nodeId={node.id} />
                  </span>
                </>
              ) : (
                <>
                  <CreateMirrorButton
                    pending={creatingMirror}
                    error={mirrorError}
                    onCreate={() => void createMirrorAndRefresh()}
                  />
                  <span className="ml-0.5 inline-flex shrink-0 items-center gap-0.5">
                    <RemoteFolderActions nodeId={node.id} />
                  </span>
                </>
              )}
            </>
          )}
          {node.type === "organization" && (
            <span className="ml-0.5 inline-flex items-center gap-0.5">
              <RemoteFolderActions nodeId={node.id} />
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as DetailTab)}
        className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4"
      >
        <TabsList variant="line" className="gap-0 p-0 group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="overview" className={TAB_TRIGGER_CLASS}>
            Přehled
          </TabsTrigger>
          <TabsTrigger value="events" className={TAB_TRIGGER_CLASS}>
            Události
            <TabCount count={node.events.length} active={tab === "events"} />
          </TabsTrigger>
          <TabsTrigger value="files" className={TAB_TRIGGER_CLASS}>
            Soubory
            <TabCount count={node.files.length} active={tab === "files"} />
            {syncDot && (
              <span
                title={syncDot.title}
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: syncDot.color,
                  boxShadow: `0 0 6px color-mix(in srgb, ${syncDot.color} 70%, transparent)`,
                }}
              />
            )}
          </TabsTrigger>
          <TabsTrigger value="connections" className={TAB_TRIGGER_CLASS}>
            Propojení
            <TabCount count={node.edges.length} active={tab === "connections"} />
          </TabsTrigger>
          {node.type !== "organization" && (
            <TabsTrigger value="sessions" className={TAB_TRIGGER_CLASS}>
              Relace
            </TabsTrigger>
          )}
          <TabsTrigger value="sharing" className={TAB_TRIGGER_CLASS}>
            Sdílení
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {errorMsg && (
        <div
          className="border-b px-6 py-2 text-[14px]"
          style={{
            color: "var(--color-danger)",
            borderColor: "var(--color-danger-border)",
            background: "var(--color-danger-bg)",
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* Scroll area */}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {tab === "overview" && (
          <>
        <Section title="Popis">
          <EditableDescription
            nodeId={node.id}
            value={node.description}
            onMutate={onMutate}
            onError={setErrorMsg}
          />
        </Section>

        {/* Organization (Organizace) — every non-organization node belongs
            to exactly one organization. Picker rebinds the membership
            atomically via POST /nodes/:id/move. */}
        {node.type !== "organization" && (
          <Section title="Organizace">
            <OrganizationPicker
              node={node}
              graph={graph}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          </Section>
        )}

        {/* Goal (Účel) — editable, only for project/process/area */}
        {(node.type === "project" ||
          node.type === "process" ||
          node.type === "area") && (
          <Section title="Účel">
            <EditableGoal
              nodeId={node.id}
              value={node.goal}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          </Section>
        )}

        {/* Owner (Vlastník) — editable, only for project/process/area */}
        {(node.type === "project" ||
          node.type === "process" ||
          node.type === "area") && (
          <Section title="Vlastník">
            <OwnerPicker
              node={node}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          </Section>
        )}

        {/* Responsibilities (Úlohy) — interactive on project/process/area */}
        {(node.type === "project" ||
          node.type === "process" ||
          node.type === "area") && (
          <Section title="Úlohy">
            <ResponsibilitiesEditor
              node={node}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          </Section>
        )}

        {/* Data sources (Datové zdroje) — interactive on project/process/area,
            read-only otherwise. Hidden entirely if empty on non-editable types. */}
        {(node.type === "project" ||
          node.type === "process" ||
          node.type === "area" ||
          node.data_sources.length > 0) && (
          <Section title="Datové zdroje">
            <EntityAttributeSection
              title="datový zdroj"
              items={node.data_sources}
              nodeId={node.id}
              canEdit={
                node.type === "project" ||
                node.type === "process" ||
                node.type === "area"
              }
              addCreator={addDataSource}
              updateCreator={updateDataSource}
              removeCreator={removeDataSource}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          </Section>
        )}

        {/* Tools (Nástroje) — interactive on project/process/area,
            read-only otherwise. Hidden entirely if empty on non-editable types. */}
        {(node.type === "project" ||
          node.type === "process" ||
          node.type === "area" ||
          node.tools.length > 0) && (
          <Section title="Nástroje">
            <EntityAttributeSection
              title="nástroj"
              items={node.tools}
              nodeId={node.id}
              canEdit={
                node.type === "project" ||
                node.type === "process" ||
                node.type === "area"
              }
              addCreator={addTool}
              updateCreator={updateTool}
              removeCreator={removeTool}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          </Section>
        )}

        {editing && (
          <Section title="Nebezpečná oblast">
            <Button variant="destructive" size="sm" onClick={handleArchive} disabled={busy}>
              <Archive />
              Archivovat tento uzel
            </Button>
            <p className="mt-2 text-[10px] text-[var(--color-text-dim)]">
              Uzel bude skryt z grafu, ale jeho vazby a události zůstanou
              v databázi pro audit.
            </p>
          </Section>
        )}

        <MetaSection meta={node.meta} />
          </>
        )}

        {tab === "events" && (
          <div className="px-5 py-4">
            <div className="space-y-4">
              {groupEventsByDate(node.events).map((group) => (
                <div key={group.date} className="space-y-2">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                    {group.date}
                  </div>
                  {group.events.map((evt) => (
                    <EventCard
                      key={evt.id}
                      event={evt}
                      onMutate={onMutate}
                      busy={busy}
                    />
                  ))}
                </div>
              ))}
              {node.events.length === 0 && (
                <div className="text-[14px] text-[var(--color-text-dim)]">
                  Zatím žádné události.
                </div>
              )}
            </div>
            <AddEventForm
              nodeId={node.id}
              onMutate={onMutate}
              disabled={busy}
            />
          </div>
        )}

        {tab === "files" && (
          <div className="px-5 py-4">
            {/* A team workspace uses the same full files UI: file content
                and lifecycle go to the central server, sync + mirrors to the
                device's sync agent (teammate mirrors). */}
            {/* Rendered here (not inside SyncBar) so the personal-workspace
                hint shows even on a node with no files yet. */}
            <LocalWorkspaceFilesBanner />
            <WatcherErrorBanner errors={watcherErrors} />
            {node.type !== "organization" && !node.local_mirror && (
              <NoMirrorBanner
                pending={creatingMirror}
                error={mirrorError}
                onCreate={() => void createMirrorAndRefresh()}
              />
            )}
            {/* One row: the sync button and "Nový soubor" on the same line.
                The row owns the bottom margin (SyncBar has none of its own),
                otherwise its margin box shifts the button off the row's
                vertical centre. */}
            <div className="mb-3 flex items-center justify-between gap-2">
              {isCentralMode && node.local_mirror ? (
                <SyncBar
                  running={syncRunning}
                  result={syncRunResult}
                  error={syncError}
                  statusLoaded={syncLoaded}
                  statusMap={syncStatus}
                  onRun={handleRunSync}
                />
              ) : (
                <span />
              )}
              <NewFileSplitButton
                hasMirror={!!node.local_mirror}
                onNewFile={() => {
                  setPresentationError(null);
                  setCreatingFile((v) => !v);
                }}
                onOpenNewFile={() => {
                  setPresentationError(null);
                  setCreatingFile(true);
                }}
                onNewPresentation={handleNewPresentation}
              />
            </div>
                {presentationError && (
                  <div className="mb-3 text-[11px]" style={{ color: "var(--color-danger)" }}>
                    {presentationError}
                  </div>
                )}
                {creatingFile && (
                  <NewFileForm
                    onSubmit={handleCreateFile}
                    onCancel={() => setCreatingFile(false)}
                  />
                )}
                {node.files.length > 0 || untracked.length > 0 ? (
                  <FileTree
                    files={node.files}
                    untracked={untracked}
                    nodeId={node.id}
                    syncStatus={syncStatus}
                    syncLoaded={syncLoaded}
                    mirrorPath={node.local_mirror?.local_path ?? null}
                    onOpenFile={(rel) => onOpenFile?.(node.id, rel)}
                    onRename={handleRenameFile}
                    onDelete={handleDeleteFile}
                    onResolve={handleResolveFile}
                    runErrors={syncRunErrorsByFile(syncRunResult)}
                    isCentralMode={isCentralMode}
                  />
                ) : (
                  <div className="text-[14px] text-[var(--color-text-dim)]">
                    Zatím žádné soubory.
                  </div>
                )}
          </div>
        )}

        {tab === "connections" && (
          <div className="px-5 py-4">
            {grouped.size > 0 ? (
              <div className="space-y-4">
                {Array.from(grouped.entries()).map(([relation, edges]) => (
                  <div key={relation}>
                    <div className="mb-1.5 font-mono text-[14px] uppercase tracking-[0.14em] text-[var(--color-text-dim)]">
                      {relation}
                    </div>
                    <div className="space-y-0.5">
                      {edges.map((edge, edgeIndex) => (
                        <ConnectionLink
                          key={edge.id || `${relation}:${edge.peer_name}:${edgeIndex}`}
                          edge={edge}
                          onSelect={onSelect}
                          onRemove={() => handleRemoveEdge(edge.id)}
                          onChangeRelation={(next) =>
                            handleChangeEdgeRelation(edge, next)
                          }
                          disabled={busy}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mb-3 text-[14px] text-[var(--color-text-dim)]">
                Zatím žádná propojení.
              </div>
            )}
            {graph && (
              <div className="mt-4">
                <AddEdgeForm
                  currentNodeId={node.id}
                  graph={graph}
                  onAdd={handleAddEdge}
                  disabled={busy}
                />
              </div>
            )}
          </div>
        )}

        {tab === "sessions" && (
          <SessionsSection
            nodeId={node.id}
            onOpenFile={onOpenFile}
            onOpenChat={onOpenChat ? (sessionId) => onOpenChat(node.id, sessionId) : undefined}
            onSessionStarted={onSessionStarted}
            liveStates={liveSessionStates}
            canManage={canManage}
            meId={meId}
          />
        )}

        {tab === "sharing" && (
          <div className="px-5 py-4">
            <AccessSection
              nodeId={node.id}
              canManage={canManage}
              onMutate={onMutate}
              graph={graph}
            />
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-6 py-4">
        {editing ? (
          <div className="flex gap-2">
            <Button
              onClick={saveEdit}
              disabled={saving || !draftName.trim()}
              className="flex-1"
            >
              <Save />
              {saving ? "Ukládám..." : "Uložit změny"}
            </Button>
            <Button variant="outline" onClick={cancelEdit} disabled={saving}>
              Zrušit
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {node.type !== "organization" ? (
              <NewTaskButton node={node} onSessionStarted={onSessionStarted} />
            ) : null}
          </div>
        )}
      </div>
    </PaneShell>
  );
}

function PaneShell({
  children,
  canGoBack,
  onBack,
  onClose,
  editing,
  onEdit,
  embedded,
  onCollapse,
}: {
  children: React.ReactNode;
  canGoBack: boolean;
  onBack: () => void;
  onClose: () => void;
  editing?: boolean;
  onEdit?: () => void;
  // When embedded inside another pane (e.g. WorkspaceView's right
  // column), drop the slide-in animation, the fixed-width / min-width
  // sizing, and the left border — the parent supplies all of those.
  embedded?: boolean;
  // When provided in embedded mode, render a chevron-right collapse
  // button on the left of the header so it doesn't overlap Upravit.
  onCollapse?: () => void;
}) {
  return (
    <aside
      className={
        embedded
          ? "flex h-full w-full flex-col bg-[var(--color-bg)]"
          : "animate-slide-in flex h-full w-[40vw] min-w-[440px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]"
      }
    >
      <div className="flex min-h-[42px] items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5">
        {embedded ? (
          onCollapse ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onCollapse}
              title="Skrýt detail"
              aria-label="Skrýt detail"
              className="text-muted-foreground"
            >
              <ChevronRight />
            </Button>
          ) : (
            // Embedded but no collapse handler -- keep the layout
            // balanced so Upravit stays right-aligned.
            <span />
          )
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={!canGoBack}
            onClick={onBack}
            className="text-muted-foreground"
          >
            <ArrowLeft />
            Zpět
          </Button>
        )}
        <div className="flex items-center gap-1.5">
          {onEdit && !editing && (
            <Button variant="ghost" size="sm" onClick={onEdit} title="Upravit uzel">
              <Pencil />
              Upravit
            </Button>
          )}
          {/*
            X close deselects the node (onSelect(null)). In standalone
            mode that's the right way to dismiss the slide-in pane. In
            embedded mode (WorkspaceView right column), the parent owns
            visibility via its own chevron toggle — rendering X here
            duplicates the affordance AND breaks workspace layout when
            clicked (left column would lose selection).
          */}
          {!embedded && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} title="Zavřít detail" aria-label="Zavřít detail" className="text-muted-foreground">
              <X />
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--color-border)] px-6 py-5 last:border-b-0">
      {title && (
        <div className="mb-3 font-mono text-[14px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function ConnectionLink({
  edge,
  onSelect,
  onRemove,
  onChangeRelation,
  disabled,
}: {
  edge: DetailEdge;
  onSelect: (id: string) => void;
  onRemove: () => void;
  onChangeRelation: (newRelation: string) => Promise<void>;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draftRelation, setDraftRelation] = useState<string>(edge.relation);

  // belongs_to has its own invariants and a dedicated UX (OrganizationPicker
  // for the org case, plus DB triggers for the rest). Keep this row read-only
  // for relation changes to avoid trigger-error surprises. A locked
  // (peer_restricted) edge has its edge id blanked by the server, so there
  // is no real id to edit or delete against -- treat it as read-only too
  // (peer_id is kept for the request-access button only).
  const editable = edge.relation !== "belongs_to" && !edge.peer_restricted;

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded bg-[var(--color-surface)] px-2 py-1.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{
            background: nodeTypeVar(edge.peer_type),
            boxShadow: `0 0 8px ${nodeTypeGlow(edge.peer_type, 0.4)}`,
          }}
        />
        <span className="flex-1 truncate text-[13.5px] text-[var(--color-text)]">
          {edge.peer_name}
        </span>
        <Select value={draftRelation} onValueChange={setDraftRelation} disabled={disabled}>
          <SelectTrigger size="sm" className="font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RELATION_TYPES.map((r) => (
              <SelectItem key={r} value={r} className="font-mono">
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={async () => {
            await onChangeRelation(draftRelation);
            setEditing(false);
          }}
          disabled={disabled || draftRelation === edge.relation}
          title="Uložit relaci"
          className="ml-0.5 text-[var(--color-accent)]"
        >
          <Check />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            setDraftRelation(edge.relation);
            setEditing(false);
          }}
          disabled={disabled}
          title="Zrušit"
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-1 rounded px-2 py-1.5 transition-colors hover:bg-[var(--color-surface)]">
      {edge.peer_restricted ? (
        <>
          <span
            title="Přístup na vyžádání"
            className="flex min-w-0 flex-1 cursor-not-allowed items-center gap-2 text-left opacity-60"
          >
            <Lock size={11} className="shrink-0 text-[var(--color-text-dim)]" />
            <span className="flex-1 truncate text-[13.5px] text-[var(--color-text-dim)]">
              {edge.peer_name}
            </span>
            <span className="font-mono text-[14px] text-[var(--color-text-dim)]">
              {edge.peer_type}
            </span>
          </span>
          {edge.peer_id && <RequestAccessControl nodeId={edge.peer_id} />}
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSelect(edge.peer_id)}
          className="min-w-0 flex-1 justify-start gap-2 px-1 text-left font-normal hover:bg-transparent"
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{
              background: nodeTypeVar(edge.peer_type),
              boxShadow: `0 0 8px ${nodeTypeGlow(edge.peer_type, 0.4)}`,
            }}
          />
          <span className="flex-1 truncate text-[13.5px] text-[var(--color-text)]">
            {edge.peer_name}
          </span>
          <span className="font-mono text-[14px] text-[var(--color-text-dim)]">
            {edge.peer_type}
          </span>
          <ArrowRight className="text-[var(--color-text-dim)] opacity-0 transition-opacity group-hover:opacity-100" />
        </Button>
      )}
      {editable && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            setDraftRelation(edge.relation);
            setEditing(true);
          }}
          disabled={disabled}
          title="Změnit typ vazby"
          className="ml-0.5 text-muted-foreground opacity-0 transition-all group-hover:opacity-100"
        >
          <Pencil />
        </Button>
      )}
      {!edge.peer_restricted && (
        <Button
          variant="destructive"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          disabled={disabled}
          title="Odebrat vazbu"
          className="ml-0.5 opacity-0 transition-all group-hover:opacity-100"
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

function AddEdgeForm({
  currentNodeId,
  graph,
  onAdd,
  disabled,
}: {
  currentNodeId: string;
  graph: GraphPayload;
  onAdd: (
    relation: string,
    targetId: string,
    direction: "outgoing" | "incoming",
  ) => Promise<void>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [relation, setRelation] = useState<string>(RELATION_TYPES[0]);
  const [direction, setDirection] = useState<"outgoing" | "incoming">(
    "outgoing",
  );
  const [targetId, setTargetId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="mt-3">
        <Plus />
        Přidat propojení
      </Button>
    );
  }

  const candidates = graph.nodes
    .filter((n) => n.id !== currentNodeId)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.name.localeCompare(b.name);
    });

  const submit = async () => {
    if (!targetId) return;
    setSubmitting(true);
    try {
      await onAdd(relation, targetId, direction);
      setOpen(false);
      setTargetId("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[14px] uppercase tracking-widest text-[var(--color-text-dim)]">
          Nové propojení
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen(false)}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="space-y-2">
        <NodePicker
          nodes={candidates}
          value={targetId}
          onChange={setTargetId}
        />
        <div className="flex items-center gap-2">
          <Select value={relation} onValueChange={setRelation}>
            <SelectTrigger size="sm" className="flex-1 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RELATION_TYPES.map((r) => (
                <SelectItem key={r} value={r} className="font-mono">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() =>
              setDirection((d) => (d === "outgoing" ? "incoming" : "outgoing"))
            }
            title="Otočit směr"
            className="shrink-0 text-muted-foreground"
          >
            {direction === "outgoing" ? "→" : "←"}
          </Button>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={submit} disabled={!targetId || submitting || disabled}>
          {submitting ? "Přidávám..." : "Přidat propojení"}
        </Button>
      </div>
    </div>
  );
}

// Custom node picker that replaces the native <select>. The native select
// can only show plain text, so project and process both show as "[P]" which
// is useless. This dropdown renders a colored dot per node type and supports
// keyboard search so it's fast even with many nodes.
function NodePicker({
  nodes,
  value,
  onChange,
}: {
  nodes: Array<{ id: string; type: string; name: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = nodes.find((n) => n.id === value);

  const filtered = filter.trim()
    ? nodes.filter(
        (n) =>
          n.name.toLowerCase().includes(filter.toLowerCase()) ||
          n.type.toLowerCase().includes(filter.toLowerCase()),
      )
    : nodes;

  // Outside click and Escape close via the Popover itself; the filter is
  // reset on every close.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setFilter("");
  };

  // Auto-focus input when dropdown opens.
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setFilter("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      setFilter("");
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 text-left font-normal"
        >
          {selected ? (
            <>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  background: nodeTypeVar(selected.type),
                  boxShadow: `0 0 6px ${nodeTypeGlow(selected.type, 0.35)}`,
                }}
              />
              <span className="flex-1 truncate text-[var(--color-text)]">
                {selected.name}
              </span>
              <span className="shrink-0 text-[10px] text-[var(--color-text-dim)]">
                {selected.type}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Vyberte uzel...</span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) gap-0 overflow-hidden p-0"
      >
        <div className="border-b border-[var(--color-border)] px-2.5 py-1.5">
          <Input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Hledat..."
            className="h-7 border-none bg-transparent px-0 focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <div className="scroll-thin max-h-[240px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
              Žádné výsledky
            </div>
          ) : (
            filtered.map((n) => (
              <Button
                key={n.id}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => pick(n.id)}
                className={`w-full justify-start gap-2 rounded-none text-left font-normal hover:bg-[var(--color-surface)] ${
                  n.id === value ? "bg-[var(--color-surface-2)]" : ""
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    background: nodeTypeVar(n.type),
                    boxShadow: `0 0 6px ${nodeTypeGlow(n.type, 0.35)}`,
                  }}
                />
                <span className="flex-1 truncate text-[var(--color-text)]">
                  {n.name}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-dim)]">
                  {n.type}
                </span>
              </Button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Tab strip styling on top of shadcn Tabs (variant="line"): dim label,
// full text colour when active, accent underline instead of the kit's
// foreground one.
const TAB_TRIGGER_CLASS =
  "h-auto flex-none gap-1.5 rounded-none px-3 py-2.5 text-[13px] text-[var(--color-text-dim)] hover:text-[var(--color-text-muted)] data-active:text-[var(--color-text)] data-active:after:bg-[var(--color-accent)]";

function TabCount({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <Badge
      variant="secondary"
      className={`h-4 min-w-4 rounded-full px-1.5 font-mono text-[10px] ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
          : "bg-[var(--color-surface-2)] text-[var(--color-text-dim)]"
      }`}
    >
      {count}
    </Badge>
  );
}

// Clickable lifecycle badge that opens a dropdown of valid states for the
// node's type (from LIFECYCLE_STATES_BY_TYPE). Selecting a state PATCHes
// the node and triggers a refetch. Includes an explicit "unset" option at
// the top which sends lifecycle_state: null.
function LifecycleDropdown({
  nodeId,
  nodeType,
  value,
  onMutate,
  onError,
}: {
  nodeId: string;
  nodeType: string;
  value: string | null;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [saving, setSaving] = useState(false);

  const states =
    (LIFECYCLE_STATES_BY_TYPE as Record<string, readonly string[]>)[nodeType] ??
    [];

  const pick = async (next: string | null) => {
    if (next === value) return;
    setSaving(true);
    onError(null);
    try {
      await updateNode(nodeId, { lifecycle_state: next });
      await onMutate();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const badgeClass = value
    ? `lifecycle-badge lifecycle-${LIFECYCLE_COLORS[value] ?? "gray"}`
    : "lifecycle-badge lifecycle-gray";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={saving}>
        <Button
          variant="ghost"
          size="xs"
          title="Změnit stav životního cyklu"
          className={`${badgeClass} h-auto rounded-full hover:opacity-80`}
        >
          {value ?? "nevyplněno"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        <DropdownMenuItem
          onSelect={() => void pick(null)}
          className={value === null ? "bg-[var(--color-surface-2)]" : ""}
        >
          <span className="text-muted-foreground">— nevyplněno —</span>
        </DropdownMenuItem>
        {states.map((s) => (
          <DropdownMenuItem
            key={s}
            onSelect={() => void pick(s)}
            className={value === s ? "bg-[var(--color-surface-2)]" : ""}
          >
            <Badge className={`lifecycle-badge lifecycle-${LIFECYCLE_COLORS[s] ?? "gray"}`}>
              {s}
            </Badge>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Clickable health badge for project nodes -- same interaction pattern as
// LifecycleDropdown, but a flat 3-value enum with no per-type set and no
// "unset" option (health always has a value; default is on_track).
function HealthDropdown({
  nodeId,
  value,
  onMutate,
  onError,
}: {
  nodeId: string;
  value: string;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [saving, setSaving] = useState(false);

  const pick = async (next: string) => {
    if (next === value) return;
    setSaving(true);
    onError(null);
    try {
      await updateNode(nodeId, { health: next });
      await onMutate();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={saving}>
        <Button
          variant="ghost"
          size="xs"
          title="Změnit zdraví projektu"
          className={`lifecycle-badge lifecycle-${HEALTH_COLORS[value] ?? "gray"} h-auto rounded-full hover:opacity-80`}
        >
          {value}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {HEALTH_STATES.map((s) => (
          <DropdownMenuItem
            key={s}
            onSelect={() => void pick(s)}
            className={value === s ? "bg-[var(--color-surface-2)]" : ""}
          >
            <Badge className={`lifecycle-badge lifecycle-${HEALTH_COLORS[s] ?? "gray"}`}>
              {s}
            </Badge>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Inline editor for the `goal` field. Read-mode shows the current value
// (or a muted placeholder). Clicking Edit reveals a textarea with
// Save/Cancel buttons. Empty goal saves as null.
// Inline editor for node.description. Same interaction pattern as
// EditableGoal: click to edit, Save/Cancel on commit. Freed from the
// node-level "Upravit" dialog so it works the same as other inline fields.
function EditableDescription({
  nodeId,
  value,
  onMutate,
  onError,
}: {
  nodeId: string;
  value: string | null;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value ?? "");
    setEditing(false);
  }, [nodeId, value]);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      const trimmed = draft.trim();
      await updateNode(nodeId, { description: trimmed ? trimmed : null });
      await onMutate();
      setEditing(false);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(value ?? "");
    setEditing(false);
    onError(null);
  };

  if (!editing) {
    return (
      <div className="group flex items-start gap-2">
        <div className="flex-1">
          {value ? (
            <p className="text-[14px] leading-relaxed text-[var(--color-text-muted)]">
              {value}
            </p>
          ) : (
            <p className="text-[14px] italic leading-relaxed text-[var(--color-text-dim)]">
              Nevyplněno
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setEditing(true)}
          title="Upravit popis"
          className="text-muted-foreground opacity-0 transition-all group-hover:opacity-100"
        >
          <Pencil />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        autoFocus
        placeholder="Popište, co tento uzel reprezentuje..."
        className="field-sizing-fixed resize-y leading-relaxed"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          <Save />
          {saving ? "Ukládám..." : "Uložit"}
        </Button>
        <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
          Zrušit
        </Button>
      </div>
    </div>
  );
}

function EditableGoal({
  nodeId,
  value,
  onMutate,
  onError,
}: {
  nodeId: string;
  value: string | null;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  // Reset local draft when node/value changes from the outside.
  useEffect(() => {
    setDraft(value ?? "");
    setEditing(false);
  }, [nodeId, value]);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      const trimmed = draft.trim();
      await updateNode(nodeId, { goal: trimmed ? trimmed : null });
      await onMutate();
      setEditing(false);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(value ?? "");
    setEditing(false);
    onError(null);
  };

  if (!editing) {
    return (
      <div className="group flex items-start gap-2">
        <div className="flex-1">
          {value ? (
            <p className="text-[14px] leading-relaxed text-[var(--color-text-muted)]">
              {value}
            </p>
          ) : (
            <p className="text-[14px] italic leading-relaxed text-[var(--color-text-dim)]">
              Nevyplněno
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setEditing(true)}
          title="Upravit účel"
          className="text-muted-foreground opacity-0 transition-all group-hover:opacity-100"
        >
          <Pencil />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        autoFocus
        placeholder="Proč tento uzel existuje, čeho má dosáhnout..."
        className="field-sizing-fixed resize-y leading-relaxed"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          <Save />
          {saving ? "Ukládám..." : "Uložit"}
        </Button>
        <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
          Zrušit
        </Button>
      </div>
    </div>
  );
}

// Organization picker for a non-organization node. Reads the current
// organization from node.edges (the outgoing belongs_to -> organization
// edge), lists all organizations from the loaded graph, and POSTs to
// /nodes/:id/move on selection. The endpoint atomically rebinds the
// existing belongs_to edge -- see moveNodeToOrganization() for why
// disconnect+connect cannot satisfy the org-invariant triggers.
function OrganizationPicker({
  node,
  graph,
  onMutate,
  onError,
}: {
  node: NodeDetail;
  graph: GraphPayload | null;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [saving, setSaving] = useState(false);

  const currentOrgEdge = node.edges.find(
    (e) =>
      e.relation === "belongs_to" &&
      e.direction === "outgoing" &&
      e.peer_type === "organization",
  );
  const orgs = (graph?.nodes ?? [])
    .filter((n) => n.type === "organization")
    .sort((a, b) => a.name.localeCompare(b.name, "cs"));

  const pick = async (orgId: string) => {
    if (orgId === currentOrgEdge?.peer_id) return;
    setSaving(true);
    onError(null);
    try {
      await moveNode(node.id, orgId);
      await onMutate();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={saving || orgs.length === 0}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 text-left font-normal"
        >
          {currentOrgEdge ? (
            <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
              <Building2 className="shrink-0 text-muted-foreground" />
              <span className="truncate">{currentOrgEdge.peer_name}</span>
            </span>
          ) : (
            <span className="flex-1 text-muted-foreground">
              — Bez organizace —
            </span>
          )}
          <Pencil className="shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72">
        {orgs.length === 0 ? (
          <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
            Žádné organizace nejsou k dispozici.
          </div>
        ) : (
          orgs.map((o) => (
            <DropdownMenuItem
              key={o.id}
              onSelect={() => void pick(o.id)}
              className={
                currentOrgEdge?.peer_id === o.id
                  ? "bg-[var(--color-surface-2)]"
                  : ""
              }
            >
              <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
                <Building2 className="shrink-0 text-muted-foreground" />
                <span className="truncate">{o.name}</span>
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Strip diacritics + lowercase so the picker's search matches "Dasa"
// against "Dáša", "Petr" against "Petřík", etc.
function normalizeForSearch(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

// Owner picker for a node. Fetches every actor from the global registry
// (registered persons, placeholders, and automations) and PATCHes
// owner_id on selection. Actors are cross-organizational. The popover
// is a search field: type to filter, ArrowUp/Down to move, Enter to
// pick, Escape to close. Default sort: registered persons → placeholders
// → automations. "— Žádný —" unsets the owner.
function OwnerPicker({
  node,
  onMutate,
  onError,
}: {
  node: NodeDetail;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actors, setActors] = useState<Actor[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus the search input as soon as the popover renders.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const openPicker = async () => {
    setOpen(true);
    setQuery("");
    setHighlight(0);
    if (actors !== null) return;
    setLoading(true);
    setFetchError(null);
    try {
      const list = await fetchActors();
      const rank = (a: Actor) => {
        if (a.type === "automation") return 2;
        if (a.is_placeholder === 1 || a.user_id === null) return 1;
        return 0;
      };
      setActors(
        [...list].sort((a, b) => {
          const r = rank(a) - rank(b);
          return r !== 0 ? r : a.name.localeCompare(b.name);
        }),
      );
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const pick = async (actorId: string | null) => {
    setOpen(false);
    if (actorId === (node.owner?.id ?? null)) return;
    setSaving(true);
    onError(null);
    try {
      await updateNode(node.id, { owner_id: actorId });
      await onMutate();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // Build the rendered list: "— Žádný —" sentinel followed by actors
  // matching the current query. Highlight indexes into this combined
  // list, so index 0 is always the unset option.
  const filtered = useMemo(() => {
    if (!actors) return [];
    const q = normalizeForSearch(query.trim());
    if (!q) return actors;
    return actors.filter((a) => normalizeForSearch(a.name).includes(q));
  }, [actors, query]);
  const rows: Array<{ kind: "unset" } | { kind: "actor"; actor: Actor }> = [
    { kind: "unset" },
    ...filtered.map((actor) => ({ kind: "actor" as const, actor })),
  ];

  // Keep the highlighted row in view when the user navigates with the
  // arrow keys; without this, long lists scroll past the active item.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${highlight}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Reset the highlight to the first row whenever the filter changes,
  // so "type then Enter" picks the top match.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, rows.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[highlight];
      if (!row) return;
      void pick(row.kind === "unset" ? null : row.actor.id);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) void openPicker();
        else setOpen(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          className="w-full justify-start gap-2 text-left font-normal"
        >
          {node.owner ? (
            <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
              <User className="shrink-0 text-muted-foreground" />
              <span className="truncate">{node.owner.name}</span>
            </span>
          ) : (
            <span className="flex-1 text-muted-foreground">
              — Žádný —
            </span>
          )}
          <Pencil className="shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
          <Search
            size={12}
            className="shrink-0 text-[var(--color-text-dim)]"
          />
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Hledat aktéra..."
            className="h-7 flex-1 border-none bg-transparent px-0 focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
          {loading ? (
            <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
              Načítám aktéry...
            </div>
          ) : fetchError ? (
            <div
              className="px-3 py-2 text-[14px]"
              style={{ color: "var(--color-danger)" }}
            >
              {fetchError}
            </div>
          ) : (
            <>
              {rows.map((row, idx) => {
                const isHighlight = idx === highlight;
                if (row.kind === "unset") {
                  const isCurrent = !node.owner;
                  return (
                    <Button
                      key="__unset__"
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-row-index={idx}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => pick(null)}
                      className={`w-full justify-start gap-2 rounded-none text-left font-normal hover:bg-[var(--color-surface)] ${
                        isHighlight ? "bg-[var(--color-surface)]" : ""
                      } ${
                        isCurrent && !isHighlight
                          ? "bg-[var(--color-surface-2)]"
                          : ""
                      }`}
                    >
                      <span className="text-muted-foreground">
                        — Žádný —
                      </span>
                    </Button>
                  );
                }
                const a = row.actor;
                const isPlaceholder =
                  a.is_placeholder === 1 || a.user_id === null;
                const isCurrent = node.owner?.id === a.id;
                return (
                  <Button
                    key={a.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-row-index={idx}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => pick(a.id)}
                    className={`w-full justify-start gap-2 rounded-none text-left font-normal hover:bg-[var(--color-surface)] ${
                      isHighlight ? "bg-[var(--color-surface)]" : ""
                    } ${
                      isCurrent && !isHighlight
                        ? "bg-[var(--color-surface-2)]"
                        : ""
                    }`}
                  >
                    <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
                      <User className="shrink-0 text-muted-foreground" />
                      <span
                        className={`truncate ${
                          a.type === "person" && isPlaceholder
                            ? "italic text-[var(--color-text-dim)]"
                            : ""
                        }`}
                      >
                        {a.name}
                      </span>
                      <ActorBadge
                        type={a.type}
                        placeholder={isPlaceholder}
                      />
                    </span>
                  </Button>
                );
              })}
              {actors && filtered.length === 0 && query.trim() !== "" && (
                <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
                  Nic neodpovídá „{query}".
                </div>
              )}
              {actors && actors.length === 0 && (
                <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
                  Žádní aktéři nejsou k dispozici.
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ----- Responsibilities editor -----

// Small tag showing assignee type (P = person, A = automation) with
// optional placeholder marking. Kept minimal so it fits in pills & rows.
// Only automations get a visible "A" badge. Humans are the default and
// stay unmarked to reduce visual noise on responsibility rows.
function ActorBadge({
  type,
  placeholder,
}: {
  type: "person" | "automation" | string;
  placeholder?: boolean;
}) {
  if (type !== "automation") return null;
  const color = placeholder
    ? "var(--color-text-dim)"
    : "var(--color-node-project)";
  return (
    <span
      className="ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded font-mono text-[8.5px] font-semibold"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
      title={"Automatizace" + (placeholder ? " (placeholder)" : "")}
    >
      A
    </span>
  );
}

function ResponsibilitiesEditor({
  node,
  onMutate,
  onError,
}: {
  node: NodeDetail;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);

  const items = node.responsibilities;

  // Renumber the whole list whenever an item moves: historical rows all
  // share sort_order=0, so swapping a single pair wouldn't change the
  // rendered order (DB tiebreaker is title). Instead, rewrite indices
  // 0..N-1 in the target order; only send PATCHes for rows whose
  // sort_order actually changes.
  const moveBy = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onError(null);
    try {
      await Promise.all(
        next
          .map((r, i) =>
            r.sort_order === i
              ? null
              : updateResponsibility(r.id, { sort_order: i }),
          )
          .filter((p): p is Promise<DetailResponsibility> => p !== null),
      );
      await onMutate();
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div>
      {items.length > 0 ? (
        <ul className="responsibility-list">
          {items.map((r, i) => (
            <ResponsibilityItem
              key={r.id}
              responsibility={r}
              canMoveUp={i > 0}
              canMoveDown={i < items.length - 1}
              onMoveUp={() => moveBy(i, -1)}
              onMoveDown={() => moveBy(i, 1)}
              onMutate={onMutate}
              onError={onError}
            />
          ))}
        </ul>
      ) : (
        <p className="mb-2 text-[13.5px] italic text-[var(--color-text-dim)]">
          Žádné úlohy zatím nejsou.
        </p>
      )}

      {adding ? (
        <AddResponsibilityForm
          nodeId={node.id}
          onCancel={() => setAdding(false)}
          onDone={async () => {
            await onMutate();
            setAdding(false);
          }}
          onError={onError}
        />
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="mt-3">
          <Plus />
          Přidat úlohu
        </Button>
      )}
    </div>
  );
}

function ResponsibilityItem({
  responsibility,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onMutate,
  onError,
}: {
  responsibility: DetailResponsibility;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => Promise<void>;
  onMoveDown: () => Promise<void>;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(responsibility.title);
  const [draftDescription, setDraftDescription] = useState(
    responsibility.description ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Reset drafts whenever the underlying row changes (e.g. after onMutate
  // refetch while this row stays mounted).
  useEffect(() => {
    setDraftTitle(responsibility.title);
    setDraftDescription(responsibility.description ?? "");
    setEditing(false);
  }, [responsibility.id, responsibility.title, responsibility.description]);

  const save = async () => {
    const title = draftTitle.trim();
    if (!title) return;
    setSaving(true);
    onError(null);
    try {
      await updateResponsibility(responsibility.id, {
        title,
        description: draftDescription.trim() ? draftDescription.trim() : null,
      });
      await onMutate();
      setEditing(false);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraftTitle(responsibility.title);
    setDraftDescription(responsibility.description ?? "");
    setEditing(false);
  };

  const remove = async () => {
    // window.confirm() is a no-op in the Tauri webview (see d229d84).
    // The trash icon is the explicit gesture.
    setBusy(true);
    onError(null);
    try {
      await deleteResponsibility(responsibility.id);
      await onMutate();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  };

  const unassign = async (actorId: string) => {
    setBusy(true);
    onError(null);
    try {
      await unassignResponsibility(responsibility.id, actorId);
      await onMutate();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const assign = async (actorId: string) => {
    setBusy(true);
    onError(null);
    try {
      await assignResponsibility(responsibility.id, actorId);
      await onMutate();
      setPickerOpen(false);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li>
        <div className="space-y-2">
          <Input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            autoFocus
            placeholder="Název úlohy"
            className="font-semibold"
          />
          <Textarea
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            rows={3}
            placeholder="Popis (volitelné)"
            className="field-sizing-fixed resize-y leading-relaxed"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving || !draftTitle.trim()}>
              <Save />
              {saving ? "Ukládám..." : "Uložit"}
            </Button>
            <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
              Zrušit
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li>
      <div className="group flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="resp-title">{responsibility.title}</div>
          {responsibility.description && (
            <div className="resp-description">{responsibility.description}</div>
          )}
          <div className="resp-assignees">
            {responsibility.assignees.length === 0 && !pickerOpen && (
              <span className="assignee-empty">— Nikdo zatím</span>
            )}
            {responsibility.assignees.map((a) => (
              <Badge
                key={a.id}
                variant="secondary"
                className={`assignee assignee-${a.type} gap-1`}
              >
                <span className="truncate">{a.name}</span>
                <ActorBadge type={a.type} />
                {/* size-4: the pill is 20px tall, so even icon-xs (24px)
                    would stretch it -- the one hand-set button size here. */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => unassign(a.id)}
                  disabled={busy}
                  title="Odebrat"
                  className="ml-0.5 size-4 rounded-full text-muted-foreground hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
                >
                  <X />
                </Button>
              </Badge>
            ))}
            {pickerOpen ? (
              <AssigneePicker
                existing={responsibility.assignees.map((a) => a.id)}
                onPick={assign}
                onClose={() => setPickerOpen(false)}
                disabled={busy}
              />
            ) : (
              <Button
                variant="outline"
                size="xs"
                onClick={() => setPickerOpen(true)}
                disabled={busy}
                className="rounded-full text-muted-foreground hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
              >
                <Plus />
                přiřadit
              </Button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onMoveUp}
            disabled={busy || !canMoveUp}
            title="Posunout nahoru"
            className="text-muted-foreground"
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onMoveDown}
            disabled={busy || !canMoveDown}
            title="Posunout dolů"
            className="text-muted-foreground"
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setEditing(true)}
            disabled={busy}
            title="Upravit úlohu"
            className="text-muted-foreground"
          >
            <Pencil />
          </Button>
          <Button
            variant="destructive"
            size="icon-xs"
            onClick={remove}
            disabled={busy}
            title="Smazat úlohu"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </li>
  );
}

function AddResponsibilityForm({
  nodeId,
  onCancel,
  onDone,
  onError,
}: {
  nodeId: string;
  onCancel: () => void;
  onDone: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [actors, setActors] = useState<Actor[] | null>(null);
  const [loadingActors, setLoadingActors] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingActors(true);
    setFetchError(null);
    fetchActors()
      .then((list) => {
        if (!cancelled) setActors(list);
      })
      .catch((e) => {
        if (!cancelled) setFetchError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingActors(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: string) => {
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );
  };

  const submit = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSaving(true);
    onError(null);
    try {
      await createResponsibility({
        node_id: nodeId,
        title: trimmedTitle,
        description: description.trim() || undefined,
        assignees: selected.length > 0 ? selected : undefined,
      });
      await onDone();
      setTitle("");
      setDescription("");
      setSelected([]);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[14px] uppercase tracking-widest text-[var(--color-text-dim)]">
          Nová úloha
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onCancel} className="text-muted-foreground">
          <X />
        </Button>
      </div>
      <div className="space-y-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="Název úlohy"
        />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Popis (volitelné)"
          className="field-sizing-fixed resize-y leading-relaxed"
        />
        <div>
          <div className="mb-1 font-mono text-[14px] uppercase tracking-widest text-[var(--color-text-dim)]">
            Přiřazení
          </div>
          {loadingActors ? (
            <div className="text-[14px] text-[var(--color-text-dim)]">
              Načítám...
            </div>
          ) : fetchError ? (
            <div
              className="text-[14px]"
              style={{ color: "var(--color-danger)" }}
            >
              {fetchError}
            </div>
          ) : actors && actors.length === 0 ? (
            <div className="text-[14px] text-[var(--color-text-dim)]">
              Registr aktérů je prázdný.
            </div>
          ) : (
            <div className="scroll-thin max-h-[180px] space-y-1 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-1.5">
              {actors?.map((a) => {
                const isPlaceholder = a.is_placeholder === 1;
                const checked = selected.includes(a.id);
                return (
                  <Label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11.5px] font-normal hover:bg-[var(--color-surface)]"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggle(a.id)} />
                    <span
                      className={`flex-1 truncate ${
                        isPlaceholder
                          ? "italic text-[var(--color-text-dim)]"
                          : "text-[var(--color-text)]"
                      }`}
                    >
                      {a.name}
                      {isPlaceholder ? " (placeholder)" : ""}
                    </span>
                    <ActorBadge type={a.type} placeholder={isPlaceholder} />
                  </Label>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Zrušit
        </Button>
        <Button size="sm" onClick={submit} disabled={!title.trim() || saving}>
          {saving ? "Vytvářím..." : "Vytvořit"}
        </Button>
      </div>
    </div>
  );
}

// Shared editor for entity-attached attribute collections (data_sources,
// tools). Both share identical shape { id, name, description, external_link }
// and identical UX: list with per-item X, "Přidat …" button that opens an
// inline form below the list. Parametrized by title (used in button label
// and form header) and by add/remove API wrappers.
type EntityAttributeItem = DetailDataSource | DetailTool;

function EntityAttributeSection<TItem extends EntityAttributeItem>({
  title,
  items,
  nodeId,
  canEdit,
  addCreator,
  updateCreator,
  removeCreator,
  onMutate,
  onError,
}: {
  title: string; // e.g. "datový zdroj" | "nástroj"
  items: TItem[];
  nodeId: string;
  canEdit: boolean;
  addCreator: (input: {
    node_id: string;
    name: string;
    description?: string;
    external_link?: string;
  }) => Promise<TItem>;
  updateCreator: (
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      external_link?: string | null;
    },
  ) => Promise<TItem>;
  removeCreator: (id: string) => Promise<{ deleted: string }>;
  onMutate: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const remove = async (item: TItem) => {
    // window.confirm() is a no-op in the Tauri webview (see d229d84).
    setBusyId(item.id);
    onError(null);
    try {
      await removeCreator(item.id);
      await onMutate();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      {items.length > 0 ? (
        <ul className="entity-attr-list">
          {items.map((item) => (
            <EntityAttributeItem
              key={item.id}
              item={item}
              title={title}
              canEdit={canEdit}
              busy={busyId === item.id}
              updateCreator={updateCreator}
              onSavedMutate={onMutate}
              onRemove={() => remove(item)}
              onError={onError}
            />
          ))}
        </ul>
      ) : (
        canEdit && (
          <p className="mb-2 text-[13.5px] italic text-[var(--color-text-dim)]">
            Žádné záznamy.
          </p>
        )
      )}

      {canEdit &&
        (adding ? (
          <AddEntityAttributeForm
            title={title}
            nodeId={nodeId}
            addCreator={addCreator}
            onCancel={() => setAdding(false)}
            onDone={async () => {
              await onMutate();
              setAdding(false);
            }}
            onError={onError}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="mt-3">
            <Plus />
            Přidat {title}
          </Button>
        ))}
    </div>
  );
}

// Single row with inline edit (click Pencil) or delete (click X). Used
// for both data sources and tools via the generic updateCreator.
function EntityAttributeItem<TItem extends EntityAttributeItem>({
  item,
  title,
  canEdit,
  busy,
  updateCreator,
  onSavedMutate,
  onRemove,
  onError,
}: {
  item: TItem;
  title: string;
  canEdit: boolean;
  busy: boolean;
  updateCreator: (
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      external_link?: string | null;
    },
  ) => Promise<TItem>;
  onSavedMutate: () => Promise<void>;
  onRemove: () => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? "");
  const [link, setLink] = useState(item.external_link ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(item.name);
    setDescription(item.description ?? "");
    setLink(item.external_link ?? "");
    setEditing(false);
  }, [item.id, item.name, item.description, item.external_link]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    onError(null);
    try {
      await updateCreator(item.id, {
        name: trimmed,
        description: description.trim() ? description.trim() : null,
        external_link: link.trim() ? link.trim() : null,
      });
      await onSavedMutate();
      setEditing(false);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setName(item.name);
    setDescription(item.description ?? "");
    setLink(item.external_link ?? "");
    setEditing(false);
    onError(null);
  };

  if (editing) {
    return (
      <li className="space-y-1.5 py-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Název" />
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Odkaz (volitelné)"
          className="font-mono text-[12px]"
        />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Popis (volitelné)"
          className="resize-y"
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving || !name.trim()}>
            <Save />
            {saving ? "Ukládám..." : "Uložit"}
          </Button>
          <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
            Zrušit
          </Button>
        </div>
      </li>
    );
  }

  const safeLink = safeHref(item.external_link);
  return (
    <li className="group flex items-start gap-2">
      <div className="flex-1">
        {safeLink ? (
          <a
            {...externalLinkProps(safeLink)}
            className="text-[var(--color-accent)] hover:underline"
          >
            {item.name}
          </a>
        ) : (
          <span className="text-[var(--color-text)]">{item.name}</span>
        )}
        {item.description && (
          <span className="attr-desc"> — {item.description}</span>
        )}
      </div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label={`Upravit ${title}`}
            className="text-muted-foreground"
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Smazat ${title}`}
            className="text-muted-foreground hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
          >
            <X />
          </Button>
        </div>
      )}
    </li>
  );
}

function AddEntityAttributeForm<TItem extends EntityAttributeItem>({
  title,
  nodeId,
  addCreator,
  onCancel,
  onDone,
  onError,
}: {
  title: string;
  nodeId: string;
  addCreator: (input: {
    node_id: string;
    name: string;
    description?: string;
    external_link?: string;
  }) => Promise<TItem>;
  onCancel: () => void;
  onDone: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [externalLink, setExternalLink] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSaving(true);
    onError(null);
    try {
      await addCreator({
        node_id: nodeId,
        name: trimmedName,
        description: description.trim() || undefined,
        external_link: externalLink.trim() || undefined,
      });
      await onDone();
      setName("");
      setDescription("");
      setExternalLink("");
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[14px] uppercase tracking-widest text-[var(--color-text-dim)]">
          Nový {title}
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onCancel} aria-label="Zavřít" className="text-muted-foreground">
          <X />
        </Button>
      </div>
      <div className="space-y-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Název" />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Popis (volitelné)"
          className="resize-y"
        />
        <Input
          value={externalLink}
          onChange={(e) => setExternalLink(e.target.value)}
          type="url"
          placeholder="Odkaz (volitelné, např. https://…)"
        />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Zrušit
        </Button>
        <Button size="sm" onClick={submit} disabled={!name.trim() || saving}>
          {saving ? "Vytvářím..." : "Vytvořit"}
        </Button>
      </div>
    </div>
  );
}

// Inline picker shown when user clicks "+ přiřadit" on an existing
// responsibility. Lazy-loads the global actor registry, filters out those
// already assigned, and closes on outside click.
function AssigneePicker({
  existing,
  onPick,
  onClose,
  disabled,
}: {
  existing: string[];
  onPick: (actorId: string) => Promise<void>;
  onClose: () => void;
  disabled: boolean;
}) {
  const [actors, setActors] = useState<Actor[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetchActors()
      .then((list) => {
        if (!cancelled) setActors(list);
      })
      .catch((e) => {
        if (!cancelled) setFetchError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = (actors ?? []).filter((a) => !existing.includes(a.id));

  return (
    <div ref={containerRef} className="relative inline-block">
      <span className="assignee inline-flex items-center gap-1 border-dashed text-[var(--color-accent)]">
        <Plus size={10} />
        přiřadit
      </span>
      <div className="absolute left-0 top-full z-50 mt-1 w-[220px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
        {loading ? (
          <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
            Načítám...
          </div>
        ) : fetchError ? (
          <div
            className="px-3 py-2 text-[14px]"
            style={{ color: "var(--color-danger)" }}
          >
            {fetchError}
          </div>
        ) : candidates.length === 0 ? (
          <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
            Žádní další aktéři k přiřazení.
          </div>
        ) : (
          <div className="scroll-thin max-h-[220px] overflow-y-auto">
            {candidates.map((a) => {
              const isPlaceholder = a.is_placeholder === 1;
              return (
                <Button
                  key={a.id}
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onPick(a.id)}
                  className="w-full justify-start gap-2 rounded-none px-3 font-normal text-[11.5px]"
                >
                  <span
                    className={`flex-1 truncate ${
                      isPlaceholder
                        ? "italic text-[var(--color-text-dim)]"
                        : "text-[var(--color-text)]"
                    }`}
                  >
                    {a.name}
                    {isPlaceholder ? " (placeholder)" : ""}
                  </span>
                  <ActorBadge type={a.type} placeholder={isPlaceholder} />
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function IdCopy({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard write rejected; skip copied state */
    }
  };
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={handle}
      title="Kliknutím zkopírujete ID"
      className="group h-auto shrink-0 gap-1.5 px-1 py-0.5 font-mono text-[11.5px] font-normal text-[var(--color-text-muted)] hover:bg-transparent hover:text-[var(--color-text)]"
    >
      <span>{id}</span>
      {copied ? (
        <Check className="text-[var(--color-accent)]" />
      ) : (
        <Copy className="opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </Button>
  );
}

// (i) icon that toggles a small popover with a raw JSON dump of node.meta.
// Debug-only: meta is dev/import bookkeeping (e.g. source: "evoluce",
// evoluce_entity_id, ...), not user-facing labels. Hidden entirely when
// meta is empty/null so it adds no visual noise to nodes without meta.
function MetaSection({ meta }: { meta: unknown }) {
  const [open, setOpen] = useState(false);
  if (!meta || typeof meta !== "object" || Object.keys(meta as object).length === 0) {
    return null;
  }
  return (
    <div className="px-6 py-3">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen((v) => !v)}
        className="h-auto gap-1.5 px-1 py-0.5 font-mono text-[11px] font-normal uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:bg-transparent hover:text-[var(--color-text)]"
      >
        <Info />
        Meta
        {open ? <ChevronUp /> : <ChevronDown />}
      </Button>
      {open && (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          {JSON.stringify(meta, null, 2)}
        </pre>
      )}
    </div>
  );
}

// Remote-folder actions in the identity row: copy the folder's web URL, then
// open it. Both fetch the routed remote's web URL for the node folder and
// render nothing when there is none (no routed remote, a backend without a
// web URL such as s3/sftp, or a folder not synced yet) -- best-effort, same
// as the old FolderLink icon this replaces. A Google Drive URL gets the
// Drive mark; anything else a generic link icon labelled by remote name.
function RemoteFolderActions({ nodeId }: { nodeId: string }) {
  const [info, setInfo] = useState<{ url: string; remote_name?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    fetchNodeFolderUrl(nodeId)
      .then((r) => {
        if (cancelled) return;
        if (r.url) setInfo({ url: r.url, remote_name: r.remote_name });
      })
      .catch(() => { /* best-effort -- absence is fine */ });
    return () => { cancelled = true; };
  }, [nodeId]);
  if (!info) return null;
  const isDrive = /(^|\.)drive\.google\.com$/.test(safeHost(info.url));
  const label = isDrive ? "Google Drive" : (info.remote_name ?? "remote");
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyText(info.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard write rejected; skip copied state */
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        title={`Kopírovat odkaz na ${label}`}
        aria-label={`Kopírovat odkaz na ${label}`}
        className="text-muted-foreground"
      >
        {copied ? <Check className="text-[var(--color-accent)]" /> : isDrive ? <GoogleDriveIcon size={13} /> : <Link2 />}
      </Button>
      <Button
        asChild
        variant="ghost"
        size="icon-xs"
        title={`Otevřít na ${label}`}
        aria-label={`Otevřít na ${label}`}
        className="text-muted-foreground"
      >
        <a {...externalLinkProps(info.url, { onClick: (e) => e.stopPropagation() })}>
          <ExternalLink />
        </a>
      </Button>
    </>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// Header action that creates the local mirror for this node. Fills the
// same horizontal slot as PathCopy so the
// layout doesn't shift the moment the mirror is created.
function CreateMirrorButton({
  pending,
  error,
  onCreate,
}: {
  pending: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11.5px] text-[var(--color-text-dim)]">
      <Button
        variant="ghost"
        size="xs"
        onClick={onCreate}
        disabled={pending}
        className="h-auto min-w-0 gap-1.5 px-1 py-0.5 font-mono text-[11.5px] font-normal text-[var(--color-text-muted)] hover:bg-transparent hover:text-[var(--color-text)]"
      >
        <Folder />
        <span className="truncate">
          {pending ? "Vytvářím…" : "Vytvořit pracovní složku"}
        </span>
      </Button>
      {error && (
        <span
          className="truncate"
          style={{ color: "var(--color-danger)" }}
          title={error}
        >
          {error}
        </span>
      )}
    </span>
  );
}

// Click-to-copy local mirror path. Sits right under IdCopy in the header so
// the two share the same "inline identifier" feel.
function PathCopy({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard write rejected; skip copied state */
    }
  };
  // `shrink min-w-0` overrides Button's base `shrink-0`: without it the
  // button keeps its full intrinsic width, the truncating span never engages
  // and a long path pushes the trailing icons past the header's right edge.
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={handle}
      title={`${path}\nKliknutím zkopírujete cestu`}
      className="group h-auto shrink min-w-0 gap-1.5 px-1 py-0.5 font-mono text-[11.5px] font-normal text-[var(--color-text-muted)] hover:bg-transparent hover:text-[var(--color-text)]"
    >
      <Folder />
      {/* dir="rtl" on the truncating span puts the ellipsis on the LEFT;
          <bdi> isolates the path so its own characters still read
          left-to-right. The leaf folder stays visible however long the
          prefix is. */}
      <span dir="rtl" className="min-w-0 truncate text-left">
        <bdi>{path}</bdi>
      </span>
      {copied ? (
        <Check className="shrink-0 text-[var(--color-accent)]" />
      ) : (
        <Copy className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </Button>
  );
}



