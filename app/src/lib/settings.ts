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
];

export function loadAgentCommand(): string {
  if (typeof window === "undefined") return DEFAULT_AGENT_COMMAND;
  const stored = window.localStorage.getItem(AGENT_COMMAND_KEY);
  return stored && stored.trim() ? stored : DEFAULT_AGENT_COMMAND;
}

export function saveAgentCommand(template: string): void {
  window.localStorage.setItem(AGENT_COMMAND_KEY, template);
}
