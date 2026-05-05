// First-run gate. In Tauri mode, queries the Rust host for whether
// turso_url is set + whether a token exists in the OS keychain. If the
// configured URL is remote (libsql://) but no token exists, blocks the
// app with a modal asking the user to paste one. Saving stores the
// token in Keychain via `set_turso_token`, restarts the sidecar so
// it picks up the new env, and reloads the page so the apiFetch ready
// gate re-polls cleanly.
//
// In a plain browser (Vite dev / static preview) this short-circuits to
// "ready" — the dev proxy handles auth and there is no Keychain.

import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "../lib/backend-url";

type TursoStatus = {
  url_set: boolean;
  token_set: boolean;
  url: string | null;
};

type GateStatus = "checking" | "needs-token" | "ready";

type Props = {
  children: ReactNode;
};

export default function TursoSetupGate({ children }: Props) {
  const [status, setStatus] = useState<GateStatus>("checking");
  const [tursoUrl, setTursoUrl] = useState<string | null>(null);
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

  async function handleSave() {
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

  if (status === "checking") return null;
  if (status === "ready") return <>{children}</>;

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
            onClick={() => void handleSave()}
            className="rounded bg-[var(--color-text)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Ukládám…" : "Uložit a restartovat"}
          </button>
        </div>
      </div>
    </div>
  );
}
