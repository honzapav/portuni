// The one node search for every sidebar tab: a shadcn CommandDialog opened
// by the "Hledat uzel…" button or ⌘K / Ctrl+K. Filtering is ours
// (foldForSearch, diacritics-insensitive, same as the old inline pickers),
// so cmdk's own filter is off. What picking a node DOES is the caller's
// business -- Graf selects it in the graph, Práce opens it.
import { useEffect, useMemo, useState } from "react";
import type { GraphNode } from "../types";
import { foldForSearch } from "../lib/normalize";
import { groupNodesByType, nodeTypeLabel } from "../lib/node-search";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

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

  // A row: the type dot in a 20 px icon slot, the name, and the type name
  // muted on the right -- empty under a group heading that already names it.
  const row = (n: GraphNode, grouped: boolean) => (
    <CommandItem
      key={n.id}
      value={n.id}
      onSelect={() => {
        onPick(n.id);
        onOpenChange(false);
      }}
    >
      <span className="inline-flex size-5 shrink-0 items-center justify-center" aria-hidden>
        <span className="inline-block size-2 rounded-full" style={{ background: nodeTypeVar(n.type) }} />
      </span>
      <span className="min-w-0 flex-1 truncate">{n.name}</span>
      {!grouped && <span className="ml-auto shrink-0 text-muted-foreground">{nodeTypeLabel(n.type)}</span>}
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
          <CommandEmpty>Žádný uzel</CommandEmpty>
          {groups
            ? groups.map((g) => (
                <CommandGroup key={g.type} heading={g.label}>
                  {g.nodes.map((n) => row(n, true))}
                </CommandGroup>
              ))
            : matches.map((n) => row(n, false))}
        </CommandList>
        <CommandFooter>
          <KbdGroup className="gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span>Navigace</span>
          </KbdGroup>
          <KbdGroup className="gap-1.5">
            <Kbd>Enter</Kbd>
            <span>Otevřít</span>
          </KbdGroup>
          <KbdGroup className="gap-1.5">
            <Kbd>Esc</Kbd>
            <span>Zavřít</span>
          </KbdGroup>
        </CommandFooter>
      </Command>
    </CommandDialog>
  );
}
