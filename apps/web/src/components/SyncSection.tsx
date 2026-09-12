// Nastaveni > Synchronizace. Collaboration runs through central mode only
// (see docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md):
// a local workspace tracks files on one machine and never holds Drive
// credentials or routes to a remote (#310), so there is nothing to connect
// here anymore. Drive access on central mode is configured once, via the
// service account (`portuni_setup_remote`, MCP-only) -- no UI needed. This
// tab keeps its slot for the watcher-error panel below, which is unrelated
// to Drive connection state.

import { useDataMode } from "../lib/central";
import { useSyncHealth } from "../lib/use-sync-health";

export default function SyncSection() {
  const dataMode = useDataMode();
  const { health: syncHealth } = useSyncHealth();

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Synchronizace
      </div>

      {syncHealth.errors.length > 0 && (
        <div className="mb-4 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          <div className="mb-1 font-medium">
            Sledování souborů hlásí {syncHealth.errors.length}{" "}
            {syncHealth.errors.length === 1 ? "chybu" : "chyb"} u{" "}
            {new Set(syncHealth.errors.map((e) => e.node_id)).size}{" "}
            {new Set(syncHealth.errors.map((e) => e.node_id)).size === 1 ? "uzlu" : "uzlů"}.
          </div>
          <ul className="flex flex-col gap-0.5">
            {syncHealth.errors.slice(0, 5).map((e) => (
              <li key={`${e.node_id}:${e.path}`} className="min-w-0 truncate font-mono text-[11.5px]">
                {e.path}: {e.message}
              </li>
            ))}
          </ul>
          {syncHealth.errors.length > 5 && (
            <div className="mt-1 text-[11px] text-red-400">
              … a dalších {syncHealth.errors.length - 5}.
            </div>
          )}
        </div>
      )}

      {dataMode?.mode === "central" ? (
        <p className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Synchronizaci souborů na Google Drive spravuje centrální server{" "}
          <span className="font-mono text-[var(--color-text)]">
            {dataMode.server_url ?? "—"}
          </span>
          .
        </p>
      ) : (
        <p className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Tento workspace běží v lokálním režimu – soubory se ukládají jen na
          tento počítač a nesdílejí se. Sdílení souborů vyžaduje připojení k
          týmu (centrální režim).
        </p>
      )}
    </section>
  );
}
