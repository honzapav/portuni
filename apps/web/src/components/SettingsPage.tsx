import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  AGENT_PRESETS,
  DEFAULT_AGENT_COMMAND,
  TERMINAL_PRESETS,
  DEFAULT_TERMINAL_LAUNCH,
} from "../lib/settings";
import McpServerSection from "./McpServerSection";
import SettingsActorsPanel from "./SettingsPage.actors";
import SettingsUsersPanel from "./SettingsPage.users";
import SettingsAccessRequestsPanel from "./AccessRequests";
import AccountSection from "./AccountSection";
import WorkspacesSection from "./WorkspacesSection";
import SyncSection from "./SyncSection";
import UpdateSection from "./UpdateSection";
import { fetchAccessRequestCount, fetchMe } from "../api";
import type { AppUpdate } from "../lib/updater";

type Props = {
  agentCommand: string;
  onAgentCommandChange: (value: string) => void;
  terminalLaunch: string;
  onTerminalLaunchChange: (value: string) => void;
  appUpdate: AppUpdate;
};

type SubTab =
  | "general"
  | "actors"
  | "account"
  | "workspaces"
  | "sync"
  | "users"
  | "access-requests";

export default function SettingsPage({
  agentCommand,
  onAgentCommandChange,
  terminalLaunch,
  onTerminalLaunchChange,
  appUpdate,
}: Props) {
  const [tab, setTab] = useState<SubTab>(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("settingsTab");
    if (t === "actors") return "actors";
    if (t === "account") return "account";
    if (t === "workspaces") return "workspaces";
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

  const [draft, setDraft] = useState(agentCommand);

  useEffect(() => {
    setDraft(agentCommand);
  }, [agentCommand]);

  const commit = (value: string) => {
    const next = value.trim() || DEFAULT_AGENT_COMMAND;
    setDraft(next);
    onAgentCommandChange(next);
  };

  const matchingPreset = AGENT_PRESETS.find((p) => p.command === draft);

  const [termDraft, setTermDraft] = useState(terminalLaunch);

  useEffect(() => {
    setTermDraft(terminalLaunch);
  }, [terminalLaunch]);

  const commitTerm = (value: string) => {
    const next = value.trim() || DEFAULT_TERMINAL_LAUNCH;
    setTermDraft(next);
    onTerminalLaunchChange(next);
  };

  const matchingTerminal = TERMINAL_PRESETS.find((p) => p.template === termDraft);

  const previewPath = "/Users/ty/workspaces/portuni/tvuj-projekt";
  const invocation = (draft.trim() || DEFAULT_AGENT_COMMAND).replace(/\s*\{prompt\}\s*/g, " ").trim();
  const preview = `cd '${previewPath}' && ${invocation}`;

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
                Příkaz agenta
              </div>
              <p className="mb-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
                Když otevřeš terminál z uzlu, Portuni ho prefixuje přechodem{" "}
                <code className="font-mono">cd</code> do lokální složky uzlu a
                spustí tenhle příkaz beze změny — terminál se otevře prázdný a
                připravený, žádný úvodní prompt se neposílá. Kontext uzlu
                (souhrn, odpovědnosti, nedávné události, ukazatel na handoff)
                najde agent sám v{" "}
                <code className="font-mono text-[var(--color-accent)]">
                  PORTUNI_SCOPE.md
                </code>{" "}
                v pracovní složce.
              </p>

              <div className="mb-4 space-y-1.5">
                <div className="text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                  Předvolby
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_PRESETS.map((p) => {
                    const active = matchingPreset?.id === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => commit(p.command)}
                        title={p.hint}
                        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13.5px] transition-colors ${
                          active
                            ? "border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 text-[var(--color-accent)]"
                            : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        {active && <Check size={11} />}
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                Šablona příkazu
              </label>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commit((e.target as HTMLInputElement).value);
                  }
                }}
                spellCheck={false}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[14px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
                placeholder={DEFAULT_AGENT_COMMAND}
              />

              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                    Náhled
                  </div>
                  <div className="text-[12px] text-[var(--color-text-dim)]">
                    Vzorová cesta – skutečná cesta vznikne z vybraného uzlu.
                  </div>
                </div>
                <pre className="scroll-thin max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                  {preview}
                </pre>
              </div>
            </section>

            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
                Terminál
              </div>
              <p className="mb-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
                Při kliknutí na „Spustit agenta" Portuni spustí tenhle shell
                příkaz s těmito proměnnými prostředí:{" "}
                <code className="font-mono text-[var(--color-accent)]">
                  $PORTUNI_CWD
                </code>{" "}
                (pracovní složka uzlu),{" "}
                <code className="font-mono text-[var(--color-accent)]">
                  $PORTUNI_COMMAND
                </code>{" "}
                (úplný <code className="font-mono">cd … && agent …</code>) a{" "}
                <code className="font-mono text-[var(--color-accent)]">
                  $PORTUNI_COMMAND_AS
                </code>{" "}
                (totéž, escapováno pro AppleScript). Funguje jen na macOS.
              </p>

              <div className="mb-4 space-y-1.5">
                <div className="text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                  Předvolby
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TERMINAL_PRESETS.map((p) => {
                    const active = matchingTerminal?.id === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => commitTerm(p.template)}
                        title={p.hint}
                        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13.5px] transition-colors ${
                          active
                            ? "border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 text-[var(--color-accent)]"
                            : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        {active && <Check size={11} />}
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                Šablona shell příkazu
              </label>
              <textarea
                value={termDraft}
                onChange={(e) => setTermDraft(e.target.value)}
                onBlur={(e) => commitTerm(e.target.value)}
                spellCheck={false}
                rows={6}
                className="scroll-thin w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
                placeholder={DEFAULT_TERMINAL_LAUNCH}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
