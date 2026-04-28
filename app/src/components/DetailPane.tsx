import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowRight,
  ArrowLeft,
  Copy,
  FileText,
  Folder,
  Sparkles,
  X,
  Clock,
  Check,
  Pencil,
  Trash2,
  Plus,
  Archive,
  Save,
  Search,
  User,
  Users,
  Lock,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Building2,
  Info,
  ExternalLink,
} from "lucide-react";
import type {
  NodeDetail,
  DetailEdge,
  DetailEvent,
  DetailFile,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
  GraphPayload,
  SyncClass,
  SyncStatusFile,
  SyncRunResponse,
} from "../types";
import {
  RELATION_TYPES,
  EVENT_TYPES,
  LIFECYCLE_COLORS,
  LIFECYCLE_STATES_BY_TYPE,
  NODE_VISIBILITIES,
} from "../types";
import { buildAgentCommand } from "../lib/prompt";
import { safeHref } from "../lib/safe-url";
import type { Actor } from "../api";
import {
  updateNode,
  archiveNode,
  moveNode,
  createEdge,
  deleteEdge,
  createEvent,
  updateEvent,
  archiveEvent,
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
  fetchNodeFolderUrl,
} from "../api";

// Module-level cache of the per-node sync-status map, so revisiting a
// node shows the last-known badges instantly while the background
// refresh runs. Lives outside the component tree because DetailPane
// unmounts whenever no node is selected. The backend's `fast` mode is
// already DB-only, but caching here also avoids the network round-trip
// for repeat visits during a single session.
const SYNC_STATUS_CACHE = new Map<string, Map<string, SyncStatusFile>>();

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
  agentCommand: string;
};

export default function DetailPane({
  node,
  graph,
  loading,
  error,
  onSelect,
  canGoBack,
  onBack,
  onMutate,
  agentCommand,
}: Props) {
  if (loading && !node) {
    return (
      <PaneShell onClose={() => onSelect(null)} canGoBack={false} onBack={onBack}>
        <div className="flex h-full items-center justify-center text-[13.5px] text-[var(--color-text-dim)]">
          Načítám...
        </div>
      </PaneShell>
    );
  }

  if (error) {
    return (
      <PaneShell onClose={() => onSelect(null)} canGoBack={false} onBack={onBack}>
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
      onSelect={onSelect}
      canGoBack={canGoBack}
      onBack={onBack}
      onMutate={onMutate}
      agentCommand={agentCommand}
    />
  );
}

function DetailPaneBody({
  node,
  graph,
  onSelect,
  canGoBack,
  onBack,
  onMutate,
  agentCommand,
}: {
  node: NodeDetail;
  graph: GraphPayload | null;
  onSelect: (id: string | null) => void;
  canGoBack: boolean;
  onBack: () => void;
  onMutate: () => Promise<void>;
  agentCommand: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<
    "overview" | "events" | "files" | "connections"
  >("overview");
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

  // Reset edit drafts whenever we switch to a different node.
  const lastIdRef = useRef(node.id);
  useEffect(() => {
    if (lastIdRef.current !== node.id) {
      lastIdRef.current = node.id;
      setEditing(false);
      setDraftName(node.name);
      setErrorMsg(null);
      setTab("overview");
      // Seed sync state from the module cache so revisits feel instant.
      // The background refetch below will update cache + state when the
      // server responds.
      const cached = SYNC_STATUS_CACHE.get(node.id);
      setSyncStatus(cached ?? new Map());
      setSyncLoaded(cached !== undefined);
      setSyncError(null);
      setSyncRunning(false);
      setSyncRunResult(null);
    }
  }, [node.id, node.name]);

  // Trigger node-wide sync. Pushes push_candidates, pulls pull_candidates,
  // surfaces conflicts/errors. Refreshes the per-file status map after.
  // The lastIdRef gate ignores responses that arrive after the user has
  // already navigated away, so a slow sync on node A does not paint
  // results into node B's pane.
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

  // Auto-load per-file sync classification as soon as the node is
  // selected, so the Files tab badges are ready when the user looks at
  // them. statusScan does I/O (file hashing + 30s-cached remote stat)
  // but it runs in parallel with the detail fetch and never blocks
  // rendering. Errors fall back silently to "no badge".
  //
  // Only node.id is in the deps. Adding syncLoading would re-fire the
  // effect on the very setState below, the previous run's cleanup would
  // mark its own response cancelled, and nothing would ever land.
  useEffect(() => {
    let cancelled = false;
    setSyncError(null);
    fetchNodeSyncStatus(node.id)
      .then((res) => {
        if (cancelled) return;
        const m = new Map<string, SyncStatusFile>();
        for (const f of res.files) m.set(f.file_id, f);
        SYNC_STATUS_CACHE.set(node.id, m);
        setSyncStatus(m);
        setSyncLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setSyncError(String(e));
        setSyncLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id]);

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
    if (
      !confirm(
        `Archivovat „${node.name}"? Uzel bude skryt z grafu, ale vazby a historie zůstanou v databázi.`,
      )
    ) {
      return;
    }
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

  const grouped = new Map<string, DetailEdge[]>();
  for (const edge of node.edges) {
    if (!grouped.has(edge.relation)) grouped.set(edge.relation, []);
    grouped.get(edge.relation)!.push(edge);
  }

  // Aggregate sync state across all files for the Files-tab indicator.
  // Worst-class wins: conflict > pending (push/pull/missing) > orphan >
  // clean. Native is treated as benign (no dot needed). Returns null
  // until the read-only fetch finishes, so the user does not see a
  // misleading green before the data arrives.
  const syncDot: { color: string; title: string } | null = (() => {
    if (!syncLoaded || node.files.length === 0) return null;
    let hasConflict = false;
    let hasPending = false;
    let hasOrphan = false;
    let hasClean = false;
    for (const f of syncStatus.values()) {
      if (f.sync_class === "conflict") hasConflict = true;
      else if (
        f.sync_class === "push" ||
        f.sync_class === "pull" ||
        f.sync_class === "deleted_local"
      ) {
        hasPending = true;
      } else if (f.sync_class === "orphan") hasOrphan = true;
      else if (f.sync_class === "clean") hasClean = true;
    }
    if (hasConflict)
      return { color: "var(--color-danger)", title: "Konflikt v souborech" };
    if (hasPending)
      return {
        color: "var(--color-node-process)",
        title: "Soubory čekají na synchronizaci",
      };
    if (hasOrphan)
      return {
        color: "var(--color-status-archived)",
        title: "Některé soubory jsou orphan (chybí remote vazba)",
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
          <StatusDot status={node.status} />
          <VisibilityDropdown
            nodeId={node.id}
            value={node.visibility}
            onMutate={onMutate}
            onError={setErrorMsg}
          />
        </div>
        {editing ? (
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            autoFocus
            className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[22px] font-semibold leading-tight tracking-tight text-[var(--color-text)] focus:border-[var(--color-accent-dim)]"
          />
        ) : (
          <h1 className="mb-1 text-[22px] font-semibold leading-tight tracking-tight text-[var(--color-text)]">
            {node.name}
          </h1>
        )}
        <div className="flex items-center gap-3 min-w-0">
          <IdCopy id={node.id} />
          <MetaInfo meta={node.meta} />
          <FolderLink nodeId={node.id} />
          {node.local_mirror && (
            <>
              <span className="text-[var(--color-border-strong)]">·</span>
              <PathCopy path={node.local_mirror.local_path} />
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4">
        <TabButton
          active={tab === "overview"}
          onClick={() => setTab("overview")}
          label="Přehled"
        />
        <TabButton
          active={tab === "events"}
          onClick={() => setTab("events")}
          label="Události"
          count={node.events.length}
        />
        <TabButton
          active={tab === "files"}
          onClick={() => setTab("files")}
          label="Soubory"
          count={node.files.length}
          dotColor={syncDot?.color}
          dotTitle={syncDot?.title}
        />
        <TabButton
          active={tab === "connections"}
          onClick={() => setTab("connections")}
          label="Propojení"
          count={node.edges.length}
        />
      </div>

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
            <button
              onClick={handleArchive}
              disabled={busy}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-[11.5px] font-medium transition-colors disabled:opacity-50"
              style={{
                color: "var(--color-danger)",
                borderColor: "var(--color-danger-border)",
                background: "var(--color-danger-bg)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background =
                  "var(--color-danger-bg-hover)";
                e.currentTarget.style.borderColor =
                  "var(--color-danger-border-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--color-danger-bg)";
                e.currentTarget.style.borderColor = "var(--color-danger-border)";
              }}
            >
              <Archive size={12} />
              Archivovat tento uzel
            </button>
            <p className="mt-2 text-[10px] text-[var(--color-text-dim)]">
              Uzel bude skryt z grafu, ale jeho vazby a události zůstanou
              v databázi pro audit.
            </p>
          </Section>
        )}
          </>
        )}

        {tab === "events" && (
          <div className="px-5 py-4">
            <div className="space-y-2">
              {node.events.map((evt) => (
                <EventCard
                  key={evt.id}
                  event={evt}
                  onMutate={onMutate}
                  busy={busy}
                />
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
            {node.files.length > 0 && (
              <SyncBar
                running={syncRunning}
                result={syncRunResult}
                error={syncError}
                statusLoaded={syncLoaded}
                statusMap={syncStatus}
                onRun={handleRunSync}
              />
            )}
            {node.files.length > 0 ? (
              <FileTree
                files={node.files}
                syncStatus={syncStatus}
                syncLoaded={syncLoaded}
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
                      {edges.map((edge) => (
                        <ConnectionLink
                          key={edge.id}
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
      </div>

      {/* Action bar */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-6 py-4">
        {editing ? (
          <div className="flex gap-2">
            <button
              onClick={saveEdit}
              disabled={saving || !draftName.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-4 py-2.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)] disabled:opacity-50"
            >
              <Save size={13} />
              {saving ? "Ukládám..." : "Uložit změny"}
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-[13.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Zrušit
            </button>
          </div>
        ) : (
          <ActionButtons node={node} agentCommand={agentCommand} />
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
}: {
  children: React.ReactNode;
  canGoBack: boolean;
  onBack: () => void;
  onClose: () => void;
  editing?: boolean;
  onEdit?: () => void;
}) {
  return (
    <aside className="animate-slide-in flex h-full w-[40vw] min-w-[440px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2">
        <button
          disabled={!canGoBack}
          onClick={onBack}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[14px] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)] disabled:opacity-30 disabled:hover:text-[var(--color-text-dim)]"
        >
          <ArrowLeft size={12} />
          Zpět
        </button>
        <div className="flex items-center gap-1">
          {onEdit && !editing && (
            <button
              onClick={onEdit}
              title="Upravit uzel"
              className="flex h-6 items-center gap-1.5 rounded px-2 text-[14px] text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              <Pencil size={12} />
              Upravit
            </button>
          )}
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <X size={13} />
          </button>
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
  // for relation changes to avoid trigger-error surprises.
  const editable = edge.relation !== "belongs_to";

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
        <select
          value={draftRelation}
          onChange={(e) => setDraftRelation(e.target.value)}
          disabled={disabled}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[13px] text-[var(--color-text)]"
        >
          {RELATION_TYPES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            await onChangeRelation(draftRelation);
            setEditing(false);
          }}
          disabled={disabled || draftRelation === edge.relation}
          title="Uložit relaci"
          className="ml-0.5 flex h-6 w-6 items-center justify-center rounded text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/15 disabled:pointer-events-none disabled:opacity-40"
        >
          <Check size={12} />
        </button>
        <button
          onClick={() => {
            setDraftRelation(edge.relation);
            setEditing(false);
          }}
          disabled={disabled}
          title="Zrušit"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-1 rounded px-2 py-1.5 transition-colors hover:bg-[var(--color-surface)]">
      <button
        onClick={() => onSelect(edge.peer_id)}
        className="flex flex-1 items-center gap-2 text-left"
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
        <ArrowRight
          size={11}
          className="text-[var(--color-text-dim)] opacity-0 transition-opacity group-hover:opacity-100"
        />
      </button>
      {editable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setDraftRelation(edge.relation);
            setEditing(true);
          }}
          disabled={disabled}
          title="Změnit typ vazby"
          className="ml-0.5 flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-all hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] group-hover:opacity-100 disabled:pointer-events-none"
        >
          <Pencil size={11} />
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        disabled={disabled}
        title="Odebrat vazbu"
        className="ml-0.5 flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-all group-hover:opacity-100 disabled:pointer-events-none"
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--color-danger-bg)";
          e.currentTarget.style.color = "var(--color-danger)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "";
          e.currentTarget.style.color = "";
        }}
      >
        <Trash2 size={11} />
      </button>
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
      <button
        onClick={() => setOpen(true)}
        className="mt-3 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[14px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
      >
        <Plus size={12} />
        Přidat propojení
      </button>
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
        <button
          onClick={() => setOpen(false)}
          className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      </div>
      <div className="space-y-2">
        <NodePicker
          nodes={candidates}
          value={targetId}
          onChange={setTargetId}
        />
        <div className="flex items-center gap-2">
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
            className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[14px] text-[var(--color-text)]"
          >
            {RELATION_TYPES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              setDirection((d) => (d === "outgoing" ? "incoming" : "outgoing"))
            }
            title="Otočit směr"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            {direction === "outgoing" ? "→" : "←"}
          </button>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <button
          onClick={submit}
          disabled={!targetId || submitting || disabled}
          className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[14px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          {submitting ? "Přidávám..." : "Přidat propojení"}
        </button>
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
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = nodes.find((n) => n.id === value);

  const filtered = filter.trim()
    ? nodes.filter(
        (n) =>
          n.name.toLowerCase().includes(filter.toLowerCase()) ||
          n.type.toLowerCase().includes(filter.toLowerCase()),
      )
    : nodes;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

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
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left text-[11.5px]"
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
          <span className="text-[var(--color-text-dim)]">Vyberte uzel...</span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg">
          <div className="border-b border-[var(--color-border)] px-2.5 py-1.5">
            <input
              ref={inputRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Hledat..."
              className="w-full bg-transparent text-[11.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none"
            />
          </div>
          <div className="scroll-thin max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
                Žádné výsledky
              </div>
            ) : (
              filtered.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => pick(n.id)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] ${
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
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
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
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const states =
    (LIFECYCLE_STATES_BY_TYPE as Record<string, readonly string[]>)[nodeType] ??
    [];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pick = async (next: string | null) => {
    setOpen(false);
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
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={saving}
        title="Změnit stav životního cyklu"
        className={`${badgeClass} cursor-pointer transition-opacity hover:opacity-80 disabled:opacity-50`}
      >
        {value ?? "nevyplněno"}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
          <button
            type="button"
            onClick={() => pick(null)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] ${
              value === null ? "bg-[var(--color-surface-2)]" : ""
            }`}
          >
            <span className="text-[var(--color-text-dim)]">— nevyplněno —</span>
          </button>
          {states.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => pick(s)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] ${
                value === s ? "bg-[var(--color-surface-2)]" : ""
              }`}
            >
              <span
                className={`lifecycle-badge lifecycle-${LIFECYCLE_COLORS[s] ?? "gray"}`}
              >
                {s}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VisibilityDropdown({
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
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pick = async (next: string) => {
    setOpen(false);
    if (next === value) return;
    setSaving(true);
    onError(null);
    try {
      await updateNode(nodeId, { visibility: next });
      await onMutate();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const isPrivate = value === "private";
  const Icon = isPrivate ? Lock : Users;
  const label = isPrivate ? "soukromé" : "tým";
  const tone = isPrivate
    ? "border-[color:color-mix(in_srgb,var(--color-warning,#a16207)_50%,transparent)] text-[color:var(--color-warning,#a16207)]"
    : "border-[var(--color-border)] text-[var(--color-text-dim)]";

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={saving}
        title="Změnit viditelnost nodu"
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-[2px] font-mono text-[11px] transition-opacity hover:opacity-80 disabled:opacity-50 ${tone}`}
      >
        <Icon size={11} strokeWidth={2} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
          {NODE_VISIBILITIES.map((v) => {
            const priv = v === "private";
            const VIcon = priv ? Lock : Users;
            const vLabel = priv ? "soukromé" : "tým";
            const vHint = priv
              ? "jen tvůrce"
              : "všichni v týmu";
            return (
              <button
                key={v}
                type="button"
                onClick={() => pick(v)}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] ${
                  value === v ? "bg-[var(--color-surface-2)]" : ""
                }`}
              >
                <VIcon
                  size={12}
                  strokeWidth={2}
                  className="mt-[2px] shrink-0 text-[var(--color-text-dim)]"
                />
                <span className="flex flex-col">
                  <span className="font-mono text-[11px] text-[var(--color-text)]">
                    {vLabel}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-dim)]">
                    {vHint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
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
        <button
          onClick={() => setEditing(true)}
          title="Upravit popis"
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[13.5px] text-[var(--color-text-dim)] opacity-0 transition-all hover:text-[var(--color-text)] group-hover:opacity-100"
        >
          <Pencil size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        autoFocus
        placeholder="Popište, co tento uzel reprezentuje..."
        className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
      />
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[14px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          <Save size={11} />
          {saving ? "Ukládám..." : "Uložit"}
        </button>
        <button
          onClick={cancel}
          disabled={saving}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[14px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          Zrušit
        </button>
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
        <button
          onClick={() => setEditing(true)}
          title="Upravit účel"
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[13.5px] text-[var(--color-text-dim)] opacity-0 transition-all hover:text-[var(--color-text)] group-hover:opacity-100"
        >
          <Pencil size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        autoFocus
        placeholder="Proč tento uzel existuje, čeho má dosáhnout..."
        className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
      />
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[14px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          <Save size={11} />
          {saving ? "Ukládám..." : "Uložit"}
        </button>
        <button
          onClick={cancel}
          disabled={saving}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[14px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          Zrušit
        </button>
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
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

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
    setOpen(false);
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
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={saving || orgs.length === 0}
        className="flex w-full items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:border-[var(--color-border-strong)] disabled:opacity-50"
      >
        {currentOrgEdge ? (
          <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
            <Building2 size={12} className="shrink-0 text-[var(--color-text-dim)]" />
            <span className="truncate">{currentOrgEdge.peer_name}</span>
          </span>
        ) : (
          <span className="flex-1 text-[var(--color-text-dim)]">
            — Bez organizace —
          </span>
        )}
        <Pencil size={11} className="shrink-0 text-[var(--color-text-dim)]" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
          {orgs.length === 0 ? (
            <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
              Žádné organizace nejsou k dispozici.
            </div>
          ) : (
            orgs.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => pick(o.id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] ${
                  currentOrgEdge?.peer_id === o.id
                    ? "bg-[var(--color-surface-2)]"
                    : ""
                }`}
              >
                <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
                  <Building2 size={12} className="shrink-0 text-[var(--color-text-dim)]" />
                  <span className="truncate">{o.name}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
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
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

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
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={openPicker}
        disabled={saving}
        className="flex w-full items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:border-[var(--color-border-strong)] disabled:opacity-50"
      >
        {node.owner ? (
          <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
            <User size={12} className="shrink-0 text-[var(--color-text-dim)]" />
            <span className="truncate">{node.owner.name}</span>
          </span>
        ) : (
          <span className="flex-1 text-[var(--color-text-dim)]">
            — Žádný —
          </span>
        )}
        <Pencil size={11} className="shrink-0 text-[var(--color-text-dim)]" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
            <Search
              size={12}
              className="shrink-0 text-[var(--color-text-dim)]"
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Hledat aktéra..."
              className="flex-1 bg-transparent text-[11.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
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
                      <button
                        key="__unset__"
                        type="button"
                        data-row-index={idx}
                        onMouseEnter={() => setHighlight(idx)}
                        onClick={() => pick(null)}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors ${
                          isHighlight ? "bg-[var(--color-surface)]" : ""
                        } ${
                          isCurrent && !isHighlight
                            ? "bg-[var(--color-surface-2)]"
                            : ""
                        }`}
                      >
                        <span className="text-[var(--color-text-dim)]">
                          — Žádný —
                        </span>
                      </button>
                    );
                  }
                  const a = row.actor;
                  const isPlaceholder =
                    a.is_placeholder === 1 || a.user_id === null;
                  const isCurrent = node.owner?.id === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      data-row-index={idx}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => pick(a.id)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors ${
                        isHighlight ? "bg-[var(--color-surface)]" : ""
                      } ${
                        isCurrent && !isHighlight
                          ? "bg-[var(--color-surface-2)]"
                          : ""
                      }`}
                    >
                      <span className="flex flex-1 items-center gap-1.5 truncate text-[var(--color-text)]">
                        <User
                          size={12}
                          className="shrink-0 text-[var(--color-text-dim)]"
                        />
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
                    </button>
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
        </div>
      )}
    </div>
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
        <button
          onClick={() => setAdding(true)}
          className="mt-3 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[14px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} />
          Přidat úlohu
        </button>
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
    if (
      !confirm(`Smazat úlohu „${responsibility.title}"? Tato akce je trvalá.`)
    ) {
      return;
    }
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
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            autoFocus
            placeholder="Název úlohy"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] font-semibold text-[var(--color-text)] focus:border-[var(--color-accent-dim)]"
          />
          <textarea
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            rows={3}
            placeholder="Popis (volitelné)"
            className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13.5px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
          />
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving || !draftTitle.trim()}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[14px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
            >
              <Save size={11} />
              {saving ? "Ukládám..." : "Uložit"}
            </button>
            <button
              onClick={cancel}
              disabled={saving}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[14px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Zrušit
            </button>
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
              <span
                key={a.id}
                className={`assignee assignee-${a.type} inline-flex items-center gap-1`}
              >
                <span className="truncate">{a.name}</span>
                <ActorBadge type={a.type} />
                <button
                  onClick={() => unassign(a.id)}
                  disabled={busy}
                  title="Odebrat"
                  className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[var(--color-text-dim)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)] disabled:opacity-50"
                >
                  <X size={9} />
                </button>
              </span>
            ))}
            {pickerOpen ? (
              <AssigneePicker
                existing={responsibility.assignees.map((a) => a.id)}
                onPick={assign}
                onClose={() => setPickerOpen(false)}
                disabled={busy}
              />
            ) : (
              <button
                onClick={() => setPickerOpen(true)}
                disabled={busy}
                className="assignee inline-flex items-center gap-1 border-dashed text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)] disabled:opacity-50"
                style={{ borderStyle: "dashed" }}
              >
                <Plus size={10} />
                přiřadit
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={onMoveUp}
            disabled={busy || !canMoveUp}
            title="Posunout nahoru"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronUp size={12} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={busy || !canMoveDown}
            title="Posunout dolů"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronDown size={12} />
          </button>
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            title="Upravit úlohu"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={remove}
            disabled={busy}
            title="Smazat úlohu"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] disabled:opacity-50"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-danger-bg)";
              e.currentTarget.style.color = "var(--color-danger)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "";
              e.currentTarget.style.color = "";
            }}
          >
            <Trash2 size={11} />
          </button>
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
        <button
          onClick={onCancel}
          className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      </div>
      <div className="space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="Název úlohy"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Popis (volitelné)"
          className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
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
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11.5px] hover:bg-[var(--color-surface)]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(a.id)}
                      className="h-3 w-3 shrink-0"
                    />
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
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[14px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          Zrušit
        </button>
        <button
          onClick={submit}
          disabled={!title.trim() || saving}
          className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[14px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          {saving ? "Vytvářím..." : "Vytvořit"}
        </button>
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
    if (!confirm("Opravdu smazat?")) return;
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
          <button
            onClick={() => setAdding(true)}
            className="mt-3 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[14px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
          >
            <Plus size={12} />
            Přidat {title}
          </button>
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
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Název"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13.5px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none"
        />
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Odkaz (volitelné)"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Popis (volitelné)"
          className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving || !name.trim()}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1 text-[13px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
          >
            <Save size={11} />
            {saving ? "Ukládám..." : "Uložit"}
          </button>
          <button
            onClick={cancel}
            disabled={saving}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Zrušit
          </button>
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
            href={safeLink}
            target="_blank"
            rel="noreferrer"
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
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label={`Upravit ${title}`}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={onRemove}
            disabled={busy}
            aria-label={`Smazat ${title}`}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)] disabled:opacity-30"
          >
            <X size={11} />
          </button>
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
        <button
          onClick={onCancel}
          className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      </div>
      <div className="space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Název"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Popis (volitelné)"
          className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
        />
        <input
          value={externalLink}
          onChange={(e) => setExternalLink(e.target.value)}
          type="url"
          placeholder="Odkaz (volitelné, např. https://…)"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
        />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[14px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          Zrušit
        </button>
        <button
          onClick={submit}
          disabled={!name.trim() || saving}
          className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[14px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          {saving ? "Vytvářím..." : "Vytvořit"}
        </button>
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
                <button
                  key={a.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(a.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] disabled:opacity-50"
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
                </button>
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
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      onClick={handle}
      title="Kliknutím zkopírujete ID"
      className="group inline-flex items-center gap-1.5 rounded font-mono text-[10px] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text-muted)]"
    >
      <span>{id}</span>
      {copied ? (
        <Check size={10} className="text-[var(--color-accent)]" />
      ) : (
        <Copy
          size={10}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
}

// (i) icon that toggles a small popover with a raw JSON dump of node.meta.
// Debug-only: meta is dev/import bookkeeping (e.g. source: "evoluce",
// evoluce_entity_id, ...), not user-facing labels. Hidden entirely when
// meta is empty/null so it adds no visual noise to nodes without meta.
function MetaInfo({ meta }: { meta: unknown }) {
  const [open, setOpen] = useState(false);
  if (!meta || typeof meta !== "object" || Object.keys(meta as object).length === 0) {
    return null;
  }
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Meta (debug)"
        className="inline-flex items-center justify-center rounded text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text-muted)]"
      >
        <Info size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 max-h-80 min-w-[280px] max-w-md overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {JSON.stringify(meta, null, 2)}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}

// Folder-link icon: fetches the routed remote's web URL for the node folder
// and shows a click-to-open external-link icon when one is available. The
// fetch is best-effort: hidden silently when there is no routed remote, the
// backend has no web URL (s3, sftp), or the folder isn't synced yet.
function FolderLink({ nodeId }: { nodeId: string }) {
  const [info, setInfo] = useState<{ url: string; remote_name?: string } | null>(null);
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
  return (
    <a
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Otevřít na ${info.remote_name ?? "remote"}`}
      className="inline-flex items-center justify-center rounded text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text-muted)]"
    >
      <ExternalLink size={11} />
    </a>
  );
}

// Click-to-copy local mirror path. Sits right under IdCopy in the header so
// the two share the same "inline identifier" feel.
function PathCopy({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      onClick={handle}
      title="Kliknutím zkopírujete cestu"
      className="group flex min-w-0 flex-1 items-center gap-1.5 rounded font-mono text-[10px] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text-muted)]"
    >
      <Folder size={10} className="shrink-0" />
      <span className="truncate">{path}</span>
      {copied ? (
        <Check size={10} className="shrink-0 text-[var(--color-accent)]" />
      ) : (
        <Copy
          size={10}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
}

// Tab button for the detail pane. Underline indicator + optional count badge.
function TabButton({
  active,
  onClick,
  label,
  count,
  dotColor,
  dotTitle,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  dotColor?: string;
  dotTitle?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium transition-colors ${
        active
          ? "text-[var(--color-text)]"
          : "text-[var(--color-text-dim)] hover:text-[var(--color-text-muted)]"
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
            active
              ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
              : "bg-[var(--color-surface)] text-[var(--color-text-dim)]"
          }`}
        >
          {count}
        </span>
      )}
      {dotColor && (
        <span
          title={dotTitle}
          className="h-1.5 w-1.5 rounded-full"
          style={{
            background: dotColor,
            boxShadow: `0 0 6px color-mix(in srgb, ${dotColor} 70%, transparent)`,
          }}
        />
      )}
      {active && (
        <span
          className="absolute inset-x-0 bottom-0 h-[2px]"
          style={{ background: "var(--color-accent)" }}
        />
      )}
    </button>
  );
}

function StatusDot({ status }: { status: string }) {
  const cssVar =
    status === "active"
      ? "var(--color-status-active)"
      : status === "completed"
      ? "var(--color-status-completed)"
      : "var(--color-status-archived)";
  return (
    <span className="ml-auto flex items-center gap-1.5">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: cssVar }}
      />
      <span className="text-[10px] text-[var(--color-text-dim)]">{status}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// File tree (Files tab)
// ---------------------------------------------------------------------------

type TreeNode = {
  name: string;
  // Full path from the mirror root, used as React key + collapse map key.
  // For the synthetic top-level "(root)" wrapper, this is "".
  path: string;
  // A folder node has children; a file node has file.
  children?: Map<string, TreeNode>;
  file?: DetailFile;
};

function buildFileTree(files: DetailFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    // Files without a derivable in-mirror path land at the root with just
    // their filename, so they stay visible instead of disappearing.
    const rel = f.relative_path ?? f.filename;
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
  let hasOrphan = false;
  let hasClean = false;
  let any = false;
  const stack: TreeNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.file) {
      const sync = map.get(cur.file.id);
      if (sync) {
        any = true;
        if (sync.sync_class === "conflict") hasConflict = true;
        else if (
          sync.sync_class === "push" ||
          sync.sync_class === "pull" ||
          sync.sync_class === "deleted_local"
        ) {
          hasPending = true;
        } else if (sync.sync_class === "orphan") hasOrphan = true;
        else if (sync.sync_class === "clean") hasClean = true;
      }
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
  if (hasOrphan)
    return {
      color: "var(--color-status-archived)",
      title: "Některé soubory jsou orphan",
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

function FileTree({
  files,
  syncStatus,
  syncLoaded,
}: {
  files: DetailFile[];
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
}) {
  const root = useMemo(() => buildFileTree(files), [files]);
  // Collapsed folder paths. Default = everything expanded; the user
  // collapses what they don't want to see. Using "collapsed" rather than
  // "expanded" means a freshly-added folder is visible by default.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
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
          syncStatus={syncStatus}
          syncLoaded={syncLoaded}
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
  syncStatus,
  syncLoaded,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
}) {
  const indent = depth * 14;
  if (node.file) {
    const f = node.file;
    const sync = syncStatus.get(f.id);
    return (
      <div
        className="flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface)]"
        style={{ paddingLeft: indent + 8 }}
      >
        <FileText
          size={12}
          className="mt-0.5 shrink-0 text-[var(--color-text-dim)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] text-[var(--color-text)]">
              {f.filename}
            </span>
            {sync && <SyncStatusBadge sync={sync} />}
            {!sync && !syncLoaded && (
              <span className="font-mono text-[8.5px] uppercase tracking-wider text-[var(--color-text-dim)]">
                ...
              </span>
            )}
          </div>
          {f.description && (
            <div className="mt-0.5 line-clamp-2 text-[13.5px] leading-relaxed text-[var(--color-text-dim)]">
              {f.description}
            </div>
          )}
        </div>
      </div>
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
              syncStatus={syncStatus}
              syncLoaded={syncLoaded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const SYNC_LABEL: Record<SyncClass, string> = {
  clean: "synced",
  push: "push",
  pull: "pull",
  conflict: "conflict",
  orphan: "orphan",
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
    case "orphan":
      return "var(--color-status-archived)";
    case "native":
      return "var(--color-accent)";
  }
}

// Pluralization for the work-pending counter ("3 soubory ke synchronizaci"
// vs. "1 soubor ke synchronizaci"). Czech grammar: 1 -> singular,
// 2-4 -> few, 5+ -> many. Used to label the action button.
function syncPendingLabel(count: number): string {
  if (count === 1) return "1 soubor ke synchronizaci";
  if (count >= 2 && count <= 4) return `${count} soubory ke synchronizaci`;
  return `${count} souborů ke synchronizaci`;
}

function SyncBar({
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
  // matches what the user sees. deleted_local is pull-restorable, so it
  // counts as pending work; conflicts are reported separately because
  // they need manual resolve.
  let pending = 0;
  let conflicts = 0;
  for (const f of statusMap.values()) {
    if (
      f.sync_class === "push" ||
      f.sync_class === "pull" ||
      f.sync_class === "deleted_local"
    ) {
      pending++;
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

  return (
    <div className="mb-3 space-y-2">
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
            title="Konflikty se neresolvují automaticky -- vyřešte ručně přes shell."
          >
            {conflicts} konflikt{conflicts === 1 ? "" : "y"}
          </span>
        )}
      </div>
      {result && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px] text-[var(--color-text-dim)]">
          {result.pushed.length > 0 && (
            <div>Push: {result.pushed.length} souborů</div>
          )}
          {result.pulled.length > 0 && (
            <div>Pull: {result.pulled.length} souborů</div>
          )}
          {result.conflicts.length > 0 && (
            <div style={{ color: "var(--color-danger)" }}>
              Konflikty (přeskočeno): {result.conflicts.length}
            </div>
          )}
          {result.errors.length > 0 && (
            <div style={{ color: "var(--color-danger)" }}>
              Chyby: {result.errors.length} (
              {result.errors.map((e) => e.filename).join(", ")})
            </div>
          )}
          {result.pushed.length === 0 &&
            result.pulled.length === 0 &&
            result.conflicts.length === 0 &&
            result.errors.length === 0 && <div>Nic k synchronizaci.</div>}
        </div>
      )}
      {error && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px]">
          <span style={{ color: "var(--color-danger)" }}>Chyba: {error}</span>
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

function ActionButtons({
  node,
  agentCommand,
}: {
  node: NodeDetail;
  agentCommand: string;
}) {
  const [copiedLaunch, setCopiedLaunch] = useState(false);

  // Organizations are workspace roots, not work locations -- nobody runs an
  // agent at org scope, so the launch command is pointless here.
  if (node.type === "organization") return null;

  const handleCopyLaunch = async () => {
    const cmd = buildAgentCommand(node, agentCommand);
    await navigator.clipboard.writeText(cmd);
    setCopiedLaunch(true);
    setTimeout(() => setCopiedLaunch(false), 1500);
  };

  const agentLabel = agentCommand.trim().split(/\s+/)[0] || "agent";

  return (
    <div className="flex gap-2">
      <button
        onClick={handleCopyLaunch}
        title="Zkopíruje shell příkaz, který vstoupí do složky uzlu a spustí nakonfigurovaného agenta s promptem"
        className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-4 py-2.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-all hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)]"
      >
        {copiedLaunch ? (
          <>
            <Check size={13} />
            Zkopírováno
          </>
        ) : (
          <>
            <Sparkles size={13} />
            Spouštěcí příkaz ({agentLabel})
          </>
        )}
      </button>
    </div>
  );
}

function EventCard({
  event: evt,
  onMutate,
  busy,
}: {
  event: DetailEvent;
  onMutate: () => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(evt.content);
  const [type, setType] = useState(evt.type);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, string> = {};
      if (content.trim() !== evt.content) patch.content = content.trim();
      if (type !== evt.type) patch.type = type;
      if (Object.keys(patch).length > 0) {
        await updateEvent(evt.id, patch);
        await onMutate();
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    setSaving(true);
    try {
      await archiveEvent(evt.id);
      await onMutate();
    } finally {
      setSaving(false);
    }
  };

  const resolve = async () => {
    setSaving(true);
    try {
      await updateEvent(evt.id, { status: "resolved" });
      await onMutate();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-surface)] px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[12.5px] text-[var(--color-text)]"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span className="flex-1" />
          <button
            onClick={() => {
              setEditing(false);
              setContent(evt.content);
              setType(evt.type);
            }}
            className="text-[12.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            Zrušit
          </button>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
        />
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={save}
            disabled={saving || !content.trim()}
            className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1 text-[13px] text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
          >
            {saving ? "Ukládám..." : "Uložit"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="mb-0.5 flex items-center gap-2">
        <span className="font-mono text-[12px] uppercase tracking-wider text-[var(--color-accent)]">
          {evt.type}
        </span>
        {evt.status !== "active" && (
          <span className="rounded-sm bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)]">
            {evt.status}
          </span>
        )}
        <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-dim)]">
          <Clock size={9} />
          {evt.created_at.slice(0, 10)}
        </span>
        <span className="flex-1" />
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {evt.status === "active" && (
            <button
              onClick={resolve}
              disabled={busy || saving}
              title="Označit jako vyřešené"
              className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)]"
            >
              <Check size={11} />
            </button>
          )}
          <button
            onClick={() => setEditing(true)}
            disabled={busy || saving}
            title="Upravit"
            className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={archive}
            disabled={busy || saving}
            title="Archivovat"
            className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-danger)]"
          >
            <Trash2 size={11} />
          </button>
        </span>
      </div>
      <div className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {evt.content}
      </div>
    </div>
  );
}

function AddEventForm({
  nodeId,
  onMutate,
  disabled,
}: {
  nodeId: string;
  onMutate: () => Promise<void>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>("note");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[13.5px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
      >
        <Plus size={12} />
        Přidat událost
      </button>
    );
  }

  const submit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      await createEvent({ node_id: nodeId, type, content: content.trim() });
      await onMutate();
      setOpen(false);
      setContent("");
      setType("note");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[12px] uppercase tracking-widest text-[var(--color-text-dim)]">
          Nová událost
        </div>
        <button
          onClick={() => {
            setOpen(false);
            setContent("");
          }}
          className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      </div>
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="mb-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[13.5px] text-[var(--color-text)]"
      >
        {EVENT_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Co se stalo?"
        rows={3}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none focus:border-[var(--color-accent-dim)]"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={submit}
          disabled={!content.trim() || submitting || disabled}
          className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[13.5px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          {submitting ? "Přidávám..." : "Přidat událost"}
        </button>
      </div>
    </div>
  );
}
