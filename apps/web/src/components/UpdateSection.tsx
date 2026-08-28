// "Aktualizace" section on Settings -> Obecné. Shows the current version,
// lets the user check on demand, download + install and restart. Desktop
// only -- see AppUpdate.updateInfo comment in lib/updater.ts for why
// downloading/ready reuse the last "available" info instead of carrying
// their own.

import { Download, ExternalLink, RotateCw } from "lucide-react";
import type { AppUpdate } from "../lib/updater";
import { isTauri, openExternal } from "../lib/backend-url";

type Props = {
  appUpdate: AppUpdate;
};

export default function UpdateSection({ appUpdate }: Props) {
  const { state, currentVersion, updateInfo, hasChecked, checkNow, install, restart } =
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

  const busy = state.kind === "checking" || state.kind === "downloading";
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
        {state.kind === "ready" && "Aktualizace nainstalována -- restartuj pro dokončení."}
        {state.kind === "error" && (
          <span className="text-[var(--color-danger)]">{state.message}</span>
        )}
      </div>

      {state.kind === "downloading" && (
        <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
            style={{ width: `${state.pct ?? 0}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={checkNow}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-60"
        >
          <RotateCw size={13} />
          Zkontrolovat nyní
        </button>

        {(state.kind === "available" || (state.kind === "error" && updateInfo)) && (
          <button
            type="button"
            onClick={install}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] px-3 py-1.5 text-[13px] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)]"
          >
            <Download size={13} />
            Stáhnout a nainstalovat
          </button>
        )}

        {state.kind === "ready" && (
          <button
            type="button"
            onClick={() => void restart()}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] px-3 py-1.5 text-[13px] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)]"
          >
            Restartovat
          </button>
        )}

        {releaseVersion && (
          <button
            type="button"
            onClick={() =>
              void openExternal(
                `https://github.com/honzapav/portuni/releases/tag/v${releaseVersion}`,
              )
            }
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)]"
          >
            Co je nového
            <ExternalLink size={12} />
          </button>
        )}
      </div>
    </section>
  );
}
