// Nastavení > Workspaces -- desktop-only tab: list every configured
// workspace (local + central), let the user activate/enable/disable/delete
// them, and create new ones. Mirrors the shape of SettingsPage.users.tsx
// (list state machine + inline form) but drives Tauri commands instead of
// the REST API.
//
// The `running` column matters more here than it looks: backend-ready /
// backend-error events (see lib/backend-url.ts) are per-window
// (emit_to("ws:<id>", ...)) and only ever fire for THIS WINDOW's own
// workspace's sidecar, so this table is the only place another, enabled
// workspace's health is visible at all.

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  openWorkspaceWindow,
  restartWorkspace,
  setWorkspaceEnabled,
  slugify,
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
  // Inline two-step delete confirm: window.confirm is a silent no-op in the
  // Tauri webview on macOS (see DetailPane.tsx). Holds the id of the row whose
  // delete is awaiting confirmation; the row swaps its Smazat button for the
  // warning + Potvrdit/Zrušit while set.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    // Whenever the list reloads, an armed "Opravdu smazat" must not survive
    // -- the row set it belonged to may have just changed underneath it.
    setConfirmDeleteId(null);
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

  // Cross-window sync (#226): Rust broadcasts "workspaces-changed" after
  // every config mutation, from ANY window -- replacing the old
  // document-local CustomEvent that only this window's own dispatch could
  // trigger (so e.g. a workspace created in another window's Settings now
  // shows up here too).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen("workspaces-changed", () => void load());
      } catch {
        /* not running in Tauri */
      }
    })();
    return () => {
      try {
        unlisten?.();
      } catch {
        /* window already gone */
      }
    };
  }, [load]);

  // restartWorkspace doesn't mutate config.json (no workspaces-changed
  // broadcast), so its own row needs an explicit reload; harmless to call
  // for the broadcasting mutations too (create/enable/disable/delete) --
  // just a redundant extra load alongside the one the event above already
  // triggers.
  const reloadAfterMutation = useCallback(async () => {
    await load();
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

  async function handleOpen(id: string) {
    // Row action: an armed delete confirm elsewhere in the table must not
    // survive an unrelated action.
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(id, () => openWorkspaceWindow(id));
      // Opens/focuses its own window -- nothing left to do here.
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRestart(id: string) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(id, () => restartWorkspace(id));
      await reloadAfterMutation();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleToggleEnabled(id: string, enabled: boolean) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(id, () => setWorkspaceEnabled(id, enabled));
      await reloadAfterMutation();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(w: WorkspaceInfo) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(w.id, () => deleteWorkspace(w.id));
      await reloadAfterMutation();
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
          Každý workspace má vlastní sidecar, port a data (osobní workspace
          vlastní Turso databázi, týmový workspace centrální server). Zdraví
          workspace bez otevřeného okna se dá
          zjistit jen tady – stavové eventy backendu chodí jen do okna daného
          workspace.
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
          <div className="text-[13px] text-[var(--color-text-dim)]">
            Načítám workspaces…
          </div>
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
                  <th className="pb-2 pr-4 font-semibold">Druh</th>
                  <th className="pb-2 pr-4 font-semibold">Port</th>
                  <th className="pb-2 pr-4 font-semibold">Stav</th>
                  <th className="pb-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {state.workspaces.map((w) => {
                  const busy = pending.has(w.id);
                  const canRestart = w.enabled && !w.running && !w.deferred;
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
                            <Badge
                              variant="outline"
                              className="border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] font-mono uppercase tracking-wide text-[var(--color-accent)]"
                            >
                              aktivní
                            </Badge>
                          )}
                          {w.window_open && (
                            <Badge
                              variant="outline"
                              className="font-mono uppercase tracking-wide text-[var(--color-text-dim)]"
                            >
                              okno otevřené
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.id}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.data_mode === "central" ? "týmový" : "osobní"}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.mcp_port ?? "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {w.running ? (
                          <span className="text-green-400">běží</span>
                        ) : w.deferred ? (
                          <span className="text-[var(--color-text-dim)]">
                            čeká na přihlášení
                          </span>
                        ) : w.enabled ? (
                          <span className="text-[var(--color-text-dim)]">neběží</span>
                        ) : (
                          <span className="text-[var(--color-text-dim)]">vypnutý</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy || !w.enabled}
                            onClick={() => void handleOpen(w.id)}
                          >
                            {w.window_open ? "Přepnout na okno" : "Otevřít"}
                          </Button>
                          {canRestart && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => void handleRestart(w.id)}
                            >
                              Restartovat
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant={w.enabled ? "destructive" : "outline"}
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleToggleEnabled(w.id, !w.enabled)}
                          >
                            {w.enabled ? "Vypnout" : "Zapnout"}
                          </Button>
                          {confirmDeleteId === w.id ? (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => void handleDelete(w)}
                            >
                              Opravdu smazat
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmDeleteId(w.id)}
                            >
                              Smazat
                            </Button>
                          )}
                          {confirmDeleteId === w.id && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              Zrušit
                            </Button>
                          )}
                        </div>
                        {confirmDeleteId === w.id && (
                          <div className="mt-1.5 max-w-[420px] text-[11px] leading-snug text-[var(--color-text-dim)]">
                            {DELETE_CONFIRM_MESSAGE}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateWorkspaceForm onCreated={() => void reloadAfterMutation()} />
    </section>
  );
}

// --- Create workspace form ---------------------------------------------------

const FIELD_LABEL =
  "mb-1 text-[12.5px] uppercase tracking-wider text-[var(--color-text-dim)]";

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

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      if (wasLocal && mountedRef.current) setCreatedHint(true);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Přidat workspace
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="ws-create-name" className={FIELD_LABEL}>
            Jméno
          </Label>
          <Input
            id="ws-create-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Např. Osobní"
          />
          <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
            ID: <span className="font-mono">{id || "(neplatné)"}</span> –
            po vytvoření už nejde změnit.
          </div>
        </div>

        <div>
          <Label className={FIELD_LABEL}>Druh workspace</Label>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as typeof mode)}
            disabled={busy}
            className="flex gap-4"
            aria-label="Druh workspace"
          >
            <Label className="gap-1.5 font-normal text-[13px] text-[var(--color-text-muted)]">
              <RadioGroupItem value="local" />
              Osobní workspace
            </Label>
            <Label className="gap-1.5 font-normal text-[13px] text-[var(--color-text-muted)]">
              <RadioGroupItem value="central" />
              Týmový workspace
            </Label>
          </RadioGroup>
        </div>

        {mode === "local" && (
          <div>
            <Label htmlFor="ws-create-turso-url" className={FIELD_LABEL}>
              Turso URL (volitelné)
            </Label>
            <Input
              id="ws-create-turso-url"
              type="text"
              value={tursoUrl}
              onChange={(e) => setTursoUrl(e.target.value)}
              disabled={busy}
              placeholder="libsql://your-db.turso.io"
              spellCheck={false}
              className="font-mono"
            />
            <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
              Necháš-li prázdné, workspace startuje s lokální SQLite – token
              se vkládá až po přepnutí do workspace v Settings.
            </div>
          </div>
        )}

        {mode === "central" && (
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="ws-create-server-url" className={FIELD_LABEL}>
                Server URL
              </Label>
              <Input
                id="ws-create-server-url"
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                disabled={busy}
                placeholder="https://portuni.example.com"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="ws-create-google-client-id" className={FIELD_LABEL}>
                Google Client ID
              </Label>
              <Input
                id="ws-create-google-client-id"
                type="text"
                value={googleClientId}
                onChange={(e) => setGoogleClientId(e.target.value)}
                disabled={busy}
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="ws-create-google-client-secret" className={FIELD_LABEL}>
                Google Client Secret
              </Label>
              <Input
                id="ws-create-google-client-secret"
                type="password"
                value={googleClientSecret}
                onChange={(e) => setGoogleClientSecret(e.target.value)}
                disabled={busy}
                spellCheck={false}
                className="font-mono"
              />
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="ws-create-root" className={FIELD_LABEL}>
            Workspace root
          </Label>
          <Input
            id="ws-create-root"
            type="text"
            value={effectiveWorkspaceRoot}
            onChange={(e) => {
              setWorkspaceRootTouched(true);
              setWorkspaceRoot(e.target.value);
            }}
            disabled={busy}
            spellCheck={false}
            className="font-mono"
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {createdHint && (
          <Alert className="border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
            <AlertDescription className="text-[var(--color-accent)]">
              Workspace vytvořen. Turso token vlož po přepnutí do workspace v
              Settings.
            </AlertDescription>
          </Alert>
        )}

        <div>
          <Button type="button" disabled={busy || !id} onClick={() => void handleCreate()}>
            {busy ? "Vytvářím…" : "Vytvořit workspace"}
          </Button>
        </div>
      </div>
    </div>
  );
}
