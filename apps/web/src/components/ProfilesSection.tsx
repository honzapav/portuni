// Nastavení > Profily — desktop-only tab: CLI spawn profiles registry
// (name + env vars to inject at spawn, optionally a custom command) plus
// the per-organization default assignment. Spec: "Spawn UX" -- profiles
// (docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md).
// Mirrors the shape of WorkspacesSection.tsx (list state machine + inline
// forms), driving Tauri commands instead of the REST API.
//
// Zero registered profiles keeps the whole feature invisible elsewhere in
// the app (the per-spawn picker only renders when >=2 profiles exist) --
// this section is the only place a profile is ever created.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createProfile,
  deleteProfile,
  listProfiles,
  notifyProfilesChanged,
  setDefaultProfileForOrg,
  updateProfile,
  type ProfileInfo,
  type ProfilesData,
} from "../lib/profiles";
import { slugify } from "../lib/workspaces";
import { fetchGraph } from "../api";
import type { GraphNode } from "../types";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; data: ProfilesData };

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

const DELETE_CONFIRM_MESSAGE =
  "Profil se smaže z registru a přestane se nabízet při spouštění terminálu. Výchozí volby organizací, které na něj mířily, se zruší.";

export default function ProfilesSection() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [orgs, setOrgs] = useState<GraphNode[]>([]);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    setConfirmDeleteId(null);
    setState({ kind: "loading" });
    try {
      const data = await listProfiles();
      if (mountedRef.current) setState({ kind: "ok", data });
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

  const reloadAfterMutation = useCallback(async () => {
    await load();
    notifyProfilesChanged();
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

  async function handleDelete(p: ProfileInfo) {
    setConfirmDeleteId(null);
    setRowError(null);
    try {
      await withPending(p.id, () => deleteProfile(p.id));
      await reloadAfterMutation();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSetDefault(orgId: string, profileId: string) {
    setRowError(null);
    try {
      await withPending(orgId, () => setDefaultProfileForOrg(orgId, profileId || null));
      await reloadAfterMutation();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  const profiles = state.kind === "ok" ? state.data.profiles : [];
  const defaultByOrg = state.kind === "ok" ? state.data.default_by_org : {};

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          Profily
        </div>
        <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Profil popisuje, co se má vložit do prostředí terminálu při
          spuštění agenta — typicky{" "}
          <code className="font-mono">CLAUDE_CONFIG_DIR=…</code>, volitelně i
          vlastní příkaz. Portuni nijak nedetekuje ani neparsuje tvůj vlastní
          mechanismus profilů (aliasy, rc soubory) — jen nastaví proměnné
          prostředí, než se shell spustí. Bez registrovaného profilu zůstává
          tahle funkce v appce neviditelná — terminál se spouští se zděděným
          prostředím jako dřív.
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
          <div className="text-[13px] text-[var(--color-text-dim)]">Načítám profily…</div>
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

        {state.kind === "ok" && profiles.length === 0 && (
          <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
            Zatím žádné profily.
          </div>
        )}

        {state.kind === "ok" && profiles.length > 0 && (
          <div className="flex flex-col gap-2">
            {profiles.map((p) => (
              <ProfileRow
                key={p.id}
                profile={p}
                busy={pending.has(p.id)}
                editing={editingId === p.id}
                onEdit={() => setEditingId(p.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  void reloadAfterMutation();
                }}
                onError={setRowError}
                confirmDelete={confirmDeleteId === p.id}
                onAskDelete={() => setConfirmDeleteId(p.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onDelete={() => void handleDelete(p)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateProfileForm
        existingIds={profiles.map((p) => p.id)}
        onCreated={() => void reloadAfterMutation()}
      />

      {state.kind === "ok" && profiles.length > 0 && orgs.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
            Výchozí profil podle organizace
          </div>
          <p className="mb-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            Při otevření terminálu z uzlu se jako výchozí nabídne profil
            nastavený pro jeho organizaci — výběr se dá při spuštění změnit,
            pokud je profilů víc.
          </p>
          <div className="flex flex-col gap-2">
            {orgs.map((org) => (
              <div key={org.id} className="flex items-center justify-between gap-3">
                <span className="text-[13.5px] text-[var(--color-text)]">{org.name}</span>
                <select
                  value={defaultByOrg[org.id] ?? ""}
                  disabled={pending.has(org.id)}
                  onChange={(e) => void handleSetDefault(org.id, e.target.value)}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
                >
                  <option value="">(žádný)</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// --- Profile row (view + inline edit) --------------------------------------

function ProfileRow({
  profile,
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
  profile: ProfileInfo;
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
  const [label, setLabel] = useState(profile.label);
  const [envText, setEnvText] = useState(envToText(profile.env));
  const [command, setCommand] = useState(profile.command ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setLabel(profile.label);
      setEnvText(envToText(profile.env));
      setCommand(profile.command ?? "");
    }
  }, [editing, profile]);

  async function handleSave() {
    if (!label.trim()) {
      onError("Název profilu je povinný.");
      return;
    }
    setSaving(true);
    try {
      await updateProfile({
        id: profile.id,
        label: label.trim(),
        env: parseEnvText(envText),
        command: command.trim() || undefined,
      });
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
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={saving}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Proměnné prostředí (jedna na řádek, KLÍČ=hodnota)
            </label>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              disabled={saving}
              rows={3}
              spellCheck={false}
              placeholder="CLAUDE_CONFIG_DIR=~/.claude-work"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Vlastní příkaz (volitelné — nahradí příkaz agenta z Obecné)
            </label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={saving}
              spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
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
            <span className="font-medium text-[var(--color-text)]">{profile.label}</span>
            <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{profile.id}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--color-text-dim)]">
            {Object.keys(profile.env).length > 0
              ? Object.entries(profile.env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join("  ")
              : profile.command
                ? "(bez env)"
                : "(bez env, bez vlastního příkazu)"}
            {profile.command ? `  · příkaz: ${profile.command}` : ""}
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

// --- Create profile form -----------------------------------------------------

function CreateProfileForm({
  existingIds,
  onCreated,
}: {
  existingIds: string[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [envText, setEnvText] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const id = slugify(name);
  const idTaken = id !== "" && existingIds.includes(id);

  function reset() {
    setName("");
    setEnvText("");
    setCommand("");
  }

  async function handleCreate() {
    if (!id) {
      setError("Zadej platné jméno profilu.");
      return;
    }
    if (idTaken) {
      setError(`Profil '${id}' už existuje.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createProfile({
        id,
        label: name.trim(),
        env: parseEnvText(envText),
        command: command.trim() || undefined,
      });
      reset();
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
        Přidat profil
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
            placeholder="Např. Práce"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
          />
          <div className="mt-1 text-[11.5px] text-[var(--color-text-dim)]">
            ID: <span className="font-mono">{id || "(neplatné)"}</span>
            {idTaken ? " — už existuje" : ""} – po vytvoření už nejde změnit.
          </div>
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
            placeholder="CLAUDE_CONFIG_DIR=~/.claude-work"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
          />
        </div>

        <div>
          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Vlastní příkaz (volitelné — nahradí příkaz agenta z Obecné)
          </label>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
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

        <div>
          <button
            type="button"
            disabled={busy || !id || idTaken}
            onClick={() => void handleCreate()}
            className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Vytvářím…" : "Vytvořit profil"}
          </button>
        </div>
      </div>
    </div>
  );
}
