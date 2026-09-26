import { Suspense, useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { loadShowtimeEnabled, saveShowtimeEnabled } from "../lib/settings";
import McpServerSection from "./McpServerSection";
import SettingsActorsPanel from "./SettingsPage.actors";
import SettingsUsersPanel from "./SettingsPage.users";
import SettingsAccessRequestsPanel from "./AccessRequests";
import AccountSection from "./AccountSection";
import WorkspacesSection from "./WorkspacesSection";
import RunnersSection from "./RunnersSection";
import UpdateSection from "./UpdateSection";
import { fetchAccessRequestCount, fetchMe } from "../api";
import { isTauri } from "../lib/backend-url";
import { showtimeInstalled } from "../lib/showtime";
import type { AppUpdate } from "../lib/updater";
import { lazyWithNamespaces } from "../i18n";

// Settings › Sync reads the `files` namespace; it loads with the chunk.
const SyncSection = lazyWithNamespaces(() => import("./SyncSection"), ["files"]);

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
  const { t } = useTranslation("settings");
  const [tab, setTab] = useState<SubTab>(() => {
    const p = new URLSearchParams(window.location.search);
    const q = p.get("settingsTab");
    if (q === "actors") return "actors";
    if (q === "account") return "account";
    if (q === "workspaces") return "workspaces";
    if (q === "runners") return "runners";
    if (q === "sync") return "sync";
    if (q === "users") return "users";
    if (q === "access-requests") return "access-requests";
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
            {t(($) => $.page.title)}
          </h1>
          {isGeneralTab && (
            <p className="mt-1 text-[13px] text-[var(--color-text-dim)]">
              {t(($) => $.page.autosave)}
            </p>
          )}
          <Tabs value={tab} onValueChange={(v) => setTab(v as SubTab)} className="mt-3">
            <TabsList>
              <TabsTrigger value="general">{t(($) => $.page.tabs.general)}</TabsTrigger>
              <TabsTrigger value="actors">{t(($) => $.page.tabs.actors)}</TabsTrigger>
              <TabsTrigger value="account">{t(($) => $.page.tabs.account)}</TabsTrigger>
              <TabsTrigger value="workspaces">{t(($) => $.page.tabs.workspaces)}</TabsTrigger>
              <TabsTrigger value="runners">{t(($) => $.page.tabs.runners)}</TabsTrigger>
              <TabsTrigger value="sync">{t(($) => $.page.tabs.sync)}</TabsTrigger>
              {canManage && (
                <TabsTrigger value="access-requests">
                  {t(($) => $.page.tabs.access_requests)}
                  {pendingCount > 0 && (
                    <Badge className="bg-[var(--color-accent)] font-mono text-[var(--color-bg)]">
                      {pendingCount}
                    </Badge>
                  )}
                </TabsTrigger>
              )}
              {isAdmin && <TabsTrigger value="users">{t(($) => $.page.tabs.users)}</TabsTrigger>}
            </TabsList>
          </Tabs>
        </header>

        {tab === "actors" && <SettingsActorsPanel />}

        {tab === "account" && <AccountSection />}

        {tab === "workspaces" && <WorkspacesSection />}

        {tab === "runners" && <RunnersSection />}

        {tab === "sync" && (
          <Suspense fallback={null}>
            <SyncSection />
          </Suspense>
        )}

        {tab === "users" && isAdmin && <SettingsUsersPanel />}

        {tab === "access-requests" && canManage && (
          <SettingsAccessRequestsPanel onChanged={refreshPendingCount} />
        )}

        {(tab === "users" || tab === "access-requests") && !scopeKnown && (
          <div className="text-[13px] text-[var(--color-text-dim)]">
            {t(($) => $.page.loading)}
          </div>
        )}

        {tab === "general" && (
          <>
            <UpdateSection appUpdate={appUpdate} />

            <McpServerSection />

            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
                {t(($) => $.page.integrations.title)}
              </div>
              <div className="flex items-start gap-3">
                <Switch
                  id="showtime-enabled"
                  checked={showtimeEnabled}
                  onCheckedChange={toggleShowtime}
                  className="mt-0.5"
                />
                <span>
                  <Label
                    htmlFor="showtime-enabled"
                    className="cursor-pointer text-[13.5px] text-[var(--color-text)]"
                  >
                    {t(($) => $.page.integrations.showtime.label)}
                  </Label>
                  <span className="block text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                    <Trans
                      t={t}
                      ns="settings"
                      i18nKey={($) => $.page.integrations.showtime.description}
                      components={{ code: <code className="font-mono" /> }}
                    />
                  </span>
                  <span className="mt-1 block text-[12.5px] text-[var(--color-text-dim)]">
                    {showtimeFound === null
                      ? t(($) => $.page.integrations.showtime.searching)
                      : showtimeFound
                        ? t(($) => $.page.integrations.showtime.found)
                        : isTauri()
                          ? t(($) => $.page.integrations.showtime.not_found)
                          : t(($) => $.page.integrations.showtime.desktop_only)}
                  </span>
                </span>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
