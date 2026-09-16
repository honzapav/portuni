// "Nový úkol" dialog (#342, docs/superpowers/specs/2026-09-12-runner-and-
// session-design.md "Web: ... New task"): brief + runner + instance, then
// POST /sessions and hand the fresh session back to the caller (which opens
// it in Práce's SessionChat). Same modal shape as CreateNodeModal.tsx.

import { useEffect, useMemo, useState } from "react";
import type { NodeDetail, SessionSummary, SessionRunRow } from "../types";
import { startSession } from "../api";
import { listRunners, listRunnerInstances, type RunnerInfo, type RunnerInstanceSummary } from "../lib/runners";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

// Radix Select refuses an empty-string item value, so "(výchozí)" -- no
// instance picked, `instanceId === ""` -- travels as this sentinel.
const NO_INSTANCE = "__none__";

type Props = {
  node: NodeDetail;
  onClose: () => void;
  onStarted: (result: { session: SessionSummary; run: SessionRunRow }) => void;
};

export default function NewTaskDialog({ node, onClose, onStarted }: Props) {
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [instances, setInstances] = useState<RunnerInstanceSummary[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [brief, setBrief] = useState("");
  const [runnerId, setRunnerId] = useState<string>("");
  const [instanceId, setInstanceId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgId = node.edges.find(
    (e) => e.relation === "belongs_to" && e.direction === "outgoing" && e.peer_type === "organization",
  )?.peer_id;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listRunners(), listRunnerInstances()])
      .then(([rs, is]) => {
        if (cancelled) return;
        setRunners(rs);
        setInstances(is);
        const firstUsable = rs.find((r) => r.availability.installed && r.availability.logged_in);
        if (firstUsable) setRunnerId(firstUsable.id);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Instances for the selected runner. Preselects the organization's
  // default instance (org_defaults), same lookup RunnersSection's own
  // org-default row already uses.
  const instancesForRunner = useMemo(
    () => instances.filter((i) => i.runner === runnerId),
    [instances, runnerId],
  );
  useEffect(() => {
    const def = orgId ? instancesForRunner.find((i) => i.org_defaults.includes(orgId)) : undefined;
    setInstanceId(def?.id ?? "");
  }, [instancesForRunner, orgId]);

  const trimmedBrief = brief.trim();
  const selectedRunner = runners.find((r) => r.id === runnerId);
  const runnerUsable = selectedRunner ? selectedRunner.availability.installed && selectedRunner.availability.logged_in : false;
  const canSubmit = trimmedBrief.length > 0 && runnerId.length > 0 && runnerUsable && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await startSession({
        node_id: node.id,
        brief: trimmedBrief,
        runner: runnerId,
        instance_id: instanceId || null,
      });
      onStarted(result);
    } catch (err) {
      setError(String(err));
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Nový úkol — {node.name}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <Field label="Zadání" required>
              <Textarea
                autoFocus
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={4}
                placeholder="Co má agent udělat?"
                className="resize-y leading-relaxed"
              />
            </Field>

            <Field label="Runner" required>
              {loadingOptions ? (
                <div className="text-[13px] text-[var(--color-text-dim)]">Načítám dostupné runnery…</div>
              ) : runners.length === 0 ? (
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-text-dim)]">
                  Žádný runner není zaregistrovaný.
                </div>
              ) : (
                <Select value={runnerId} onValueChange={setRunnerId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="(vyber runner)" />
                  </SelectTrigger>
                  <SelectContent>
                    {runners.map((r) => (
                      <SelectItem key={r.id} value={r.id} disabled={!(r.availability.installed && r.availability.logged_in)}>
                        {r.id}
                        {!r.availability.installed
                          ? " — nenainstalováno"
                          : !r.availability.logged_in
                            ? " — nepřihlášeno"
                            : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {selectedRunner && !runnerUsable && (
                <FieldHint>
                  {selectedRunner.availability.installed
                    ? "Runner není přihlášený."
                    : "Runner není nainstalovaný na tomto zařízení."}
                </FieldHint>
              )}
            </Field>

            {instancesForRunner.length >= 2 && (
              <Field label="Instance">
                <Select
                  value={instanceId || NO_INSTANCE}
                  onValueChange={(v) => setInstanceId(v === NO_INSTANCE ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_INSTANCE}>(výchozí)</SelectItem>
                    {instancesForRunner.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
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
              {submitting ? "Spouštím…" : "Spustit"}
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
  return <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">{children}</div>;
}
