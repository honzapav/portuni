// The Files tab's move plan as state (#448).
//
// The plan belongs to the node on this device (rule 8 of
// docs/superpowers/specs/2026-09-22-files-organize-design.md): it survives
// leaving the node and restarting the app and is never sent anywhere. It is
// held here rather than inside FileTree because the toolbar owns it too --
// "Nová složka" adds a virtual folder to the same plan the tree renders, and
// a node whose only planned change is such a folder still has a tree to show.

import { useState } from "react";
import type { FilePlan } from "./file-plan";
import { loadFilePlan, saveFilePlan } from "./settings";

export type FilePlanState = {
  plan: FilePlan;
  // Every change is persisted immediately: the plan is the node's own state
  // on this device, not something an unmount may drop.
  setPlan: (next: FilePlan) => void;
};

// A plan paired with the node it belongs to (#451). Kept together so a
// stale plan can never be laid over a different node's files: the pairing
// changes atomically, never in two steps that a render could land between.
export type FilePlanEntry = { nodeId: string; plan: FilePlan };

// Pure: what the entry should be once the caller wants `nodeId`. Returns
// `current` unchanged (same reference) when it already matches, so a caller
// can tell "nothing to do" apart from "the node changed" by reference.
export function syncFilePlanEntry(
  current: FilePlanEntry,
  nodeId: string,
  load: (nodeId: string) => FilePlan,
): FilePlanEntry {
  if (current.nodeId === nodeId) return current;
  return { nodeId, plan: load(nodeId) };
}

export function useFilePlan(nodeId: string): FilePlanState {
  const [entry, setEntry] = useState<FilePlanEntry>(() => ({
    nodeId,
    plan: loadFilePlan(nodeId),
  }));
  // Adjusted during render, not in an effect: an effect-based reset runs
  // after a child's own effects (React flushes them children-before-parents),
  // so a child reading `entry` on the first render after `nodeId` changes
  // would still see the previous node's plan paired with the new node's
  // files and could write it back under the new node's id (#451). Resolving
  // here means no render ever pairs a node with another node's plan.
  const resolved = syncFilePlanEntry(entry, nodeId, loadFilePlan);
  if (resolved !== entry) setEntry(resolved);

  const setPlan = (next: FilePlan) => {
    setEntry({ nodeId, plan: next });
    saveFilePlan(nodeId, next);
  };
  return { plan: resolved.plan, setPlan };
}
