// What the Files tab's "+ Nový soubor" button is for a node: the plain
// button, or a split whose second item starts a Showtime deck in the node's
// wip/ (spec: docs/superpowers/specs/2026-09-13-showtime-new-deck-design.md).
// The split exists only where that item could ever do something — the
// Showtime integration on and Showtime.app found; a node without a mirror on
// this device shows it disabled with the reason, since Showtime writes to
// disk and there is nowhere to put the deck.

export interface NewFileMenuInput {
  showtimeEnabled: boolean;
  showtimeInstalled: boolean;
  hasMirror: boolean;
}

export type NewFileMenu =
  | { kind: "plain" }
  | { kind: "split"; presentation: { enabled: true } | { enabled: false; reason: string } };

export const NO_MIRROR_REASON = "Nejdřív vytvoř mirror uzlu";

export function newFileMenu(input: NewFileMenuInput): NewFileMenu {
  if (!input.showtimeEnabled || !input.showtimeInstalled) return { kind: "plain" };
  return {
    kind: "split",
    presentation: input.hasMirror ? { enabled: true } : { enabled: false, reason: NO_MIRROR_REASON },
  };
}
