import type { NodeDetail } from "../types";

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
 * reads it on its own rather than being told it upfront. Any leftover
 * `{prompt}` placeholder from a template saved before this change is
 * stripped -- there is no prompt to substitute anymore.
 */
export function buildAgentCommand(node: NodeDetail, template: string): string {
  const tpl = (template.trim() || "claude").replace(/\s*\{prompt\}\s*/g, " ").trim();

  if (node.local_mirror) {
    return `cd ${shellQuote(node.local_mirror.local_path)} && ${tpl}`;
  }
  return tpl;
}
