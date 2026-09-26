// Settings > Users -- admin-only tab: full account list (GET
// /auth/users/admin) plus an invite form (POST /auth/users/invite). Visible
// gating (global_scope === "admin") happens in SettingsPage.tsx; this
// component assumes it's only ever rendered for an admin.

import { displayError } from "../errors";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchUsersAdmin, inviteUser, UserExistsError } from "../api";
import { formatDateTime } from "../lib/format";
import { useLocale } from "../lib/use-locale";
import { useListLoad } from "../lib/use-list-load";
import { ErrorActionAlert } from "./ErrorActionAlert";

const fetchUsers = async () => ({ users: await fetchUsersAdmin() });

// Simple format check, mirrors the server's zod z.string().email() closely
// enough to catch typos before a round-trip -- not a full RFC validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SettingsUsersPanel() {
  const locale = useLocale();
  const { t } = useTranslation("settings");
  // mountedRef guards setState calls that resolve after the panel has
  // unmounted (tab switch mid-fetch, admin bounced back to "general", etc.),
  // shared across load() and handleInvite() since both call async work
  // outside a single effect body.
  const { state, load, mountedRef } = useListLoad(fetchUsers);
  const [email, setEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  async function handleInvite() {
    const trimmed = email.trim();
    if (!trimmed) return;
    if (!EMAIL_RE.test(trimmed)) {
      setInviteError(t(($) => $.users.invite.invalid_email));
      return;
    }
    setInviteBusy(true);
    setInviteError(null);
    try {
      await inviteUser(trimmed);
      if (!mountedRef.current) return;
      setEmail("");
      await load();
    } catch (e) {
      if (mountedRef.current) {
        setInviteError(
          e instanceof UserExistsError
            ? t(($) => $.users.invite.user_exists)
            : displayError(e),
        );
      }
    } finally {
      if (mountedRef.current) setInviteBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.users.title)}
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {t(($) => $.users.description)}
      </p>

      <div className="mb-4 flex items-center gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (inviteError) setInviteError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleInvite();
          }}
          placeholder={t(($) => $.users.invite.placeholder)}
          disabled={inviteBusy}
          className="flex-1"
        />
        <Button
          type="button"
          disabled={inviteBusy || !email.trim()}
          onClick={() => void handleInvite()}
          className="shrink-0"
        >
          {inviteBusy ? t(($) => $.users.invite.submitting) : t(($) => $.users.invite.submit)}
        </Button>
      </div>

      {inviteError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{inviteError}</AlertDescription>
        </Alert>
      )}

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.users.loading)}
        </div>
      )}

      {state.kind === "error" && (
        <ErrorActionAlert
          message={state.reason}
          actionLabel={t(($) => $.users.retry)}
          onAction={() => void load()}
        />
      )}

      {state.kind === "ok" && state.users.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.users.empty)}
        </div>
      )}

      {state.kind === "ok" && state.users.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.users.columns.name)}</th>
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.users.columns.email)}</th>
                <th className="pb-2 pr-4 font-semibold">{t(($) => $.users.columns.role)}</th>
                <th className="pb-2 font-semibold">{t(($) => $.users.columns.last_sign_in)}</th>
              </tr>
            </thead>
            <tbody>
              {state.users.map((u) => (
                <tr
                  key={u.id}
                  className="border-b border-[var(--color-border)] last:border-b-0"
                >
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2.5">
                      {u.avatar_url ? (
                        <img
                          src={u.avatar_url}
                          alt={u.name}
                          className="h-6 w-6 shrink-0 rounded-full border border-[var(--color-border)]"
                        />
                      ) : (
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-accent-soft)] text-[10px] font-semibold text-[var(--color-accent)]">
                          {initials(u.name)}
                        </div>
                      )}
                      <span className="font-medium text-[var(--color-text)]">
                        {u.name}
                      </span>
                      {u.invited && (
                        <Badge
                          variant="outline"
                          className="bg-[var(--color-bg)] font-mono uppercase tracking-wide text-[var(--color-text-dim)]"
                        >
                          {t(($) => $.users.invited_badge)}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                    {u.email}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                    {u.global_scope ?? t(($) => $.users.none)}
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)]">
                    {u.last_login_at ? formatDateTime(locale, u.last_login_at) : t(($) => $.users.none)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
