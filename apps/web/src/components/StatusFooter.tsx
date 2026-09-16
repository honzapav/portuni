// Persistent footer indicator: green dot + "mcp" when the bundled MCP
// server is reachable, red when it isn't, amber while the first probe
// is in flight. Clicking the indicator switches the app to the Settings
// page so the user can copy URLs / install configs / regenerate token.

import { useMcpStatus } from "../lib/use-mcp-status";
import { pluralFiles } from "../lib/plural-files";
import type { AppUpdate } from "../lib/updater";
import { Button } from "@/components/ui/button";

type Props = {
  onOpenSettings: () => void;
  // #343: the live running-session count from session_state frames
  // (countRunningSessions) -- a session can be running without being open
  // anywhere in this window.
  sessionCount: number;
  onOpenWorkspace: () => void;
  pendingCount: number;
  onOpenSyncOverview: () => void;
  appUpdate: AppUpdate;
};

// Every footer indicator is a clickable pill: a small ghost Button keeping
// the footer's own dim/hover colours.
const PILL = "h-5 gap-1.5 rounded-full px-2 font-normal text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]";

export default function StatusFooter({
  onOpenSettings,
  sessionCount,
  onOpenWorkspace,
  pendingCount,
  onOpenSyncOverview,
  appUpdate,
}: Props) {
  const status = useMcpStatus();
  const updateState = appUpdate.state;

  const dotColor =
    status.state === "running"
      ? "bg-emerald-500"
      : status.state === "loading"
        ? "bg-amber-400"
        : "bg-red-500";

  const label =
    status.state === "running"
      ? "mcp"
      : status.state === "loading"
        ? "mcp…"
        : "mcp ×";

  const title =
    status.state === "running"
      ? `MCP server běží: ${status.url}`
      : status.state === "loading"
        ? "Zjišťuji stav MCP serveru…"
        : `MCP server nedostupný: ${status.reason}`;

  return (
    <footer className="flex h-7 shrink-0 items-center border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12px] text-[var(--color-text-dim)]">
      <Button variant="ghost" size="xs" className={PILL} title={title} onClick={onOpenSettings}>
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
        <span className="font-mono">{label}</span>
      </Button>
      {sessionCount > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className={`ml-3 ${PILL}`}
          title={`Aktivní sessions: ${sessionCount}`}
          onClick={onOpenWorkspace}
        >
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-mono">{sessionCount} sess</span>
        </Button>
      )}
      {pendingCount > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className={`ml-3 ${PILL}`}
          title={`Nesynchronizováno: ${pendingCount} ${pluralFiles(pendingCount)}`}
          onClick={onOpenSyncOverview}
        >
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-amber-500" />
          <span className="font-mono">↑ {pendingCount} nesynced</span>
        </Button>
      )}
      {updateState.kind === "available" && (
        <Button
          variant="ghost"
          size="xs"
          className={`ml-auto ${PILL}`}
          title="Nová verze Portuni – klikni pro aktualizaci"
          onClick={onOpenSettings}
        >
          <span className="font-mono">↑ {updateState.info.version}</span>
        </Button>
      )}
      {updateState.kind === "ready" && (
        <Button
          variant="ghost"
          size="xs"
          className={`ml-auto ${PILL}`}
          title="Restartovat pro dokončení aktualizace"
          onClick={() => void appUpdate.restart()}
        >
          <span className="font-mono">Restartovat</span>
        </Button>
      )}
    </footer>
  );
}
