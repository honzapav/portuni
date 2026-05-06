// MCP server section on the Settings page. Surfaces:
// - server status (URL, port, has-auth flag) read from /mcp/info
// - the bearer token from Keychain (on demand, hidden by default)
// - one-click install into ~/.claude.json and ~/.codex/config.toml
// - token rotation
//
// Tauri-only actions (get_mcp_token, regenerate_mcp_token, install_*)
// are gated by isTauri(); in plain browser dev mode the buttons are
// disabled with an explanation, so the page still renders.

import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { apiFetch, isTauri } from "../lib/backend-url";

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
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [token, setToken] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
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
            reason: e instanceof Error ? e.message : String(e),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function flash(kind: "ok" | "err", text: string) {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage(null), 3500);
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      flash("ok", `${label} zkopírováno do schránky`);
    } catch (e) {
      flash("err", `Kopírování selhalo: ${e instanceof Error ? e.message : String(e)}`);
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
      flash("err", `Nepodařilo se načíst token: ${e instanceof Error ? e.message : String(e)}`);
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

  async function install(target: "claude" | "codex") {
    if (!isTauri()) {
      flash("err", "Instalaci konfigurace lze spustit jen z desktop appky.");
      return;
    }
    setBusy(target);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cmd = target === "claude" ? "install_claude_global" : "install_codex_global";
      const path = await invoke<string>(cmd);
      flash("ok", `Zapsáno do ${path}`);
    } catch (e) {
      flash("err", `Chyba: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    if (!isTauri()) {
      flash("err", "Rotace tokenu je dostupná jen z desktop appky.");
      return;
    }
    const ok = window.confirm(
      "Vygenerovat nový MCP token? Všechny existující .mcp.json a externí konfigurace přestanou fungovat, dokud znovu neklikneš \"Přidat do Claude Code\" / \"Přidat do Codexu\".",
    );
    if (!ok) return;
    setBusy("regenerate");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const fresh = await invoke<string>("regenerate_mcp_token");
      setToken(fresh);
      setTokenVisible(true);
      flash(
        "ok",
        "Nový token vygenerován. Nezapomeň znovu spustit instalaci pro Claude Code i Codex.",
      );
    } catch (e) {
      flash("err", `Chyba: ${e instanceof Error ? e.message : String(e)}`);
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
        Endpoint, ke kterému se připojuje Claude Code a Codex. Token žije
        v macOS Keychain a přežívá restarty appky.
      </p>

      {status.kind === "loading" && (
        <div className="text-[13px] text-[var(--color-text-dim)]">
          Zjišťuji stav serveru…
        </div>
      )}

      {status.kind === "error" && (
        <div className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-[13px] text-red-300">
          MCP server není dostupný: <span className="font-mono">{status.reason}</span>
        </div>
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
                <Copy size={12} />
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
                    {tokenVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                  </IconButton>
                  <IconButton title="Kopírovat token" onClick={() => void copyToken()}>
                    <Copy size={12} />
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
              busy={busy === "regenerate"}
              disabled={busy !== null || !isTauri()}
              onClick={() => void regenerate()}
              variant="ghost"
            >
              <RefreshCw size={11} className="mr-1.5" />
              Vygenerovat nový token
            </ActionButton>
          </div>

          {!isTauri() && (
            <div className="text-[12px] text-[var(--color-text-dim)]">
              Akce výše fungují pouze v desktop appce; v dev režimu prohlížeče
              jsou vypnuté.
            </div>
          )}
        </div>
      )}

      {message && (
        <div
          role="status"
          className={`mt-4 rounded-md border px-3 py-2 text-[12.5px] ${
            message.kind === "ok"
              ? "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"
              : "border-red-900/50 bg-red-950/20 text-red-300"
          }`}
        >
          {message.text}
        </div>
      )}
    </section>
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
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
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
  const base =
    "flex items-center rounded-md border px-3 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "ghost"
      ? "border-[var(--color-border)] bg-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:border-[var(--color-border-strong)]";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${styles}`}
    >
      {busy ? "…" : children}
    </button>
  );
}
