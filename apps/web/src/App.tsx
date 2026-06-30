import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar, { type AppView } from "./components/Sidebar";
import DetailPane from "./components/DetailPane";
import SettingsPage from "./components/SettingsPage";
import WorkspaceView from "./components/WorkspaceView";
import EditorFullscreen from "./components/EditorFullscreen";
import EditorPane from "./components/EditorPane";
import StatusFooter from "./components/StatusFooter";
import CreateNodeModal from "./components/CreateNodeModal";
import { fetchGraph, fetchNode, createNodeMirror, fetchSandboxProfile } from "./api";
import { useFileEditor } from "./lib/use-file-editor";
import { buildAgentCommand } from "./lib/prompt";
import { useDataMode } from "./lib/central";
import {
  type TerminalSession,
  createSession,
  removeSession,
  markActivity,
  markForegroundBusy,
  renameSession,
  deriveWorkspaceNodeRows,
} from "./lib/sessions";
import { isTauri } from "./lib/backend-url";
import { useSyncPending } from "./lib/use-sync-pending";
import { pluralFiles } from "./lib/plural-files";
import SyncOverview from "./components/SyncOverview";

// Lazy chunks: cytoscape (the GraphView dep) is the main reason the app
// bundle blew past 500 kB. Splitting GraphView and ActorsPage cuts the
// initial bundle by ~70 % and keeps the marketing/docs sites snappy.
const GraphView = lazy(() => import("./components/GraphView"));
import type { GraphPayload, NodeDetail } from "./types";
import type { Theme } from "./lib/theme";
import { loadTheme, saveTheme } from "./lib/theme";
import {
  loadAgentCommand,
  saveAgentCommand,
  loadTerminalLaunch,
  saveTerminalLaunch,
  loadOpenNodes,
  saveOpenNodes,
} from "./lib/settings";

// Files that have a useful rendered preview (MarkdownPreview). These open in
// Náhled by default; everything else starts in the source editor.
function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relPath);
}

export default function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  // Failures from opening a node terminal/session. Kept separate from
  // graphError: that one renders as a full-screen "graph failed to load"
  // overlay, which is the wrong message and blocks the whole view.
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSessionError = useCallback((msg: string) => {
    setSessionError(msg);
    if (sessionErrorTimer.current) clearTimeout(sessionErrorTimer.current);
    sessionErrorTimer.current = setTimeout(() => setSessionError(null), 8000);
  }, []);

  const dataMode = useDataMode();
  const isCentral = dataMode?.mode === "central";

  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [agentCommand, setAgentCommandRaw] = useState<string>(() =>
    loadAgentCommand(),
  );

  const setAgentCommand = useCallback((value: string) => {
    setAgentCommandRaw(value);
    saveAgentCommand(value);
  }, []);

  const [terminalLaunch, setTerminalLaunchRaw] = useState<string>(() =>
    loadTerminalLaunch(),
  );

  const setTerminalLaunch = useCallback((value: string) => {
    setTerminalLaunchRaw(value);
    saveTerminalLaunch(value);
  }, []);

  const [view, setView] = useState<AppView>(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("view");
    if (v === "workspace") return "workspace";
    if (v === "settings") return "settings";
    return "graph";
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

  // Sync URL with current view. Default "graph" is omitted from the URL
  // to keep it clean; ?view=actors / ?view=settings only appear when on
  // those views. The ?node param coexists and is only meaningful in
  // graph view.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "graph") {
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

  // --- Session state ---
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selectedWorkspaceNodeId, setSelectedWorkspaceNodeId] = useState<string | null>(null);
  const [activeSessionIdByNode, setActiveSessionIdByNode] = useState<Record<string, string>>({});
  // The set of nodes open in the workspace, decoupled from sessions: a node
  // can be open (and switched to) without ever launching a terminal, and it
  // stays open after its last terminal closes. Persisted across restarts and
  // pruned against the graph once it loads (the terminals themselves are
  // never restored -- a PTY does not survive a restart).
  const [openNodeIds, setOpenNodeIds] = useState<string[]>(() => loadOpenNodes());
  useEffect(() => {
    saveOpenNodes(openNodeIds);
  }, [openNodeIds]);

  // Selecting a session jumps straight to it: focus its node AND make it the
  // node's active session. That is what lets every tab in the left column be
  // one click away, without selecting the parent node first.
  const workspaceSelectSession = useCallback(
    (nodeId: string, sessionId: string) => {
      setSelectedWorkspaceNodeId(nodeId);
      setActiveSessionIdByNode((p) => ({ ...p, [nodeId]: sessionId }));
    },
    [],
  );

  // Open a node in the workspace WITHOUT launching a terminal -- the core of
  // "open more nodes and switch between them". Idempotent; focuses the node
  // and flips to the workspace view.
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

  // The workspace's left-column rows: open nodes ∪ nodes-with-sessions,
  // de-duplicated and ordered open-first. Name/type resolved from the graph
  // for nodes without a live session.
  const workspaceRows = useMemo(
    () =>
      deriveWorkspaceNodeRows(openNodeIds, sessions, (id) => {
        const n = graph?.nodes.find((g) => g.id === id);
        return n ? { name: n.name, type: n.type } : undefined;
      }),
    [openNodeIds, sessions, graph],
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
  const openingSessionNodeIdsRef = useRef<Set<string>>(new Set());
  // Set when the create-node modal is opened from the workspace view, so that
  // on success we also open a terminal session for the freshly created node
  // (one-click "Nový uzel + terminál"). Reset on close or after handling.
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

  const { pending: syncPending, refresh: refreshSyncPending } = useSyncPending();
  const [syncOverviewOpen, setSyncOverviewOpen] = useState(false);

  const syncPendingRef = useRef(syncPending.total);
  useEffect(() => {
    syncPendingRef.current = syncPending.total;
  }, [syncPending.total]);
  const [syncQuitGuard, setSyncQuitGuard] = useState<{ count: number } | null>(null);

  const reallyOpenFile = useCallback((nodeId: string, relPath: string) => {
    // Always open in the right-side pane first (replacing the detail pane in
    // both graph and workspace views). Fullscreen is opt-in via the expand (⤢)
    // button, never automatic.
    setEditorFile({ nodeId, relPath });
    setEditorFullscreen(false);
    // Markdown opens in Náhled (rendered preview) by default; editing is the
    // secondary mode. Other file types have no useful preview, so they start
    // in the source editor.
    setEditorMode(isMarkdownPath(relPath) ? "preview" : "edit");
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
  // discard. Quit destroys the Tauri window (the close request that opened
  // the guard was prevented).
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
        if (isTauri()) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().destroy().catch(() => undefined);
        }
      }
    },
    [editorGuard, fileEditor, reallyOpenFile, reallyCloseEditor],
  );

  // Browser: warn before unload while dirty. Tauri: intercept the window
  // close request and route it through the same inline confirm.
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
            if (selectedIdRef.current === requestId) setNodeDetail(n);
          })
          .catch(() => undefined);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [view, selectedWorkspaceNodeId, selectedId, refetchWorkspaceDetail]);

  // The 1s activity-dot clock lives in WorkspaceNodeList (useNowTick) --
  // ticking here re-rendered the whole tree every second forever.

  // Listen for pty-data and pty-exit events at App level so lastOutputAt
  // updates for every session regardless of which pane is visible.
  useEffect(() => {
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenForeground: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      if (typeof window === "undefined") return;
      // Browser-mode (vite dev outside Tauri) has no pty events. Skip.
      try {
        const { listen } = await import("@tauri-apps/api/event");
        type PtyData = { session_id: string };
        type PtyExit = { session_id: string; code: number | null };
        type PtyForeground = { session_id: string; busy: boolean };
        unlistenData = await listen<PtyData>("pty-data", (e) => {
          if (cancelled) return;
          const id = e.payload.session_id;
          setSessions((prev) => markActivity(prev, id));
        });
        unlistenExit = await listen<PtyExit>("pty-exit", (e) => {
          if (cancelled) return;
          const id = e.payload.session_id;
          setSessions((prev) => removeSession(prev, id));
          setActiveSessionIdByNode((prev) => {
            const next: Record<string, string> = {};
            for (const [nid, sid] of Object.entries(prev)) {
              if (sid !== id) next[nid] = sid;
            }
            return next;
          });
          // The node stays open after its last terminal closes (it lives in
          // openNodeIds now, not only in sessions), so selectedWorkspaceNodeId
          // remains valid -- the workspace just shows the node's detail
          // center-stage instead of a terminal. Nothing to clear here.
        });
        // Rust foreground-poll signal (Unix only, ~500 ms cadence).
        // Authoritative "agent computing" indicator: green while a
        // subprocess owns the PTY foreground, amber when the shell is
        // idle at its prompt.
        unlistenForeground = await listen<PtyForeground>("pty-foreground", (e) => {
          if (cancelled) return;
          const { session_id, busy } = e.payload;
          setSessions((prev) => markForegroundBusy(prev, session_id, busy));
        });
      } catch {
        // Not running in Tauri -- fine.
      }
    })();
    return () => {
      cancelled = true;
      try { unlistenData?.(); } catch { /* unlisten can throw if Tauri is gone */ }
      try { unlistenExit?.(); } catch { /* same */ }
      try { unlistenForeground?.(); } catch { /* same */ }
    };
  }, []);

  const openSession = useCallback(
    (input: { node: NodeDetail; cwd: string; command: string; sandboxProfile: string | null }) => {
      const session = createSession({
        nodeId: input.node.id,
        nodeName: input.node.name,
        nodeType: input.node.type,
        cwd: input.cwd,
        command: input.command,
        sandboxProfile: input.sandboxProfile,
      });
      setSessions((prev) => [...prev, session]);
      // Opening a terminal also opens the node (terminals imply an open node).
      setOpenNodeIds((prev) =>
        prev.includes(input.node.id) ? prev : [...prev, input.node.id],
      );
      setSelectedWorkspaceNodeId(input.node.id);
      setActiveSessionIdByNode((prev) => ({ ...prev, [input.node.id]: session.id }));
      setView("workspace");
    },
    [],
  );

  const openSessionForNodeId = useCallback(
    async (nodeId: string) => {
      if (isCentral) {
        showSessionError("Terminál v Portuni je dostupný jen v lokálním režimu (fáze B).");
        return;
      }
      if (openingSessionNodeIdsRef.current.has(nodeId)) return;
      openingSessionNodeIdsRef.current.add(nodeId);
      try {
        let detail: NodeDetail | null = null;
        try {
          detail = await fetchNode(nodeId);
        } catch (err) {
          showSessionError(`Nelze načíst uzel: ${String(err)}`);
          return;
        }
        if (!detail) return;
        let cwd: string;
        try {
          const mirror = await createNodeMirror(nodeId);
          cwd = mirror.local_path;
        } catch (err) {
          showSessionError(`Nelze otevřít terminál: ${String(err)}`);
          return;
        }
        // Fail-closed: without the disk-scope profile the terminal does
        // not open at all. Running an agent without the kernel boundary
        // must be a deliberate act, never a silent fallback.
        let sandboxProfile: string;
        try {
          sandboxProfile = (await fetchSandboxProfile(nodeId)).profile;
        } catch (err) {
          showSessionError(`Nelze načíst sandbox profil uzlu: ${String(err)}`);
          return;
        }
        const enriched: NodeDetail = {
          ...detail,
          local_mirror: detail.local_mirror ?? {
            local_path: cwd,
            registered_at: new Date().toISOString(),
          },
        };
        const command = buildAgentCommand(enriched, agentCommand);
        openSession({ node: enriched, cwd, command, sandboxProfile });
      } finally {
        openingSessionNodeIdsRef.current.delete(nodeId);
      }
    },
    [agentCommand, isCentral, openSession, showSessionError],
  );

  const workspaceNewSession = useCallback(
    (nodeId: string) => {
      void openSessionForNodeId(nodeId);
    },
    [openSessionForNodeId],
  );
  const workspaceCreateNode = useCallback(() => {
    createFromWorkspaceRef.current = true;
    openCreateModal();
  }, [openCreateModal]);

  const closeSession = useCallback((sessionId: string) => {
    setSessions((prev) => removeSession(prev, sessionId));
    setActiveSessionIdByNode((prev) => {
      const next = { ...prev };
      for (const [nid, sid] of Object.entries(next)) {
        if (sid === sessionId) delete next[nid];
      }
      return next;
    });
    // Best-effort: tell the backend the PTY is gone. Errors swallowed --
    // the pty-exit reader thread will clean up its own map entry once
    // the child SIGHUPs. (closeNode kills a node's sessions the same way.)
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("pty_kill", { args: { session_id: sessionId } });
      } catch { /* errors swallowed -- pty-exit thread self-cleans */ }
    })();
  }, []);

  // Close a node: drop it from the open set and tear down every terminal it
  // owns (PTYs included). Moves the workspace selection to a neighbouring
  // open node, or clears it when nothing is left.
  const closeNode = useCallback(
    (nodeId: string) => {
      setOpenNodeIds((prev) => prev.filter((id) => id !== nodeId));
      setSessions((prev) => {
        const doomed = prev.filter((s) => s.nodeId === nodeId);
        if (doomed.length > 0) {
          void (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              for (const s of doomed) {
                await invoke("pty_kill", { args: { session_id: s.id } }).catch(
                  () => undefined,
                );
              }
            } catch {
              /* not running in Tauri */
            }
          })();
        }
        return prev.filter((s) => s.nodeId !== nodeId);
      });
      setActiveSessionIdByNode((prev) => {
        if (!(nodeId in prev)) return prev;
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      setSelectedWorkspaceNodeId((prev) => {
        if (prev !== nodeId) return prev;
        const remaining = workspaceRows.filter((r) => r.id !== nodeId);
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      });
    },
    [workspaceRows],
  );

  const renameSessionTab = useCallback((sessionId: string, label: string) => {
    setSessions((prev) => renameSession(prev, sessionId, label));
  }, []);

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
          workspaceBadge={workspaceRows.length}
          workspaceRows={workspaceRows}
          workspaceSessions={sessions}
          workspaceSelectedNodeId={selectedWorkspaceNodeId}
          workspaceActiveSessionIdByNode={activeSessionIdByNode}
          onWorkspaceSelectNode={workspaceSelectNode}
          onWorkspaceSelectSession={workspaceSelectSession}
          onWorkspaceCloseSession={closeSession}
          onWorkspaceCloseNode={closeNode}
          onWorkspaceNewSession={workspaceNewSession}
          onWorkspaceRenameSession={renameSessionTab}
          onWorkspaceOpenNode={openNode}
          onWorkspaceCreateNode={workspaceCreateNode}
        />
      )}

      <main className="relative min-w-0 flex-1 bg-[var(--color-bg)]">
        {sessionError && (
          <div className="absolute left-1/2 top-4 z-50 flex max-w-[80%] -translate-x-1/2 items-start gap-3 rounded-md border border-red-900 bg-red-950/80 px-4 py-3 text-[13px] text-red-200 shadow-lg">
            <span className="min-w-0 break-words">{sessionError}</span>
            <button
              type="button"
              onClick={() => setSessionError(null)}
              className="shrink-0 text-red-300 hover:text-red-100"
              title="Zavřít"
            >
              ×
            </button>
          </div>
        )}
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
        {!graph && !graphError && (
          <div className="absolute inset-0 flex items-center justify-center text-[14px] text-[var(--color-text-dim)]">
            Načítám graf...
          </div>
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
            />
          </Suspense>
        )}
        {/*
          WorkspaceView stays mounted whenever there are live sessions, so
          switching to Graf/Nastavení and back doesn't unmount TerminalPane
          and accidentally re-spawn the PTY (pty_spawn replaces by id, which
          would SIGHUP the running shell — breaks the "sessions přežijí
          přepnutí pohledu" contract from the sidebar hint). When no sessions
          exist, we only mount on demand so the picker's autoFocus doesn't
          steal focus from the graph view.
        */}
        {(view === "workspace" || sessions.length > 0) && (
          <div
            className={
              view === "workspace"
                ? "absolute inset-0"
                : "pointer-events-none absolute inset-0 hidden"
            }
            aria-hidden={view !== "workspace"}
          >
            <WorkspaceView
              graph={graph}
              sessions={sessions}
              theme={theme}
              selectedNodeId={selectedWorkspaceNodeId}
              onSelectNode={workspaceSelectNode}
              activeSessionIdByNode={activeSessionIdByNode}
              onCloseSession={closeSession}
              onOpenNodeFromPicker={(node) => openNode(node.id)}
              openNodeCount={workspaceRows.length}
              nodeDetail={workspaceNodeDetail}
              nodeDetailLoading={workspaceDetailLoading}
              nodeDetailError={workspaceDetailError}
              agentCommand={agentCommand}
              terminalLaunch={terminalLaunch}
              onOpenTerminal={openSessionForNodeId}
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
            />
          </div>
        )}
        {view === "settings" && (
          <SettingsPage
            agentCommand={agentCommand}
            onAgentCommandChange={setAgentCommand}
            terminalLaunch={terminalLaunch}
            onTerminalLaunchChange={setTerminalLaunch}
          />
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
            agentCommand={agentCommand}
            terminalLaunch={terminalLaunch}
            onOpenTerminal={openSessionForNodeId}
            onOpenFile={openFileInEditor}
          />
        ))}

      </div>
      <StatusFooter
        onOpenSettings={openSettingsView}
        sessionCount={sessions.length}
        onOpenWorkspace={openWorkspaceView}
        pendingCount={syncPending.total}
        onOpenSyncOverview={() => setSyncOverviewOpen(true)}
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
            // freshly created node in the workspace (no forced terminal --
            // terminals are optional now, and this works for orgs too).
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
                onClick={() => setEditorGuard(null)}
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
                onClick={() => setSyncQuitGuard(null)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)]"
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={() => {
                  setSyncQuitGuard(null);
                  setSyncOverviewOpen(true);
                }}
                className="rounded-md border border-[var(--color-accent-dim)] px-3 py-1.5 text-[12.5px] text-[var(--color-accent)] hover:bg-[var(--color-surface)]"
              >
                Zobrazit a synchronizovat
              </button>
              <button
                type="button"
                onClick={async () => {
                  setSyncQuitGuard(null);
                  const { getCurrentWindow } = await import("@tauri-apps/api/window");
                  await getCurrentWindow().destroy().catch(() => undefined);
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
