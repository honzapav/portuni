// Nastaveni > Synchronizace. Collaboration runs through a team workspace only
// (see docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md):
// a local workspace tracks files on one machine and never holds Drive
// credentials or routes to a remote (#310), so there is nothing to connect
// here anymore. Drive access in a team workspace is configured once, via the
// service account (`portuni_setup_remote`, MCP-only) -- no UI needed. This
// tab keeps its slot for the watcher-error panel below and for the remote
// watcher's own per-remote line (#339), neither of which is about Drive
// connection state.

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useDataMode } from "../lib/central";
import { useSyncHealth } from "../lib/use-sync-health";
import { useSyncWatch } from "../lib/use-sync-watch";
import { remoteWatchLine } from "../lib/remote-watch-view";
import { useLocale } from "../lib/use-locale";
import { Trans, useTranslation } from "react-i18next";

export default function SyncSection() {
  const { t } = useTranslation("files");
  const locale = useLocale();
  const dataMode = useDataMode();
  const { health: syncHealth } = useSyncHealth();
  // The remote watcher (#338/#339) runs on central only, so a local
  // workspace gets an empty list here and renders no watcher line at all.
  const { watch } = useSyncWatch();
  const now = Date.now();
  const errorNodes = new Set(syncHealth.errors.map((e) => e.node_id)).size;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.sync_section.heading)}
      </div>

      {syncHealth.errors.length > 0 && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>
            {/* One sentence, two counts: the errors pick the plural form, the
                nodes pick the key (Czech "u 1 uzlu" / "u N uzlů" and English
                "in 1 node" / "in N nodes" both split only at one). */}
            {errorNodes === 1
              ? t(($) => $.sync_section.watcher_errors_one_node, {
                  count: syncHealth.errors.length,
                })
              : t(($) => $.sync_section.watcher_errors_nodes, {
                  count: syncHealth.errors.length,
                  nodes: errorNodes,
                })}
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-0.5">
              {syncHealth.errors.slice(0, 5).map((e) => (
                <li key={`${e.node_id}:${e.path}`} className="min-w-0 truncate font-mono text-[11.5px]">
                  {e.path}: {e.message}
                </li>
              ))}
            </ul>
            {syncHealth.errors.length > 5 && (
              <div className="mt-1 text-[11px]">
                {t(($) => $.sync_section.more_errors, { count: syncHealth.errors.length - 5 })}
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      {watch.remotes.length > 0 && (
        <ul className="mb-4 flex flex-col gap-1">
          {watch.remotes.map((r) => {
            const line = remoteWatchLine(r, now, locale, t);
            return (
              <li
                key={line.remote_name}
                className={`flex flex-wrap items-baseline gap-x-2 text-[12.5px] ${
                  line.tone === "error"
                    ? "text-[var(--color-danger)]"
                    : line.tone === "ok"
                      ? "text-[var(--color-text-muted)]"
                      : "text-[var(--color-text-dim)]"
                }`}
              >
                <span>{line.text}</span>
                {line.retry && (
                  <span className="text-[var(--color-text-dim)]">({line.retry})</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dataMode?.mode === "central" ? (
        <p className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          <Trans
            t={t}
            i18nKey={($) => $.sync_section.central}
            values={{ server: dataMode.server_url ?? "—" }}
            components={{ server: <span className="font-mono text-[var(--color-text)]" /> }}
          />
        </p>
      ) : (
        <p className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          {t(($) => $.sync_section.personal)}
        </p>
      )}
    </section>
  );
}
