// Nastaveni > Synchronizace -- Google Drive connect flow for local
// workspaces. Central workspaces show a single informational line (Drive
// credentials live on the central server, nothing to configure here); the
// service-account path never gets UI (MCP-only, see the design spec).
//
// States: loading -> central | prerequisite (no google_client_id/secret) |
// not-connected | select-target (connected, no routing target yet) |
// active (connected + target). Every mutation invalidates the shared
// status cache (lib/sync-drive.ts, reused by the node-detail banner) and
// reloads from the server rather than guessing the new state client-side.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectDrive,
  disconnectDrive,
  fetchDriveStatus,
  fetchDriveTargets,
  googleClientConfigured,
  invalidateSyncStatusCache,
  setDriveTarget,
  testDrive,
  type DriveTarget,
} from "../lib/sync-drive";
import { openExternal } from "../lib/backend-url";
import { useDataMode } from "../lib/central";

const TEAM_SETUP_DOCS_URL = "https://docs.portuni.com/getting-started/team-setup/";

const DISCONNECT_CONFIRM_MESSAGE =
  "Opravdu odpojit Google Drive? Lokální soubory zůstanou.";

type LoadState =
  | { kind: "loading" }
  | { kind: "central"; serverUrl: string | null }
  | { kind: "prerequisite" }
  | { kind: "not-connected" }
  | { kind: "select-target"; email: string | null }
  | { kind: "active"; email: string | null; targetName: string };

export default function SyncSection() {
  const dataMode = useDataMode();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    setState({ kind: "loading" });
    setError(null);
    try {
      const [clientConfigured, status] = await Promise.all([
        googleClientConfigured(),
        fetchDriveStatus(),
      ]);
      if (!mountedRef.current) return;
      if (!clientConfigured) {
        setState({ kind: "prerequisite" });
      } else if (!status.connected) {
        setState({ kind: "not-connected" });
      } else if (!status.target) {
        setState({ kind: "select-target", email: status.account_email });
      } else {
        setState({
          kind: "active",
          email: status.account_email,
          targetName: status.target.name,
        });
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    // Wait for the data-mode check to resolve before doing any Drive
    // network calls -- central workspaces never touch these endpoints.
    if (dataMode === null) return;
    if (dataMode.mode === "central") {
      setState({ kind: "central", serverUrl: dataMode.server_url });
      return;
    }
    void load();
  }, [dataMode, load]);

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      await connectDrive();
      invalidateSyncStatusCache();
      await load();
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        Synchronizace
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        Propojení s Google Drive pro zálohování a sdílení souborů uzlů.
      </p>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-red-400 hover:text-red-200"
          >
            Zavřít
          </button>
        </div>
      )}

      {state.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          Zjišťuji stav synchronizace…
        </div>
      )}

      {state.kind === "central" && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] text-[var(--color-text-muted)]">
          Synchronizaci souborů spravuje server{" "}
          <span className="font-mono text-[var(--color-text)]">
            {state.serverUrl ?? "—"}
          </span>
          .
        </div>
      )}

      {state.kind === "prerequisite" && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          Propojení s Google Drive vyžaduje{" "}
          <code className="font-mono text-[12px]">google_client_id</code> a{" "}
          <code className="font-mono text-[12px]">google_client_secret</code> v
          konfiguraci workspace.{" "}
          <a
            href={TEAM_SETUP_DOCS_URL}
            onClick={(e) => {
              e.preventDefault();
              void openExternal(TEAM_SETUP_DOCS_URL);
            }}
            className="text-[var(--color-accent)] underline hover:no-underline"
          >
            Návod v dokumentaci
          </a>
          .
        </div>
      )}

      {state.kind === "not-connected" && (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleConnect()}
            className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Propojuji…" : "Propojit Google Drive"}
          </button>
        </div>
      )}

      {state.kind === "select-target" && (
        <TargetSelector onSaved={() => void load()} onError={setError} />
      )}

      {state.kind === "active" && (
        <ActivePanel
          email={state.email}
          targetName={state.targetName}
          onDisconnected={() => void load()}
          onExpired={() => setState({ kind: "not-connected" })}
          onError={setError}
        />
      )}
    </section>
  );
}

// --- Select target -----------------------------------------------------------

type TargetsState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; targets: DriveTarget[] };

const MY_DRIVE_VALUE = "__my_drive__";

function TargetSelector({
  onSaved,
  onError,
}: {
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [targetsState, setTargetsState] = useState<TargetsState>({ kind: "loading" });
  const [selected, setSelected] = useState<string>(MY_DRIVE_VALUE);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setTargetsState({ kind: "loading" });
    try {
      const targets = await fetchDriveTargets();
      if (mountedRef.current) setTargetsState({ kind: "ok", targets });
    } catch (e) {
      if (mountedRef.current) {
        setTargetsState({
          kind: "error",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    setBusy(true);
    try {
      const sel =
        selected === MY_DRIVE_VALUE
          ? ({ my_drive: true } as const)
          : ({ shared_drive_id: selected } as const);
      await setDriveTarget(sel);
      invalidateSyncStatusCache();
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {targetsState.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          Načítám sdílené disky…
        </div>
      )}

      {targetsState.kind === "error" && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          <span className="min-w-0 break-words">{targetsState.reason}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 text-red-400 hover:text-red-200"
          >
            Zkusit znovu
          </button>
        </div>
      )}

      {targetsState.kind === "ok" && (
        <>
          <div>
            <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Cíl synchronizace
            </label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)] disabled:opacity-50"
            >
              <option value={MY_DRIVE_VALUE}>Můj disk (složka Portuni)</option>
              {targetsState.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
              className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Ukládám…" : "Uložit cíl"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- Active panel -------------------------------------------------------------

type TestResultState =
  | null
  | { kind: "ok" }
  | { kind: "code"; code: string }
  | { kind: "unknown"; message: string };

function ActivePanel({
  email,
  targetName,
  onDisconnected,
  onExpired,
  onError,
}: {
  email: string | null;
  targetName: string;
  onDisconnected: () => void;
  onExpired: () => void;
  onError: (message: string) => void;
}) {
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResultState>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  // Inline two-step disconnect confirm: window.confirm is a silent no-op in
  // the Tauri webview on macOS (see WorkspacesSection.tsx, DetailPane.tsx:306,
  // commit d229d84). Arms on the first "Odpojit" click, swaps the button for
  // a warning + Potvrdit/Zrušit pair.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleTest() {
    setTestBusy(true);
    setTestResult(null);
    try {
      const result = await testDrive();
      if (!mountedRef.current) return;
      if (result.ok) {
        setTestResult({ kind: "ok" });
      } else if (result.code) {
        setTestResult({ kind: "code", code: result.code });
        if (result.code === "TOKEN_INVALID") {
          invalidateSyncStatusCache();
          onExpired();
        }
      } else {
        setTestResult({ kind: "unknown", message: "Test se nezdařil." });
      }
    } catch (e) {
      if (mountedRef.current) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setTestBusy(false);
    }
  }

  async function handleDisconnect() {
    setConfirmingDisconnect(false);
    setDisconnectBusy(true);
    try {
      await disconnectDrive();
      invalidateSyncStatusCache();
      onDisconnected();
    } catch (e) {
      if (mountedRef.current) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setDisconnectBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13.5px] text-[var(--color-text)]">
        Propojeno jako{" "}
        <span className="font-medium">{email ?? "—"}</span>
        {" → "}
        <span className="font-medium">{targetName}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={testBusy}
          onClick={() => void handleTest()}
          className="rounded border border-[var(--color-border)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testBusy ? "Testuji…" : "Otestovat připojení"}
        </button>
        {confirmingDisconnect ? (
          <>
            <button
              type="button"
              disabled={disconnectBusy}
              onClick={() => void handleDisconnect()}
              className="rounded border border-red-900/50 bg-red-950/20 px-2.5 py-1.5 text-[12.5px] font-medium text-red-300 transition-colors hover:border-red-800 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {disconnectBusy ? "…" : "Potvrdit"}
            </button>
            <button
              type="button"
              disabled={disconnectBusy}
              onClick={() => setConfirmingDisconnect(false)}
              className="rounded border border-[var(--color-border)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Zrušit
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disconnectBusy}
            onClick={() => setConfirmingDisconnect(true)}
            className="rounded border border-[var(--color-border)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text-dim)] transition-colors hover:border-red-900/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Odpojit
          </button>
        )}
      </div>

      {confirmingDisconnect && (
        <div className="max-w-[420px] text-[11px] leading-snug text-[var(--color-text-dim)]">
          {DISCONNECT_CONFIRM_MESSAGE}
        </div>
      )}

      {testResult?.kind === "ok" && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12.5px] text-green-400">
          Připojení funguje.
        </div>
      )}
      {testResult?.kind === "code" && (
        <div className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          {testResultMessage(testResult.code)}
        </div>
      )}
      {testResult?.kind === "unknown" && (
        <div className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[12.5px] text-red-300">
          {testResult.message}
        </div>
      )}
    </div>
  );
}

function testResultMessage(code: string): string {
  switch (code) {
    case "TOKEN_INVALID":
      return "Propojení vypršelo – přihlas se znovu.";
    case "TARGET_NOT_FOUND":
      return "Cílová složka nebyla nalezena.";
    case "DRIVE_UNREACHABLE":
      return "Google Drive je nedostupný.";
    default:
      return "Test se nezdařil.";
  }
}
