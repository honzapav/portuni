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
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation("settings");
  // Token rotation only applies to the local per-launch sidecar token. In
  // central data_mode the bearer credential is a device token managed in
  // Settings -> Account (revoke + re-mint), so the rotate button is hidden
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
              reason: t(($) => $.mcp.status.no_port),
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

  async function copy(text: string, copiedMessage: string) {
    try {
      await copyText(text);
      flash("ok", copiedMessage);
    } catch (e) {
      flash("err", t(($) => $.mcp.flash.copy_failed, { error: displayError(e) }));
    }
  }

  async function loadToken(): Promise<string | null> {
    if (token) return token;
    if (!isTauri()) {
      flash("err", t(($) => $.mcp.flash.token_desktop_only));
      return null;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const loaded = await invoke<string>("get_mcp_token");
      setToken(loaded);
      return loaded;
    } catch (e) {
      flash("err", t(($) => $.mcp.flash.token_load_failed, { error: displayError(e) }));
      return null;
    }
  }

  async function toggleTokenVisible() {
    if (!tokenVisible) {
      const loaded = await loadToken();
      if (loaded === null) return;
    }
    setTokenVisible((v) => !v);
  }

  async function copyToken() {
    const loaded = await loadToken();
    if (loaded) await copy(loaded, t(($) => $.mcp.flash.token_copied));
  }

  async function install(target: "claude" | "codex" | "vibe") {
    if (!isTauri()) {
      flash("err", t(($) => $.mcp.flash.install_desktop_only));
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
        flash("ok", t(($) => $.mcp.flash.install_written, { path }));
      }
    } catch (e) {
      flash("err", t(($) => $.mcp.flash.install_failed, { error: displayError(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    if (!isTauri()) {
      flash("err", t(($) => $.mcp.flash.regenerate_desktop_only));
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
      flash("ok", t(($) => $.mcp.flash.regenerated));
    } catch (e) {
      flash("err", t(($) => $.mcp.flash.regenerate_failed, { error: displayError(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
        {t(($) => $.mcp.title)}
      </div>
      <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {t(($) => $.mcp.intro)}
      </p>

      {status.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          {t(($) => $.mcp.status.loading)}
        </div>
      )}

      {status.kind === "error" && (
        <Alert variant="destructive">
          <AlertDescription>
            <Trans
              t={t}
              ns="settings"
              i18nKey={($) => $.mcp.status.unavailable}
              values={{ reason: status.reason }}
              components={{ mono: <span className="font-mono" /> }}
            />
          </AlertDescription>
        </Alert>
      )}

      {status.kind === "ok" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[100px_1fr] items-start gap-x-4 gap-y-2 text-[13px]">
            <div className="text-[var(--color-text-dim)]">{t(($) => $.mcp.fields.url)}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12.5px] text-[var(--color-text)]">
                {status.info.url}
              </code>
              <IconButton
                title={t(($) => $.mcp.fields.copy_url)}
                onClick={() => void copy(status.info.url, t(($) => $.mcp.flash.url_copied))}
              >
                <Copy />
              </IconButton>
            </div>

            <div className="text-[var(--color-text-dim)]">{t(($) => $.mcp.fields.token)}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12.5px] text-[var(--color-text)]">
                {tokenVisible && token
                  ? token
                  : status.info.has_auth_token
                    ? "••••••••••••••••••••••••••••••••••••••••••••••••"
                    : t(($) => $.mcp.fields.no_auth)}
              </code>
              {status.info.has_auth_token && (
                <>
                  <IconButton
                    title={
                      tokenVisible
                        ? t(($) => $.mcp.fields.hide_token)
                        : t(($) => $.mcp.fields.show_token)
                    }
                    onClick={() => void toggleTokenVisible()}
                  >
                    {tokenVisible ? <EyeOff /> : <Eye />}
                  </IconButton>
                  <IconButton title={t(($) => $.mcp.fields.copy_token)} onClick={() => void copyToken()}>
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
              {t(($) => $.mcp.actions.install_claude)}
            </ActionButton>
            <ActionButton
              busy={busy === "codex"}
              disabled={busy !== null || !isTauri()}
              onClick={() => void install("codex")}
            >
              {t(($) => $.mcp.actions.install_codex)}
            </ActionButton>
            <ActionButton
              busy={busy === "vibe"}
              disabled={busy !== null || !isTauri()}
              onClick={() => void install("vibe")}
            >
              {t(($) => $.mcp.actions.install_vibe)}
            </ActionButton>
            {dataMode?.mode === "local" && (
              <ActionButton
                busy={busy === "regenerate"}
                disabled={busy !== null || !isTauri()}
                onClick={() => void regenerate()}
                variant="ghost"
              >
                <RefreshCw />
                {t(($) => $.mcp.actions.regenerate)}
              </ActionButton>
            )}
          </div>

          {dataMode?.mode === "central" && (
            <div className="text-[12px] text-[var(--color-text-dim)]">
              {dataMode.server_url ? (
                <Trans
                  t={t}
                  ns="settings"
                  i18nKey={($) => $.mcp.central_note.with_url}
                  values={{ serverUrl: dataMode.server_url }}
                  components={{ mono: <span className="font-mono" /> }}
                />
              ) : (
                t(($) => $.mcp.central_note.without_url)
              )}
            </div>
          )}

          {!isTauri() && (
            <div className="text-[12px] text-[var(--color-text-dim)]">
              {t(($) => $.mcp.browser_only_note)}
            </div>
          )}

          {envHint && (
            <EnvTokenInstallHint
              agent={envHint.agent}
              path={envHint.path}
              loadToken={loadToken}
              onCopy={(text, copiedMessage) => void copy(text, copiedMessage)}
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
  onCopy: (text: string, copiedMessage: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("settings");
  const [exportLine, setExportLine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadToken();
      if (cancelled) return;
      if (loaded) setExportLine(`export PORTUNI_MCP_TOKEN='${loaded}'`);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadToken]);

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[12.5px] text-[var(--color-text-muted)]">
      <div className="mb-2 font-medium text-[var(--color-text)]">
        {t(($) => $.mcp.env_hint.written, { path })}
      </div>
      <p className="mb-2 leading-relaxed">
        <Trans
          t={t}
          ns="settings"
          i18nKey={($) => $.mcp.env_hint.body}
          values={{ agent }}
          components={{ code: <code className="font-mono text-[12px]" /> }}
        />
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[12px] text-[var(--color-text)]">
          {exportLine ?? t(($) => $.mcp.env_hint.loading_token)}
        </code>
        <IconButton
          title={t(($) => $.mcp.env_hint.copy_export)}
          onClick={() => {
            if (exportLine) onCopy(exportLine, t(($) => $.mcp.env_hint.export_copied));
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
          {t(($) => $.mcp.env_hint.dismiss)}
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
