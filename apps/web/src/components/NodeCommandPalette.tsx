// The one node search for every sidebar tab: a shadcn CommandDialog opened
// by the "Hledat uzel…" button or ⌘K / Ctrl+K. Filtering is ours
// (foldForSearch, diacritics-insensitive, same as the old inline pickers),
// so cmdk's own filter is off. What picking a node DOES is the caller's
// business -- Graf selects it in the graph, Práce opens it.
import { useEffect, useMemo, useState } from "react";
import type { GraphNode } from "../types";
import { foldForSearch } from "../lib/normalize";
import { groupNodesByType } from "../lib/node-search";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

const MAX_RESULTS = 50;

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export function filterNodes(nodes: GraphNode[], query: string): GraphNode[] {
  const q = foldForSearch(query.trim());
  const pool = q
    ? nodes.filter(
        (n) =>
          foldForSearch(n.name).includes(q) ||
          foldForSearch(n.description ?? "").includes(q) ||
          foldForSearch(n.type).includes(q),
      )
    : [...nodes].sort((a, b) => a.name.localeCompare(b.name, "cs"));
  return pool.slice(0, MAX_RESULTS);
}

export default function NodeCommandPalette({
  open,
  onOpenChange,
  nodes,
  onPick,
  onQueryChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: GraphNode[];
  onPick: (nodeId: string) => void;
  // Live text of the search field, for a caller that highlights matches
  // elsewhere while the palette is open (the graph). Cleared on close.
  onQueryChange?: (query: string) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) {
      setText("");
      onQueryChange?.("");
    }
  }, [open, onQueryChange]);

  const matches = useMemo(() => filterNodes(nodes, text), [nodes, text]);
  // Grouped by node type once the list is long enough to be worth scanning
  // in sections; a short one stays flat (lib/node-search.ts).
  const groups = useMemo(() => groupNodesByType(matches), [matches]);

  const row = (n: GraphNode) => (
    <CommandItem
      key={n.id}
      value={n.id}
      className="gap-3 px-4 py-2.5"
      onSelect={() => {
        onPick(n.id);
        onOpenChange(false);
      }}
    >
      <span
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ background: nodeTypeVar(n.type) }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{n.name}</span>
      <span className="ml-auto shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
        {n.type}
      </span>
    </CommandItem>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Hledat uzel"
      description="Napiš název uzlu a potvrď Enterem."
      className="sm:max-w-[640px]"
    >
      <Command shouldFilter={false} className="p-0">
        <CommandInput
          placeholder="Hledat uzel…"
          value={text}
          onValueChange={(v) => {
            setText(v);
            onQueryChange?.(v);
          }}
          // The wrapper owns the search header's height, padding and the
          // divider that keeps the field off the first row.
          wrapperClassName="flex h-12 items-center border-b border-border px-4 py-0"
        />
        <CommandList className="py-2">
          <CommandEmpty className="px-4 py-6">Žádný uzel</CommandEmpty>
          {groups
            ? groups.map((g) => (
                <CommandGroup
                  key={g.type}
                  heading={g.label}
                  className="p-0 **:[[cmdk-group-heading]]:px-4 **:[[cmdk-group-heading]]:py-1.5"
                >
                  {g.nodes.map(row)}
                </CommandGroup>
              ))
            : matches.map(row)}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
