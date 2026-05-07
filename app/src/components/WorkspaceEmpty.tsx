// Shown when sessions[] is empty. A search box over graph.nodes (minus
// organisations) so the user can type and pick a node to open a session
// against. Mirrors the search UX from the sidebar so the muscle memory
// transfers.
import { useState } from "react";
import { Search } from "lucide-react";
import type { GraphNode, GraphPayload } from "../types";
import { foldForSearch } from "../lib/normalize";

type Props = {
  graph: GraphPayload | null;
  onPick: (node: GraphNode) => void;
};

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export default function WorkspaceEmpty({ graph, onPick }: Props) {
  const [query, setQuery] = useState("");
  const q = foldForSearch(query.trim());
  const all = graph?.nodes ?? [];
  const matches = q
    ? all
        .filter((n) => n.type !== "organization")
        .filter(
          (n) =>
            foldForSearch(n.name).includes(q) ||
            foldForSearch(n.description ?? "").includes(q),
        )
        .slice(0, 30)
    : all
        .filter((n) => n.type !== "organization")
        .slice(-15)
        .reverse();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8">
      <div className="text-[15px] font-medium text-[var(--color-text)]">
        Vyber uzel a otevři terminál
      </div>
      <p className="max-w-[420px] text-center text-[13px] text-[var(--color-text-dim)]">
        Sessions zůstávají naživu při přepnutí pohledu. Zavři je explicitně,
        nebo až ukončíš Portuni.
      </p>
      <div className="relative w-full max-w-[480px]">
        <Search
          size={13}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
        />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Hledat uzel…"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-8 pr-3 text-[13.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
        />
      </div>
      <ul className="scroll-thin w-full max-w-[480px] flex-1 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        {matches.map((n) => (
          <li key={n.id} className="border-b border-[var(--color-border)] last:border-b-0">
            <button
              type="button"
              onClick={() => onPick(n)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: nodeTypeVar(n.type) }}
                aria-hidden
              />
              <span className="flex-1 truncate">{n.name}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{n.type}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
