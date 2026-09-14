// "Nový úkol" dialog (#342, docs/superpowers/specs/2026-09-12-runner-and-
// session-design.md "Web: ... New task"): brief + runner + instance, then
// POST /sessions and hand the fresh session back to the caller (which opens
// it in Práce's SessionChat). Same modal shape as CreateNodeModal.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { NodeDetail, SessionSummary, SessionRunRow } from "../types";
import { startSession } from "../api";
import { listRunners, listRunnerInstances, type RunnerInfo, type RunnerInstanceSummary } from "../lib/runners";

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
  const briefRef = useRef<HTMLTextAreaElement>(null);

  const orgId = node.edges.find(
    (e) => e.relation === "belongs_to" && e.direction === "outgoing" && e.peer_type === "organization",
  )?.peer_id;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    briefRef.current?.focus();
  }, []);

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
  // default instance (org_defaults), same lookup TerminalSplitButton's
  // profile-picker and RunnersSection's own org-default row already use.
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="flex-1 text-[14px] font-semibold tracking-tight text-[var(--color-text)]">
            Nový úkol — {node.name}
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
            <Field label="Zadání" required>
              <textarea
                ref={briefRef}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={4}
                placeholder="Co má agent udělat?"
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] focus:outline-none"
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
                <select
                  value={runnerId}
                  onChange={(e) => setRunnerId(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none"
                >
                  <option value="" disabled>
                    (vyber runner)
                  </option>
                  {runners.map((r) => (
                    <option key={r.id} value={r.id} disabled={!(r.availability.installed && r.availability.logged_in)}>
                      {r.id}
                      {!r.availability.installed
                        ? " — nenainstalováno"
                        : !r.availability.logged_in
                          ? " — nepřihlášeno"
                          : ""}
                    </option>
                  ))}
                </select>
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
                <select
                  value={instanceId}
                  onChange={(e) => setInstanceId(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none"
                >
                  <option value="">(výchozí)</option>
                  {instancesForRunner.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
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
              {submitting ? "Spouštím…" : "Spustit"}
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
  return <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">{children}</div>;
}
