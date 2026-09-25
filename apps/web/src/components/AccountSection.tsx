// Account settings section — Google login, user info, device tokens.
//
// States:
//   loading → auth_status
//   not-configured → info about config.json
//   configured + logged-out → "Sign in with Google" button
//   logged-in → user card (avatar/name/email/role/groups) + device token table

import { displayError } from "../errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Copy, RefreshCw, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyText } from "../lib/clipboard";
import {
  isTauri,
  authStatus,
  googleLogin,
  authLogout,
  centralFetch,
  useDataMode,
  type AuthStatus,
  type UserInfo,
  type DeviceToken,
  type NewDeviceToken,
  type OAuthGrant,
} from "../lib/central";
import { formatDate } from "../lib/format";
import { useLocale } from "../lib/use-locale";

type SectionState =
  | { kind: "loading" }
  | { kind: "not-desktop" }
  | { kind: "not-configured" }
  | { kind: "logged-out" }
  | { kind: "logged-in"; user: UserInfo };

export default function AccountSection() {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<SectionState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dataMode = useDataMode();

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
      setError(displayError(e));
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
      setError(displayError(e));
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
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.account.title)}
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {t(($) => $.account.intro)}
      </p>
      {dataMode && (
        <div className="mb-4 flex items-center gap-2 text-[13px] text-[var(--color-text-dim)]">
          <span>{t(($) => $.account.workspace_kind.label)}</span>
          {dataMode.mode === "central" ? (
            <span className="font-mono text-[var(--color-text-muted)]">
              {t(($) => $.account.workspace_kind.team)}
              {dataMode.server_url ? (
                <span className="ml-1 text-[var(--color-text-dim)]">
                  ({dataMode.server_url})
                </span>
              ) : null}
            </span>
          ) : (
            <span className="font-mono text-[var(--color-text-muted)]">
              {t(($) => $.account.workspace_kind.personal)}
            </span>
          )}
        </div>
      )}

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.account.loading)}
        </div>
      )}

      {state.kind === "not-desktop" && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] text-[var(--color-text-muted)]">
          {t(($) => $.account.not_desktop)}
        </div>
      )}

      {state.kind === "not-configured" && (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            <div className="mb-1 font-medium text-[var(--color-text)]">
              {t(($) => $.account.not_configured.title)}
            </div>
            <Trans
              t={t}
              ns="settings"
              i18nKey={($) => $.account.not_configured.body}
              components={{ code: <code className="font-mono text-[12px]" /> }}
            />
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
            <Button type="button" disabled={busy} onClick={() => void handleLogin()}>
              {busy ? <RefreshCw className="animate-spin" /> : <GoogleIcon />}
              {busy ? t(($) => $.account.sign_in.busy) : t(($) => $.account.sign_in.button)}
            </Button>
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
          <ConnectedAppsTable />
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
  const { t } = useTranslation("settings");
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
            {t(($) => $.account.user.role)}{" "}
            <span className="font-mono text-[var(--color-text-muted)]">
              {user.global_scope}
            </span>
          </div>
        )}
        {user.groups && user.groups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {user.groups.map((g) => (
              <Badge
                key={g}
                variant="outline"
                className="bg-[var(--color-bg)] font-mono text-[var(--color-text-dim)]"
              >
                {g}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Logout */}
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={onLogout}
        className="shrink-0"
      >
        {busy ? "…" : t(($) => $.account.user.sign_out)}
      </Button>
    </div>
  );
}

// --- Connected apps (chat clients with an OAuth grant) ------------------------

type GrantsState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; grants: OAuthGrant[] };

function ConnectedAppsTable() {
  const { t } = useTranslation("settings");
  const locale = useLocale();
  const [state, setState] = useState<GrantsState>({ kind: "loading" });
  const [revoking, setRevoking] = useState<Set<string>>(() => new Set());

  const loadGrants = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const grants = await centralFetch<OAuthGrant[]>("GET", "/auth/oauth-grants");
      setState({ kind: "ok", grants });
    } catch (e) {
      setState({ kind: "error", reason: displayError(e) });
    }
  }, []);

  useEffect(() => {
    void loadGrants();
  }, [loadGrants]);

  async function handleRevoke(id: string) {
    setRevoking((prev) => new Set([...prev, id]));
    try {
      await centralFetch("DELETE", `/auth/oauth-grants/${encodeURIComponent(id)}`);
      void loadGrants();
    } catch (e) {
      setState({ kind: "error", reason: displayError(e) });
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div>
      <div className="mb-3 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.account.connected_apps.title)}
      </div>

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.account.connected_apps.loading)}
        </div>
      )}

      {state.kind === "error" && (
        <ErrorBox
          message={state.reason}
          onDismiss={() => void loadGrants()}
          dismissLabel={t(($) => $.account.connected_apps.retry)}
        />
      )}

      {state.kind === "ok" && state.grants.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.account.connected_apps.empty)}
        </div>
      )}

      {state.kind === "ok" && state.grants.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.account.connected_apps.columns.app)}</th>
                <th className="pb-2 pr-4 font-semibold">
                  {t(($) => $.account.connected_apps.columns.connected)}
                </th>
                <th className="pb-2 pr-4 font-semibold">
                  {t(($) => $.account.connected_apps.columns.last_used)}
                </th>
                <th className="pb-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {state.grants.map((g) => (
                <tr key={g.id} className="border-b border-[var(--color-border)] last:border-b-0">
                  <td className="py-2 pr-4 font-medium text-[var(--color-text)]">
                    {g.client_name}
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                    {formatDate(locale, g.created_at)}
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                    {g.last_used_at ? formatDate(locale, g.last_used_at) : "—"}
                  </td>
                  <td className="py-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={revoking.has(g.id)}
                      onClick={() => {
                        if (
                          window.confirm
                            ? window.confirm(
                                t(($) => $.account.connected_apps.disconnect.confirm, {
                                  appName: g.client_name,
                                }),
                              )
                            : true
                        ) {
                          void handleRevoke(g.id);
                        }
                      }}
                      title={t(($) => $.account.connected_apps.disconnect.title)}
                    >
                      <Trash2 />
                      {revoking.has(g.id) ? "…" : t(($) => $.account.connected_apps.disconnect.button)}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  const { t } = useTranslation("settings");
  const locale = useLocale();
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
        reason: displayError(e),
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
        reason: displayError(e),
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
        reason: displayError(e),
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
      await copyText(token);
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
          {t(($) => $.account.tokens.title)}
        </div>
        {newToken === null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setNewToken({ kind: "input", label: "", busy: false })}
          >
            {t(($) => $.account.tokens.new_token)}
          </Button>
        )}
      </div>

      {/* New token input form */}
      {newToken?.kind === "input" && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-3 py-2.5">
          <Input
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
            placeholder={t(($) => $.account.tokens.label_placeholder)}
            disabled={newToken.busy}
            className="flex-1"
          />
          <Button
            type="button"
            size="sm"
            disabled={newToken.busy || !newToken.label.trim()}
            onClick={() => void handleCreateToken()}
          >
            {newToken.busy ? t(($) => $.account.tokens.creating) : t(($) => $.account.tokens.create)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={newToken.busy}
            onClick={() => setNewToken(null)}
            className="text-muted-foreground"
          >
            {t(($) => $.account.tokens.cancel)}
          </Button>
        </div>
      )}

      {/* Created token — show ONCE */}
      {newToken?.kind === "created" && (
        <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text)]">
            {t(($) => $.account.tokens.created.title)}
          </div>
          <p className="mb-2 text-[12px] leading-relaxed text-red-400">
            {t(($) => $.account.tokens.created.warning)}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)]">
              {newToken.token.token}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyToken(newToken.token.token)}
            >
              <Copy />
              {copied ? t(($) => $.account.tokens.created.copied) : t(($) => $.account.tokens.created.copy)}
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setNewToken(null)}
            className="mt-2 text-muted-foreground"
          >
            {t(($) => $.account.tokens.created.close)}
          </Button>
        </div>
      )}

      {tokensState.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.account.tokens.loading)}
        </div>
      )}

      {tokensState.kind === "error" && (
        <ErrorBox
          message={tokensState.reason}
          onDismiss={() => void loadTokens()}
          dismissLabel={t(($) => $.account.tokens.retry)}
        />
      )}

      {tokensState.kind === "ok" && tokensState.tokens.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.account.tokens.empty)}
        </div>
      )}

      {tokensState.kind === "ok" && tokensState.tokens.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.account.tokens.columns.name)}</th>
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.account.tokens.columns.created)}</th>
                <th className="pb-2 pr-4 font-semibold">
                  {t(($) => $.account.tokens.columns.last_used)}
                </th>
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.account.tokens.columns.expires)}</th>
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.account.tokens.columns.status)}</th>
                <th className="pb-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {tokensState.tokens.map((tok) => {
                const revoked = tok.revoked_at !== null;
                return (
                  <tr
                    key={tok.id}
                    className={`border-b border-[var(--color-border)] last:border-b-0 ${revoked ? "opacity-40" : ""}`}
                  >
                    <td className="py-2 pr-4 font-medium text-[var(--color-text)]">
                      {tok.label}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                      {formatDate(locale, tok.created_at)}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                      {tok.last_used_at ? formatDate(locale, tok.last_used_at) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                      {tok.expires_at ? formatDate(locale, tok.expires_at) : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {revoked ? (
                        <span className="text-[var(--color-text-dim)]">
                          {t(($) => $.account.tokens.status.revoked)}
                        </span>
                      ) : (
                        <span className="text-green-400">
                          {t(($) => $.account.tokens.status.active)}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      {!revoked && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={revoking.has(tok.id)}
                          onClick={() => {
                            if (
                              window.confirm
                                ? window.confirm(
                                    t(($) => $.account.tokens.revoke.confirm, {
                                      tokenLabel: tok.label,
                                    }),
                                  )
                                : true
                            ) {
                              void handleRevoke(tok.id);
                            }
                          }}
                          title={t(($) => $.account.tokens.revoke.title)}
                        >
                          <Trash2 />
                          {revoking.has(tok.id) ? "…" : t(($) => $.account.tokens.revoke.button)}
                        </Button>
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

function ErrorBox({
  message,
  onDismiss,
  dismissLabel,
}: {
  message: string;
  onDismiss: () => void;
  dismissLabel?: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words">{message}</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onDismiss}
          className="shrink-0 text-destructive"
        >
          {dismissLabel ?? t(($) => $.account.error_box.dismiss)}
        </Button>
      </AlertDescription>
    </Alert>
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
