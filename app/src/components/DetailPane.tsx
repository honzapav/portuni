import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
} from "lucide-react";
import type {
  NodeDetail,
  DetailEdge,
  DetailEvent,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
  GraphPayload,
} from "../types";
import {
  RELATION_TYPES,
  EVENT_TYPES,
  LIFECYCLE_COLORS,
  LIFECYCLE_STATES_BY_TYPE,
} from "../types";
import { buildAgentCommand, buildCdCommand } from "../lib/prompt";
import type { Actor } from "../api";
import {
  updateNode,
  archiveNode,
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
  removeDataSource,
  addTool,
  removeTool,
} from "../api";

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
  const [draftDescription, setDraftDescription] = useState(
    node.description ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset edit drafts whenever we switch to a different node.
  const lastIdRef = useRef(node.id);
  useEffect(() => {
    if (lastIdRef.current !== node.id) {
      lastIdRef.current = node.id;
      setEditing(false);
      setDraftName(node.name);
      setDraftDescription(node.description ?? "");
      setErrorMsg(null);
    }
  }, [node.id, node.name, node.description]);

  const startEdit = () => {
    setDraftName(node.name);
    setDraftDescription(node.description ?? "");
    setEditing(true);
    setErrorMsg(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftName(node.name);
    setDraftDescription(node.description ?? "");
    setErrorMsg(null);
  };

  const saveEdit = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      await updateNode(node.id, {
        name: draftName.trim(),
        description: draftDescription.trim() || null,
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

  const grouped = new Map<string, DetailEdge[]>();
  for (const edge of node.edges) {
    if (!grouped.has(edge.relation)) grouped.set(edge.relation, []);
    grouped.get(edge.relation)!.push(edge);
  }

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
        <IdCopy id={node.id} />
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
        {(editing || node.description) && (
          <Section title={editing ? "Popis" : undefined}>
            {editing ? (
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={5}
                placeholder="Popište, co tento uzel reprezentuje..."
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
              />
            ) : (
              <p className="text-[14px] leading-relaxed text-[var(--color-text-muted)]">
                {node.description}
              </p>
            )}
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
              removeCreator={removeTool}
              onMutate={onMutate}
              onError={setErrorMsg}
            />
          </Section>
        )}

        {/* Connections — always shown in edit mode so you can manage them */}
        <Section title="Propojení">
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
            <AddEdgeForm
              currentNodeId={node.id}
              graph={graph}
              onAdd={handleAddEdge}
              disabled={busy}
            />
          )}
        </Section>

        {/* Events */}
        <Section title="Události">
          <div className="space-y-2">
            {node.events.map((evt) => (
              <EventCard
                key={evt.id}
                event={evt}
                onMutate={onMutate}
                busy={busy}
              />
            ))}
          </div>
          <AddEventForm
            nodeId={node.id}
            onMutate={onMutate}
            disabled={busy}
          />
        </Section>

        {/* Files */}
        {node.files.length > 0 && (
          <Section title="Soubory">
            <div className="space-y-1">
              {node.files.map((f) => (
                <div
                  key={f.id}
                  className="flex items-start gap-2.5 rounded px-2 py-1.5 hover:bg-[var(--color-surface)]"
                >
                  <FileText
                    size={12}
                    className="mt-0.5 shrink-0 text-[var(--color-text-dim)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[11.5px] text-[var(--color-text)]">
                        {f.filename}
                      </span>
                      <FileStatusBadge status={f.status} />
                    </div>
                    {f.description && (
                      <div className="mt-0.5 line-clamp-2 text-[13.5px] leading-relaxed text-[var(--color-text-dim)]">
                        {f.description}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Local mirror */}
        {node.local_mirror && (
          <Section title="Lokální zrcadlo">
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <Folder
                size={12}
                className="mt-0.5 shrink-0 text-[var(--color-text-dim)]"
              />
              <code className="break-all font-mono text-[13.5px] text-[var(--color-text-muted)]">
                {node.local_mirror.local_path}
              </code>
            </div>
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
  disabled,
}: {
  edge: DetailEdge;
  onSelect: (id: string) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
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

// Inline editor for the `goal` field. Read-mode shows the current value
// (or a muted placeholder). Clicking Edit reveals a textarea with
// Save/Cancel buttons. Empty goal saves as null.
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

// Resolve the organization id for a node. Organization nodes are their
// own org; every other node has exactly one outgoing belongs_to edge to
// an organization per the POPP schema.
function resolveOrgId(node: NodeDetail): string | null {
  if (node.type === "organization") return node.id;
  const edge = node.edges.find(
    (e) =>
      e.relation === "belongs_to" &&
      e.direction === "outgoing" &&
      e.peer_type === "organization",
  );
  return edge?.peer_id ?? null;
}

// Owner picker for a node. Fetches people from the node's organization on
// open, filters down to real people (non-placeholder, with user_id), and
// PATCHes owner_id on selection. "— Žádný —" unsets the owner.
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
  const containerRef = useRef<HTMLDivElement>(null);

  const orgId = resolveOrgId(node);

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

  const openPicker = async () => {
    setOpen(true);
    if (actors !== null || !orgId) return;
    setLoading(true);
    setFetchError(null);
    try {
      const list = await fetchActors({ org_id: orgId, type: "person" });
      setActors(list.filter((a) => a.user_id !== null && a.is_placeholder === 0));
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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={openPicker}
        disabled={saving}
        className="flex w-full items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:border-[var(--color-border-strong)] disabled:opacity-50"
      >
        {node.owner ? (
          <span className="flex-1 truncate text-[var(--color-text)]">
            {"\u{1F464} "}
            {node.owner.name}
          </span>
        ) : (
          <span className="flex-1 text-[var(--color-text-dim)]">
            — Žádný —
          </span>
        )}
        <Pencil size={11} className="shrink-0 text-[var(--color-text-dim)]" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
              Načítám lidi...
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
              <button
                type="button"
                onClick={() => pick(null)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] ${
                  !node.owner ? "bg-[var(--color-surface-2)]" : ""
                }`}
              >
                <span className="text-[var(--color-text-dim)]">— Žádný —</span>
              </button>
              {actors && actors.length === 0 ? (
                <div className="px-3 py-2 text-[14px] text-[var(--color-text-dim)]">
                  Žádní vhodní lidé v organizaci.
                </div>
              ) : (
                actors?.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => pick(a.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-[var(--color-surface)] ${
                      node.owner?.id === a.id
                        ? "bg-[var(--color-surface-2)]"
                        : ""
                    }`}
                  >
                    <span className="flex-1 truncate text-[var(--color-text)]">
                      {"\u{1F464} "}
                      {a.name}
                    </span>
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ----- Responsibilities editor -----

// Small tag showing assignee type (P = person, A = automation) with
// optional placeholder marking. Kept minimal so it fits in pills & rows.
function ActorBadge({
  type,
  placeholder,
}: {
  type: "person" | "automation" | string;
  placeholder?: boolean;
}) {
  const letter = type === "automation" ? "A" : "P";
  const color = placeholder
    ? "var(--color-text-dim)"
    : type === "automation"
    ? "var(--color-node-project)"
    : "var(--color-accent)";
  return (
    <span
      className="ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded font-mono text-[8.5px] font-semibold"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
      title={
        (type === "automation" ? "Automatizace" : "Člověk") +
        (placeholder ? " (placeholder)" : "")
      }
    >
      {letter}
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
  const orgId = resolveOrgId(node);

  return (
    <div>
      {node.responsibilities.length > 0 ? (
        <ul className="responsibility-list">
          {node.responsibilities.map((r) => (
            <ResponsibilityItem
              key={r.id}
              responsibility={r}
              orgId={orgId}
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
          orgId={orgId}
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
  orgId,
  onMutate,
  onError,
}: {
  responsibility: DetailResponsibility;
  orgId: string | null;
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
                orgId={orgId}
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
  orgId,
  onCancel,
  onDone,
  onError,
}: {
  nodeId: string;
  orgId: string | null;
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
    if (!orgId) {
      setActors([]);
      return;
    }
    setLoadingActors(true);
    setFetchError(null);
    fetchActors({ org_id: orgId })
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
  }, [orgId]);

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
          {!orgId ? (
            <div className="text-[14px] text-[var(--color-text-dim)]">
              Uzel nemá organizaci.
            </div>
          ) : loadingActors ? (
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
              Žádní actoři v organizaci.
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
            <li key={item.id} className="group flex items-start gap-2">
              <div className="flex-1">
                {item.external_link ? (
                  <a
                    href={item.external_link}
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
                <button
                  onClick={() => remove(item)}
                  disabled={busyId === item.id}
                  aria-label={`Smazat ${title}`}
                  className="shrink-0 text-[var(--color-text-dim)] opacity-0 transition-opacity hover:text-[var(--color-danger)] focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                >
                  <X size={12} />
                </button>
              )}
            </li>
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
// responsibility. Lazy-loads org actors, filters out those already
// assigned, and closes on outside click.
function AssigneePicker({
  orgId,
  existing,
  onPick,
  onClose,
  disabled,
}: {
  orgId: string | null;
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
    if (!orgId) {
      setActors([]);
      return;
    }
    setLoading(true);
    setFetchError(null);
    fetchActors({ org_id: orgId })
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
  }, [orgId]);

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
            Žádní další actoři k přiřazení.
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

function FileStatusBadge({ status }: { status: string }) {
  const cssVar =
    status === "output" || status === "final"
      ? "var(--color-status-active)"
      : status === "wip"
      ? "var(--color-node-process)"
      : "var(--color-status-archived)";
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
      style={{
        color: cssVar,
        background: `color-mix(in srgb, ${cssVar} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${cssVar} 25%, transparent)`,
      }}
    >
      {status}
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
  const [copiedCd, setCopiedCd] = useState(false);

  const handleCopyLaunch = async () => {
    const cmd = buildAgentCommand(node, agentCommand);
    await navigator.clipboard.writeText(cmd);
    setCopiedLaunch(true);
    setTimeout(() => setCopiedLaunch(false), 1500);
  };

  const handleCopyCd = async () => {
    const cmd = buildCdCommand(node);
    if (!cmd) return;
    await navigator.clipboard.writeText(cmd);
    setCopiedCd(true);
    setTimeout(() => setCopiedCd(false), 1500);
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
      {node.local_mirror && (
        <button
          onClick={handleCopyCd}
          title="Zkopírovat příkaz cd"
          className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          {copiedCd ? <Check size={12} /> : <Copy size={12} />}
          cd
        </button>
      )}
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
