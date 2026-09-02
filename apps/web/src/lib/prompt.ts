import type { NodeDetail } from "../types";
import { DEFAULT_AGENT_COMMAND } from "./settings";

// POSIX single-quote escape. Safe for arbitrary content (newlines,
// backticks, $, quotes). Internal single quotes are closed, escaped, reopened.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a full shell command that cd's into the node's local mirror (if any)
 * and launches the user's configured agent command, unmodified.
 *
 * The terminal starts empty and ready -- no orientation prompt is generated
 * or injected. Everything an agent used to need a first message for (node
 * context, responsibilities, recent events, a handoff pointer for resumed
 * work) lives in `PORTUNI_SCOPE.md` in the mirror instead, so the agent
 * reads it on its own rather than being told it upfront. `{prompt}` is a
 * placeholder from a template saved before this change; settings.ts's
 * AGENT_COMMAND_MIGRATIONS upgrades every *exact* known preset string on
 * load, but a hand-customized template built around one (e.g. `gemini -p
 * {prompt} --yolo`) never matches that table exactly. Blindly stripping just
 * the placeholder would leave its preceding flag dangling with the next
 * token as its value (`gemini -p --yolo`); since there is no prompt to
 * substitute anymore and no reliable way to tell which flag, if any,
 * belonged to the placeholder, an unmigrated `{prompt}` here falls back to
 * the default command instead of guessing.
 */
export function buildAgentCommand(node: NodeDetail, template: string): string {
  const trimmed = template.trim() || DEFAULT_AGENT_COMMAND;
  const tpl = /\{prompt\}/.test(trimmed) ? DEFAULT_AGENT_COMMAND : trimmed;

  if (node.local_mirror) {
    return `cd ${shellQuote(node.local_mirror.local_path)} && ${tpl}`;
  }
  return tpl;
}
