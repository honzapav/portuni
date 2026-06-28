// User settings persisted in localStorage. Currently just the agent command
// template used when copying a launch command from a node's detail pane.

const AGENT_COMMAND_KEY = "portuni:agentCommand";

// Template uses {prompt} as a placeholder for the shell-escaped prompt.
// If the template has no placeholder, the prompt is appended as the last arg.
export const DEFAULT_AGENT_COMMAND = "claude {prompt}";

export type AgentPreset = {
  id: string;
  label: string;
  command: string;
  hint?: string;
};

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude {prompt}",
    hint: "Launches claude with the prompt as the first user message.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    command: "codex {prompt}",
    hint: "OpenAI Codex CLI.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini -p {prompt}",
    hint: "Google Gemini CLI, prompt mode.",
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    command: "cursor-agent {prompt}",
    hint: "Cursor CLI agent.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode run {prompt}",
    hint: "OpenCode CLI, one-shot run with the prompt.",
  },
  {
    id: "vibe",
    // --trust force-trusts the mirror for this session so Vibe loads the
    // per-mirror ./.vibe/config.toml (which carries ?home_node_id=... for
    // scope auto-seed). Without it, Vibe ignores project config in folders
    // not on its persistent trust list and the session starts unscoped.
    // Session-only: never written to the user's trusted_folders.toml.
    command: "vibe --trust {prompt}",
    label: "Mistral Vibe",
    hint: "Mistral Vibe CLI; trusts the mirror so it auto-seeds Portuni scope.",
  },
];

// One-shot migrations for agent commands stored before a preset gained a
// required flag. Selecting a preset persists its command string verbatim,
// so a later change to AGENT_PRESETS does NOT reach users who already
// picked it — we upgrade the stored value on load instead. Keyed by exact
// old string so a user's hand-customised command is never touched.
const AGENT_COMMAND_MIGRATIONS: Record<string, string> = {
  // Vibe needs --trust so Portuni-spawned terminals load the per-mirror
  // ./.vibe/config.toml (scope auto-seed). Stored before that was added.
  "vibe {prompt}": "vibe --trust {prompt}",
};

export function loadAgentCommand(): string {
  if (typeof window === "undefined") return DEFAULT_AGENT_COMMAND;
  const stored = window.localStorage.getItem(AGENT_COMMAND_KEY);
  if (!stored?.trim()) return DEFAULT_AGENT_COMMAND;
  const migrated = AGENT_COMMAND_MIGRATIONS[stored.trim()];
  if (migrated) {
    window.localStorage.setItem(AGENT_COMMAND_KEY, migrated);
    return migrated;
  }
  return stored;
}

export function saveAgentCommand(template: string): void {
  window.localStorage.setItem(AGENT_COMMAND_KEY, template);
}

// Display name for the agent the current template invokes. Used by
// "Spustit X" / "spustí X" labels in the UI so they reflect Settings.
// Falls back to the capitalised first token of the template when the
// user has typed a custom command — accurate for any well-formed
// invocation (`codex {prompt}`, `gemini -p {prompt}`, `my-agent ...`).
export function agentDisplayName(template: string): string {
  const bin = template.trim().split(/\s+/)[0] ?? "";
  if (!bin) return "agenta";
  return bin[0].toUpperCase() + bin.slice(1);
}

// --- Terminal launch -------------------------------------------------------
//
// A second axis next to agentCommand: which terminal emulator the "Spustit
// <agent>" action opens. Runs as `sh -c <template>` from the Tauri host with
// these env vars exposed, so one template covers Terminal.app, iTerm2,
// Ghostty, Warp, cmux, or anything else without per-terminal Rust code:
//   $PORTUNI_CWD         working directory of the node
//   $PORTUNI_COMMAND     full shell command (cd '<path>' && claude '<prompt>')
//   $PORTUNI_COMMAND_AS  same command, escaped for AppleScript double-quoted
//                        strings (\ -> \\, " -> \"), drops straight into a
//                        `do script "..."` without further work.
const TERMINAL_LAUNCH_KEY = "portuni:terminalLaunch";

// Default: Terminal.app via osascript. Carries the cold-start two-window fix
// (a fresh Terminal launch opens a startup window AND a do-script window; we
// detect that and reuse window 1) so the default behaves like the old
// hardcoded launcher.
export const DEFAULT_TERMINAL_LAUNCH = `osascript <<AS
set wasRunning to application "Terminal" is running
tell application "Terminal"
	activate
	if not wasRunning then
		repeat 40 times
			if (count windows) > 0 then exit repeat
			delay 0.05
		end repeat
		if (count windows) > 0 then
			do script "$PORTUNI_COMMAND_AS" in window 1
		else
			do script "$PORTUNI_COMMAND_AS"
		end if
	else
		do script "$PORTUNI_COMMAND_AS"
	end if
end tell
AS`;

export type TerminalPreset = {
  id: string;
  label: string;
  template: string;
  hint?: string;
};

export const TERMINAL_PRESETS: TerminalPreset[] = [
  {
    id: "terminal_app",
    label: "Terminal.app",
    template: DEFAULT_TERMINAL_LAUNCH,
    hint: "Výchozí macOS terminál.",
  },
  {
    id: "iterm2",
    label: "iTerm2",
    template: `osascript <<AS
tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow to write text "$PORTUNI_COMMAND_AS"
end tell
AS`,
    hint: "Otevře nové okno iTerm2 a pošle příkaz přes write text.",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    template: `TMP=$(mktemp -t portuni-launch)
{
  echo '#!/bin/zsh -l'
  echo '[[ -f ~/.zshrc ]] && source ~/.zshrc'
  printf '%s\\n' "$PORTUNI_COMMAND"
  echo 'exec /bin/zsh -i'
} > "$TMP"
chmod +x "$TMP"
open -na Ghostty.app --args -e "$TMP"`,
    hint: "Spustí Ghostty s login zsh skriptem (sources /etc/zprofile + ~/.zshrc, takže Homebrew/claude jsou v PATH). Po doběhu příkazu zůstane okno otevřené.",
  },
  {
    id: "warp",
    label: "Warp (jen otevře složku)",
    template: `open "warp://action/new_tab?path=$PORTUNI_CWD"`,
    hint: "Warp neumí přes URL pustit příkaz – agenta spustíš ručně.",
  },
  {
    id: "cmux",
    label: "cmux",
    template: `CMUX="$\{CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"
[ -x "$CMUX" ] || { echo "cmux CLI not found at $CMUX (set \\$CMUX_BIN to override)" >&2; exit 1; }
[ -d "$PORTUNI_CWD" ] || { echo "cwd does not exist: $PORTUNI_CWD" >&2; exit 1; }
WS_OUT=$("$CMUX" "$PORTUNI_CWD" 2>&1)
WS=$(echo "$WS_OUT" | grep -oE 'workspace:[0-9]+' | head -1)
if [ -z "$WS" ]; then
  echo "cmux <path> did not return a workspace id. cwd=$PORTUNI_CWD output=[$WS_OUT]" >&2
  exit 1
fi
sleep 1
TMP=$(mktemp -t portuni)
printf '%s\\n' "$PORTUNI_COMMAND" > "$TMP"
"$CMUX" send --workspace "$WS" "bash '$TMP'; rm -f '$TMP'" 2>&1 | grep -v '^OK ' >&2
"$CMUX" send-key --workspace "$WS" enter 2>&1 | grep -v '^OK ' >&2`,
    hint: "Vytvoří cmux workspace v pracovní složce a pošle do něj příkaz. Cílí příkaz konkrétnímu workspace, ne fokusovanému (řeší race po novém workspace).",
  },
];

export function loadTerminalLaunch(): string {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_LAUNCH;
  const stored = window.localStorage.getItem(TERMINAL_LAUNCH_KEY);
  return stored?.trim() ? stored : DEFAULT_TERMINAL_LAUNCH;
}

export function saveTerminalLaunch(template: string): void {
  window.localStorage.setItem(TERMINAL_LAUNCH_KEY, template);
}
