// Persistent footer indicator: green dot + "mcp" when the bundled MCP
// server is reachable, red when it isn't, amber while the first probe
// is in flight. Clicking the indicator switches the app to the Settings
// page so the user can copy URLs / install configs / regenerate token.

import { useMcpStatus } from "../lib/use-mcp-status";

type Props = {
  onOpenSettings: () => void;
};

export default function StatusFooter({ onOpenSettings }: Props) {
  const status = useMcpStatus();

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
      <button
        type="button"
        title={title}
        onClick={onOpenSettings}
        className="flex items-center gap-2 rounded px-2 py-0.5 transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
      >
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${dotColor}`}
        />
        <span className="font-mono">{label}</span>
      </button>
    </footer>
  );
}
