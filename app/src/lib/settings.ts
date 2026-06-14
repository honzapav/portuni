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
