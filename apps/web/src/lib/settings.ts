// User settings persisted in localStorage. Currently just the agent command
// template used when copying a launch command from a node's detail pane.

import { scopedKey } from "./workspace-storage";

// Exported so App.tsx's cross-window storage-event sync (#228) can tell
// this global-preference key apart from workspace-scoped ones.
export const AGENT_COMMAND_KEY = "portuni:agentCommand";

// No automatic first prompt (spec: "Spawn UX") -- the terminal starts empty
// and ready, so the command is just the plain CLI invocation. A `{prompt}`
// placeholder is still tolerated (and stripped) for commands saved before
// this change; it has no meaning going forward.
export const DEFAULT_AGENT_COMMAND = "claude";

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
    command: "claude",
    hint: "Spustí Claude Code s prázdným, připraveným terminálem.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    command: "codex",
    hint: "OpenAI Codex CLI.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    hint: "Google Gemini CLI.",
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    command: "cursor-agent",
    hint: "Cursor CLI agent.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    hint: "OpenCode CLI, interaktivní TUI.",
  },
  {
    id: "vibe",
    // --trust force-trusts the mirror for this session so Vibe loads the
    // per-mirror ./.vibe/config.toml (which carries ?home_node_id=... for
    // scope auto-seed). Without it, Vibe ignores project config in folders
    // not on its persistent trust list and the session starts unscoped.
    // Session-only: never written to the user's trusted_folders.toml.
    command: "vibe --trust",
    label: "Mistral Vibe",
    hint: "Mistral Vibe CLI; označí mirror jako důvěryhodný, takže se automaticky nasadí scope Portuni.",
  },
];

// One-shot migrations for agent commands stored before a preset's command
// string changed shape. Selecting a preset persists its command string
// verbatim, so a later change to AGENT_PRESETS does NOT reach users who
// already picked it -- we upgrade the stored value on load instead. Keyed by
// exact old string so a user's hand-customised command is never touched.
// Applied repeatedly until no key matches, so multi-step migrations (e.g. a
// command that changed twice) converge in a single load.
const AGENT_COMMAND_MIGRATIONS: Record<string, string> = {
  // The automatic first prompt was removed -- every preset that used to
  // carry {prompt} as an argument now runs bare.
  "claude {prompt}": "claude",
  "codex {prompt}": "codex",
  "gemini -p {prompt}": "gemini",
  "cursor-agent {prompt}": "cursor-agent",
  "opencode --prompt {prompt}": "opencode",
  "opencode run {prompt}": "opencode",
  // Vibe needs --trust so Portuni-spawned terminals load the per-mirror
  // ./.vibe/config.toml (scope auto-seed). Stored before that was added.
  "vibe {prompt}": "vibe --trust",
  "vibe --trust {prompt}": "vibe --trust",
};

// Bound on the migration chain below so a cyclic table (a bug, not a valid
// state) can never hang loadAgentCommand -- longest real chain today is 2.
const AGENT_COMMAND_MIGRATIONS_MAX_HOPS = 5;

export function loadAgentCommand(): string {
  if (typeof window === "undefined") return DEFAULT_AGENT_COMMAND;
  const stored = window.localStorage.getItem(AGENT_COMMAND_KEY);
  if (!stored?.trim()) return DEFAULT_AGENT_COMMAND;
  let current = stored.trim();
  for (let i = 0; i < AGENT_COMMAND_MIGRATIONS_MAX_HOPS; i++) {
    const migrated = AGENT_COMMAND_MIGRATIONS[current];
    if (!migrated || migrated === current) break;
    current = migrated;
  }
  if (current !== stored) {
    window.localStorage.setItem(AGENT_COMMAND_KEY, current);
  }
  return current;
}

export function saveAgentCommand(template: string): void {
  window.localStorage.setItem(AGENT_COMMAND_KEY, template);
}

// Display name for the agent the current template invokes. Used by
// "Spustit X" / "spustí X" labels in the UI so they reflect Settings.
// Falls back to the capitalised first token of the template when the
// user has typed a custom command — accurate for any well-formed
// invocation (`codex`, `gemini --foo`, `my-agent ...`).
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
//   $PORTUNI_COMMAND     full shell command (cd '<path>' && claude)
//   $PORTUNI_COMMAND_AS  same command, escaped for AppleScript double-quoted
//                        strings (\ -> \\, " -> \"), drops straight into a
//                        `do script "..."` without further work.
// Exported so App.tsx's cross-window storage-event sync (#228) can tell
// this global-preference key apart from workspace-scoped ones.
export const TERMINAL_LAUNCH_KEY = "portuni:terminalLaunch";

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

// Showtime integration (Settings -> Integrace). Off by default: with it on, a
// `.showtime` deck opens in the rendered preview (the preview.html Showtime
// packs into the bundle) and the preview offers "Otevřít v Showtime" when
// the app is installed. Off, the bundle is a binary file like any other.
const SHOWTIME_KEY = "portuni:showtime";

export function loadShowtimeEnabled(): boolean {
  try {
    return window.localStorage.getItem(SHOWTIME_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowtimeEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(SHOWTIME_KEY, "1");
    else window.localStorage.removeItem(SHOWTIME_KEY);
  } catch {
    // localStorage unavailable -- the flag stays off for this session.
  }
}

// --- Open workspace nodes --------------------------------------------------
//
// The set of nodes the user has open in the Práce view, persisted so the
// working set survives an app restart. Terminals (PTYs) cannot be restored,
// but the list of open nodes can. Stored as a JSON array of node ids; ids
// that no longer exist are pruned against the graph on load (in App).
// Workspace-scoped (#228): two windows must not share which nodes are open.
const OPEN_NODES_KEY = "openNodes";

export function loadOpenNodes(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(scopedKey(OPEN_NODES_KEY));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function saveOpenNodes(ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(scopedKey(OPEN_NODES_KEY), JSON.stringify(ids));
}

// --- File tree collapsed folders --------------------------------------------
//
// Which folders the user collapsed in a node's file tree, per node, so the
// tree doesn't reset to fully expanded every time the node detail remounts
// (switching node, switching tab and back, app restart). Stored as
// { [nodeId]: string[] } (TreeNode.path values); a node's entry is removed
// once its collapsed set is empty. Workspace-scoped (#228).
const COLLAPSED_FOLDERS_KEY = "fileTreeCollapsed";

export function loadCollapsedFolders(nodeId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(scopedKey(COLLAPSED_FOLDERS_KEY));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    const paths = parsed[nodeId];
    if (!Array.isArray(paths)) return new Set();
    return new Set(paths.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolders(nodeId: string, paths: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    const key = scopedKey(COLLAPSED_FOLDERS_KEY);
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    const all = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    if (paths.size === 0) {
      delete all[nodeId];
    } else {
      all[nodeId] = Array.from(paths);
    }
    window.localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // localStorage unavailable/full — collapsed state stays in-memory only.
  }
}
