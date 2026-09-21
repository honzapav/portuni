// Pure rules of the Práce column (WorkspaceNodeList.tsx): the one state a
// node's dot summarises and the Stav view's grouping. Dependency-free so
// test/workspace-list-helpers.test.ts can exercise them without React.

import type { SessionSummary } from "../types";

// The dot on a node row says a thread under it needs attention or is
// working. `null` = no dot: an idle, suspended or draft thread is not
// activity (v2 spec, "Left column").
export type NodeActivity = "waiting" | "running" | null;

export function summarizeNodeActivity(
  tasks: readonly Pick<SessionSummary, "state" | "waiting_since">[],
): NodeActivity {
  if (tasks.some((t) => t.state === "running" && t.waiting_since !== null)) return "waiting";
  if (tasks.some((t) => t.state === "running")) return "running";
  return null;
}

export type TaskGroupKey = "waiting" | "running" | "suspended" | "draft" | "done";
export const TASK_GROUPS: { key: TaskGroupKey; label: string }[] = [
  { key: "waiting", label: "Vyžadují pozornost" },
  { key: "running", label: "Pracují" },
  { key: "suspended", label: "Pozastavené" },
  { key: "draft", label: "Nové" },
  { key: "done", label: "Hotové" },
];

export function taskGroupOf(s: Pick<SessionSummary, "state" | "waiting_since">): TaskGroupKey {
  if (s.state === "running") return s.waiting_since !== null ? "waiting" : "running";
  if (s.state === "suspended") return "suspended";
  if (s.state === "draft") return "draft";
  return "done";
}
