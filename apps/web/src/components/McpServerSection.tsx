// MCP server section on the Settings page. Surfaces:
// - server status (URL, port, has-auth flag) read from /mcp/info in a
//   personal workspace; in a team workspace the device front door URL built
//   from the active workspace's mcp_port (apiFetch goes to the central server there, whose
//   /mcp/info would show the central URL -- not what the installed configs
//   point at, see workspace::global_front_door_url in apps/desktop)
// - the bearer token from Keychain (on demand, hidden by default)
// - one-click install into ~/.claude.json and ~/.codex/config.toml
// - token rotation
//
// Tauri-only actions (get_mcp_token, regenerate_mcp_token, install_*)
// are gated by isTauri(); in plain browser dev mode the buttons are
// disabled with an explanation, so the page still renders.

import { displayError } from "../errors";
import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFetch, isTauri } from "../lib/backend-url";
import { useDataMode } from "../lib/central";
import { listWorkspaces } from "../lib/workspaces";
import { copyText } from "../lib/clipboard";

type McpInfo = {
  url: string;
  port: number;
  has_auth_token: boolean;
};

type Status =
  | { kind: "loading" }
  | { kind: "ok"; info: McpInfo }
  | { kind: "error"; reason: string };

export default function McpServerSection() {
  // Token rotation only applies to the local per-launch sidecar token. In
  // central data_mode the bearer credential is a device token managed in
  // Settings -> Ucet (revoke + re-mint), so the rotate button is hidden
  // there. null while loading: keep the button hidden to avoid flicker.
  const dataMode = useDataMode();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [token, setToken] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Persistent "set the env var" hint shown after a successful Codex or
  // Vibe install — both read the bearer token from PORTUNI_MCP_TOKEN
  // rather than a literal in the config file. Sticky (no timeout) because
  // it carries an action the user still needs to take. Cleared when the
  // user dismisses it or runs a different install.
  const [envHint, setEnvHint] = useState<{ agent: string; path: string } | null>(null);

  useEffect(() => {
    // Wait for the data mode: the source of the URL differs per mode.
    if (!dataMode) return;
    let cancelled = false;
    void (async () => {
      try {
        if (dataMode.mode === "central") {
          // Local front door of the sync agent: what install_claude_global
          // and the per-mirror configs write. The sidecar is always
          // bearer-gated in the desktop shell (PORTUNI_AUTH_TOKEN).
          const ws = (await listWorkspaces()).find((w) => w.active);
          if (cancelled) return;
          if (!ws || ws.mcp_port === null) {
            setStatus({
              kind: "error",
              reason: "aktivní workspace nemá přiřazený MCP port",
            });
            return;
          }
          setStatus({
            kind: "ok",
            info: {
              url: `http://127.0.0.1:${ws.mcp_port}/mcp`,
              port: ws.mcp_port,
              has_auth_token: true,
            },
          });
          return;
        }
        const res = await apiFetch("/mcp/info");
        if (!res.ok) {
          if (!cancelled)
            setStatus({ kind: "error", reason: `HTTP ${res.status}` });
          return;
        }
        const info = (await res.json()) as McpInfo;
        if (!cancelled) setStatus({ kind: "ok", info });
      } catch (e) {
        if (!cancelled)
          setStatus({
            kind: "error",
            reason: displayError(e),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataMode]);

  function flash(kind: "ok" | "err", text: string) {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage(null), 3500);
  }

  async function copy(text: string, label: string) {
    try {
      await copyText(text);
      flash("ok", `${label} zkopírováno do schránky`);
    } catch (e) {
      flash("err", `Kopírování selhalo: ${displayError(e)}`);
    }
  }

  async function loadToken(): Promise<string | null> {
    if (token) return token;
    if (!isTauri()) {
      flash("err", "Token je dostupný jen v desktop appce.");
      return null;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const t = await invoke<string>("get_mcp_token");
      setToken(t);
      return t;
    } catch (e) {
      flash("err", `Nepodařilo se načíst token: ${displayError(e)}`);
      return null;
    }
  }

  async function toggleTokenVisible() {
    if (!tokenVisible) {
      const t = await loadToken();
      if (t === null) return;
    }
    setTokenVisible((v) => !v);
  }

  async function copyToken() {
    const t = await loadToken();
    if (t) await copy(t, "Token");
  }

  async function install(target: "claude" | "codex" | "vibe") {
    if (!isTauri()) {
      flash("err", "Instalaci konfigurace lze spustit jen z desktop appky.");
      return;
    }
    setBusy(target);
    setEnvHint(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cmd =
        target === "claude"
          ? "install_claude_global"
          : target === "codex"
            ? "install_codex_global"
            : "install_vibe_global";
      const path = await invoke<string>(cmd);
      if (target === "codex" || target === "vibe") {
        // Both Codex and Vibe resolve the bearer token from an env var
        // (env var indirection), not a literal in the config file. Make
        // sure the user is told to set PORTUNI_MCP_TOKEN in their shell rc
        // — without it the agent sees the server but fails every tool
        // call with 401.
        setEnvHint({ agent: target === "codex" ? "Codex" : "Vibe", path });
        setMessage(null);
      } else {
        flash("ok", `Zapsáno do ${path}`);
      }
    } catch (e) {
      flash("err", `Chyba: ${displayError(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    if (!isTauri()) {
      flash("err", "Rotace tokenu je dostupná jen z desktop appky.");
      return;
    }
    // window.confirm() is a no-op in the Tauri webview (see d229d84).
    // The button is labelled explicitly and only visible in the desktop
    // shell, so a single click is a deliberate gesture.
    setBusy("regenerate");
    setEnvHint(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const fresh = await invoke<string>("regenerate_mcp_token");
      setToken(fresh);
      setTokenVisible(true);
      flash(
        "ok",
        "Nový token vygenerován. Nezapomeň znovu spustit instalaci pro Claude Code, Codex i Vibe.",
      );
    } catch (e) {
      flash("err", `Chyba: ${displayError(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        MCP server
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        Endpoint, ke kterému se připojuje Claude Code, Codex a Mistral Vibe.
        Token žije v macOS Keychain a přežívá restarty appky.
      </p>

      {status.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          Zjišťuji stav serveru…
        </div>
      )}

      {status.kind === "error" && (
        <Alert variant="destructive">
          <AlertDescription>
            MCP server není dostupný: <span className="font-mono">{status.reason}</span>
          </AlertDescription>
        </Alert>
      )}

      {status.kind === "ok" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[100px_1fr] items-start gap-x-4 gap-y-2 text-[13px]">
            <div className="text-[var(--color-text-dim)]">URL</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12.5px] text-[var(--color-text)]">
                {status.info.url}
              </code>
              <IconButton
                title="Kopírovat URL"
                onClick={() => void copy(status.info.url, "URL")}
              >
                <Copy />
              </IconButton>
            </div>

            <div className="text-[var(--color-text-dim)]">Token</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12.5px] text-[var(--color-text)]">
                {tokenVisible && token
                  ? token
                  : status.info.has_auth_token
                    ? "••••••••••••••••••••••••••••••••••••••••••••••••"
                    : "(server bez auth)"}
              </code>
              {status.info.has_auth_token && (
                <>
                  <IconButton
                    title={tokenVisible ? "Skrýt token" : "Zobrazit token"}
                    onClick={() => void toggleTokenVisible()}
                  >
                    {tokenVisible ? <EyeOff /> : <Eye />}
                  </IconButton>
                  <IconButton title="Kopírovat token" onClick={() => void copyToken()}>
                    <Copy />
                  </IconButton>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
            <ActionButton
              busy={busy === "claude"}
              disabled={busy !== null || !isTauri()}
              onClick={() => void install("claude")}
            >
              Přidat do Claude Code (~/.claude.json)
            </ActionButton>
            <ActionButton
              busy={busy === "codex"}
              disabled={busy !== null || !isTauri()}
              onClick={() => void install("codex")}
            >
              Přidat do Codexu (~/.codex/config.toml)
            </ActionButton>
            <ActionButton
              busy={busy === "vibe"}
              disabled={busy !== null || !isTauri()}
              onClick={() => void install("vibe")}
            >
              Přidat do Vibu (~/.vibe/config.toml)
            </ActionButton>
            {dataMode?.mode === "local" && (
              <ActionButton
                busy={busy === "regenerate"}
                disabled={busy !== null || !isTauri()}
                onClick={() => void regenerate()}
                variant="ghost"
              >
                <RefreshCw />
                Vygenerovat nový token
              </ActionButton>
            )}
          </div>

          {dataMode?.mode === "central" && (
            <div className="text-[12px] text-[var(--color-text-dim)]">
              Front door na tomto zařízení: nástroje grafu se proxují na{" "}
              <span className="font-mono">{dataMode.server_url ?? "centrální server"}</span>,
              nástroje pro soubory a složky běží na tomto zařízení. Token
              patří front dooru na tomto zařízení; device token pro centrální server
              se spravuje v sekci Účet.
            </div>
          )}

          {!isTauri() && (
            <div className="text-[12px] text-[var(--color-text-dim)]">
              Akce výše fungují pouze v desktop appce; v dev režimu prohlížeče
              jsou vypnuté.
            </div>
          )}

          {envHint && (
            <EnvTokenInstallHint
              agent={envHint.agent}
              path={envHint.path}
              loadToken={loadToken}
              onCopy={(text, label) => void copy(text, label)}
              onDismiss={() => setEnvHint(null)}
            />
          )}
        </div>
      )}

      {message && (
        <Alert
          role="status"
          variant={message.kind === "ok" ? "default" : "destructive"}
          className="mt-4"
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

// Sticky post-install hint for agents that read the bearer token from an
// env var rather than a literal in their config file. Codex's
// streamable_http transport refuses a literal bearer_token ("not
// supported for streamable_http"); Vibe uses `api_key_env` by design.
// In both cases we write the env-var reference on disk, so the user has
// to set PORTUNI_MCP_TOKEN once in their shell rc.
function EnvTokenInstallHint({
  agent,
  path,
  loadToken,
  onCopy,
  onDismiss,
}: {
  agent: string;
  path: string;
  loadToken: () => Promise<string | null>;
  onCopy: (text: string, label: string) => void;
  onDismiss: () => void;
}) {
  const [exportLine, setExportLine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const t = await loadToken();
      if (cancelled) return;
      if (t) setExportLine(`export PORTUNI_MCP_TOKEN='${t}'`);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadToken]);

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[12.5px] text-[var(--color-text-muted)]">
      <div className="mb-2 font-medium text-[var(--color-text)]">
        Zapsáno do {path}
      </div>
      <p className="mb-2 leading-relaxed">
        {agent} načítá bearer token z proměnné prostředí — token v
        config.toml nepoužije. Přidej tenhle řádek na konec{" "}
        <code className="font-mono text-[12px]">~/.zshrc</code> (nebo svého
        shell rc) a otevři nový terminál:
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[12px] text-[var(--color-text)]">
          {exportLine ?? "Načítám token..."}
        </code>
        <IconButton
          title="Kopírovat export"
          onClick={() => {
            if (exportLine) onCopy(exportLine, "Export");
          }}
        >
          <Copy />
        </IconButton>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          className="text-muted-foreground"
        >
          Skrýt
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      title={title}
      onClick={onClick}
      className="shrink-0"
    >
      {children}
    </Button>
  );
}

function ActionButton({
  busy,
  disabled,
  onClick,
  children,
  variant,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
  variant?: "ghost";
}) {
  return (
    <Button
      type="button"
      variant={variant === "ghost" ? "ghost" : "outline"}
      disabled={disabled}
      onClick={onClick}
      className={variant === "ghost" ? "text-muted-foreground" : undefined}
    >
      {busy ? "…" : children}
    </Button>
  );
}
