// "Aktualizace" section on Settings -> Obecné. Shows the current version,
// lets the user check on demand, download + install and restart. Desktop
// only; see AppUpdate.updateInfo comment in lib/updater.ts for why
// downloading/ready reuse the last "available" info instead of carrying
// their own.

import { Download, ExternalLink, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppUpdate } from "../lib/updater";
import { isTauri, openExternal } from "../lib/backend-url";
import { formatDateTime } from "../lib/format";
import { useLocale } from "../lib/use-locale";

type Props = {
  appUpdate: AppUpdate;
};

export default function UpdateSection({ appUpdate }: Props) {
  const locale = useLocale();
  const { state, currentVersion, updateInfo, hasChecked, lastCheckedAt, checkNow, install, restart } =
    appUpdate;

  if (!isTauri()) {
    return (
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          Aktualizace
        </div>
        <p className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Aktualizace jsou dostupné jen v desktopové aplikaci.
        </p>
      </section>
    );
  }

  // "ready" counts as busy for the check button: checkNow ignores that state
  // (the old binary would find the same release again), so keep it disabled.
  const busy =
    state.kind === "checking" || state.kind === "downloading" || state.kind === "ready";
  const releaseVersion = state.kind === "available" ? state.info.version : updateInfo?.version;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Aktualizace
      </div>

      <div className="mb-3 text-[13.5px] text-[var(--color-text-muted)]">
        Verze {currentVersion ?? "…"}
      </div>

      <div className="mb-4 text-[13.5px] text-[var(--color-text-muted)]">
        {state.kind === "idle" &&
          (hasChecked
            ? "Aktuální verze je nejnovější."
            : "Zatím nezkontrolováno.")}
        {state.kind === "checking" && "Kontroluji aktualizace…"}
        {state.kind === "available" && `K dispozici ${state.info.version}.`}
        {state.kind === "downloading" &&
          `Stahuji a instaluji${state.pct != null ? ` (${state.pct} %)` : "…"}`}
        {state.kind === "ready" && "Aktualizace nainstalována – restartuj pro dokončení."}
        {state.kind === "error" && (
          <span className="text-[var(--color-danger)]">{state.message}</span>
        )}
      </div>

      {lastCheckedAt && (
        // #274: a silently-broken schedule (the check just never runs) used
        // to look identical to "checked, up to date" -- this timestamp
        // makes the schedule's own liveness visible, updated on every
        // completed attempt including a failed one.
        <div className="mb-4 text-[12px] text-[var(--color-text-dim)]">
          Naposledy zkontrolováno:{" "}
          {formatDateTime(locale, lastCheckedAt)}
        </div>
      )}

      {state.kind === "downloading" && (
        <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
            style={{ width: `${state.pct ?? 0}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={checkNow} disabled={busy}>
          <RotateCw />
          Zkontrolovat nyní
        </Button>

        {(state.kind === "available" || (state.kind === "error" && updateInfo)) && (
          <Button type="button" onClick={install}>
            <Download />
            Stáhnout a nainstalovat
          </Button>
        )}

        {state.kind === "ready" && (
          <Button type="button" onClick={() => void restart()}>
            Restartovat
          </Button>
        )}

        {releaseVersion && (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              void openExternal(
                `https://github.com/honzapav/portuni/releases/tag/v${releaseVersion}`,
              )
            }
            className="text-muted-foreground"
          >
            Co je nového
            <ExternalLink />
          </Button>
        )}
      </div>
    </section>
  );
}
