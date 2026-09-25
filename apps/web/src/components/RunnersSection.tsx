// Nastavení > Runnery (#344) -- replaces Profily and Příkaz agenta: detected
// runner adapters (GET /runners) and provider instances (server-side
// registry, apps/server/domain/runner/instances.ts, #319), editable through
// REST. Keeps the list-state-machine + inline-form
// shape, driving the REST API instead of Tauri commands -- the registry now
// lives on the sidecar, not in the desktop's own config.json.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  createRunnerInstance,
  deleteRunnerInstance,
  envKeysToText,
  listRunnerInstances,
  listRunners,
  parseEnvText,
  setRunnerInstanceOrgDefault,
  clearRunnerOrgDefault,
  updateRunnerInstance,
  validateEnvKeys,
  type RunnerInfo,
  type RunnerInstanceSummary,
} from "../lib/runners";
import { fetchGraph } from "../api";
import type { GraphNode } from "../types";
import { compareText } from "../lib/format";
import { useLocale } from "../lib/use-locale";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; instances: RunnerInstanceSummary[] };

const DELETE_CONFIRM_MESSAGE =
  "Instance se smaže z registru a přestane se nabízet při zakládání úkolu. Výchozí volby organizací, které na ni mířily, se zruší.";

// Radix Select refuses an empty-string item value, so "no default instance"
// travels as this sentinel and is mapped back to null at the call site.
const NO_INSTANCE = "__none__";

const FIELD_LABEL =
  "mb-1 text-[12.5px] uppercase tracking-wider text-[var(--color-text-dim)]";
const ROW_FIELD_LABEL =
  "mb-1 text-[11.5px] uppercase tracking-wider text-[var(--color-text-dim)]";

// React 18 StrictMode double-invokes effects in dev (setup -> cleanup ->
// setup again) synchronously, before any fetch can possibly resolve --
// resetting to true on setup (not just false on cleanup) is what keeps a
// real async response after that dance from being silently dropped for the
// rest of the mount's lifetime.
function useMountedRef(): MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

export default function RunnersSection() {
  const locale = useLocale();
  const [runners, setRunners] = useState<RunnerInfo[] | null>(null);
  const [runnersError, setRunnersError] = useState<string | null>(null);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [orgs, setOrgs] = useState<GraphNode[]>([]);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const mountedRef = useMountedRef();

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
            .sort((a, b) => compareText(locale, a.name, b.name)),
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

  // instanceId null: the org has no default instance anymore.
  async function handleSetDefault(orgId: string, instanceId: string | null) {
    setRowError(null);
    try {
      await withPending(orgId, () =>
        instanceId === null ? clearRunnerOrgDefault(orgId) : setRunnerInstanceOrgDefault(instanceId, orgId),
      );
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
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{runnersError}</AlertDescription>
          </Alert>
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
                <Badge
                  variant="secondary"
                  className={`shrink-0 ${
                    r.availability.installed && r.availability.logged_in
                      ? "bg-emerald-950/40 text-emerald-300"
                      : "bg-[var(--color-bg)] text-[var(--color-text-dim)]"
                  }`}
                >
                  {r.availability.installed && r.availability.logged_in ? "připraveno" : "nedostupné"}
                </Badge>
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
          <Alert variant="destructive" className="mb-4">
            <AlertDescription className="flex items-start justify-between gap-3">
              <span className="min-w-0 break-words">{rowError}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setRowError(null)}
                className="shrink-0 text-destructive"
              >
                Zavřít
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {state.kind === "loading" && (
          <div className="text-[13px] text-[var(--color-text-dim)]">Načítám instance…</div>
        )}

        {state.kind === "error" && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-start justify-between gap-3">
              <span className="min-w-0 break-words">{state.reason}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => void load()}
                className="shrink-0 text-destructive"
              >
                Zkusit znovu
              </Button>
            </AlertDescription>
          </Alert>
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
                  <Select
                    value={current?.id ?? NO_INSTANCE}
                    disabled={pending.has(org.id)}
                    onValueChange={(v) =>
                      void handleSetDefault(org.id, v === NO_INSTANCE ? null : v)
                    }
                  >
                    <SelectTrigger size="sm" aria-label={`Výchozí instance pro ${org.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_INSTANCE}>(žádná)</SelectItem>
                      {instances.map((i) => (
                        <SelectItem key={i.id} value={i.id}>
                          {i.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
            <Label htmlFor={`instance-${instance.id}-name`} className={ROW_FIELD_LABEL}>
              Název
            </Label>
            <Input
              id={`instance-${instance.id}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
            />
          </div>
          <div>
            <Label htmlFor={`instance-${instance.id}-runner`} className={ROW_FIELD_LABEL}>
              Runner
            </Label>
            <Input
              id={`instance-${instance.id}-runner`}
              type="text"
              value={runner}
              onChange={(e) => setRunner(e.target.value)}
              disabled={saving}
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div>
            <Label htmlFor={`instance-${instance.id}-env`} className={ROW_FIELD_LABEL}>
              Proměnné prostředí (jedna na řádek, KLÍČ=hodnota)
            </Label>
            {instance.env_keys.length > 0 && (
              <p className="mb-1 font-mono text-[11px] leading-snug text-[var(--color-text-dim)]">
                {instance.env_keys.map((k) => `${k} (nastaveno)`).join(", ")}
              </p>
            )}
            <p className="mb-1 text-[11px] leading-snug text-[var(--color-text-dim)]">
              Hodnoty se z bezpečnostních důvodů nikdy nenačítají zpět — u
              existujícího klíče zůstane prázdná hodnota beze změny, zadej ji
              znovu jen pokud ji chceš přepsat.
            </p>
            <Textarea
              id={`instance-${instance.id}-env`}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              disabled={saving}
              rows={3}
              spellCheck={false}
              placeholder="CLAUDE_CONFIG_DIR=/Users/vy/.claude-work"
              className="font-mono"
            />
          </div>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
              {saving ? "Ukládám…" : "Uložit"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={onCancelEdit}
            >
              Zrušit
            </Button>
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
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onEdit}>
            Upravit
          </Button>
          {confirmDelete ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={onDelete}
            >
              Opravdu smazat
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={onAskDelete}
            >
              Smazat
            </Button>
          )}
          {confirmDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onCancelDelete}
            >
              Zrušit
            </Button>
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

  const mountedRef = useMountedRef();

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
          <Label htmlFor="instance-create-name" className={FIELD_LABEL}>
            Název
          </Label>
          <Input
            id="instance-create-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Např. Práce"
          />
        </div>

        <div>
          <Label htmlFor="instance-create-runner" className={FIELD_LABEL}>
            Runner
          </Label>
          <Input
            id="instance-create-runner"
            type="text"
            list="runners-known-ids"
            value={runner}
            onChange={(e) => setRunner(e.target.value)}
            disabled={busy}
            spellCheck={false}
            placeholder="claude"
            className="font-mono"
          />
          <datalist id="runners-known-ids">
            {runners.map((r) => (
              <option key={r.id} value={r.id} />
            ))}
          </datalist>
        </div>

        <div>
          <Label htmlFor="instance-create-env" className={FIELD_LABEL}>
            Proměnné prostředí (jedna na řádek, KLÍČ=hodnota)
          </Label>
          <Textarea
            id="instance-create-env"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            disabled={busy}
            rows={3}
            spellCheck={false}
            placeholder="CLAUDE_CONFIG_DIR=/Users/vy/.claude-work"
            className="font-mono"
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div>
          <Button type="button" disabled={busy} onClick={() => void handleCreate()}>
            {busy ? "Vytvářím…" : "Vytvořit instanci"}
          </Button>
        </div>
      </div>
    </div>
  );
}
