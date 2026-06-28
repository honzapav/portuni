// First-run gate. Two cases it handles:
//
// 1. Fresh install (no config.json) — shows an onboarding wizard with two
//    paths: connect to an existing Turso org, or start locally. Without
//    this, the sidecar silently falls back to a local SQLite DB and the
//    user has no idea why they aren't seeing their team's graph.
//
// 2. Remote configured but no token (config.json has libsql:// turso_url
//    but Keychain entry is missing) — shows the original token modal.
//    Saving stores the token in Keychain via `set_turso_token`, restarts
//    the sidecar so it picks up the new env, and reloads the page so
//    apiFetch's ready gate re-polls cleanly.
//
// In a plain browser (Vite dev / static preview) this short-circuits to
// "ready" — the dev proxy handles auth and there is no Keychain.

import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "../lib/backend-url";

type TursoStatus = {
  config_exists: boolean;
  url_set: boolean;
  token_set: boolean;
  url: string | null;
};

type GateStatus = "checking" | "fresh-install" | "needs-token" | "ready";

type Props = {
  children: ReactNode;
};

export default function TursoSetupGate({ children }: Props) {
  const [status, setStatus] = useState<GateStatus>("checking");
  const [tursoUrl, setTursoUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setStatus("ready");
      return;
    }
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<TursoStatus>("get_turso_status");
        if (cancelled) return;
        if (!result.config_exists) {
          setStatus("fresh-install");
          return;
        }
        const remote = result.url?.startsWith("libsql://") ?? false;
        if (result.url_set && !result.token_set && remote) {
          setTursoUrl(result.url);
          setStatus("needs-token");
        } else {
          setStatus("ready");
        }
      } catch (e) {
        // get_turso_status should never fail in normal use. If it does,
        // unblock the app — the apiFetch path will surface the real error.
        console.error("get_turso_status failed:", e);
        if (!cancelled) setStatus("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSaveToken() {
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Token nesmí být prázdný.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_turso_token", { token: trimmed });
      await invoke("restart_sidecar");
      // Reload so backend-url.ts's ready gate, fetchGraph caches, etc.
      // start from a clean slate against the freshly-spawned sidecar.
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  async function handleConnectOrg() {
    const trimmedUrl = urlInput.trim();
    const trimmedToken = token.trim();
    if (!trimmedUrl) {
      setError("Turso URL nesmí být prázdné.");
      return;
    }
    if (!trimmedUrl.startsWith("libsql://")) {
      setError("URL musí začínat libsql://");
      return;
    }
    if (!trimmedToken) {
      setError("Auth token nesmí být prázdný.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_config", { tursoUrl: trimmedUrl });
      await invoke("set_turso_token", { token: trimmedToken });
      await invoke("restart_sidecar");
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  async function handleStartLocal() {
    setSaving(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_config", { tursoUrl: null });
      // No restart needed — sidecar is already running in local fallback
      // mode (that's what happens when config.json is missing). Just
      // commit the marker so the wizard stops showing.
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  if (status === "checking") return null;
  if (status === "ready") return <>{children}</>;

  if (status === "fresh-install") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
        <div className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl">
          <div className="border-b border-[var(--color-border)] px-5 py-3">
            <div className="text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
              Vítej v Portuni
            </div>
            <div className="mt-1 text-[12px] text-[var(--color-text-dim)]">
              Jak chceš začít?
            </div>
          </div>

          <div className="flex flex-col gap-4 px-5 py-4">
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="text-[13px] font-medium text-[var(--color-text)]">
                Připojit se k existující organizaci
              </div>
              <div className="mt-1 text-[12px] text-[var(--color-text-dim)]">
                Sdílený graf na Turso — pro tým, kde už někdo Portuni má.
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="libsql://your-db.turso.io"
                  spellCheck={false}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-text-dim)]"
                />
                <textarea
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Auth token (eyJhbGciOiJFZERTQSIs...)"
                  spellCheck={false}
                  rows={3}
                  className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-text-dim)]"
                />
                <button
                  disabled={saving}
                  onClick={() => void handleConnectOrg()}
                  className="self-end rounded bg-[var(--color-text)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "Připojuji…" : "Připojit"}
                </button>
              </div>
            </div>

            <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="text-[13px] font-medium text-[var(--color-text)]">
                Začít lokálně
              </div>
              <div className="mt-1 text-[12px] text-[var(--color-text-dim)]">
                Jen na tomto Macu, žádný účet. Vhodné pro vyzkoušení.
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  disabled={saving}
                  onClick={() => void handleStartLocal()}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Pokračovat lokálně
                </button>
              </div>
            </div>

            {error && (
              <div className="text-[12px] text-red-500">{error}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl">
        <div className="border-b border-[var(--color-border)] px-5 py-3">
          <div className="text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
            Připojení k Turso
          </div>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="text-[13px] text-[var(--color-text-dim)]">
            Portuni se připojuje ke vzdálené Turso databázi. Vlož auth token,
            uložíme ho do macOS Keychain a restartujeme backend.
          </div>
          {tursoUrl && (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[12px] text-[var(--color-text-dim)]">
              {tursoUrl}
            </div>
          )}
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="eyJhbGciOiJFZERTQSIs..."
            spellCheck={false}
            autoFocus
            rows={4}
            className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-text-dim)]"
          />
          {error && (
            <div className="text-[12px] text-red-500">{error}</div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          <button
            disabled={saving || token.trim().length === 0}
            onClick={() => void handleSaveToken()}
            className="rounded bg-[var(--color-text)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Ukládám…" : "Uložit a restartovat"}
          </button>
        </div>
      </div>
    </div>
  );
}
