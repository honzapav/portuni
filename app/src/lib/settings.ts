// User settings persisted in localStorage. Two templates:
//   - agentCommand: how to invoke the AI agent itself (claude / codex / ...).
//   - terminalLaunch: which terminal to spawn and how. Runs as `sh -c <template>`
//     on macOS with PORTUNI_CWD / PORTUNI_COMMAND / PORTUNI_COMMAND_AS env vars
//     exposed, so the same template handles Terminal.app, iTerm2, Ghostty,
//     Warp, cmux, or anything else without per-terminal Rust code.

const AGENT_COMMAND_KEY = "portuni:agentCommand";
const TERMINAL_LAUNCH_KEY = "portuni:terminalLaunch";

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
];

export function loadAgentCommand(): string {
  if (typeof window === "undefined") return DEFAULT_AGENT_COMMAND;
  const stored = window.localStorage.getItem(AGENT_COMMAND_KEY);
  return stored?.trim() ? stored : DEFAULT_AGENT_COMMAND;
}

export function saveAgentCommand(template: string): void {
  window.localStorage.setItem(AGENT_COMMAND_KEY, template);
}

// Terminal launch template. Runs as `sh -c <template>` from the Tauri host.
// Exposed env vars:
//   $PORTUNI_CWD         working directory of the node
//   $PORTUNI_COMMAND     shell command to run (cd '<path>' && claude '<prompt>')
//   $PORTUNI_COMMAND_AS  same command, escaped for AppleScript double-quoted
//                        strings (\ -> \\, " -> \"), so it drops straight
//                        into `do script "..."` without further work.
export const DEFAULT_TERMINAL_LAUNCH = `osascript <<AS
tell application "Terminal"
  activate
  do script "$PORTUNI_COMMAND_AS"
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
  tell current session of newWindow to write text "$PORTUNI_COMMAND"
end tell
AS`,
    hint: "Otevře nové okno iTerm2 a pošle příkaz přes write text.",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    template: `open -na Ghostty.app --args -e "$PORTUNI_COMMAND"`,
    hint: "Spustí Ghostty v novém okně s příkazem.",
  },
  {
    id: "warp",
    label: "Warp (jen otevře složku)",
    template: `open "warp://action/new_tab?path=$PORTUNI_CWD"`,
    hint: "Warp neumí pres URL pustit příkaz – Claude spustíš ručně.",
  },
  {
    id: "cmux",
    label: "cmux",
    template: `open -a cmux.app "$PORTUNI_CWD"`,
    hint: "Otevře cmux ve složce. Příkaz ti vloží do bufferu, spustíš sám.",
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
