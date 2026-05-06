// Modal for creating a node from the UI. Used by both the Sidebar's
// "+ Nová node" button and the empty-state CTA on the graph canvas.
//
// Type defaults to "organization" when no organizations exist yet (the
// only kind that can be created top-level), otherwise to "project". For
// non-organization types an organization picker is shown — the form
// won't submit without one because the server rejects it.

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { GraphNode } from "../types";
import { createNode } from "../api";
import type { NodeDetail } from "../types";

const NODE_TYPES = [
  "organization",
  "project",
  "process",
  "area",
  "principle",
] as const;
type NodeType = (typeof NODE_TYPES)[number];

const TYPE_LABELS: Record<NodeType, string> = {
  organization: "Organizace",
  project: "Projekt",
  process: "Proces",
  area: "Oblast",
  principle: "Princip",
};

type Props = {
  // Existing nodes used to populate the organization picker. We accept
  // the whole graph payload so the caller doesn't have to pre-filter.
  existingNodes: GraphNode[];
  // Pre-set the type and disable the type picker. Used by the empty-state
  // CTA, which always creates an organization.
  forceType?: NodeType;
  // Pre-select an organization when a non-org type is being created from
  // the context of an open detail pane. Optional.
  defaultOrgId?: string;
  onClose: () => void;
  onCreated: (node: NodeDetail) => void;
};

export default function CreateNodeModal({
  existingNodes,
  forceType,
  defaultOrgId,
  onClose,
  onCreated,
}: Props) {
  const orgs = useMemo(
    () =>
      existingNodes
        .filter((n) => n.type === "organization" && n.status !== "archived")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [existingNodes],
  );

  const [type, setType] = useState<NodeType>(
    () => forceType ?? (orgs.length === 0 ? "organization" : "project"),
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [orgId, setOrgId] = useState<string>(
    () => defaultOrgId ?? orgs[0]?.id ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Esc closes the modal — matches the rest of the app's modals.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Auto-focus the name field on open.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const trimmed = name.trim();
  const needsOrg = type !== "organization";
  const canSubmit =
    trimmed.length >= 2 && (!needsOrg || orgId.length > 0) && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createNode({
        type,
        name: trimmed,
        description: description.trim() || undefined,
        organization_id: needsOrg ? orgId : undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[90vh] w-full max-w-[480px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="flex-1 text-[14px] font-semibold tracking-tight text-[var(--color-text)]">
            Nový uzel
          </h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
            title="Zavřít"
          >
            <X size={13} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4">
          <div className="space-y-4">
            <Field label="Typ" required>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as NodeType)}
                disabled={Boolean(forceType)}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none disabled:opacity-60"
              >
                {NODE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              {forceType === "organization" && (
                <FieldHint>
                  Začínáte vytvořením první organizace — typ je předvyplněn.
                </FieldHint>
              )}
            </Field>

            {needsOrg && (
              <Field label="Organizace" required>
                {orgs.length === 0 ? (
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-text-dim)]">
                    Nejdřív vytvořte organizaci a vraťte se sem.
                  </div>
                ) : (
                  <select
                    value={orgId}
                    onChange={(e) => setOrgId(e.target.value)}
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none"
                  >
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            <Field label="Název" required>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  type === "organization" ? "Acme s.r.o." : "Onboarding klientů"
                }
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] focus:outline-none"
              />
              {trimmed.length > 0 && trimmed.length < 2 && (
                <FieldHint>Název musí mít alespoň 2 znaky.</FieldHint>
              )}
            </Field>

            <Field label="Popis">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Krátký popis (volitelné)"
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] focus:outline-none"
              />
            </Field>
          </div>

          {error && (
            <div
              className="mt-4 rounded-md border px-3 py-2 text-[11.5px]"
              style={{
                color: "var(--color-danger)",
                borderColor: "var(--color-danger-border)",
                background: "var(--color-danger-bg)",
              }}
            >
              {error}
            </div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Zrušit
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              {submitting ? "Vytvářím…" : "Vytvořit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--color-text-dim)]">
        {label}
        {required && <span className="ml-1 text-[var(--color-accent)]">*</span>}
      </div>
      {children}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
      {children}
    </div>
  );
}
