import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import Sidebar, { type AppView } from "./components/Sidebar";
import DetailPane from "./components/DetailPane";
import SettingsPage from "./components/SettingsPage";
import WorkspaceView from "./components/WorkspaceView";
import StatusFooter from "./components/StatusFooter";
import CreateNodeModal from "./components/CreateNodeModal";
import { fetchGraph, fetchNode } from "./api";
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

  // Refetch on window focus. Solves the "I created a node via MCP / Claude
  // and the graph never sees it" symptom universally — every time the
  // user comes back to the window, we re-pull the truth. The listener is
  // bound once; the closure captures `refetchAll`, which itself captures
  // selectedId so the current detail stays in sync too.
  useEffect(() => {
    const handler = () => {
      refetchAll().catch((err) => setGraphError(String(err)));
    };
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [refetchAll]);

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
        {view === "workspace" && (
          <WorkspaceView
            graph={graph}
            sessions={sessions}
            now={now}
            selectedNodeId={selectedWorkspaceNodeId}
            onSelectNode={setSelectedWorkspaceNodeId}
            activeSessionIdByNode={activeSessionIdByNode}
            onSetActiveSession={(nodeId, sessionId) =>
              setActiveSessionIdByNode((p) => ({ ...p, [nodeId]: sessionId }))
            }
            onCloseSession={closeSession}
            onOpenSessionFromPicker={(node) => {
              // Mirror creation lives in Task 9 plumbing -- for now the empty
              // state opens a session by deferring to DetailPane via selecting
              // the node in graph view. Workspace task 8 wires the real picker.
              setSelectedId(node.id);
              setView("graph");
            }}
            onNewSessionForCurrentNode={(_nodeId) => {
              // Task 9 replaces this stub with: openSession({ node, cwd, command })
              void openSession;
            }}
            detailNodeId={selectedWorkspaceNodeId}
          />
        )}
        {view === "settings" && (
          <SettingsPage
            agentCommand={agentCommand}
            onAgentCommandChange={setAgentCommand}
          />
        )}
      </main>

      {view === "graph" && selectedId && (
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
        />
      )}

      </div>
      <StatusFooter onOpenSettings={() => setView("settings")} />
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
          onClose={() => setCreateModalOpen(false)}
          onCreated={(node) => {
            setCreateModalOpen(false);
            setSelectedId(node.id);
            refetchAll().catch((err) => setGraphError(String(err)));
          }}
        />
      )}
    </div>
  );
}
