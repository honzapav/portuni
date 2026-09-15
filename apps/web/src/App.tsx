import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar, { type AppView } from "./components/Sidebar";
import DetailPane from "./components/DetailPane";
import SettingsPage from "./components/SettingsPage";
import WorkspaceView from "./components/WorkspaceView";
import OverviewView from "./components/OverviewView";
import EditorFullscreen from "./components/EditorFullscreen";
import EditorPane from "./components/EditorPane";
import StatusFooter from "./components/StatusFooter";
import CreateNodeModal from "./components/CreateNodeModal";
import NewTaskDialog from "./components/NewTaskDialog";
import { fetchGraph, fetchNode, fetchMe, fetchNodePersistentSessions } from "./api";
import type { SessionSummary } from "./types";
import { createSessionsClient, type SessionStateMessage } from "./lib/sessions-client";
import {
  applySessionStateFrame,
  countRunningSessions,
  mergeLiveSessionStates,
  pickOpenChatSession,
} from "./lib/session-views";
import { CREATE_NODE_SCOPE, isGlobalScope, scopeAtLeast } from "./lib/scopes";
import { useFileEditor } from "./lib/use-file-editor";
import { deriveWorkspaceNodeRows } from "./lib/sessions";
import { isTauri } from "./lib/backend-url";
import { useAppUpdate } from "./lib/updater";
import { useSyncPending } from "./lib/use-sync-pending";
import { pluralFiles } from "./lib/plural-files";
import SyncOverview from "./components/SyncOverview";

// Lazy chunks: cytoscape (the GraphView dep) is the main reason the app
// bundle blew past 500 kB. Splitting GraphView and ActorsPage cuts the
// initial bundle by ~70 % and keeps the marketing/docs sites snappy.
const GraphView = lazy(() => import("./components/GraphView"));
import type { GraphPayload, NodeDetail } from "./types";
import type { Theme } from "./lib/theme";
import { loadTheme, saveTheme, THEME_STORAGE_KEY } from "./lib/theme";
import { loadOpenNodes, saveOpenNodes } from "./lib/settings";
import { isShowtimePath } from "./lib/showtime";

// Files that have a useful rendered preview (MarkdownPreview). These open in
// Náhled by default; everything else starts in the source editor.
function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relPath);
}

export function isHtmlPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

// Cancels a pending window close (#229): tells the Rust host this window's
// close-guard chain (dirty editor / unsynced files) said no. Cancels the 5s fallback timer Rust armed alongside window.close()
// (without this, cancelling force-closed anyway once the timer fired,
// #221) and, if this close was part of a Cmd+Q/restart sequential quit,
// aborts the whole sequence -- no further window is asked and the app does
// not exit. A no-op outside Tauri, or when nothing was actually pending
// (a plain single-window close outside any quit).
async function declineExit(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("decline_exit").catch(() => undefined);
}

// Proceeds with a window close the guard chain approved (#229): destroys
// this window directly, bypassing any further guard (there is nothing left
// to check). Whether this was a plain close or one step of a sequential
// quit, Rust's on_window_event(Destroyed) handler takes it from there.
async function destroyCurrentWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy().catch(() => undefined);
}

export default function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  // theme is a global preference (#228, unlike the workspace-scoped keys
  // elsewhere), so a change made in one window must apply live in every
  // other one too -- all windows share the same localStorage origin, but
  // each only ever reads its own copy into React state once, at mount. The
  // native `storage` event fires in every OTHER window when one of them
  // writes, so re-reading here on that event is what keeps them in sync
  // without a reload.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setTheme(loadTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const [view, setView] = useState<AppView>(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("view");
    if (v === "workspace") return "workspace";
    if (v === "settings") return "settings";
    if (v === "graph") return "graph";
    return "overview";
  });

  const [selectedId, setSelectedIdRaw] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("node");
  });
  // Mirror of selectedId for async callbacks (poll, late responses) that
  // must check the *current* selection without re-subscribing.
  const selectedIdRef = useRef<string | null>(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const historyRef = useRef<string[]>([]);

  const [nodeDetail, setNodeDetail] = useState<NodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [disabledRelations, setDisabledRelations] = useState<Set<string>>(
    () => new Set(),
  );
  const [disabledOrgs, setDisabledOrgs] = useState<Set<string>>(
    () => new Set(),
  );
  const [disabledTypes, setDisabledTypes] = useState<Set<string>>(
    () => new Set(),
  );
  // Status filter defaults: show active + completed, hide archived. Users
  // can toggle all three in the sidebar.
  const [disabledStatuses, setDisabledStatuses] = useState<Set<string>>(
    () => new Set(["archived"]),
  );

  // Create-node modal. Triggered from the sidebar's "+ Nová node" button
  // and from the empty-state CTA on the graph canvas. `forceType` is set
  // by the empty-state CTA so the user only sees the org-creation path
  // until at least one organization exists.
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createModalForceType, setCreateModalForceType] = useState<
    "organization" | undefined
  >(undefined);

  const openCreateModal = useCallback(
    (opts?: { forceType?: "organization" }) => {
      setCreateModalForceType(opts?.forceType);
      setCreateModalOpen(true);
    },
    [],
  );

  // Whether the caller's global scope allows POST /nodes. Drives the
  // create-node buttons (sidebar, workspace, empty-state CTA) so a user
  // below the required scope sees a disabled control instead of a 403 on
  // submit. Optimistic (true) until /me resolves -- the server still
  // enforces, and a fetch failure must not hide the primary action.
  const [canCreateNode, setCanCreateNode] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void fetchMe()
      .then((me) => {
        if (cancelled || !isGlobalScope(me.global_scope)) return;
        setCanCreateNode(scopeAtLeast(me.global_scope, CREATE_NODE_SCOPE));
      })
      .catch(() => {
        /* stays true -- server gates the request */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stable identities for props of memoized children (Sidebar, GraphView,
  // DetailPane). Inline arrows would defeat React.memo on every render.
  const openSettingsView = useCallback(() => setView("settings"), []);
  const openWorkspaceView = useCallback(() => setView("workspace"), []);
  const handleCreateNodeClick = useCallback(() => openCreateModal(), [openCreateModal]);
  const handleCreateOrganization = useCallback(
    () => openCreateModal({ forceType: "organization" }),
    [openCreateModal],
  );

  // Apply theme to <html> and persist
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    saveTheme(theme);
  }, [theme]);

  // Load graph on mount
  useEffect(() => {
    fetchGraph()
      .then((g) => {
        setGraph(g);
        setGraphError(null);
      })
      .catch((err) => setGraphError(String(err)));
  }, []);

  // Sync URL with selected node
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) {
      url.searchParams.set("node", selectedId);
    } else {
      url.searchParams.delete("node");
    }
    window.history.replaceState(null, "", url.toString());
  }, [selectedId]);

  // Sync URL with current view. Default "overview" is omitted from the URL
  // to keep it clean; ?view=graph / ?view=workspace / ?view=settings only
  // appear when on those views. The ?node param coexists and is only
  // meaningful in graph view.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "overview") {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", view);
    }
    // ?settingsTab is only meaningful inside the Settings page; drop it
    // when navigating away so it doesn't leak into other views' URLs.
    if (view !== "settings") {
      url.searchParams.delete("settingsTab");
    }
    window.history.replaceState(null, "", url.toString());
  }, [view]);

  // Load detail when selection changes. The cancelled flag matters: without
  // it a slow response for node A lands after the user already clicked node
  // B and paints A's detail under B's selection.
  // Central mode serves node-detail from the central server, which has no
  // device state, so local_mirror comes back null even when this device owns
  // the mirror. Overlay it from the local sync agent (GET /nodes/:id/mirror).
  // Local mode already carries local_mirror in node-detail, so skip the extra
  // call there; orgs never have a mirror.
  // The local_mirror overlay lives in fetchNode (api.ts) — the single fetch
  // point every consumer already goes through. App used to run it a second
  // time on top, re-requesting /nodes/:id/mirror after fetchNode had already
  // asked and legitimately got null.

  useEffect(() => {
    if (!selectedId) {
      setNodeDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    fetchNode(selectedId)
      .then((n) => {
        if (cancelled) return;
        setNodeDetail(n);
        setDetailLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setDetailError(String(err));
        setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Refetch both the graph and the current node. Called by the DetailPane
  // after any mutation so the viz and the detail stay in sync.
  const refetchAll = useCallback(async () => {
    const [graphRes, nodeRes] = await Promise.all([
      fetchGraph(),
      selectedId ? fetchNode(selectedId).catch(() => null) : Promise.resolve(null),
    ]);
    setGraph(graphRes);
    setGraphError(null);
    if (nodeRes) setNodeDetail(nodeRes);
  }, [selectedId]);

  const setSelectedId = useCallback(
    (id: string | null) => {
      setSelectedIdRaw((prev) => {
        if (prev && prev !== id) {
          historyRef.current.push(prev);
        }
        return id;
      });
    },
    [],
  );

  const goBack = useCallback(() => {
    const prev = historyRef.current.pop();
    if (prev) setSelectedIdRaw(prev);
  }, []);

  const toggleRelation = useCallback((r: string) => {
    setDisabledRelations((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  }, []);

  const toggleOrg = useCallback((id: string) => {
    setDisabledOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleType = useCallback((t: string) => {
    setDisabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  const toggleStatus = useCallback((s: string) => {
    setDisabledStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  // --- Workspace state ---
  const [selectedWorkspaceNodeId, setSelectedWorkspaceNodeId] = useState<string | null>(null);
  // The set of nodes open in the workspace. Persisted across restarts and
  // pruned against the graph once it loads.
  const [openNodeIds, setOpenNodeIds] = useState<string[]>(() => loadOpenNodes());
  useEffect(() => {
    saveOpenNodes(openNodeIds);
  }, [openNodeIds]);

  // Open a node in the workspace -- the core of "open more nodes and switch
  // between them". Idempotent; focuses the node and flips to the workspace
  // view.
  const openNode = useCallback((nodeId: string) => {
    setOpenNodeIds((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
    setSelectedWorkspaceNodeId(nodeId);
    setView("workspace");
  }, []);

  // Select a node in the workspace; selecting a not-yet-open node opens it
  // (so navigating via the detail pane grows the open set instead of leaving
  // a selected-but-unlisted ghost). Null clears the selection.
  const workspaceSelectNode = useCallback(
    (id: string | null) => {
      if (id == null) {
        setSelectedWorkspaceNodeId(null);
        return;
      }
      openNode(id);
    },
    [openNode],
  );

  // Přehled tab (#196) navigation: a node reference switches to Graf and
  // opens its detail pane; a session reference opens the node in Práce and
  // focuses that session (openSessionChat below).
  const overviewSelectNode = useCallback(
    (id: string) => {
      setSelectedId(id);
      setView("graph");
    },
    [setSelectedId],
  );

  // Also #343's "Otevřít chat" (Relace tab, Práce sidebar, Přehled): jumps
  // to Práce with the node selected and THAT session as the node's shown
  // chat. A node can have several running/suspended sessions, so the
  // clicked row is the selector -- #342's workspaceOpenSession effect
  // prefers this id when it is among the node's live sessions and only
  // falls back to the newest live one otherwise (first open, or the
  // requested session has since closed).
  const [requestedChatSessionByNode, setRequestedChatSessionByNode] = useState<Record<string, string>>({});
  const openSessionChat = useCallback(
    (nodeId: string, sessionId?: string) => {
      if (sessionId) setRequestedChatSessionByNode((p) => ({ ...p, [nodeId]: sessionId }));
      openNode(nodeId);
    },
    [openNode],
  );

  // The workspace's left-column rows: the open nodes, in open order, with
  // name/type resolved from the graph.
  const workspaceRows = useMemo(
    () =>
      deriveWorkspaceNodeRows(openNodeIds, (id) => {
        const n = graph?.nodes.find((g) => g.id === id);
        return n ? { name: n.name, type: n.type } : undefined;
      }),
    [openNodeIds, graph],
  );

  // Prune persisted open ids and the workspace selection against the graph
  // once it loads, so a node deleted out from under a stale id disappears
  // instead of rendering a ghost row.
  useEffect(() => {
    if (!graph) return;
    const exists = new Set(graph.nodes.map((n) => n.id));
    setOpenNodeIds((prev) => {
      const next = prev.filter((id) => exists.has(id));
      return next.length === prev.length ? prev : next;
    });
    setSelectedWorkspaceNodeId((prev) => (prev && !exists.has(prev) ? null : prev));
  }, [graph]);
  // Set when the create-node modal is opened from the workspace view, so that
  // on success the freshly created node opens in the workspace. Reset on
  // close or after handling.
  const createFromWorkspaceRef = useRef(false);

  // Detail for the workspace's selected node. Kept separate from
  // graph-view's `nodeDetail` so the two views can have independent
  // selection (the graph is for browsing, the workspace is for active
  // work — different selections make sense).
  const [workspaceNodeDetail, setWorkspaceNodeDetail] = useState<NodeDetail | null>(null);
  const [workspaceDetailLoading, setWorkspaceDetailLoading] = useState(false);
  const [workspaceDetailError, setWorkspaceDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedWorkspaceNodeId) {
      setWorkspaceNodeDetail(null);
      setWorkspaceDetailError(null);
      return;
    }
    setWorkspaceDetailLoading(true);
    setWorkspaceDetailError(null);
    let cancelled = false;
    fetchNode(selectedWorkspaceNodeId)
      .then((n) => {
        if (cancelled) return;
        setWorkspaceNodeDetail(n);
        setWorkspaceDetailLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setWorkspaceDetailError(String(err));
        setWorkspaceDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceNodeId]);

  const refetchWorkspaceDetail = useCallback(async () => {
    if (!selectedWorkspaceNodeId) return;
    try {
      const n = await fetchNode(selectedWorkspaceNodeId);
      setWorkspaceNodeDetail(n);
      setWorkspaceDetailError(null);
    } catch (err) {
      setWorkspaceDetailError(String(err));
    }
  }, [selectedWorkspaceNodeId]);

  // --- Runner batch (#342): SessionChat in Práce ---
  //
  // One WebSocket bridge for the whole app, kept for the life of this
  // component. Connected from an effect (with a disconnect cleanup) rather
  // than at creation: StrictMode runs the state initializer and every
  // effect twice in dev, and a transport opened inside the initializer had
  // no cleanup, so the discarded first client kept a live socket delivering
  // every frame twice.
  const [sessionsClient] = useState(() => createSessionsClient({ autoConnect: false }));
  useEffect(() => {
    sessionsClient.connect();
    return () => sessionsClient.disconnect();
  }, [sessionsClient]);

  // #343: the latest session_state frame per session -- sent for every
  // session the caller can see the moment sessionsClient connects, and
  // again on every state_changed/question/run_ended anywhere, no
  // per-session subscribe needed. Drives StatusFooter's running-session
  // count, the Práce sidebar's live status overlay (openSessionsByNode
  // below) and the refresh of the selected node's shown chat. Entries in a
  // terminal state are dropped once nothing live shares the node, so the
  // map tracks what is running, not everything that ever ran while this
  // window was open.
  const [sessionStates, setSessionStates] = useState<Record<string, SessionStateMessage>>({});
  useEffect(() => {
    return sessionsClient.onSessionState((s) => {
      setSessionStates((prev) => applySessionStateFrame(prev, s));
    });
  }, [sessionsClient]);
  const runningSessionCount = useMemo(() => countRunningSessions(sessionStates), [sessionStates]);


  // The selected node's own persistent session, when it has one that's
  // running/waiting/suspended -- drives whether WorkspaceView's detail
  // surface shows SessionChat instead of DetailPane. Refetched whenever the
  // workspace selection changes, same pattern as workspaceNodeDetail above.
  const [workspaceOpenSession, setWorkspaceOpenSession] = useState<SessionSummary | null>(null);
  const requestedChatSessionId = selectedWorkspaceNodeId
    ? (requestedChatSessionByNode[selectedWorkspaceNodeId] ?? null)
    : null;
  // Re-run on every live state change of a session on the selected node
  // too (a task just started from "Nový úkol", the shown one just closed)
  // -- the REST fetch is what knows the full SessionSummary, the socket
  // only says that something changed.
  const selectedNodeLiveStamp = useMemo(() => {
    if (!selectedWorkspaceNodeId) return "";
    return Object.values(sessionStates)
      .filter((s) => s.node_id === selectedWorkspaceNodeId)
      .map((s) => `${s.session_id}:${s.state}`)
      .sort()
      .join(",");
  }, [sessionStates, selectedWorkspaceNodeId]);
  useEffect(() => {
    if (!selectedWorkspaceNodeId) {
      setWorkspaceOpenSession(null);
      return;
    }
    let cancelled = false;
    fetchNodePersistentSessions(selectedWorkspaceNodeId, false)
      .then((res) => {
        if (cancelled) return;
        setWorkspaceOpenSession(pickOpenChatSession(res.sessions, requestedChatSessionId));
      })
      .catch(() => {
        if (!cancelled) setWorkspaceOpenSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceNodeId, requestedChatSessionId, selectedNodeLiveStamp]);


  // #343's Práce sidebar: every OPEN node's own running/suspended
  // persistent sessions, for WorkspaceNodeList's sub-rows. Refetched
  // whenever the open-node set changes (a node opening/closing); live
  // state (above) is overlaid at render time via mergeLiveSessionStates
  // rather than duplicating the subscribe-per-session machinery
  // SessionChat needs for its own event log.
  const [openSessionsByNode, setOpenSessionsByNode] = useState<Record<string, SessionSummary[]>>({});
  useEffect(() => {
    if (openNodeIds.length === 0) {
      setOpenSessionsByNode({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      openNodeIds.map((id) =>
        fetchNodePersistentSessions(id, false)
          .then((res) => [id, res.sessions.filter((s) => s.state === "running" || s.state === "suspended")] as const)
          .catch(() => [id, []] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setOpenSessionsByNode(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [openNodeIds]);
  const liveOpenSessionsByNode = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(openSessionsByNode).map(([id, list]) => [id, mergeLiveSessionStates(list, sessionStates)]),
      ),
    [openSessionsByNode, sessionStates],
  );

  // --- Source editor state ---
  const [editorFile, setEditorFile] = useState<{ nodeId: string; relPath: string } | null>(null);
  const [editorFullscreen, setEditorFullscreen] = useState(false);
  // Edit/preview mode lives here (next to editorFile) so it survives the
  // pane <-> fullscreen transition; the two shells mount separate
  // EditorBody instances.
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
  // Pending action blocked by unsaved changes. Drives the inline confirm
  // dialog -- window.confirm is a no-op in the Tauri webview.
  const [editorGuard, setEditorGuard] = useState<
    | null
    | { kind: "close" }
    | { kind: "open"; nodeId: string; relPath: string }
    | { kind: "quit" }
  >(null);

  // One shared editor instance, owned here and handed to BOTH the pane and
  // the fullscreen shell. Hooks must run unconditionally, so we call it with
  // nulls when no file is open (the hook is inert in that case). Sharing it
  // is what keeps unsaved edits across the expand/collapse transition and
  // avoids a second GET when fullscreen mounts.
  const fileEditor = useFileEditor(
    editorFile?.nodeId ?? null,
    editorFile?.relPath ?? null,
  );
  const editorDirty = fileEditor.dirty;
  const editorDirtyRef = useRef(editorDirty);
  useEffect(() => {
    editorDirtyRef.current = editorDirty;
  }, [editorDirty]);

  const {
    pending: syncPending,
    refresh: refreshSyncPending,
    applyRun: applySyncRun,
  } = useSyncPending();
  const [syncOverviewOpen, setSyncOverviewOpen] = useState(false);

  const syncPendingRef = useRef(syncPending.total);
  useEffect(() => {
    syncPendingRef.current = syncPending.total;
  }, [syncPending.total]);
  const [syncQuitGuard, setSyncQuitGuard] = useState<{ count: number } | null>(null);

  const appUpdate = useAppUpdate();

  const reallyOpenFile = useCallback((nodeId: string, relPath: string) => {
    // Always open in the right-side pane first (replacing the detail pane in
    // both graph and workspace views). Fullscreen is opt-in via the expand (⤢)
    // button, never automatic.
    setEditorFile({ nodeId, relPath });
    setEditorFullscreen(false);
    // Markdown opens in Náhled (rendered preview) by default; editing is the
    // secondary mode. Other file types have no useful preview, so they start
    // in the source editor. A Showtime deck has only the preview.
    setEditorMode(
      isMarkdownPath(relPath) || isHtmlPath(relPath) || isShowtimePath(relPath)
        ? "preview"
        : "edit",
    );
    setEditorGuard(null);
  }, []);
  const openFileInEditor = useCallback(
    (nodeId: string, relPath: string) => {
      if (
        editorDirtyRef.current &&
        (editorFile?.nodeId !== nodeId || editorFile?.relPath !== relPath)
      ) {
        setEditorGuard({ kind: "open", nodeId, relPath });
        return;
      }
      reallyOpenFile(nodeId, relPath);
    },
    [editorFile, reallyOpenFile],
  );
  const reallyCloseEditor = useCallback(() => {
    setEditorFile(null);
    setEditorFullscreen(false);
    setEditorGuard(null);
  }, []);
  const closeEditor = useCallback(() => {
    if (editorDirtyRef.current) {
      setEditorGuard({ kind: "close" });
      return;
    }
    reallyCloseEditor();
  }, [reallyCloseEditor]);

  // Resolve the guarded action: either after saving or after an explicit
  // discard. "quit" (raised by onCloseRequested, #229) destroys the window
  // directly -- Rust's on_window_event(Destroyed) handler takes it from
  // there, whether this was a plain close or one step of a sequential quit.
  const resolveEditorGuard = useCallback(
    async (how: "save" | "discard") => {
      const guard = editorGuard;
      if (!guard) return;
      if (how === "save") {
        await fileEditor.save();
        if (editorDirtyRef.current) return; // save failed/conflict -- stay
      }
      if (guard.kind === "open") {
        reallyOpenFile(guard.nodeId, guard.relPath);
      } else if (guard.kind === "close") {
        reallyCloseEditor();
      } else {
        setEditorGuard(null);
        await destroyCurrentWindow();
      }
    },
    [editorGuard, fileEditor, reallyOpenFile, reallyCloseEditor],
  );

  // Browser: warn before unload while dirty. Tauri: intercept the window
  // close request and route it through the same inline confirms -- the
  // ONLY close-guard chain now (#229): Cmd+Q, menu Quit, the updater's
  // restart, and a plain click on this window's own close button all reach
  // it the same way, since Rust closes windows via window.close(), which
  // raises this same event, rather than a separate app-exit-requested
  // broadcast + confirm dance. Order: dirty editor -> unsynced files. Runs
  // belong to the sidecar and survive a window close, so there is no third
  // guard for them.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (editorDirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    let unlisten: (() => void) | null = null;
    if (isTauri()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          unlisten = await getCurrentWindow().onCloseRequested((event) => {
            if (editorDirtyRef.current) {
              event.preventDefault();
              setEditorGuard({ kind: "quit" });
            } else if (syncPendingRef.current > 0) {
              event.preventDefault();
              setSyncQuitGuard({ count: syncPendingRef.current });
            }
          });
        } catch {
          /* not running in Tauri */
        }
      })();
    }
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      try {
        unlisten?.();
      } catch {
        /* window already gone */
      }
    };
  }, []);

  // Refetch on focus AND tab-visible. Covers BOTH the graph selection and
  // the workspace selection so files registered elsewhere (MCP / another
  // window) show up without a manual reselect. Both events fire on the
  // same cmd-tab activation, so dedupe within a short window -- otherwise
  // every activation costs 2x fetchGraph + 2x fetchNode against Turso.
  useEffect(() => {
    let lastRun = 0;
    const handler = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastRun < 500) return;
      lastRun = now;
      refetchAll().catch((err) => setGraphError(String(err)));
      refetchWorkspaceDetail().catch(() => undefined);
    };
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, [refetchAll, refetchWorkspaceDetail]);

  // Poll the active node detail so externally-registered files appear within
  // seconds. Node-detail only (the graph poll stays on focus). Paused when
  // the tab is hidden to avoid background churn against Turso.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      if (view === "workspace" && selectedWorkspaceNodeId) {
        refetchWorkspaceDetail().catch(() => undefined);
      } else if (selectedId) {
        const requestId = selectedId;
        fetchNode(requestId)
          // Drop responses that arrive after the selection moved on --
          // otherwise a slow poll paints the previous node's detail.
          .then((n) => {
            if (selectedIdRef.current !== requestId) return;
            // Returning the previous object when nothing changed makes React
            // bail out of the render entirely. The poll fires every 5 s
            // whether or not the node moved, and it used to hand DetailPane a
            // fresh object each time, re-rendering the whole subtree —
            // files, timeline and all — for identical data. Comparing a
            // ~13 kB detail payload costs ~24 us; the render never does.
            setNodeDetail((prev) =>
              prev && JSON.stringify(prev) === JSON.stringify(n) ? prev : n,
            );
          })
          .catch(() => undefined);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [view, selectedWorkspaceNodeId, selectedId, refetchWorkspaceDetail]);

  // "+" on a Práce node row: start a task there. NewTaskDialog needs the
  // node's detail (name, organization edge for the instance default), so
  // fetch it first; the node is opened/selected at the same time so the
  // fresh thread lands where it is visible.
  const [newTaskNode, setNewTaskNode] = useState<NodeDetail | null>(null);
  const workspaceNewTask = useCallback(
    (nodeId: string) => {
      openNode(nodeId);
      void fetchNode(nodeId)
        .then((detail) => setNewTaskNode(detail))
        .catch(() => setNewTaskNode(null));
    },
    [openNode],
  );

  const workspaceCreateNode = useCallback(() => {
    createFromWorkspaceRef.current = true;
    openCreateModal();
  }, [openCreateModal]);

  // Close a node: drop it from the open set. Its sessions keep running on
  // the sidecar. Moves the workspace selection to a neighbouring open node,
  // or clears it when nothing is left.
  const closeNode = useCallback(
    (nodeId: string) => {
      setOpenNodeIds((prev) => prev.filter((id) => id !== nodeId));
      setSelectedWorkspaceNodeId((prev) => {
        if (prev !== nodeId) return prev;
        const remaining = workspaceRows.filter((r) => r.id !== nodeId);
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      });
    },
    [workspaceRows],
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {graph && (
        <Sidebar
          graph={graph}
          query={query}
          onQuery={setQuery}
          disabledRelations={disabledRelations}
          onToggleRelation={toggleRelation}
          disabledOrgs={disabledOrgs}
          onToggleOrg={toggleOrg}
          disabledTypes={disabledTypes}
          onToggleType={toggleType}
          disabledStatuses={disabledStatuses}
          onToggleStatus={toggleStatus}
          selectedId={selectedId}
          onSelect={setSelectedId}
          theme={theme}
          onThemeToggle={toggleTheme}
          view={view}
          onViewChange={setView}
          onOpenSettings={openSettingsView}
          onCreateNode={handleCreateNodeClick}
          canCreateNode={canCreateNode}
          workspaceBadge={workspaceRows.length}
          workspaceRows={workspaceRows}
          workspaceSelectedNodeId={selectedWorkspaceNodeId}
          onWorkspaceSelectNode={workspaceSelectNode}
          onWorkspaceCloseNode={closeNode}
          onWorkspaceNewTask={workspaceNewTask}
          workspaceOpenSessionsByNode={liveOpenSessionsByNode}
          onWorkspaceOpenSessionChat={openSessionChat}
          onWorkspaceOpenNode={openNode}
          onWorkspaceCreateNode={workspaceCreateNode}
        />
      )}

      <main className="relative min-w-0 flex-1 bg-[var(--color-bg)]">
        {graphError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="rounded-md border border-red-900 bg-red-950/30 px-6 py-4 text-[13.5px] text-red-300">
              <div className="mb-2 font-semibold">Nepodařilo se načíst graf</div>
              <div className="font-mono text-[13.5px] opacity-80">
                {graphError}
              </div>
              <div className="mt-3 text-[13.5px] text-red-200/70">
                Běží Portuni server na portu 4011?
              </div>
            </div>
          </div>
        )}
        {/*
          Jen pohledy, které graph skutečně konzumují. Overview i Nastavení
          se renderují bez něj (a Overview nese vlastní loading stav), takže
          jinak by se tenhle absolutně pozicovaný overlay při startu
          překrýval s jejich obsahem ve stejném místě.
        */}
        {!graph && !graphError && (view === "graph" || view === "workspace") && (
          <div className="absolute inset-0 flex items-center justify-center text-[14px] text-[var(--color-text-dim)]">
            Načítám graf...
          </div>
        )}
        {view === "overview" && (
          <OverviewView onSelectNode={overviewSelectNode} onOpenSession={openSessionChat} liveStates={sessionStates} />
        )}
        {graph && view === "graph" && (
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-[14px] text-[var(--color-text-dim)]">
                Načítám graf...
              </div>
            }
          >
            <GraphView
              graph={graph}
              selectedId={selectedId}
              query={query}
              disabledRelations={disabledRelations}
              disabledOrgs={disabledOrgs}
              disabledTypes={disabledTypes}
              disabledStatuses={disabledStatuses}
              theme={theme}
              onSelect={setSelectedId}
              onCreateOrganization={handleCreateOrganization}
              canCreateNode={canCreateNode}
            />
          </Suspense>
        )}
        {/* Mounted on demand so the picker's autoFocus doesn't steal focus
            from the graph view. */}
        {view === "workspace" && (
          <div className="absolute inset-0">
            <WorkspaceView
              graph={graph}
              selectedNodeId={selectedWorkspaceNodeId}
              onSelectNode={workspaceSelectNode}
              onOpenNodeFromPicker={(node) => openNode(node.id)}
              openNodeCount={workspaceRows.length}
              nodeDetail={workspaceNodeDetail}
              nodeDetailLoading={workspaceDetailLoading}
              nodeDetailError={workspaceDetailError}
              onMutate={async () => {
                await Promise.all([refetchAll(), refetchWorkspaceDetail()]);
              }}
              editorFile={editorFile}
              editor={fileEditor}
              editorFullscreen={editorFullscreen}
              editorMode={editorMode}
              onEditorModeChange={setEditorMode}
              onOpenFile={openFileInEditor}
              onCloseEditor={closeEditor}
              onExpandEditor={() => setEditorFullscreen(true)}
              openSession={workspaceOpenSession}
              sessionsClient={sessionsClient}
              liveSessionStates={sessionStates}
              onSessionUpdated={setWorkspaceOpenSession}
              onSessionStarted={(result) => setWorkspaceOpenSession(result.session)}
              onOpenChat={openSessionChat}
            />
          </div>
        )}
        {view === "settings" && (
          <SettingsPage appUpdate={appUpdate} />
        )}
      </main>

      {view === "graph" &&
        selectedId &&
        (editorFile &&
        !editorFullscreen &&
        editorFile.nodeId === selectedId ? (
          // Editor takes over the right slide-out slot (same geometry as the
          // detail pane). "← zpět" returns to the detail; ⤢ goes fullscreen.
          <aside className="animate-slide-in flex h-full w-[40vw] min-w-[440px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]">
            <EditorPane
              editor={fileEditor}
              relPath={editorFile.relPath}
              mode={editorMode}
              onModeChange={setEditorMode}
              onClose={closeEditor}
              onExpand={() => setEditorFullscreen(true)}
            />
          </aside>
        ) : (
          <DetailPane
            node={nodeDetail}
            graph={graph}
            loading={detailLoading}
            error={detailError}
            onSelect={setSelectedId}
            canGoBack={historyRef.current.length > 0}
            onBack={goBack}
            onMutate={refetchAll}
            onOpenFile={openFileInEditor}
            onOpenChat={openSessionChat}
            onSessionStarted={({ session }) => {
              // Graf has no chat surface of its own, so a task started here
              // lands in Práce: the node opens and the fresh session is the
              // thread it shows. Without this the run is live with nowhere
              // in the UI showing it.
              if (session.node_id) openSessionChat(session.node_id, session.id);
            }}
            liveSessionStates={sessionStates}
          />
        ))}

      </div>
      <StatusFooter
        onOpenSettings={openSettingsView}
        sessionCount={runningSessionCount}
        onOpenWorkspace={openWorkspaceView}
        pendingCount={syncPending.total}
        onOpenSyncOverview={() => setSyncOverviewOpen(true)}
        appUpdate={appUpdate}
      />
      {createModalOpen && graph && (
        <CreateNodeModal
          existingNodes={graph.nodes}
          forceType={createModalForceType}
          defaultOrgId={
            // When the user is staring at a non-org node and clicks
            // "+ Nová node", default to that node's organization.
            nodeDetail
              ? nodeDetail.type === "organization"
                ? nodeDetail.id
                : nodeDetail.edges.find(
                    (e) =>
                      e.relation === "belongs_to" &&
                      e.direction === "outgoing" &&
                      e.peer_type === "organization",
                  )?.peer_id
              : undefined
          }
          onClose={() => {
            createFromWorkspaceRef.current = false;
            setCreateModalOpen(false);
          }}
          onCreated={(node) => {
            setCreateModalOpen(false);
            setSelectedId(node.id);
            refetchAll().catch((err) => setGraphError(String(err)));
            // Opened from the workspace "vytvoř nový uzel" action: open the
            // freshly created node in the workspace (works for orgs too).
            if (createFromWorkspaceRef.current) {
              createFromWorkspaceRef.current = false;
              openNode(node.id);
            }
          }}
        />
      )}
      {newTaskNode && (
        <NewTaskDialog
          node={newTaskNode}
          onClose={() => setNewTaskNode(null)}
          onStarted={({ session }) => {
            setNewTaskNode(null);
            setWorkspaceOpenSession(session);
            if (session.node_id) openSessionChat(session.node_id, session.id);
          }}
        />
      )}
      {editorFile && editorFullscreen && (
        <EditorFullscreen
          editor={fileEditor}
          relPath={editorFile.relPath}
          mode={editorMode}
          onModeChange={setEditorMode}
          // Both graph and workspace render the pane when not fullscreen, so
          // collapsing always returns to the right-side pane.
          onCollapse={() => setEditorFullscreen(false)}
          onClose={closeEditor}
        />
      )}
      {editorGuard && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="w-[420px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl">
            <div className="mb-2 text-[14.5px] font-semibold text-[var(--color-text)]">
              Neuložené změny
            </div>
            <p className="mb-4 text-[13px] leading-relaxed text-[var(--color-text-dim)]">
              {editorGuard.kind === "quit"
                ? "Soubor v editoru má neuložené změny. Chceš je před zavřením aplikace uložit?"
                : "Soubor v editoru má neuložené změny. Chceš je uložit?"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  const wasQuit = editorGuard?.kind === "quit";
                  setEditorGuard(null);
                  if (wasQuit) void declineExit();
                }}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)]"
              >
                Zpět do editoru
              </button>
              <button
                type="button"
                onClick={() => void resolveEditorGuard("discard")}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-danger)] hover:border-[var(--color-danger)]"
              >
                Zahodit změny
              </button>
              <button
                type="button"
                disabled={fileEditor.saving}
                onClick={() => void resolveEditorGuard("save")}
                className="rounded-md border border-[var(--color-accent-dim)] px-3 py-1.5 text-[12.5px] text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-60"
              >
                {fileEditor.saving ? "Ukládám…" : "Uložit"}
              </button>
            </div>
          </div>
        </div>
      )}
      {syncOverviewOpen && (
        <SyncOverview
          pending={syncPending}
          onClose={() => setSyncOverviewOpen(false)}
          onSynced={applySyncRun}
          onMutated={() => {
            refreshSyncPending();
            refetchAll().catch(() => undefined);
          }}
          onSelectNode={(id) => {
            setSyncOverviewOpen(false);
            setSelectedId(id);
          }}
        />
      )}
      {syncQuitGuard && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="w-[440px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl">
            <div className="mb-2 text-[14.5px] font-semibold text-[var(--color-text)]">
              Nesynchronizovaná práce
            </div>
            <p className="mb-4 text-[13px] leading-relaxed text-[var(--color-text-dim)]">
              Máš {syncQuitGuard.count} {pluralFiles(syncQuitGuard.count)}, které nejsou na remote (nesynchronizováno). Pokud aplikaci zavřeš, zůstanou jen lokálně.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setSyncQuitGuard(null);
                  void declineExit();
                }}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)]"
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={() => {
                  setSyncQuitGuard(null);
                  setSyncOverviewOpen(true);
                  void declineExit();
                }}
                className="rounded-md border border-[var(--color-accent-dim)] px-3 py-1.5 text-[12.5px] text-[var(--color-accent)] hover:bg-[var(--color-surface)]"
              >
                Zobrazit a synchronizovat
              </button>
              <button
                type="button"
                onClick={async () => {
                  setSyncQuitGuard(null);
                  await destroyCurrentWindow();
                }}
                className="rounded-md border border-[var(--color-danger-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-danger)] hover:bg-[var(--color-surface)]"
              >
                Zavřít bez synchronizace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
