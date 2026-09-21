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
import {
  fetchGraph,
  fetchNode,
  fetchMe,
  fetchNodePersistentSessions,
  startDraftThread,
  deletePersistentSession,
  renamePersistentSession,
} from "./api";
import type { SessionSummary, SessionRunRow } from "./types";
import { createSessionsClient, type SessionStateMessage } from "./lib/sessions-client";
import {
  applyNodeSessionsRefetch,
  applySessionStateFrame,
  countRunningSessions,
  dropPromotedDrafts,
  mergeDraftsIntoNodeMap,
  mergeLiveSessionStates,
  mergeSessionIntoNodeMap,
  mountedChatSessions,
  pickOpenChatSession,
  pruneNodeSessions,
  requestChatSession,
} from "./lib/session-views";
import { CREATE_NODE_SCOPE, isGlobalScope, scopeAtLeast } from "./lib/scopes";
import { useFileEditor } from "./lib/use-file-editor";
import { deriveWorkspaceNodeRows } from "./lib/sessions";
import { isTauri } from "./lib/backend-url";
import { useAppUpdate } from "./lib/updater";
import { useSyncPending } from "./lib/use-sync-pending";
import { pullNodeCount } from "./lib/remote-watch-view";
import { pluralFiles } from "./lib/plural";
import SyncOverview from "./components/SyncOverview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  // A team workspace serves node-detail from the central server, which has
  // no device state, so local_mirror comes back null even when this device
  // owns the mirror. Overlay it from the sync agent (GET /nodes/:id/mirror).
  // A personal workspace already carries local_mirror in node-detail, so skip
  // the extra call there; orgs never have a mirror.
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


  // Draft threads (#374): a draft is visible only as the open thread it
  // is -- every list the server serves (GET /nodes/:id/sessions included)
  // excludes it, so the window that created one tracks it here, keyed by
  // session id, until it is promoted (its first message starts the run) or
  // closed. It is dropped from here only once a refetch of its node's
  // threads actually carries it (dropPromotedDrafts, below): a promotion
  // frame says "it is running now", not "the list you last fetched has
  // it", and forgetting it on the frame alone made the row vanish the
  // moment a draft became a real thread (#412).
  const [localDrafts, setLocalDrafts] = useState<Record<string, SessionSummary>>({});

  // The selected node's own persistent session, when it has one that's
  // running/waiting/suspended/draft -- drives whether WorkspaceView's
  // detail surface shows SessionChat instead of DetailPane. Refetched
  // whenever the workspace selection changes, same pattern as
  // workspaceNodeDetail above.
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
    const localForNode = Object.values(localDrafts).filter((d) => d.node_id === selectedWorkspaceNodeId);
    fetchNodePersistentSessions(selectedWorkspaceNodeId, false)
      .then((res) => {
        if (cancelled) return;
        setWorkspaceOpenSession(pickOpenChatSession([...res.sessions, ...localForNode], requestedChatSessionId));
      })
      .catch(() => {
        if (!cancelled) setWorkspaceOpenSession(pickOpenChatSession(localForNode, requestedChatSessionId));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceNodeId, requestedChatSessionId, selectedNodeLiveStamp, localDrafts]);

  // A chat reporting its session back (a model/effort change, a live state
  // frame). Every open thread has a mounted chat now (#429), so the update
  // has to be matched by id: a hidden thread's frame must not replace the
  // shown one.
  const updateWorkspaceOpenSession = useCallback((updated: SessionSummary) => {
    setWorkspaceOpenSession((prev) => (prev && prev.id === updated.id ? updated : prev));
  }, []);


  // #343's Práce sidebar: every OPEN node's own running/suspended
  // persistent sessions, for WorkspaceNodeList's sub-rows. Refetched
  // whenever the open-node set changes (a node opening/closing); live
  // state (above) is overlaid at render time via mergeLiveSessionStates
  // rather than duplicating the subscribe-per-session machinery
  // SessionChat needs for its own event log.
  const [openSessionsByNode, setOpenSessionsByNode] = useState<Record<string, SessionSummary[]>>({});
  // What is open right now, readable from a fetch callback without making
  // the callback itself depend on it (a response for a node closed in the
  // meantime is dropped instead of re-adding its key).
  const openNodeIdsRef = useRef<string[]>(openNodeIds);
  useEffect(() => {
    openNodeIdsRef.current = openNodeIds;
  }, [openNodeIds]);
  // One node's threads, refetched. Coalesced per node: a second request
  // while one is in flight schedules exactly one follow-up instead of
  // racing a parallel fetch, so a burst of frames on the same node costs
  // at most two round trips and the last one always wins.
  const sessionRefetches = useRef(new Map<string, { trailing: boolean }>());
  const refreshNodeSessions = useCallback(function refresh(nodeId: string): void {
    const inFlight = sessionRefetches.current.get(nodeId);
    if (inFlight) {
      inFlight.trailing = true;
      return;
    }
    const entry = { trailing: false };
    sessionRefetches.current.set(nodeId, entry);
    void fetchNodePersistentSessions(nodeId, false)
      .then((res) => {
        if (!openNodeIdsRef.current.includes(nodeId)) return;
        setOpenSessionsByNode((prev) => applyNodeSessionsRefetch(prev, nodeId, res.sessions));
        setLocalDrafts((prev) => dropPromotedDrafts(prev, res.sessions));
      })
      .catch(() => undefined)
      .finally(() => {
        sessionRefetches.current.delete(nodeId);
        if (entry.trailing && openNodeIdsRef.current.includes(nodeId)) refresh(nodeId);
      });
  }, []);
  useEffect(() => {
    setOpenSessionsByNode((prev) => pruneNodeSessions(prev, openNodeIds));
    for (const id of openNodeIds) refreshNodeSessions(id);
  }, [openNodeIds, refreshNodeSessions]);
  // #412: a thread started anywhere else in the app (the Relace tab's
  // "Navázat", the node detail's "Nový úkol", another window) announces
  // itself only as a session_state frame, so that frame is what refetches
  // the node it belongs to -- without it the sidebar's map only ever
  // changed when the open-node set did.
  useEffect(() => {
    return sessionsClient.onSessionState((s) => {
      if (s.node_id && openNodeIdsRef.current.includes(s.node_id)) refreshNodeSessions(s.node_id);
    });
  }, [sessionsClient, refreshNodeSessions]);
  // Local drafts merged in per node (#374) -- the server-fetched list above
  // never contains one, and a promoted draft stays here until a refetch
  // proves the server list has it, so the merge dedupes by id.
  const openSessionsByNodeWithDrafts = useMemo(
    () => mergeDraftsIntoNodeMap(openSessionsByNode, localDrafts),
    [openSessionsByNode, localDrafts],
  );
  const liveOpenSessionsByNode = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(openSessionsByNodeWithDrafts).map(([id, list]) => [
          id,
          mergeLiveSessionStates(list, sessionStates),
        ]),
      ),
    [openSessionsByNodeWithDrafts, sessionStates],
  );

  // #429: every thread open in this window keeps a mounted SessionChat, so
  // switching threads is a visibility flip instead of a remount (scroll
  // position, streaming buffers and the composer survive, and nothing
  // re-subscribes). Closing a node or a thread drops it from this list,
  // which is what unmounts its chat and unsubscribes it.
  const workspaceMountedSessions = useMemo(
    () => mountedChatSessions(liveOpenSessionsByNode, openNodeIds, workspaceOpenSession),
    [liveOpenSessionsByNode, openNodeIds, workspaceOpenSession],
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

  // "+" on a Práce node row: open a fresh, empty thread there (#374, "one
  // click, thread is there, composer has focus") -- no dialog, nothing to
  // pick first. The node opens/selects at the same time so the thread
  // lands where it's visible, and openSessionChat focuses the new draft
  // specifically (there may be other open threads on the same node).
  const workspaceNewTask = useCallback(
    (nodeId: string) => {
      openNode(nodeId);
      void startDraftThread(nodeId)
        .then((session) => {
          setLocalDrafts((prev) => ({ ...prev, [session.id]: session }));
          openSessionChat(nodeId, session.id);
        })
        .catch(() => undefined);
    },
    [openNode, openSessionChat],
  );

  // Shared by every onSessionStarted call site (Práce's own NewTaskButton,
  // Graf's, the workspace sidebar's "+"): shows the fresh thread and, when
  // it's a draft (run: null), tracks it locally so it survives the next
  // sidebar refetch too (#374).
  const registerSessionStarted = useCallback(
    (result: { session: SessionSummary; run: SessionRunRow | null }) => {
      setWorkspaceOpenSession(result.session);
      // The node's shown chat is re-picked (pickOpenChatSession) on every
      // refetch, so the fresh thread has to be the requested one -- else a
      // node that already had a thread open snapped back to it the moment
      // the new draft was tracked.
      setRequestedChatSessionByNode((prev) => requestChatSession(prev, result.session));
      if (result.session.state === "draft") {
        setLocalDrafts((prev) => ({ ...prev, [result.session.id]: result.session }));
        return;
      }
      // #412: an already-running thread (the Relace tab's "Navázat") has
      // no draft phase to track, so it goes straight into the sidebar's
      // per-node map -- the refetch its own state frame triggers is what
      // confirms it, this is what makes the row appear at once.
      setOpenSessionsByNode((prev) => mergeSessionIntoNodeMap(prev, result.session));
    },
    [],
  );

  const workspaceCreateNode = useCallback(() => {
    createFromWorkspaceRef.current = true;
    openCreateModal();
  }, [openCreateModal]);

  // Inline rename on a thread's own sub-row (#374). A local draft is
  // renamed only in place (there is no server row to rename yet -- naming
  // a draft is moot anyway, since its first message renames it for real);
  // otherwise PATCH /sessions/:id.
  const workspaceRenameTask = useCallback((session: SessionSummary, name: string) => {
    if (session.state === "draft") {
      setLocalDrafts((prev) =>
        prev[session.id] ? { ...prev, [session.id]: { ...prev[session.id], name, name_is_custom: true } } : prev,
      );
      return;
    }
    void renamePersistentSession(session.id, name)
      .then((updated) => {
        const nodeId = session.node_id;
        if (nodeId) {
          setOpenSessionsByNode((prev) => {
            const list = prev[nodeId];
            if (!list?.some((s) => s.id === updated.id)) return prev;
            return { ...prev, [nodeId]: list.map((s) => (s.id === updated.id ? updated : s)) };
          });
        }
        setWorkspaceOpenSession((prev) => (prev?.id === updated.id ? updated : prev));
      })
      .catch(() => undefined);
  }, []);

  // The × on a thread's own sub-row (#374): a draft with no first message
  // yet is deleted outright; anything else is Uzavřít, which asks first --
  // via closeTaskConfirm below, a real dialog (window.confirm is a no-op
  // in the Tauri webview, same reasoning as editorGuard).
  const [closeTaskConfirm, setCloseTaskConfirm] = useState<SessionSummary | null>(null);
  const workspaceCloseTask = useCallback((session: SessionSummary) => {
    const forgetLocally = () => {
      setLocalDrafts((prev) => {
        if (!(session.id in prev)) return prev;
        const next = { ...prev };
        delete next[session.id];
        return next;
      });
      setWorkspaceOpenSession((prev) => (prev?.id === session.id ? null : prev));
    };
    if (session.state === "draft") {
      forgetLocally();
      void deletePersistentSession(session.id).catch(() => undefined);
      return;
    }
    setCloseTaskConfirm(session);
  }, []);

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
          workspaceActiveSessionId={workspaceOpenSession?.id ?? null}
          onWorkspaceOpenSessionChat={openSessionChat}
          onWorkspaceRenameTask={workspaceRenameTask}
          onWorkspaceCloseTask={workspaceCloseTask}
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
              mountedSessions={workspaceMountedSessions}
              sessionsClient={sessionsClient}
              liveSessionStates={sessionStates}
              onSessionUpdated={updateWorkspaceOpenSession}
              onSessionStarted={registerSessionStarted}
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
            onSessionStarted={(result) => {
              // Graf has no chat surface of its own, so a task started here
              // lands in Práce: the node opens and the fresh session is the
              // thread it shows. Without this the run is live with nowhere
              // in the UI showing it.
              registerSessionStarted(result);
              if (result.session.node_id) openSessionChat(result.session.node_id, result.session.id);
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
        pullNodeCount={pullNodeCount(syncPending.nodes)}
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
        <Dialog
          open
          onOpenChange={(open) => {
            if (open) return;
            const wasQuit = editorGuard?.kind === "quit";
            setEditorGuard(null);
            if (wasQuit) void declineExit();
          }}
        >
          <DialogContent showCloseButton={false} className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>Neuložené změny</DialogTitle>
              <DialogDescription>
                {editorGuard.kind === "quit"
                  ? "Soubor v editoru má neuložené změny. Chceš je před zavřením aplikace uložit?"
                  : "Soubor v editoru má neuložené změny. Chceš je uložit?"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const wasQuit = editorGuard?.kind === "quit";
                  setEditorGuard(null);
                  if (wasQuit) void declineExit();
                }}
              >
                Zpět do editoru
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void resolveEditorGuard("discard")}>
                Zahodit změny
              </Button>
              <Button
                size="sm"
                disabled={fileEditor.saving}
                onClick={() => void resolveEditorGuard("save")}
              >
                {fileEditor.saving ? "Ukládám…" : "Uložit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {closeTaskConfirm && (
        <Dialog open onOpenChange={(open) => !open && setCloseTaskConfirm(null)}>
          <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>Uzavřít vlákno?</DialogTitle>
              <DialogDescription>
                Vlákno „{closeTaskConfirm.name}“ se uzavře. Server napřed uloží shrnutí konverzace; najdeš ho pak
                mezi Hotové.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCloseTaskConfirm(null)}>
                Zpět
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const session = closeTaskConfirm;
                  setCloseTaskConfirm(null);
                  void sessionsClient.close(session.id).catch(() => undefined);
                }}
              >
                Uzavřít
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
        <Dialog
          open
          onOpenChange={(open) => {
            if (open) return;
            setSyncQuitGuard(null);
            void declineExit();
          }}
        >
          <DialogContent showCloseButton={false} className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>Nesynchronizovaná práce</DialogTitle>
              <DialogDescription>
                Máš {syncQuitGuard.count} {pluralFiles(syncQuitGuard.count)}, které nejsou na remote (nesynchronizováno). Pokud aplikaci zavřeš, zůstanou jen lokálně.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSyncQuitGuard(null);
                  void declineExit();
                }}
              >
                Zrušit
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setSyncQuitGuard(null);
                  setSyncOverviewOpen(true);
                  void declineExit();
                }}
              >
                Zobrazit a synchronizovat
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  setSyncQuitGuard(null);
                  await destroyCurrentWindow();
                }}
              >
                Zavřít bez synchronizace
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
