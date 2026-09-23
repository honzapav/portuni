// The Files tab's move plan as state (#448).
//
// The plan belongs to the node on this device (rule 8 of
// docs/superpowers/specs/2026-09-22-files-organize-design.md): it survives
// leaving the node and restarting the app and is never sent anywhere. It is
// held here rather than inside FileTree because the toolbar owns it too --
// "Nová složka" adds a virtual folder to the same plan the tree renders, and
// a node whose only planned change is such a folder still has a tree to show.
//
// The plan is held paired with its node and the pairing is resolved during
// render (#451): the Files tab is not remounted on a node switch, so an
// effect-time reset would let one render pair node B's files with node A's
// plan, and the tree's cleaning pass would then write the cleaned remains
// under B's id -- destroying B's own plan.

import { useCallback, useState } from "react";
import { planForNode, type FilePlan, type NodeFilePlan } from "./file-plan";
import { loadFilePlan, saveFilePlan } from "./settings";

export type FilePlanState = {
  plan: FilePlan;
  // Every change is persisted immediately: the plan is the node's own state
  // on this device, not something an unmount may drop.
  setPlan: (next: FilePlan) => void;
};

export function useFilePlan(nodeId: string): FilePlanState {
  const [held, setHeld] = useState<NodeFilePlan>(() => ({
    nodeId,
    plan: loadFilePlan(nodeId),
  }));
  const current = planForNode(held, nodeId, loadFilePlan);
  if (current !== held) setHeld(current);
  // Bound to the node of the render that handed it out, which after the reset
  // above is always the node whose plan that render rendered: a write from a
  // still-committed earlier render lands on that earlier node, never here.
  const setPlan = useCallback(
    (next: FilePlan) => {
      setHeld({ nodeId, plan: next });
      saveFilePlan(nodeId, next);
    },
    [nodeId],
  );
  return { plan: current.plan, setPlan };
}
