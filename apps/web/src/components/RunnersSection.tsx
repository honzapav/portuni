// Nastavení > Runnery (#344) -- replaces Profily and Příkaz agenta: detected
// runner adapters (GET /runners) and provider instances (server-side
// registry, apps/server/domain/runner/instances.ts, #319), editable through
// REST. Mirrors ProfilesSection.tsx's list-state-machine + inline-form
// shape, driving the REST API instead of Tauri commands -- the registry now
// lives on the sidecar, not in the desktop's own config.json.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRunnerInstance,
  deleteRunnerInstance,
  envKeysToText,
  listRunnerInstances,
  listRunners,
  parseEnvText,
  setRunnerInstanceOrgDefault,
  updateRunnerInstance,
  validateEnvKeys,
  type RunnerInfo,
  type RunnerInstanceSummary,
} from "../lib/runners";
import { fetchGraph } from "../api";
import type { GraphNode } from "../types";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; instances: RunnerInstanceSummary[] };

const DELETE_CONFIRM_MESSAGE =
  "Instance se smaže z registru a přestane se nabízet při zakládání úkolu. Výchozí volby organizací, které na ni mířily, se zruší.";

export default function RunnersSection() {
  const [runners, setRunners] = useState<RunnerInfo[] | null>(null);
  const [runnersError, setRunnersError] = useState<string | null>(null);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [orgs, setOrgs] = useState<GraphNode[]>([]);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // React 18 StrictMode double-invokes this effect in dev (setup -> cleanup
  // -> setup again) synchronously, before any fetch below can possibly
  // resolve -- resetting to true on setup (not just false on cleanup) is
  // what keeps a real async response after that dance from being silently
  // dropped for the rest of this mount's lifetime.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    listRunners()
      .then((r) => {
        if (mountedRef.current) setRunners(r);
      })
      .catch((e) => {
        if (mountedRef.current) setRunnersError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    setConfirmDeleteId(null);
    setState({ kind: "loading" });
    try {
      const instances = await listRunnerInstances();
      if (mountedRef.current) setState({ kind: "ok", instances });
    } catch (e) {
      if (mountedRef.current) {
        setState({ kind: "error", reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetchGraph()
      .then((g) => {
        if (!mountedRef.current) return;
        setOrgs(
          g.nodes
            .filter((n) => n.type === "organization")
            .sort((a, b) => a.name.localeCompare(b.name, "cs")),
        );
      })
      .catch(() => {
        // The org-default picker just stays empty -- not fatal to the tab.
      });
  }, []);

  function withPending<T>(id: string, fn: () => Promise<T>): Promise<T> {
    setPending((prev) => new Set([...prev, id]));
    return fn().finally(() => {
      if (!mountedRef.current) return;
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  }

  async function handleDelete(instance: RunnerInstanceSummary) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(instance.id, () => deleteRunnerInstance(instance.id));
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSetDefault(orgId: string, instanceId: string) {
    setRowError(null);
    try {
      await withPending(orgId, () => setRunnerInstanceOrgDefault(instanceId, orgId));
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  const instances = state.kind === "ok" ? state.instances : [];

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          Runnery
        </div>
        <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Runner je nástroj (např. Claude Code), který server spustí a řídí
          přes kanonický protokol událostí. Přihlášení zůstává na CLI
          samotném — Portuni nikdy nenabízí vlastní přihlášení.
        </p>

        {runnersError && (
          <div className="mb-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
            {runnersError}
          </div>
        )}
        {runners === null && !runnersError && (
          <div className="text-[13px] text-[var(--color-text-dim)]">Zjišťuji dostupné runnery…</div>
        )}
        {runners && runners.length === 0 && (
          <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
            Zatím žádný runner není na tomto zařízení zaregistrovaný.
          </div>
        )}
        {runners && runners.length > 0 && (
          <div className="flex flex-col gap-2">
            {runners.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--color-text)]">{r.id}</span>
                    {r.availability.version && (
                      <span className="font-mono text-[11px] text-[var(--color-text-dim)]">
                        {r.availability.version}
                      </span>
                    )}
                  </div>
                  {!r.availability.installed && (
                    <div className="mt-0.5 text-[12px] text-[var(--color-text-dim)]">
                      Nenainstalováno na tomto zařízení.
                    </div>
                  )}
                  {r.availability.installed && !r.availability.logged_in && (
                    <div className="mt-0.5 text-[12px] text-[var(--color-text-dim)]">
                      Nainstalováno, ale nepřihlášeno — přihlas se přímo v {r.id} CLI.
                    </div>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    r.availability.installed && r.availability.logged_in
                      ? "bg-emerald-950/40 text-emerald-300"
                      : "bg-[var(--color-bg)] text-[var(--color-text-dim)]"
                  }`}
                >
                  {r.availability.installed && r.availability.logged_in ? "připraveno" : "nedostupné"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          Instance
        </div>
        <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Instance popisuje, co se má vložit do prostředí spuštěného úkolu —
          typicky <code className="font-mono">CLAUDE_CONFIG_DIR=…</code> pro
          přepnutí účtu. Hodnoty se z bezpečnostních důvodů nikdy nenačítají
          zpět z registru.
        </p>

        {rowError && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
            <span className="min-w-0 break-words">{rowError}</span>
            <button
              type="button"
              onClick={() => setRowError(null)}
              className="shrink-0 text-red-400 hover:text-red-200"
            >
              Zavřít
            </button>
          </div>
        )}

        {state.kind === "loading" && (
          <div className="text-[13px] text-[var(--color-text-dim)]">Načítám instance…</div>
        )}

        {state.kind === "error" && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
            <span className="min-w-0 break-words">{state.reason}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="shrink-0 text-red-400 hover:text-red-200"
            >
              Zkusit znovu
            </button>
          </div>
        )}

        {state.kind === "ok" && instances.length === 0 && (
          <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
            Zatím žádné instance.
          </div>
        )}

        {state.kind === "ok" && instances.length > 0 && (
          <div className="flex flex-col gap-2">
            {instances.map((instance) => (
              <InstanceRow
                key={instance.id}
                instance={instance}
                busy={pending.has(instance.id)}
                editing={editingId === instance.id}
                onEdit={() => setEditingId(instance.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  void load();
                }}
                onError={setRowError}
                confirmDelete={confirmDeleteId === instance.id}
                onAskDelete={() => setConfirmDeleteId(instance.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onDelete={() => void handleDelete(instance)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateInstanceForm runners={runners ?? []} onCreated={() => void load()} />

      {state.kind === "ok" && instances.length > 0 && orgs.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
            Výchozí instance podle organizace
          </div>
          <p className="mb-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            Při založení úkolu z uzlu se jako výchozí nabídne instance
            nastavená pro jeho organizaci.
          </p>
          <div className="flex flex-col gap-2">
            {orgs.map((org) => {
              const current = instances.find((i) => i.org_defaults.includes(org.id));
              return (
                <div key={org.id} className="flex items-center justify-between gap-3">
                  <span className="text-[13.5px] text-[var(--color-text)]">{org.name}</span>
                  <select
                    value={current?.id ?? ""}
                    disabled={pending.has(org.id)}
                    onChange={(e) => {
                      if (e.target.value) void handleSetDefault(org.id, e.target.value);
                    }}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
                  >
                    <option value="">(žádná)</option>
                    {instances.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// --- Instance row (view + inline edit) --------------------------------------

function InstanceRow({
  instance,
  busy,
  editing,
  onEdit,
  onCancelEdit,
  onSaved,
  onError,
  confirmDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  instance: RunnerInstanceSummary;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
  confirmDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(instance.name);
  const [runner, setRunner] = useState(instance.runner);
  const [envText, setEnvText] = useState(envKeysToText(instance.env_keys));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setName(instance.name);
      setRunner(instance.runner);
      setEnvText(envKeysToText(instance.env_keys));
    }
  }, [editing, instance]);

  async function handleSave() {
    if (!name.trim()) {
      onError("Název instance je povinný.");
      return;
    }
    const env = parseEnvText(envText);
    const envIssue = validateEnvKeys(env);
    if (envIssue) {
      onError(envIssue);
      return;
    }
    setSaving(true);
    try {
      await updateRunnerInstance(instance.id, { name: name.trim(), runner: runner.trim(), env });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-bg)] p-3">
        <div className="flex flex-col gap-2">
          <div>
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Název
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Runner
            </label>
            <input
              type="text"
              value={runner}
              onChange={(e) => setRunner(e.target.value)}
              disabled={saving}
              spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Proměnné prostředí (jedna na řádek, KLÍČ=hodnota)
            </label>
            <p className="mb-1 text-[11px] leading-snug text-[var(--color-text-dim)]">
              Hodnoty se z bezpečnostních důvodů nikdy nenačítají zpět — u
              existujícího klíče zůstane prázdná hodnota beze změny, zadej ji
              znovu jen pokud ji chceš přepsat.
            </p>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              disabled={saving}
              rows={3}
              spellCheck={false}
              placeholder="CLAUDE_CONFIG_DIR=/Users/vy/.claude-work"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
            />
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="rounded border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Ukládám…" : "Uložit"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={onCancelEdit}
              className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Zrušit
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--color-text)]">{instance.name}</span>
            <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{instance.runner}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--color-text-dim)]">
            {instance.env_keys.length > 0 ? `proměnné: ${instance.env_keys.join(", ")}` : "(bez env)"}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Upravit
          </button>
          {confirmDelete ? (
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="rounded border border-red-900/50 bg-red-950/20 px-2 py-1 text-[11.5px] font-medium text-red-300 transition-colors hover:border-red-800 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Opravdu smazat
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onAskDelete}
              className="rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-dim)] transition-colors hover:border-red-900/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Smazat
            </button>
          )}
          {confirmDelete && (
            <button
              type="button"
              disabled={busy}
              onClick={onCancelDelete}
              className="rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Zrušit
            </button>
          )}
        </div>
      </div>
      {confirmDelete && (
        <div className="mt-1.5 max-w-[420px] text-[11px] leading-snug text-[var(--color-text-dim)]">
          {DELETE_CONFIRM_MESSAGE}
        </div>
      )}
    </div>
  );
}

// --- Create instance form ----------------------------------------------------

function CreateInstanceForm({
  runners,
  onCreated,
}: {
  runners: RunnerInfo[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [runner, setRunner] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // React 18 StrictMode double-invokes this effect in dev (setup -> cleanup
  // -> setup again) synchronously, before any fetch below can possibly
  // resolve -- resetting to true on setup (not just false on cleanup) is
  // what keeps a real async response after that dance from being silently
  // dropped for the rest of this mount's lifetime.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleCreate() {
    if (!name.trim()) {
      setError("Zadej název instance.");
      return;
    }
    if (!runner.trim()) {
      setError("Zadej runner (např. claude).");
      return;
    }
    const env = parseEnvText(envText);
    const envIssue = validateEnvKeys(env);
    if (envIssue) {
      setError(envIssue);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createRunnerInstance({ name: name.trim(), runner: runner.trim(), env });
      setName("");
      setRunner("");
      setEnvText("");
      onCreated();
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Přidat instanci
      </div>
      <div className="flex flex-col gap-3">
        <div>
          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Název
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Např. Práce"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
          />
        </div>

        <div>
          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Runner
          </label>
          <input
            type="text"
            list="runners-known-ids"
            value={runner}
            onChange={(e) => setRunner(e.target.value)}
            disabled={busy}
            spellCheck={false}
            placeholder="claude"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
          />
          <datalist id="runners-known-ids">
            {runners.map((r) => (
              <option key={r.id} value={r.id} />
            ))}
          </datalist>
        </div>

        <div>
          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Proměnné prostředí (jedna na řádek, KLÍČ=hodnota)
          </label>
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            disabled={busy}
            rows={3}
            spellCheck={false}
            placeholder="CLAUDE_CONFIG_DIR=/Users/vy/.claude-work"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
          />
        </div>

        {error && (
          <div className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
            {error}
          </div>
        )}

        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCreate()}
            className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Vytvářím…" : "Vytvořit instanci"}
          </button>
        </div>
      </div>
    </div>
  );
}
