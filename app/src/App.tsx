import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import Sidebar, { type AppView } from "./components/Sidebar";
import DetailPane from "./components/DetailPane";
import SettingsPage from "./components/SettingsPage";
import WorkspaceView from "./components/WorkspaceView";
import EditorFullscreen from "./components/EditorFullscreen";
import EditorPane from "./components/EditorPane";
import StatusFooter from "./components/StatusFooter";
import CreateNodeModal from "./components/CreateNodeModal";
import { fetchGraph, fetchNode, createNodeMirror } from "./api";
import { useFileEditor } from "./lib/use-file-editor";
import { buildAgentCommand } from "./lib/prompt";
import {
  type TerminalSession,
  createSession,
  removeSession,
  markActivity,
} from "./lib/sessions";

// Lazy chunks: cytoscape (the GraphView dep) is the main reason the app
// bundle blew past 500 kB. Splitting GraphView and ActorsPage cuts the
// initial bundle by ~70 % and keeps the marketing/docs sites snappy.
const GraphView = lazy(() => import("./components/GraphView"));
import type { GraphPayload, NodeDetail } from "./types";
import type { Theme } from "./lib/theme";
import { loadTheme, saveTheme } from "./lib/theme";
import { loadAgentCommand, saveAgentCommand } from "./lib/settings";

export default function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [agentCommand, setAgentCommandRaw] = useState<string>(() =>
    loadAgentCommand(),
  );

  const setAgentCommand = useCallback((value: string) => {
    setAgentCommandRaw(value);
    saveAgentCommand(value);
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

  // Apply theme to <html> and persist
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    saveTheme(theme);
  }, [theme]);

  // Load graph on mount
  useEffect(() => {
    fetchGraph()
      .then(setGraph)
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

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedId) {
      setNodeDetail(null);
      setDetailError(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    fetchNode(selectedId)
      .then((n) => {
        setNodeDetail(n);
        setDetailLoading(false);
      })
      .catch((err) => {
        setDetailError(String(err));
        setDetailLoading(false);
      });
  }, [selectedId]);

  // Refetch both the graph and the current node. Called by the DetailPane
  // after any mutation so the viz and the detail stay in sync.
  const refetchAll = useCallback(async () => {
    const [graphRes, nodeRes] = await Promise.all([
      fetchGraph(),
      selectedId ? fetchNode(selectedId).catch(() => null) : Promise.resolve(null),
    ]);
    setGraph(graphRes);
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
  const [now, setNow] = useState<number>(() => Date.now());
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

  // One shared editor instance, owned here and handed to BOTH the pane and
  // the fullscreen shell. Hooks must run unconditionally, so we call it with
  // nulls when no file is open (the hook is inert in that case). Sharing it
  // is what keeps unsaved edits across the expand/collapse transition and
  // avoids a second GET when fullscreen mounts.
  const fileEditor = useFileEditor(
    editorFile?.nodeId ?? null,
    editorFile?.relPath ?? null,
  );

  const openFileInEditor = useCallback((nodeId: string, relPath: string) => {
    // Always open in the right-side pane first (replacing the detail pane in
    // both graph and workspace views). Fullscreen is opt-in via the expand (⤢)
    // button, never automatic.
    setEditorFile({ nodeId, relPath });
    setEditorFullscreen(false);
  }, []);
  const closeEditor = useCallback(() => {
    setEditorFile(null);
    setEditorFullscreen(false);
  }, []);

  // Refetch on focus AND tab-visible. Covers BOTH the graph selection and
  // the workspace selection so files registered elsewhere (MCP / another
  // window) show up without a manual reselect.
  useEffect(() => {
    const handler = () => {
      if (document.hidden) return;
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
        fetchNode(selectedId)
          .then((n) => setNodeDetail(n))
          .catch(() => undefined);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [view, selectedWorkspaceNodeId, selectedId, refetchWorkspaceDetail]);

  // 1s tick so the activity-indicator color flips green->orange as the
  // 1.5s threshold passes without further output. Cheap; the only state
  // consumers are the indicator dots in WorkspaceNodeList and TerminalTabs.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Listen for pty-data and pty-exit events at App level so lastOutputAt
  // updates for every session regardless of which pane is visible.
  useEffect(() => {
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      if (typeof window === "undefined") return;
      // Browser-mode (vite dev outside Tauri) has no pty events. Skip.
      try {
        const { listen } = await import("@tauri-apps/api/event");
        type PtyData = { session_id: string };
        type PtyExit = { session_id: string; code: number | null };
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
          // selectedWorkspaceNodeId may now point at a node with zero
          // sessions. WorkspaceNodeList only renders nodes-with-sessions
          // so a stale pointer is a render-time no-op for now; Task 9
          // can clear it explicitly once we have a UX answer for "where
          // does focus land when the last session for the selected node
          // dies?".
        });
      } catch {
        // Not running in Tauri -- fine.
      }
    })();
    return () => {
      cancelled = true;
      try { unlistenData?.(); } catch { /* unlisten can throw if Tauri is gone */ }
      try { unlistenExit?.(); } catch { /* same */ }
    };
  }, []);

  const openSession = useCallback(
    (input: { node: NodeDetail; cwd: string; command: string }) => {
      const session = createSession({
        nodeId: input.node.id,
        nodeName: input.node.name,
        nodeType: input.node.type,
        cwd: input.cwd,
        command: input.command,
      });
      setSessions((prev) => [...prev, session]);
      setSelectedWorkspaceNodeId(input.node.id);
      setActiveSessionIdByNode((prev) => ({ ...prev, [input.node.id]: session.id }));
      setView("workspace");
    },
    [],
  );

  const openSessionForNodeId = useCallback(
    async (nodeId: string) => {
      if (openingSessionNodeIdsRef.current.has(nodeId)) return;
      openingSessionNodeIdsRef.current.add(nodeId);
      try {
        let detail: NodeDetail | null = null;
        try {
          detail = await fetchNode(nodeId);
        } catch (err) {
          setGraphError(`Nelze načíst uzel: ${String(err)}`);
          return;
        }
        if (!detail) return;
        let cwd: string;
        try {
          const mirror = await createNodeMirror(nodeId);
          cwd = mirror.local_path;
        } catch (err) {
          setGraphError(`Nelze otevřít terminál: ${String(err)}`);
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
        openSession({ node: enriched, cwd, command });
      } finally {
        openingSessionNodeIdsRef.current.delete(nodeId);
      }
    },
    [agentCommand, openSession],
  );

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
    // the child SIGHUPs. This is the SOLE pty_kill call site in the app.
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("pty_kill", { args: { session_id: sessionId } });
      } catch { /* errors swallowed -- pty-exit thread self-cleans */ }
    })();
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
          onOpenSettings={() => setView("settings")}
          onCreateNode={() => openCreateModal()}
          workspaceBadge={sessions.length}
          workspaceSessions={sessions}
          workspaceSelectedNodeId={selectedWorkspaceNodeId}
          workspaceActiveSessionIdByNode={activeSessionIdByNode}
          workspaceNow={now}
          onWorkspaceSelectNode={setSelectedWorkspaceNodeId}
          onWorkspaceSelectSession={(nodeId, sessionId) =>
            setActiveSessionIdByNode((p) => ({ ...p, [nodeId]: sessionId }))
          }
          onWorkspaceCloseSession={closeSession}
          onWorkspaceNewSession={(nodeId) => {
            void openSessionForNodeId(nodeId);
          }}
          onWorkspaceCreateNode={() => {
            createFromWorkspaceRef.current = true;
            openCreateModal();
          }}
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
              onCreateOrganization={() =>
                openCreateModal({ forceType: "organization" })
              }
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
              onSelectNode={setSelectedWorkspaceNodeId}
              activeSessionIdByNode={activeSessionIdByNode}
              onCloseSession={closeSession}
              onOpenSessionFromPicker={(node) => {
                void openSessionForNodeId(node.id);
              }}
              nodeDetail={workspaceNodeDetail}
              nodeDetailLoading={workspaceDetailLoading}
              nodeDetailError={workspaceDetailError}
              agentCommand={agentCommand}
              onOpenTerminal={openSessionForNodeId}
              onMutate={async () => {
                await Promise.all([refetchAll(), refetchWorkspaceDetail()]);
              }}
              editorFile={editorFile}
              editor={fileEditor}
              editorFullscreen={editorFullscreen}
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
            onOpenTerminal={openSessionForNodeId}
            onOpenFile={openFileInEditor}
          />
        ))}

      </div>
      <StatusFooter
        onOpenSettings={() => setView("settings")}
        sessionCount={sessions.length}
        onOpenWorkspace={() => setView("workspace")}
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
            // Opened from the workspace "Nový uzel + terminál" button: also
            // launch a session for it. Organizations have no terminal, so
            // only nodes that support one get the auto-open.
            if (createFromWorkspaceRef.current) {
              createFromWorkspaceRef.current = false;
              if (node.type !== "organization") {
                void openSessionForNodeId(node.id);
              }
            }
          }}
        />
      )}
      {editorFile && editorFullscreen && (
        <EditorFullscreen
          editor={fileEditor}
          relPath={editorFile.relPath}
          // Both graph and workspace render the pane when not fullscreen, so
          // collapsing always returns to the right-side pane.
          onCollapse={() => setEditorFullscreen(false)}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}
