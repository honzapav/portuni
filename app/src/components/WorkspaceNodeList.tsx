// Left column of the workspace view. Lists every node that currently has
// at least one PTY session, in the order the first session was created.
// A node disappears the instant its last session is closed (no pinning
// in v1 — see spec).
import { countSessionsByNode, nodeIsActive, type TerminalSession } from "../lib/sessions";

type NodeRow = {
  id: string;
  name: string;
  type: string;
};

type Props = {
  sessions: TerminalSession[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  now: number;
};

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export default function WorkspaceNodeList({ sessions, selectedNodeId, onSelectNode, now }: Props) {
  const counts = countSessionsByNode(sessions);

  // Stable order: first-seen wins. We can derive this from sessions[]
  // because they're appended chronologically.
  const seen = new Set<string>();
  const rows: NodeRow[] = [];
  for (const s of sessions) {
    if (seen.has(s.nodeId)) continue;
    seen.add(s.nodeId);
    rows.push({ id: s.nodeId, name: s.nodeName, type: s.nodeType });
  }

  if (rows.length === 0) {
    return (
      <div className="px-4 py-6 text-[13px] text-[var(--color-text-dim)]">
        Žádné aktivní sessions.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 px-2 py-2">
      {rows.map((r) => {
        const count = counts.get(r.id) ?? 0;
        const active = nodeIsActive(sessions, r.id, now);
        const selected = r.id === selectedNodeId;
        return (
          <li key={r.id}>
            <button
              onClick={() => onSelectNode(r.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                selected
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              }`}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: nodeTypeVar(r.type) }}
                aria-hidden
              />
              <span className="flex-1 truncate">{r.name}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{count}</span>
              <span
                role="img"
                className={`inline-block h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500/70"}`}
                title={active ? "Agent píše" : "Idle"}
                aria-label={active ? "active" : "idle"}
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
