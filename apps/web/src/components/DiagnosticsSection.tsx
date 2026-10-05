// "Reporting a problem" on Settings -> General (#573): one button copying
// the UI trail (lib/ui-trail.ts) plus the app version, the workspace kind
// and the workspace id as plain text. Nothing is sent anywhere; the user
// pastes it where they report the problem.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { displayError } from "../errors";
import { isTauri } from "../lib/backend-url";
import { copyText } from "../lib/clipboard";
import { getDataModeCached } from "../lib/data-mode";
import { getAppVersion } from "../lib/updater";
import { currentWorkspaceId } from "../lib/workspace-storage";
import { formatDiagnostics, uiTrail } from "../lib/ui-trail";

async function buildDiagnostics(): Promise<string> {
  const appVersion = isTauri() ? await getAppVersion().catch(() => "unknown") : "browser";
  const workspaceKind: "personal" | "team" | "unknown" = await getDataModeCached().then(
    (m) => (m.mode === "central" ? "team" : "personal"),
    () => "unknown",
  );
  return formatDiagnostics({
    appVersion,
    workspaceKind,
    workspaceId: currentWorkspaceId(),
    generatedAt: new Date(),
    lines: uiTrail.lines(),
  });
}

export default function DiagnosticsSection() {
  const { t } = useTranslation("settings");
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function copy() {
    try {
      await copyText(await buildDiagnostics());
      setMessage({ kind: "ok", text: t(($) => $.diagnostics.copied) });
    } catch (e) {
      setMessage({ kind: "err", text: t(($) => $.diagnostics.copy_failed, { error: displayError(e) }) });
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.diagnostics.title)}
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {t(($) => $.diagnostics.description)}
      </p>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          <Copy />
          {t(($) => $.diagnostics.copy)}
        </Button>
        {message && (
          <span
            className={
              message.kind === "ok"
                ? "text-[13px] text-[var(--color-text-muted)]"
                : "text-[13px] text-[var(--color-danger)]"
            }
          >
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}
