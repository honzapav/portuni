// Account settings section — Google login, user info, device tokens.
//
// States:
//   loading → auth_status
//   not-configured → info about config.json
//   configured + logged-out → "Přihlásit přes Google" button
//   logged-in → user card (avatar/name/email/role/groups) + device token table

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, RefreshCw, Trash2 } from "lucide-react";
import {
  isTauri,
  authStatus,
  googleLogin,
  authLogout,
  centralFetch,
  type AuthStatus,
  type UserInfo,
  type DeviceToken,
  type NewDeviceToken,
} from "../lib/central";

type SectionState =
  | { kind: "loading" }
  | { kind: "not-desktop" }
  | { kind: "not-configured" }
  | { kind: "logged-out" }
  | { kind: "logged-in"; user: UserInfo };

export default function AccountSection() {
  const [state, setState] = useState<SectionState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "not-desktop" });
      return;
    }
    try {
      const s: AuthStatus = await authStatus();
      if (!s.configured) {
        setState({ kind: "not-configured" });
      } else if (!s.logged_in || !s.user) {
        setState({ kind: "logged-out" });
      } else {
        // Eager: try to enrich with /me; fall back to JWT claims from auth_status.
        let enriched = s.user;
        try {
          const me = await centralFetch<UserInfo>("GET", "/me");
          enriched = me;
        } catch {
          // /me unreachable or token issue — use claims as fallback, don't block
        }
        setState({ kind: "logged-in", user: enriched });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState({ kind: "logged-out" });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function handleLogin() {
    setError(null);
    setBusy(true);
    try {
      const user = await googleLogin();
      // Refresh from /me after login to get full profile
      let enriched = user;
      try {
        const me = await centralFetch<UserInfo>("GET", "/me");
        enriched = me;
      } catch {
        /* use returned user claims */
      }
      setState({ kind: "logged-in", user: enriched });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setError(null);
    setBusy(true);
    try {
      await authLogout();
      setState({ kind: "logged-out" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Účet
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        Přihlášení k centrálnímu Portuni serveru přes Google OAuth.
      </p>

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          Zjišťuji stav přihlášení…
        </div>
      )}

      {state.kind === "not-desktop" && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] text-[var(--color-text-muted)]">
          Dostupné jen v desktop aplikaci.
        </div>
      )}

      {state.kind === "not-configured" && (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            <div className="mb-1 font-medium text-[var(--color-text)]">
              Centrální server není nakonfigurován.
            </div>
            Doplň <code className="font-mono text-[12px]">server_url</code> a{" "}
            <code className="font-mono text-[12px]">google_client_id</code> do konfiguračního souboru:
            <code className="mt-2 block rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)]">
              ~/Library/Application Support/ooo.workflow.portuni/config.json
            </code>
          </div>
        </div>
      )}

      {state.kind === "logged-out" && (
        <div className="flex flex-col gap-3">
          {error && (
            <ErrorBox message={error} onDismiss={() => setError(null)} />
          )}
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleLogin()}
              className="flex items-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <GoogleIcon />
              )}
              {busy ? "Přihlašuji…" : "Přihlásit přes Google"}
            </button>
          </div>
        </div>
      )}

      {state.kind === "logged-in" && (
        <div className="flex flex-col gap-6">
          {error && (
            <ErrorBox message={error} onDismiss={() => setError(null)} />
          )}
          <UserCard
            user={state.user}
            busy={busy}
            onLogout={() => void handleLogout()}
          />
          <DeviceTokensTable />
        </div>
      )}
    </section>
  );
}

// --- User card ---------------------------------------------------------------

function UserCard({
  user,
  busy,
  onLogout,
}: {
  user: UserInfo;
  busy: boolean;
  onLogout: () => void;
}) {
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex items-start gap-4">
      {/* Avatar */}
      <div className="shrink-0">
        {user.avatar_url ? (
          <img
            src={user.avatar_url}
            alt={user.name}
            className="h-12 w-12 rounded-full border border-[var(--color-border)]"
          />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-accent-soft)] text-[16px] font-semibold text-[var(--color-accent)]">
            {initials}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-[var(--color-text)]">
          {user.name}
        </div>
        <div className="truncate text-[13px] text-[var(--color-text-muted)]">
          {user.email}
        </div>
        {user.global_scope && (
          <div className="mt-1 text-[12px] text-[var(--color-text-dim)]">
            Role:{" "}
            <span className="font-mono text-[var(--color-text-muted)]">
              {user.global_scope}
            </span>
          </div>
        )}
        {user.groups && user.groups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {user.groups.map((g) => (
              <span
                key={g}
                className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-dim)]"
              >
                {g}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Logout */}
      <button
        type="button"
        disabled={busy}
        onClick={onLogout}
        className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "…" : "Odhlásit"}
      </button>
    </div>
  );
}

// --- Device tokens -----------------------------------------------------------

type TokensState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; tokens: DeviceToken[] };

type NewTokenState =
  | null
  | { kind: "input"; label: string; busy: boolean }
  | { kind: "created"; token: NewDeviceToken };

function DeviceTokensTable() {
  const [tokensState, setTokensState] = useState<TokensState>({ kind: "loading" });
  const [newToken, setNewToken] = useState<NewTokenState>(null);
  const [revoking, setRevoking] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTokens = useCallback(async () => {
    setTokensState({ kind: "loading" });
    try {
      const tokens = await centralFetch<DeviceToken[]>("GET", "/device-tokens");
      setTokensState({ kind: "ok", tokens });
    } catch (e) {
      setTokensState({
        kind: "error",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  async function handleCreateToken() {
    if (newToken?.kind !== "input") return;
    const label = newToken.label.trim();
    if (!label) return;
    setNewToken({ kind: "input", label, busy: true });
    try {
      const created = await centralFetch<NewDeviceToken>("POST", "/device-tokens", { label });
      setNewToken({ kind: "created", token: created });
      void loadTokens();
    } catch (e) {
      setNewToken({ kind: "input", label, busy: false });
      setTokensState({
        kind: "error",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleRevoke(id: string) {
    setRevoking((prev) => new Set([...prev, id]));
    try {
      await centralFetch("DELETE", `/device-tokens/${encodeURIComponent(id)}`);
      void loadTokens();
    } catch (e) {
      setTokensState({
        kind: "error",
        reason: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          Device tokeny
        </div>
        {newToken === null && (
          <button
            type="button"
            onClick={() => setNewToken({ kind: "input", label: "", busy: false })}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
          >
            Nový token
          </button>
        )}
      </div>

      {/* New token input form */}
      {newToken?.kind === "input" && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-3 py-2.5">
          <input
            autoFocus
            type="text"
            value={newToken.label}
            onChange={(e) =>
              setNewToken({ kind: "input", label: e.target.value, busy: newToken.busy })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateToken();
              if (e.key === "Escape") setNewToken(null);
            }}
            placeholder="Název tokenu (např. dev-laptop)"
            disabled={newToken.busy}
            className="flex-1 bg-transparent text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] disabled:opacity-50"
          />
          <button
            type="button"
            disabled={newToken.busy || !newToken.label.trim()}
            onClick={() => void handleCreateToken()}
            className="rounded-md border border-[var(--color-accent-dim)] px-3 py-1 text-[12.5px] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {newToken.busy ? "Vytvářím…" : "Vytvořit"}
          </button>
          <button
            type="button"
            disabled={newToken.busy}
            onClick={() => setNewToken(null)}
            className="rounded-md px-2 py-1 text-[12.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            Zrušit
          </button>
        </div>
      )}

      {/* Created token — show ONCE */}
      {newToken?.kind === "created" && (
        <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text)]">
            Token vytvořen
          </div>
          <p className="mb-2 text-[12px] leading-relaxed text-red-400">
            Token se zobrazuje jen jednou. Zkopíruj ho a ulož na bezpečné místo.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)]">
              {newToken.token.token}
            </code>
            <button
              type="button"
              onClick={() => void copyToken(newToken.token.token)}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
            >
              <Copy size={11} />
              {copied ? "Zkopírováno" : "Zkopírovat"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setNewToken(null)}
            className="mt-2 text-[12px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            Zavřít
          </button>
        </div>
      )}

      {tokensState.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          Načítám tokeny…
        </div>
      )}

      {tokensState.kind === "error" && (
        <ErrorBox
          message={tokensState.reason}
          onDismiss={() => void loadTokens()}
          dismissLabel="Zkusit znovu"
        />
      )}

      {tokensState.kind === "ok" && tokensState.tokens.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
          Zatím žádné device tokeny.
        </div>
      )}

      {tokensState.kind === "ok" && tokensState.tokens.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                <th className="pb-2 pr-4 font-semibold">Název</th>
                <th className="pb-2 pr-4 font-semibold">Vytvořen</th>
                <th className="pb-2 pr-4 font-semibold">Naposledy použit</th>
                <th className="pb-2 pr-4 font-semibold">Expirace</th>
                <th className="pb-2 pr-4 font-semibold">Stav</th>
                <th className="pb-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {tokensState.tokens.map((t) => {
                const revoked = t.revoked_at !== null;
                return (
                  <tr
                    key={t.id}
                    className={`border-b border-[var(--color-border)] last:border-b-0 ${revoked ? "opacity-40" : ""}`}
                  >
                    <td className="py-2 pr-4 font-medium text-[var(--color-text)]">
                      {t.label}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                      {fmtDate(t.created_at)}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                      {t.last_used_at ? fmtDate(t.last_used_at) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                      {t.expires_at ? fmtDate(t.expires_at) : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {revoked ? (
                        <span className="text-[var(--color-text-dim)]">revokován</span>
                      ) : (
                        <span className="text-green-400">aktivní</span>
                      )}
                    </td>
                    <td className="py-2">
                      {!revoked && (
                        <button
                          type="button"
                          disabled={revoking.has(t.id)}
                          onClick={() => {
                            if (
                              window.confirm
                                ? window.confirm(
                                    `Revokovat token „${t.label}"? Tuto akci nelze vrátit.`,
                                  )
                                : true
                            ) {
                              void handleRevoke(t.id);
                            }
                          }}
                          title="Revokovat token"
                          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-text-dim)] transition-colors hover:border-red-900/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Trash2 size={11} />
                          {revoking.has(t.id) ? "…" : "Revokovat"}
                        </button>
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
  );
}

// --- Helpers -----------------------------------------------------------------

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("cs-CZ", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

function ErrorBox({
  message,
  onDismiss,
  dismissLabel = "Zavřít",
}: {
  message: string;
  onDismiss: () => void;
  dismissLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
      <span className="min-w-0 break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-red-400 hover:text-red-200"
      >
        {dismissLabel}
      </button>
    </div>
  );
}

// Inline Google "G" icon — no external deps, no emoji.
function GoogleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
    >
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
