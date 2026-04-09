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
import type { NodeDetail, DetailEdge, GraphPayload } from "../types";
import { RELATION_TYPES } from "../types";
import { buildAgentPrompt, buildCdCommand } from "../lib/prompt";
import { updateNode, archiveNode, createEdge, deleteEdge } from "../api";

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
}: Props) {
  if (loading && !node) {
    return (
      <PaneShell onClose={() => onSelect(null)} canGoBack={false} onBack={onBack}>
        <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-text-dim)]">
          Loading...
        </div>
      </PaneShell>
    );
  }

  if (error) {
    return (
      <PaneShell onClose={() => onSelect(null)} canGoBack={false} onBack={onBack}>
        <div
          className="flex h-full items-center justify-center text-[12px]"
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
}: {
  node: NodeDetail;
  graph: GraphPayload | null;
  onSelect: (id: string | null) => void;
  canGoBack: boolean;
  onBack: () => void;
  onMutate: () => Promise<void>;
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
        `Archive "${node.name}"? It will be hidden from the graph but edges and history stay in the DB.`,
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
            className="font-mono text-[9.5px] uppercase tracking-[0.14em]"
            style={{ color: nodeTypeVar(node.type) }}
          >
            {node.type}
          </span>
          <StatusDot status={node.status} />
        </div>
        {editing ? (
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            autoFocus
            className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[19px] font-semibold leading-tight tracking-tight text-[var(--color-text)] focus:border-[var(--color-accent-dim)]"
          />
        ) : (
          <h1 className="mb-1 text-[20px] font-semibold leading-tight tracking-tight text-[var(--color-text)]">
            {node.name}
          </h1>
        )}
        <IdCopy id={node.id} />
      </div>

      {errorMsg && (
        <div
          className="border-b px-6 py-2 text-[11px]"
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
          <Section title={editing ? "Description" : undefined}>
            {editing ? (
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={5}
                placeholder="Describe what this node represents..."
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)]"
              />
            ) : (
              <p className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                {node.description}
              </p>
            )}
          </Section>
        )}

        {/* Connections — always shown in edit mode so you can manage them */}
        <Section title="Connections">
          {grouped.size > 0 ? (
            <div className="space-y-4">
              {Array.from(grouped.entries()).map(([relation, edges]) => (
                <div key={relation}>
                  <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-text-dim)]">
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
            <div className="mb-3 text-[11px] text-[var(--color-text-dim)]">
              No connections yet.
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
        {node.events.length > 0 && (
          <Section title="Recent events">
            <div className="space-y-2.5">
              {node.events.slice(0, 6).map((evt) => (
                <div
                  key={evt.id}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className="font-mono text-[9.5px] uppercase tracking-wider text-[var(--color-accent)]">
                      {evt.type}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-dim)]">
                      <Clock size={9} />
                      {evt.created_at.slice(0, 10)}
                    </span>
                  </div>
                  <div className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                    {evt.content}
                  </div>
                </div>
              ))}
              {node.events.length > 6 && (
                <div className="text-[10.5px] text-[var(--color-text-dim)]">
                  + {node.events.length - 6} more
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Files */}
        {node.files.length > 0 && (
          <Section title="Files">
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
                      <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-[var(--color-text-dim)]">
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
          <Section title="Local mirror">
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <Folder
                size={12}
                className="mt-0.5 shrink-0 text-[var(--color-text-dim)]"
              />
              <code className="break-all font-mono text-[10.5px] text-[var(--color-text-muted)]">
                {node.local_mirror.local_path}
              </code>
            </div>
          </Section>
        )}

        {editing && (
          <Section title="Danger zone">
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
              Archive this node
            </button>
            <p className="mt-2 text-[10px] text-[var(--color-text-dim)]">
              The node is hidden from the graph but its edges and events stay
              in the database for audit.
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
              className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-4 py-2.5 text-[12px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)] disabled:opacity-50"
            >
              <Save size={13} />
              {saving ? "Saving..." : "Save changes"}
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <ActionButtons node={node} />
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
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)] disabled:opacity-30 disabled:hover:text-[var(--color-text-dim)]"
        >
          <ArrowLeft size={12} />
          Back
        </button>
        <div className="flex items-center gap-1">
          {onEdit && !editing && (
            <button
              onClick={onEdit}
              title="Edit node"
              className="flex h-6 items-center gap-1.5 rounded px-2 text-[11px] text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              <Pencil size={12} />
              Edit
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
        <div className="mb-3 font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
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
        <span className="flex-1 truncate text-[12px] text-[var(--color-text)]">
          {edge.peer_name}
        </span>
        <span className="font-mono text-[9.5px] text-[var(--color-text-dim)]">
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
        title="Remove edge"
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
        className="mt-3 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
      >
        <Plus size={12} />
        Add connection
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
        <div className="font-mono text-[9.5px] uppercase tracking-widest text-[var(--color-text-dim)]">
          New connection
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
            className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[11px] text-[var(--color-text)]"
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
            title="Swap direction"
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
          className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          {submitting ? "Adding..." : "Add connection"}
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
          <span className="text-[var(--color-text-dim)]">Choose node...</span>
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
              placeholder="Search..."
              className="w-full bg-transparent text-[11.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none"
            />
          </div>
          <div className="scroll-thin max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[var(--color-text-dim)]">
                No matches
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
      title="Click to copy ID"
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

function ActionButtons({ node }: { node: NodeDetail }) {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedCd, setCopiedCd] = useState(false);

  const handleCopyPrompt = async () => {
    const prompt = buildAgentPrompt(node);
    await navigator.clipboard.writeText(prompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 1500);
  };

  const handleCopyCd = async () => {
    const cmd = buildCdCommand(node);
    if (!cmd) return;
    await navigator.clipboard.writeText(cmd);
    setCopiedCd(true);
    setTimeout(() => setCopiedCd(false), 1500);
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={handleCopyPrompt}
        className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-4 py-2.5 text-[12px] font-medium text-[var(--color-accent)] transition-all hover:bg-[var(--color-accent-dim)]/25 hover:border-[var(--color-accent)]"
      >
        {copiedPrompt ? (
          <>
            <Check size={13} />
            Copied
          </>
        ) : (
          <>
            <Sparkles size={13} />
            Copy agent prompt
          </>
        )}
      </button>
      {node.local_mirror && (
        <button
          onClick={handleCopyCd}
          title="Copy cd command"
          className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          {copiedCd ? <Check size={12} /> : <Copy size={12} />}
          cd
        </button>
      )}
    </div>
  );
}
