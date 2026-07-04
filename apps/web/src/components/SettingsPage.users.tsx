// Nastavení > Uživatelé -- admin-only tab: full account list (GET
// /auth/users/admin) plus an invite form (POST /auth/users/invite). Visible
// gating (global_scope === "admin") happens in SettingsPage.tsx; this
// component assumes it's only ever rendered for an admin.

import { useCallback, useEffect, useState } from "react";
import { fetchUsersAdmin, inviteUser, UserExistsError } from "../api";
import type { UserAdmin } from "../types";

type UsersState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; users: UserAdmin[] };

export default function SettingsUsersPanel() {
  const [state, setState] = useState<UsersState>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const users = await fetchUsersAdmin();
      setState({ kind: "ok", users });
    } catch (e) {
      setState({
        kind: "error",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleInvite() {
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      await inviteUser(trimmed);
      setEmail("");
      await load();
    } catch (e) {
      setInviteError(
        e instanceof UserExistsError
          ? "Uživatel už existuje"
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setInviteBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Uživatelé
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        Účty s přístupem k tomuto Portuni serveru. Pozvaní uživatelé ještě
        nikdy nepřihlásili -- placeholder účet jde sdílet a přiřazovat
        rovnou.
      </p>

      <div className="mb-4 flex items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (inviteError) setInviteError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleInvite();
          }}
          placeholder="email@example.com"
          disabled={inviteBusy}
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] disabled:opacity-50"
        />
        <button
          type="button"
          disabled={inviteBusy || !email.trim()}
          onClick={() => void handleInvite()}
          className="shrink-0 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {inviteBusy ? "Zvu…" : "Pozvat"}
        </button>
      </div>

      {inviteError && (
        <div className="mb-4 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          {inviteError}
        </div>
      )}

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          Načítám uživatele…
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

      {state.kind === "ok" && state.users.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] px-3 py-3 text-[13px] text-[var(--color-text-dim)]">
          Zatím žádní uživatelé.
        </div>
      )}

      {state.kind === "ok" && state.users.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                <th className="pb-2 pr-4 font-semibold">Jméno</th>
                <th className="pb-2 pr-4 font-semibold">E-mail</th>
                <th className="pb-2 pr-4 font-semibold">Role</th>
                <th className="pb-2 font-semibold">Poslední přihlášení</th>
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
                        <span className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide text-[var(--color-text-dim)]">
                          Pozvaný
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                    {u.email}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[var(--color-text-muted)]">
                    {u.global_scope ?? "—"}
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)]">
                    {u.last_login_at ? fmtDateTime(u.last_login_at) : "—"}
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

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("cs-CZ", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
