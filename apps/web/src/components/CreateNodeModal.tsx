// Modal for creating a node from the UI. Used by both the Sidebar's
// "+ Nová node" button and the empty-state CTA on the graph canvas.
//
// Type defaults to "organization" when no organizations exist yet (the
// only kind that can be created top-level), otherwise to "project". For
// non-organization types an organization picker is shown — the form
// won't submit without one because the server rejects it.

import { displayError } from "../errors";
import { useMemo, useState } from "react";
import type { GraphNode } from "../types";
import { createNode } from "../api";
import type { NodeDetail } from "../types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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
      setError(displayError(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Nový uzel</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <Field label="Typ" required>
              <Select
                value={type}
                onValueChange={(v) => setType(v as NodeType)}
                disabled={Boolean(forceType)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NODE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                  <Select value={orgId} onValueChange={setOrgId}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {orgs.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}

            <Field label="Název" required>
              {/* Auto-focus the name field on open. */}
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  type === "organization" ? "Acme s.r.o." : "Onboarding klientů"
                }
              />
              {trimmed.length > 0 && trimmed.length < 2 && (
                <FieldHint>Název musí mít alespoň 2 znaky.</FieldHint>
              )}
            </Field>

            <Field label="Popis">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Krátký popis (volitelné)"
                className="resize-y leading-relaxed"
              />
            </Field>
          </div>

          {error && (
            <Alert
              variant="destructive"
              className="mt-4 border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]"
            >
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              Zrušit
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Vytvářím…" : "Vytvořit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
    <Label className="block font-normal leading-normal">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--color-text-dim)]">
        {label}
        {required && <span className="ml-1 text-[var(--color-accent)]">*</span>}
      </div>
      {children}
    </Label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
      {children}
    </div>
  );
}
