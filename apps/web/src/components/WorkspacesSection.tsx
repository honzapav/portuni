// Nastavení > Workspaces -- desktop-only tab: list every configured
// workspace (local + central), let the user activate/enable/disable/delete
// them, and create new ones. Mirrors the shape of SettingsPage.users.tsx
// (list state machine + inline form) but drives Tauri commands instead of
// the REST API.
//
// The `running` column matters more here than it looks: backend-ready /
// backend-error events (see lib/backend-url.ts) only ever fire for the
// ACTIVE workspace's sidecar, so this table is the only place a
// non-active, enabled workspace's health is visible at all.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  setWorkspaceEnabled,
  slugify,
  switchWorkspace,
  type WorkspaceInfo,
} from "../lib/workspaces";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; workspaces: WorkspaceInfo[] };

const DELETE_CONFIRM_MESSAGE =
  "Workspace se odebere z appky, sidecar se zastaví a tokeny se smažou z Keychain. Data na disku (mirror složky a databáze) zůstávají — smaž je ručně, pokud je nechceš.";

export default function WorkspacesSection() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [rowError, setRowError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    setState({ kind: "loading" });
    try {
      const workspaces = await listWorkspaces();
      if (mountedRef.current) setState({ kind: "ok", workspaces });
    } catch (e) {
      if (mountedRef.current) {
        setState({
          kind: "error",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  async function handleActivate(id: string) {
    setRowError(null);
    try {
      await withPending(id, () => switchWorkspace(id));
      // switchWorkspace reloads the page on success -- nothing left to do.
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRestart(id: string) {
    setRowError(null);
    try {
      await withPending(id, async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("restart_sidecar");
      });
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleToggleEnabled(id: string, enabled: boolean) {
    setRowError(null);
    try {
      await withPending(id, () => setWorkspaceEnabled(id, enabled));
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(w: WorkspaceInfo) {
    const confirmed = window.confirm
      ? window.confirm(`Smazat workspace „${w.label}"?\n\n${DELETE_CONFIRM_MESSAGE}`)
      : true;
    if (!confirmed) return;
    setRowError(null);
    try {
      await withPending(w.id, () => deleteWorkspace(w.id));
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          Workspaces
        </div>
        <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Každý workspace má vlastní sidecar, port a data (lokální Turso nebo
          centrální server). Zdraví neaktivního workspace se dá zjistit jen
          tady -- stavové eventy backendu chodí jen pro ten aktivní.
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
          <div className="text-[13px] text-[var(--color-text-dim)]">
            Načítám workspaces…
          </div>
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

        {state.kind === "ok" && state.workspaces.length === 0 && (
          <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
            Zatím žádné workspaces.
          </div>
        )}

        {state.kind === "ok" && state.workspaces.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                  <th className="pb-2 pr-4 font-semibold">Název</th>
                  <th className="pb-2 pr-4 font-semibold">ID</th>
                  <th className="pb-2 pr-4 font-semibold">Režim</th>
                  <th className="pb-2 pr-4 font-semibold">Port</th>
                  <th className="pb-2 pr-4 font-semibold">Stav</th>
                  <th className="pb-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {state.workspaces.map((w) => {
                  const busy = pending.has(w.id);
                  const canRestart = w.enabled && !w.running;
                  return (
                    <tr
                      key={w.id}
                      className="border-b border-[var(--color-border)] last:border-b-0"
                    >
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-[var(--color-text)]">
                            {w.label}
                          </span>
                          {w.active && (
                            <span className="rounded-sm border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide text-[var(--color-accent)]">
                              aktivní
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.id}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.data_mode === "central" ? "centrální" : "lokální"}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.mcp_port ?? "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {!w.enabled ? (
                          <span className="text-[var(--color-text-dim)]">vypnutý</span>
                        ) : w.running ? (
                          <span className="text-green-400">běží</span>
                        ) : (
                          <span className="text-[var(--color-text-dim)]">neběží</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy || w.active}
                            onClick={() => void handleActivate(w.id)}
                            className="rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Aktivovat
                          </button>
                          {canRestart &&
                            (w.active ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleRestart(w.id)}
                                className="rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Restartovat
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled
                                title="Přepni se do workspace a zkus restart"
                                className="cursor-not-allowed rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-dim)] opacity-50"
                              >
                                Restartovat
                              </button>
                            ))}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleToggleEnabled(w.id, !w.enabled)}
                            className="rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {w.enabled ? "Vypnout" : "Zapnout"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDelete(w)}
                            className="rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-dim)] transition-colors hover:border-red-900/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Smazat
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateWorkspaceForm onCreated={() => void load()} />
    </section>
  );
}

// --- Create workspace form ---------------------------------------------------

function CreateWorkspaceForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"local" | "central">("local");
  const [tursoUrl, setTursoUrl] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceRootTouched, setWorkspaceRootTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdHint, setCreatedHint] = useState(false);

  const id = slugify(name);
  const effectiveWorkspaceRoot = workspaceRootTouched
    ? workspaceRoot
    : `~/Workspaces/${id || "workspace"}`;

  function reset() {
    setName("");
    setMode("local");
    setTursoUrl("");
    setServerUrl("");
    setGoogleClientId("");
    setGoogleClientSecret("");
    setWorkspaceRoot("");
    setWorkspaceRootTouched(false);
  }

  async function handleCreate() {
    if (!id) {
      setError("Zadej platné jméno workspace.");
      return;
    }
    setBusy(true);
    setError(null);
    setCreatedHint(false);
    try {
      await createWorkspace({
        id,
        label: name.trim() || undefined,
        data_mode: mode,
        turso_url: mode === "local" ? tursoUrl.trim() || undefined : undefined,
        server_url: mode === "central" ? serverUrl.trim() || undefined : undefined,
        google_client_id: mode === "central" ? googleClientId.trim() || undefined : undefined,
        google_client_secret:
          mode === "central" ? googleClientSecret.trim() || undefined : undefined,
        workspace_root: effectiveWorkspaceRoot,
      });
      const wasLocal = mode === "local";
      reset();
      onCreated();
      if (wasLocal) setCreatedHint(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Přidat workspace
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Jméno
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Např. Osobní"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
          />
          <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
            ID: <span className="font-mono">{id || "(neplatné)"}</span> --
            po vytvoření už nejde změnit.
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Režim
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
              <input
                type="radio"
                name="workspace-mode"
                checked={mode === "local"}
                onChange={() => setMode("local")}
                disabled={busy}
              />
              Lokální (Turso)
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
              <input
                type="radio"
                name="workspace-mode"
                checked={mode === "central"}
                onChange={() => setMode("central")}
                disabled={busy}
              />
              Centrální server
            </label>
          </div>
        </div>

        {mode === "local" && (
          <div>
            <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Turso URL (volitelné)
            </label>
            <input
              type="text"
              value={tursoUrl}
              onChange={(e) => setTursoUrl(e.target.value)}
              disabled={busy}
              placeholder="libsql://your-db.turso.io"
              spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
            />
            <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
              Necháš-li prázdné, workspace startuje s lokální SQLite -- token
              se vkládá až po přepnutí do workspace v Settings.
            </div>
          </div>
        )}

        {mode === "central" && (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                Server URL
              </label>
              <input
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                disabled={busy}
                placeholder="https://portuni.example.com"
                spellCheck={false}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                Google Client ID
              </label>
              <input
                type="text"
                value={googleClientId}
                onChange={(e) => setGoogleClientId(e.target.value)}
                disabled={busy}
                spellCheck={false}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                Google Client Secret
              </label>
              <input
                type="password"
                value={googleClientSecret}
                onChange={(e) => setGoogleClientSecret(e.target.value)}
                disabled={busy}
                spellCheck={false}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
              />
            </div>
          </div>
        )}

        <div>
          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Workspace root
          </label>
          <input
            type="text"
            value={effectiveWorkspaceRoot}
            onChange={(e) => {
              setWorkspaceRootTouched(true);
              setWorkspaceRoot(e.target.value);
            }}
            disabled={busy}
            spellCheck={false}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
          />
        </div>

        {error && (
          <div className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
            {error}
          </div>
        )}

        {createdHint && (
          <div className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-3 py-2 text-[12.5px] text-[var(--color-accent)]">
            Workspace vytvořen. Turso token vlož po přepnutí do workspace v
            Settings.
          </div>
        )}

        <div>
          <button
            type="button"
            disabled={busy || !id}
            onClick={() => void handleCreate()}
            className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Vytvářím…" : "Vytvořit workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}
