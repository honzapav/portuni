import type { NodeDetail } from "../types";

/**
 * Build an agent-ready prompt from a node detail payload.
 *
 * The prompt is a pointer, not a cached truth: it tells the agent to call
 * portuni_get_node first so state stays honest. The snapshot that follows is
 * for orientation only.
 */
export function buildAgentPrompt(node: NodeDetail): string {
  const lines: string[] = [];

  lines.push(
    `You are working on the Portuni node **${node.name}** (type: ${node.type}, id: \`${node.id}\`).`,
  );
  lines.push("");
  lines.push(
    "Before doing anything else, call `portuni_get_node({ node_id: \"" +
      node.id +
      "\" })` to refresh state. The context below is a snapshot captured when this prompt was generated and may be stale.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");

  if (node.description) {
    lines.push("**Description:** " + node.description);
    lines.push("");
  }

  lines.push(`**Status:** ${node.status}`);
  if (node.local_mirror) {
    lines.push(`**Local mirror:** \`${node.local_mirror.local_path}\``);
  }
  lines.push("");

  if (node.edges.length > 0) {
    lines.push("### Connections");
    lines.push("");
    const grouped = new Map<string, typeof node.edges>();
    for (const e of node.edges) {
      if (!grouped.has(e.relation)) grouped.set(e.relation, []);
      grouped.get(e.relation)!.push(e);
    }
    for (const [relation, edges] of grouped) {
      lines.push(`- **${relation}**`);
      for (const e of edges) {
        const arrow = e.direction === "outgoing" ? "→" : "←";
        lines.push(
          `    ${arrow} ${e.peer_name} _(${e.peer_type}, \`${e.peer_id}\`)_`,
        );
      }
    }
    lines.push("");
  }

  if (node.events.length > 0) {
    lines.push("### Recent events");
    lines.push("");
    for (const e of node.events.slice(0, 10)) {
      const date = e.created_at.slice(0, 10);
      lines.push(`- \`[${e.type}]\` ${date} — ${e.content}`);
    }
    lines.push("");
  }

  if (node.files.length > 0) {
    lines.push("### Files");
    lines.push("");
    for (const f of node.files) {
      const path = f.local_path ? ` \`${f.local_path}\`` : "";
      lines.push(`- ${f.filename} _(${f.status})_${path}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "When you understand the state, ask me what I'd like you to do next, or propose a sensible next step based on the events above.",
  );

  return lines.join("\n");
}

export function buildCdCommand(node: NodeDetail): string | null {
  if (!node.local_mirror) return null;
  return `cd ${shellQuote(node.local_mirror.local_path)}`;
}

// POSIX single-quote escape. Safe for arbitrary prompt content (newlines,
// backticks, $, quotes). Internal single quotes are closed, escaped, reopened.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a full shell command that cd's into the node's local mirror (if any)
 * and launches the user's configured agent with the prompt as argument.
 *
 * The template may contain `{prompt}` which is replaced by the shell-escaped
 * prompt. If the template has no placeholder, the escaped prompt is appended.
 */
export function buildAgentCommand(node: NodeDetail, template: string): string {
  const prompt = buildAgentPrompt(node);
  const escaped = shellQuote(prompt);

  const tpl = template.trim() || "claude {prompt}";
  const invocation = tpl.includes("{prompt}")
    ? tpl.replaceAll("{prompt}", escaped)
    : `${tpl} ${escaped}`;

  if (node.local_mirror) {
    return `cd ${shellQuote(node.local_mirror.local_path)} && ${invocation}`;
  }
  return invocation;
}
