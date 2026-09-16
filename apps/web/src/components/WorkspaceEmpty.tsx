// Shown when the workspace has nothing open. A search box over graph.nodes
// (all types) so the user can type and pick a
// node to open. Mirrors the search UX from the sidebar so the muscle memory
// transfers.
import { useState } from "react";
import { Search } from "lucide-react";
import type { GraphNode, GraphPayload } from "../types";
import { foldForSearch } from "../lib/normalize";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
        .filter(
          (n) =>
            foldForSearch(n.name).includes(q) ||
            foldForSearch(n.description ?? "").includes(q),
        )
        .slice(0, 30)
    : all
        .filter((n) => n.status === "active")
        .sort(
          (a, b) =>
            (b.updated_at ?? b.created_at ?? "").localeCompare(
              a.updated_at ?? a.created_at ?? "",
            ),
        )
        .slice(0, 15);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8">
      <div className="text-[15px] font-medium text-[var(--color-text)]">
        Otevři uzel v Práci
      </div>
      <p className="max-w-[420px] text-center text-[13px] text-[var(--color-text-dim)]">
        Otevři libovolný uzel a pracuj na něm. Můžeš mít otevřených víc uzlů
        a přeskakovat mezi nimi.
      </p>
      <div className="relative w-full max-w-[480px]">
        <Search
          size={13}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
        />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Hledat uzel…"
          className="bg-[var(--color-surface)] pl-8"
        />
      </div>
      <ul className="scroll-thin w-full max-w-[480px] flex-1 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        {matches.map((n) => (
          <li key={n.id} className="border-b border-[var(--color-border)] last:border-b-0">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onPick(n)}
              className="w-full justify-start rounded-none font-normal text-[var(--color-text-muted)]"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: nodeTypeVar(n.type) }}
                aria-hidden
              />
              <span className="flex-1 truncate text-left">{n.name}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{n.type}</span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
