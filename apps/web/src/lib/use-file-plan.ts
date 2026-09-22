// The Files tab's move plan as state (#448).
//
// The plan belongs to the node on this device (rule 8 of
// docs/superpowers/specs/2026-09-22-files-organize-design.md): it survives
// leaving the node and restarting the app and is never sent anywhere. It is
// held here rather than inside FileTree because the toolbar owns it too --
// "Nová složka" adds a virtual folder to the same plan the tree renders, and
// a node whose only planned change is such a folder still has a tree to show.

import { useCallback, useEffect, useState } from "react";
import type { FilePlan } from "./file-plan";
import { loadFilePlan, saveFilePlan } from "./settings";

export type FilePlanState = {
  plan: FilePlan;
  // Every change is persisted immediately: the plan is the node's own state
  // on this device, not something an unmount may drop.
  setPlan: (next: FilePlan) => void;
};

export function useFilePlan(nodeId: string): FilePlanState {
  const [plan, setPlanState] = useState<FilePlan>(() => loadFilePlan(nodeId));
  useEffect(() => {
    setPlanState(loadFilePlan(nodeId));
  }, [nodeId]);
  const setPlan = useCallback(
    (next: FilePlan) => {
      setPlanState(next);
      saveFilePlan(nodeId, next);
    },
    [nodeId],
  );
  return { plan, setPlan };
}
