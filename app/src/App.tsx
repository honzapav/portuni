import { useCallback, useEffect, useRef, useState } from "react";
import Sidebar, { type AppView } from "./components/Sidebar";
import GraphView from "./components/GraphView";
import DetailPane from "./components/DetailPane";
import ActorsPage from "./components/ActorsPage";
import { fetchGraph, fetchNode } from "./api";
import type { GraphPayload, NodeDetail } from "./types";
import type { Theme } from "./lib/theme";
import { loadTheme, saveTheme } from "./lib/theme";

export default function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  const [view, setView] = useState<AppView>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("view") === "actors" ? "actors" : "graph";
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
  // to keep it clean; ?view=actors is only present when actually on that
  // view. The ?node param coexists and is only meaningful in graph view.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "actors") {
      url.searchParams.set("view", "actors");
    } else {
      url.searchParams.delete("view");
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

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {graph && (
        <Sidebar
          graph={graph}
          query={query}
          onQuery={setQuery}
          disabledRelations={disabledRelations}
          onToggleRelation={toggleRelation}
          disabledOrgs={disabledOrgs}
          onToggleOrg={toggleOrg}
          selectedId={selectedId}
          onSelect={setSelectedId}
          theme={theme}
          onThemeToggle={toggleTheme}
          view={view}
          onViewChange={setView}
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
          <GraphView
            graph={graph}
            selectedId={selectedId}
            query={query}
            disabledRelations={disabledRelations}
            disabledOrgs={disabledOrgs}
            theme={theme}
            onSelect={setSelectedId}
          />
        )}
        {view === "actors" && <ActorsPage graph={graph} />}
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
        />
      )}
    </div>
  );
}
