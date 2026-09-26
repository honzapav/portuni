// Settings > Workspaces -- desktop-only tab: list every configured
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

import { displayError } from "../errors";
import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { useFormAction, useListLoad, usePendingIds } from "../lib/use-list-load";
import { ErrorActionAlert } from "./ErrorActionAlert";

const fetchWorkspaces = async () => ({ workspaces: await listWorkspaces() });

const DATA_MODE_TEXT: Record<
  WorkspaceInfo["data_mode"],
  (t: TFunction<"settings">) => string
> = {
  central: (t) => t(($) => $.workspaces.list.kind_team, { ns: "settings" }),
  local: (t) => t(($) => $.workspaces.list.kind_personal, { ns: "settings" }),
};

export default function WorkspacesSection() {
  const { t } = useTranslation("settings");
  const { state, load: loadList, mountedRef } = useListLoad(fetchWorkspaces);
  const [rowError, setRowError] = useState<string | null>(null);
  const { pending, withPending } = usePendingIds(mountedRef);
  // Inline two-step delete confirm: window.confirm is a silent no-op in the
  // Tauri webview on macOS (see DetailPane.tsx). Holds the id of the row whose
  // delete is awaiting confirmation; the row swaps its Delete button for the
  // warning + Really delete/Cancel while set.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Whenever the list reloads, an armed "Really delete" must not survive
    // -- the row set it belonged to may have just changed underneath it.
    setConfirmDeleteId(null);
    await loadList();
  }, [loadList]);

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

  async function handleOpen(id: string) {
    // Row action: an armed delete confirm elsewhere in the table must not
    // survive an unrelated action.
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(id, () => openWorkspaceWindow(id));
      // Opens/focuses its own window -- nothing left to do here.
    } catch (e) {
      setRowError(displayError(e));
    }
  }

  async function handleRestart(id: string) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(id, () => restartWorkspace(id));
      await reloadAfterMutation();
    } catch (e) {
      setRowError(displayError(e));
    }
  }

  async function handleToggleEnabled(id: string, enabled: boolean) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(id, () => setWorkspaceEnabled(id, enabled));
      await reloadAfterMutation();
    } catch (e) {
      setRowError(displayError(e));
    }
  }

  async function handleDelete(w: WorkspaceInfo) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(w.id, () => deleteWorkspace(w.id));
      await reloadAfterMutation();
    } catch (e) {
      setRowError(displayError(e));
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          {t(($) => $.workspaces.list.title)}
        </div>
        <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          {t(($) => $.workspaces.list.intro)}
        </p>

        {rowError && (
          <ErrorActionAlert
            message={rowError}
            actionLabel={t(($) => $.workspaces.list.dismiss_error)}
            onAction={() => setRowError(null)}
            className="mb-4"
          />
        )}

        {state.kind === "loading" && (
          <div className="text-[13px] text-[var(--color-text-dim)]">
            {t(($) => $.workspaces.list.loading)}
          </div>
        )}

        {state.kind === "error" && (
          <ErrorActionAlert
            message={state.reason}
            actionLabel={t(($) => $.workspaces.list.retry)}
            onAction={() => void load()}
          />
        )}

        {state.kind === "ok" && state.workspaces.length === 0 && (
          <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
            {t(($) => $.workspaces.list.empty)}
          </div>
        )}

        {state.kind === "ok" && state.workspaces.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                  <th className="pb-2 pr-4 font-semibold">{t(($) => $.workspaces.list.col_name)}</th>
                  <th className="pb-2 pr-4 font-semibold">{t(($) => $.workspaces.list.col_id)}</th>
                  <th className="pb-2 pr-4 font-semibold">{t(($) => $.workspaces.list.col_kind)}</th>
                  <th className="pb-2 pr-4 font-semibold">{t(($) => $.workspaces.list.col_port)}</th>
                  <th className="pb-2 pr-4 font-semibold">{t(($) => $.workspaces.list.col_status)}</th>
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
                              {t(($) => $.workspaces.list.badge_active)}
                            </Badge>
                          )}
                          {w.window_open && (
                            <Badge
                              variant="outline"
                              className="font-mono uppercase tracking-wide text-[var(--color-text-dim)]"
                            >
                              {t(($) => $.workspaces.list.badge_window_open)}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.id}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {DATA_MODE_TEXT[w.data_mode](t)}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                        {w.mcp_port ?? "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {w.running ? (
                          <span className="text-green-400">
                            {t(($) => $.workspaces.list.status_running)}
                          </span>
                        ) : w.deferred ? (
                          <span className="text-[var(--color-text-dim)]">
                            {t(($) => $.workspaces.list.status_awaiting_sign_in)}
                          </span>
                        ) : w.enabled ? (
                          <span className="text-[var(--color-text-dim)]">
                            {t(($) => $.workspaces.list.status_stopped)}
                          </span>
                        ) : (
                          <span className="text-[var(--color-text-dim)]">
                            {t(($) => $.workspaces.list.status_disabled)}
                          </span>
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
                            {w.window_open
                              ? t(($) => $.workspaces.list.switch_to_window)
                              : t(($) => $.workspaces.list.open)}
                          </Button>
                          {canRestart && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => void handleRestart(w.id)}
                            >
                              {t(($) => $.workspaces.list.restart)}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant={w.enabled ? "destructive" : "outline"}
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleToggleEnabled(w.id, !w.enabled)}
                          >
                            {w.enabled
                              ? t(($) => $.workspaces.list.disable)
                              : t(($) => $.workspaces.list.enable)}
                          </Button>
                          {confirmDeleteId === w.id ? (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => void handleDelete(w)}
                            >
                              {t(($) => $.workspaces.list.confirm_delete)}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmDeleteId(w.id)}
                            >
                              {t(($) => $.workspaces.list.delete)}
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
                              {t(($) => $.workspaces.list.cancel_delete)}
                            </Button>
                          )}
                        </div>
                        {confirmDeleteId === w.id && (
                          <div className="mt-1.5 max-w-[420px] text-[11px] leading-snug text-[var(--color-text-dim)]">
                            {t(($) => $.workspaces.list.delete_warning)}
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
  const { t } = useTranslation("settings");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"local" | "central">("local");
  const [tursoUrl, setTursoUrl] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceRootTouched, setWorkspaceRootTouched] = useState(false);
  const { busy, error, setError, run, mountedRef } = useFormAction();
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
      setError(t(($) => $.workspaces.create.invalid_name));
      return;
    }
    setCreatedHint(false);
    await run(async () => {
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
    });
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.workspaces.create.title)}
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="ws-create-name" className={FIELD_LABEL}>
            {t(($) => $.workspaces.create.name_label)}
          </Label>
          <Input
            id="ws-create-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder={t(($) => $.workspaces.create.name_placeholder)}
          />
          <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
            {id ? (
              <Trans
                t={t}
                ns="settings"
                i18nKey={($) => $.workspaces.create.id_hint}
                values={{ id }}
                components={{ mono: <span className="font-mono" /> }}
              />
            ) : (
              <Trans
                t={t}
                ns="settings"
                i18nKey={($) => $.workspaces.create.id_hint_invalid}
                components={{ mono: <span className="font-mono" /> }}
              />
            )}
          </div>
        </div>

        <div>
          <Label className={FIELD_LABEL}>
            {t(($) => $.workspaces.create.kind_label)}
          </Label>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as typeof mode)}
            disabled={busy}
            className="flex gap-4"
            aria-label={t(($) => $.workspaces.create.kind_aria_label)}
          >
            <Label className="gap-1.5 font-normal text-[13px] text-[var(--color-text-muted)]">
              <RadioGroupItem value="local" />
              {t(($) => $.workspaces.create.kind_personal)}
            </Label>
            <Label className="gap-1.5 font-normal text-[13px] text-[var(--color-text-muted)]">
              <RadioGroupItem value="central" />
              {t(($) => $.workspaces.create.kind_team)}
            </Label>
          </RadioGroup>
        </div>

        {mode === "local" && (
          <div>
            <Label htmlFor="ws-create-turso-url" className={FIELD_LABEL}>
              {t(($) => $.workspaces.create.turso_url_label)}
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
              {t(($) => $.workspaces.create.turso_url_hint)}
            </div>
          </div>
        )}

        {mode === "central" && (
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="ws-create-server-url" className={FIELD_LABEL}>
                {t(($) => $.workspaces.create.server_url_label)}
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
                {t(($) => $.workspaces.create.google_client_id_label)}
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
                {t(($) => $.workspaces.create.google_client_secret_label)}
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
            {t(($) => $.workspaces.create.workspace_root_label)}
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
              {t(($) => $.workspaces.create.created_hint)}
            </AlertDescription>
          </Alert>
        )}

        <div>
          <Button type="button" disabled={busy || !id} onClick={() => void handleCreate()}>
            {busy
              ? t(($) => $.workspaces.create.submit_busy)
              : t(($) => $.workspaces.create.submit)}
          </Button>
        </div>
      </div>
    </div>
  );
}
