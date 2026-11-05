// What the window's background polls and the focus refetch may ask for
// (docs/superpowers/specs/2026-11-05-client-traffic-contract.md, rule 5):
// the node on screen, only while the window is visible, never during a 429
// cooldown (lib/rate-limit-cooldown.ts). App.tsx and DetailPane call these
// before each tick; the decisions are pure so test/web-poll-policy.test.ts
// can pin them.

// The detail, sync-status and open-file polls are fallbacks behind the
// change feed (lib/node-changes.ts): a change reaches the window on the
// live channel, the poll only catches what a dropped frame missed.
export const FALLBACK_POLL_MS = 60_000;

export type NodeDetailPollInput = {
  view: string;
  hidden: boolean;
  rateLimited: boolean;
  selectedId: string | null;
  selectedWorkspaceNodeId: string | null;
  // Práce's detail aside is shown (or the detail is centre stage because no
  // thread is shown). Collapsed means nobody is looking at the detail.
  workspaceDetailVisible: boolean;
};

export type NodeDetailPollTarget = { kind: "graph" | "workspace"; nodeId: string } | null;

// The one node whose detail the 5 s poll refreshes, or null: Přehled and
// Settings show no detail, a collapsed Práce aside shows none either.
export function nodeDetailPollTarget(input: NodeDetailPollInput): NodeDetailPollTarget {
  if (input.hidden || input.rateLimited) return null;
  if (input.view === "workspace") {
    if (!input.selectedWorkspaceNodeId || !input.workspaceDetailVisible) return null;
    return { kind: "workspace", nodeId: input.selectedWorkspaceNodeId };
  }
  if (input.view === "graph") {
    if (!input.selectedId) return null;
    return { kind: "graph", nodeId: input.selectedId };
  }
  return null;
}

// The detail pane's sync-status poll runs only while the Files tab, the
// only surface that shows per-file state, is on screen -- and the pane's
// own surface too: Práce stays mounted behind Graf, Přehled and Settings,
// `visible` false then.
export function shouldPollSyncStatus(input: {
  tab: string;
  hidden: boolean;
  rateLimited: boolean;
  visible: boolean;
}): boolean {
  return input.tab === "files" && !input.hidden && !input.rateLimited && input.visible;
}

// Whether an answer fetched at `fetchedAt` (ms epoch) is still fresh at
// `now`: a remount of a pane within the window reads what the window has
// instead of asking again.
export function isFresh(fetchedAt: number | undefined, now: number, ttlMs: number): boolean {
  return fetchedAt !== undefined && now - fetchedAt < ttlMs;
}

export type FocusRefetchInput = {
  view: string;
  rateLimited: boolean;
  selectedId: string | null;
  selectedWorkspaceNodeId: string | null;
};

// A window focus refreshes the graph and the node of the shown view: not
// the graph selection while Práce is up, nor the Práce selection while
// Graf is.
export function focusRefetchTargets(input: FocusRefetchInput): { graph: boolean; nodeId: string | null } {
  if (input.rateLimited) return { graph: false, nodeId: null };
  if (input.view === "workspace") return { graph: true, nodeId: input.selectedWorkspaceNodeId };
  if (input.view === "graph") return { graph: true, nodeId: input.selectedId };
  return { graph: true, nodeId: null };
}
