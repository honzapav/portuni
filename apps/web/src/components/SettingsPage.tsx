import { useCallback, useEffect, useState } from "react";
import { loadShowtimeEnabled, saveShowtimeEnabled } from "../lib/settings";
import McpServerSection from "./McpServerSection";
import SettingsActorsPanel from "./SettingsPage.actors";
import SettingsUsersPanel from "./SettingsPage.users";
import SettingsAccessRequestsPanel from "./AccessRequests";
import AccountSection from "./AccountSection";
import WorkspacesSection from "./WorkspacesSection";
import RunnersSection from "./RunnersSection";
import SyncSection from "./SyncSection";
import UpdateSection from "./UpdateSection";
import { fetchAccessRequestCount, fetchMe } from "../api";
import { isTauri } from "../lib/backend-url";
import { showtimeInstalled } from "../lib/showtime";
import type { AppUpdate } from "../lib/updater";

type Props = {
  appUpdate: AppUpdate;
};

type SubTab =
  | "general"
  | "actors"
  | "account"
  | "workspaces"
  | "runners"
  | "sync"
  | "users"
  | "access-requests";

export default function SettingsPage({ appUpdate }: Props) {
  const [tab, setTab] = useState<SubTab>(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("settingsTab");
    if (t === "actors") return "actors";
    if (t === "account") return "account";
    if (t === "workspaces") return "workspaces";
    if (t === "runners") return "runners";
    if (t === "sync") return "sync";
    if (t === "users") return "users";
    if (t === "access-requests") return "access-requests";
    return "general";
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "general") url.searchParams.delete("settingsTab");
    else url.searchParams.set("settingsTab", tab);
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  // Uzivatele tab is admin-only, Zadosti o pristup is manage+. fetchMe()
  // resolves the caller's global_scope; scopeState starts "unknown" so a
  // direct ?settingsTab=users link isn't bounced before the check resolves
  // -- the tab button/panel just stay hidden until we know. Once resolved,
  // a caller below the tab's tier is bounced back to "general".
  const [scopeState, setScopeState] = useState<"unknown" | "read" | "write" | "manage" | "admin">(
    "unknown",
  );
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (cancelled) return;
        const s = me.global_scope;
        setScopeState(s === "admin" || s === "manage" || s === "write" ? s : "read");
      })
      .catch(() => {
        if (!cancelled) setScopeState("read");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const isAdmin = scopeState === "admin";
  const canManage = scopeState === "admin" || scopeState === "manage";
  const scopeKnown = scopeState !== "unknown";
  useEffect(() => {
    if (tab === "users" && scopeKnown && !isAdmin) setTab("general");
    if (tab === "access-requests" && scopeKnown && !canManage) setTab("general");
  }, [tab, scopeKnown, isAdmin, canManage]);

  // Pending-request badge on the tab label. One cheap count on mount for
  // managers, refreshed after every approve/deny from the panel itself.
  const [pendingCount, setPendingCount] = useState(0);
  const refreshPendingCount = useCallback(() => {
    fetchAccessRequestCount()
      .then(setPendingCount)
      .catch(() => {
        /* badge stays at its last value */
      });
  }, []);
  useEffect(() => {
    if (canManage) refreshPendingCount();
  }, [canManage, refreshPendingCount]);

  const isGeneralTab = tab === "general";

  const [showtimeEnabled, setShowtimeEnabled] = useState(loadShowtimeEnabled);
  // null while the desktop is still answering; false in the browser.
  const [showtimeFound, setShowtimeFound] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void showtimeInstalled().then((ok) => {
      if (!cancelled) setShowtimeFound(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleShowtime = (enabled: boolean) => {
    saveShowtimeEnabled(enabled);
    setShowtimeEnabled(enabled);
  };

  return (
    <div className="scroll-thin h-full w-full overflow-y-auto bg-[var(--color-bg)]">
      <div className="mx-auto flex max-w-[840px] flex-col gap-8 px-8 py-8">
        <header>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
            Nastavení
          </h1>
          {isGeneralTab && (
            <p className="mt-1 text-[13px] text-[var(--color-text-dim)]">
              Změny se ukládají automaticky.
            </p>
          )}
          <div className="mt-3 flex w-max gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
            <button
              onClick={() => setTab("general")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "general"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Obecné
            </button>
            <button
              onClick={() => setTab("actors")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "actors"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Aktéři
            </button>
            <button
              onClick={() => setTab("account")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "account"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Účet
            </button>
            <button
              onClick={() => setTab("workspaces")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "workspaces"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Workspaces
            </button>
            <button
              onClick={() => setTab("runners")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "runners"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Runnery
            </button>
            <button
              onClick={() => setTab("sync")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "sync"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Synchronizace
            </button>
            {canManage && (
              <button
                onClick={() => setTab("access-requests")}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-[13px] transition-colors ${
                  tab === "access-requests"
                    ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                }`}
              >
                Žádosti o přístup
                {pendingCount > 0 && (
                  <span className="rounded-full bg-[var(--color-accent)] px-1.5 py-px font-mono text-[10.5px] font-semibold leading-tight text-[var(--color-bg)]">
                    {pendingCount}
                  </span>
                )}
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setTab("users")}
                className={`rounded px-3 py-1 text-[13px] transition-colors ${
                  tab === "users"
                    ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                }`}
              >
                Uživatelé
              </button>
            )}
          </div>
        </header>

        {tab === "actors" && <SettingsActorsPanel />}

        {tab === "account" && <AccountSection />}

        {tab === "workspaces" && <WorkspacesSection />}

        {tab === "runners" && <RunnersSection />}

        {tab === "sync" && <SyncSection />}

        {tab === "users" && isAdmin && <SettingsUsersPanel />}

        {tab === "access-requests" && canManage && (
          <SettingsAccessRequestsPanel onChanged={refreshPendingCount} />
        )}

        {(tab === "users" || tab === "access-requests") && !scopeKnown && (
          <div className="text-[13px] text-[var(--color-text-dim)]">
            Načítám…
          </div>
        )}

        {tab === "general" && (
          <>
            <UpdateSection appUpdate={appUpdate} />

            <McpServerSection />

            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
                Integrace
              </div>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={showtimeEnabled}
                  onChange={(e) => toggleShowtime(e.target.checked)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block text-[13.5px] font-medium text-[var(--color-text)]">
                    Showtime
                  </span>
                  <span className="block text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                    Soubor <code className="font-mono">.showtime</code> se otevře jako náhled
                    prezentace (náhled, který Showtime uloží do souboru při každém uložení).
                    Když je Showtime nainstalovaný, náhled nabídne „Otevřít v Showtime“: deck
                    se otevře v Showtime a agent, kterého Showtime spustí, dostane připojení
                    k Portuni s tímto uzlem jako domovským a zrcadlo uzlu jako druhý pracovní
                    adresář.
                  </span>
                  <span className="mt-1 block text-[12.5px] text-[var(--color-text-dim)]">
                    {showtimeFound === null
                      ? "Hledám Showtime.app…"
                      : showtimeFound
                        ? "Showtime.app nalezena."
                        : isTauri()
                          ? "Showtime.app nenalezena (hledá se v /Applications a ~/Applications)."
                          : "Otevření v Showtime je dostupné jen v desktopové aplikaci."}
                  </span>
                </span>
              </label>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
