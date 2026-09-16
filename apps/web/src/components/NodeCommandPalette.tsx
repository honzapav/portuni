// The one node search for every sidebar tab: a shadcn CommandDialog opened
// by the "Hledat uzel…" button or ⌘K / Ctrl+K. Filtering is ours
// (foldForSearch, diacritics-insensitive, same as the old inline pickers),
// so cmdk's own filter is off. What picking a node DOES is the caller's
// business -- Graf selects it in the graph, Práce opens it.
import { useEffect, useMemo, useState } from "react";
import type { GraphNode } from "../types";
import { foldForSearch } from "../lib/normalize";
import {
  Command,
  CommandDialog,
  CommandEmpty,
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Hledat uzel"
      description="Napiš název uzlu a potvrď Enterem."
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Hledat uzel…"
          value={text}
          onValueChange={(v) => {
            setText(v);
            onQueryChange?.(v);
          }}
        />
        <CommandList>
          <CommandEmpty>Žádné výsledky</CommandEmpty>
          {matches.map((n) => (
            <CommandItem
              key={n.id}
              value={n.id}
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
              <span className="font-mono text-xs text-muted-foreground">{n.type}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
