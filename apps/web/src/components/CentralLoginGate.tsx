// Central-mode login gate. In central data_mode the whole graph is served by
// the remote server behind a per-user session JWT — so before login there is
// literally nothing to render. Without this gate the app tries to load the
// graph, fails with "not logged in (no session JWT)", and dead-ends on an
// error card with no way to reach Settings → Účet. A fresh teammate would be
// stuck. This gate short-circuits that: central + logged-out → a login screen.
//
// Local mode (or a plain browser) passes straight through — no gating.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { isTauri, getDataMode, authStatus, googleLogin } from "../lib/central";

type GateStatus =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "not-configured" }
  | { kind: "login" }
  | { kind: "first-steps" };

export default function CentralLoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!isTauri()) {
      setStatus({ kind: "ready" });
      return;
    }
    try {
      const dm = await getDataMode();
      if (dm.mode !== "central") {
        setStatus({ kind: "ready" });
        return;
      }
      const s = await authStatus();
      if (!s.configured) {
        setStatus({ kind: "not-configured" });
      } else if (s.logged_in) {
        // First login on this install: show the one-time guidance that
        // mirror folders appear only after a terminal is opened on a node.
        if (localStorage.getItem("portuni.first-steps-pending") === "1") {
          setStatus({ kind: "first-steps" });
        } else {
          setStatus({ kind: "ready" });
        }
      } else {
        setStatus({ kind: "login" });
      }
    } catch (e) {
      // If the gate check itself fails, don't trap the user — fall through to
      // the app, which surfaces its own error path.
      console.error("CentralLoginGate check failed:", e);
      setStatus({ kind: "ready" });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function handleLogin() {
    setError(null);
    setBusy(true);
    try {
      await googleLogin();
      localStorage.setItem("portuni.first-steps-pending", "1");
      // Reload so the graph fetch, caches and auth-status re-run cleanly with
      // the freshly stored session JWT.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function handleFirstStepsDone() {
    localStorage.removeItem("portuni.first-steps-pending");
    setStatus({ kind: "ready" });
  }

  if (status.kind === "checking") return null;
  if (status.kind === "ready") return <>{children}</>;

  if (status.kind === "first-steps") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)] p-6">
        <div className="flex w-full max-w-[480px] flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-8 py-8 shadow-2xl">
          <div className="text-[17px] font-semibold tracking-tight text-[var(--color-text)]">
            Přihlášení proběhlo
          </div>
          <div className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            Sdílený graf uvidíš hned – co je v něm vidět, řídí oprávnění na
            serveru.
          </div>
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Pracovní složky na Macu vznikají po uzlech: otevři uzel v grafu a
            klikni na <span className="font-medium text-[var(--color-text)]">Otevřít terminál v Portuni</span>.
            Portuni založí lokální složku uzlu, spustí v ní agenta a stáhne
            soubory. Bez tohoto kroku zůstává obsah jen na serveru.
          </div>
          <button
            type="button"
            onClick={handleFirstStepsDone}
            className="self-end rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-5 py-2.5 text-[14px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]"
          >
            Rozumím, otevřít Portuni
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)] p-6">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-8 py-10 text-center shadow-2xl">
        <div className="text-[17px] font-semibold tracking-tight text-[var(--color-text)]">
          Portuni
        </div>

        {status.kind === "not-configured" ? (
          <div className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Centrální režim je aktivní, ale chybí konfigurace. Doplň{" "}
            <code className="font-mono text-[12px]">server_url</code> a{" "}
            <code className="font-mono text-[12px]">google_client_id</code> do{" "}
            <code className="font-mono text-[12px]">config.json</code>.
          </div>
        ) : (
          <>
            <div className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
              Pro přístup ke sdílenému grafu se přihlas přes Google.
            </div>
            {error && (
              <div className="w-full break-words rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-left text-[12.5px] text-red-300">
                {error}
              </div>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleLogin()}
              className="flex items-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-5 py-2.5 text-[14px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <GoogleIcon />
              {busy ? "Přihlašuji…" : "Přihlásit přes Google"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Inline Google "G" icon — no external deps, no emoji.
function GoogleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
