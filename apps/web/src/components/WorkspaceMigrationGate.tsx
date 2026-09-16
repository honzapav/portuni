// One-shot v1 -> v2 config migration dialog. Mounted ABOVE TursoSetupGate in
// main.tsx: a v1 install has no workspace concept yet, so this gate must
// resolve ("ready") before TursoSetupGate's own Tauri commands (which assume
// a workspace-scoped config) run. The workspace ID is immutable afterwards,
// so the user must pick it here (prefill "default").
//
// In a plain browser (Vite dev / static preview) this short-circuits to
// "ready" -- same convention as TursoSetupGate.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/backend-url";
import { slugify } from "../lib/workspaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type GateStatus = "checking" | "needed" | "ready";

export default function WorkspaceMigrationGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<GateStatus>(isTauri() ? "checking" : "ready");
  const [name, setName] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<boolean>("workspace_migration_status")
      .then((needed) => {
        if (!cancelled) setStatus(needed ? "needed" : "ready");
      })
      .catch((e) => {
        // workspace_migration_status should never fail in normal use. If it
        // does, show the migration prompt anyway rather than silently
        // unblocking into a possibly-unmigrated backend.
        console.error("workspace_migration_status failed:", e);
        if (!cancelled) {
          setError(String(e));
          setStatus("needed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") return null;
  if (status === "ready") return <>{children}</>;

  const id = slugify(name);

  async function migrate() {
    setBusy(true);
    setError(null);
    try {
      await invoke("migrate_to_workspaces", { id });
      // No reload: the Rust host opens the new ws:<id> window and closes
      // this bootstrap one itself (#222, "Bootstrap -> workspace handoff").
      // Nothing left to do here -- this window is about to disappear.
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl">
        <div className="border-b border-[var(--color-border)] px-5 py-3">
          <div className="text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
            Pojmenuj svůj workspace
          </div>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="text-[13px] text-[var(--color-text-dim)]">
            Portuni nově podporuje více workspaces. Stávající data se přesunou
            pod zvolené jméno — jméno je pak neměnné.
          </div>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
            spellCheck={false}
          />
          {id !== name && (
            <div className="text-[12px] text-[var(--color-text-dim)]">
              ID: {id || "(neplatné)"}
            </div>
          )}
          {error && <div className="text-[12px] text-red-500">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          <Button type="button" disabled={busy || !id} onClick={() => void migrate()}>
            {busy ? "Migruji…" : "Pokračovat"}
          </Button>
        </div>
      </div>
    </div>
  );
}
