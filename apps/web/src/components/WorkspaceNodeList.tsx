// Left column of the workspace view. Two arrangements of the same data,
// switched by the Uzly | Stav toggle in the section header (remembered per
// workspace in localStorage):
//
// - "Uzly": every OPEN node in open-first order (see deriveWorkspaceNodeRows)
//   with its tasks (persistent runner sessions) as flush sub-rows under the
//   node name, so any live thread on any node is one click away without
//   first selecting its parent. A node stays until it is explicitly closed.
//   The row's "+" starts a new task on that node.
// - "Stav": tasks only, no node rows, grouped by what they need from the
//   user -- waiting on an answer, working, suspended, done -- each with its
//   node's name underneath. The group says the state; there are no state
//   dots here, so the only dots in this view are node-type dots.
import { useState } from "react";
import { Plus, Share2, X } from "lucide-react";
import type { WorkspaceNodeRow } from "../lib/sessions";
import { nodeRowActive } from "../lib/session-views";
import { scopedKey } from "../lib/workspace-storage";
import {
  type NodeActivity,
  TASK_GROUPS,
  type TaskGroupKey,
  summarizeNodeActivity,
  taskGroupOf,
} from "../lib/workspace-list";
import type { SessionSummary } from "../types";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";

type Props = {
  rows: WorkspaceNodeRow[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onCloseNode: (id: string) => void;
  // "+" on a node row: start a new task there (opens a thread directly,
  // #374 -- no dialog, no required field).
  onNewTask: (id: string) => void;
  // #343: each open node's own steerable threads -- running, waiting,
  // suspended and (#374) draft alike, drafts included because since #463
  // the node's session list carries the caller's own. The caller derives
  // the map from the session store (#465), so the status shown here is the
  // record's own state/waiting_since, kept current by session_state frames.
  threadsByNode: Record<string, SessionSummary[]>;
  // #412: the thread the canvas currently shows, marked in both
  // arrangements (the per-node tree and the grouped task list) the same way
  // a selected node row is -- otherwise nothing says which row is open.
  activeSessionId: string | null;
  onOpenSessionChat: (nodeId: string, sessionId: string) => void;
  // Inline rename (#374, "sub-rows ... inline rename").
  onRenameTask: (session: SessionSummary, name: string) => void;
  // The × on a thread's own row: a draft with no first message yet is
  // deleted outright (nothing to lose); anything else is Uzavřít, which
  // asks first -- #378 is what will replace this stand-in confirm() with
  // a real dialog carrying the session's summary.
  onCloseTask: (session: SessionSummary) => void;
  // #459 "Předat": ends the turn and the run and writes the thread's
  // handoff file into the node's mirror, so another machine can pick the
  // work up from it. Offered on a running or suspended thread only.
  onHandoffTask: (session: SessionSummary) => void;
};

export type ListMode = "nodes" | "state";
const LIST_MODE_KEY = "workspace.listMode";

function readListMode(): ListMode {
  try {
    return localStorage.getItem(scopedKey(LIST_MODE_KEY)) === "state" ? "state" : "nodes";
  } catch {
    return "nodes";
  }
}

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

// The node's status dot (lib/workspace-list.ts decides which): waiting or
// running only -- a suspended or draft thread is not activity.
const ACTIVITY_DOT: Record<Exclude<NodeActivity, null>, { color: string; title: string; pulse: boolean }> = {
  waiting: { color: "var(--color-node-process)", title: "Úkol čeká na odpověď", pulse: true },
  running: { color: "var(--color-status-active)", title: "Úkol běží", pulse: true },
};

export default function WorkspaceNodeList(props: Props) {
  const [mode, setMode] = useState<ListMode>(readListMode);
  const changeMode = (m: ListMode) => {
    setMode(m);
    try {
      localStorage.setItem(scopedKey(LIST_MODE_KEY), m);
    } catch {
      /* per-viewer convenience only */
    }
  };
  const pressed = "aria-pressed:bg-muted aria-pressed:text-foreground dark:aria-pressed:bg-muted";

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 pt-4 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-dim)]">
          Otevřené
        </span>
        <ButtonGroup className="ml-auto" aria-label="Řazení">
          <Button
            variant="outline"
            size="xs"
            aria-pressed={mode === "nodes"}
            onClick={() => changeMode("nodes")}
            className={pressed}
            title="Seskupit podle uzlů"
          >
            Uzly
          </Button>
          <Button
            variant="outline"
            size="xs"
            aria-pressed={mode === "state"}
            onClick={() => changeMode("state")}
            className={pressed}
            title="Jen úkoly, podle stavu"
          >
            Stav
          </Button>
        </ButtonGroup>
      </div>
      {mode === "nodes" ? <NodeTree {...props} /> : <TaskList {...props} />}
    </div>
  );
}

// ---------------------------------------------------------------- Uzly

function NodeTree({
  rows,
  selectedNodeId,
  onSelectNode,
  onCloseNode,
  onNewTask,
  threadsByNode,
  activeSessionId,
  onOpenSessionChat,
  onRenameTask,
  onCloseTask,
  onHandoffTask,
}: Props) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-6 text-[13px] text-[var(--color-text-dim)]">
        Žádné otevřené uzly. Otevři uzel přes Hledat uzel (⌘K) nebo vytvoř nový.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2 px-3 pb-4">
      {rows.map((r) => {
        const tasks = threadsByNode[r.id] ?? [];
        const activity = summarizeNodeActivity(tasks);
        // v2 rule 6: the node row is marked only while the centre shows the
        // node itself; with a thread open, that thread's row is the one.
        const selected = nodeRowActive(r.id, selectedNodeId, activeSessionId);
        return (
          <li key={r.id}>
            {/* Node row. The row itself selects the node; the + / × controls
                are real <Button>s (the row is a div, so no nested <button>). */}
            {/* biome-ignore lint/a11y/useSemanticElements: the row hosts buttons, so it cannot be a <button> itself */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelectNode(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectNode(r.id);
                }
              }}
              className={`group relative flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors ${
                selected
                  ? "bg-[var(--color-surface-2)] font-medium text-[var(--color-text)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              {selected && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-2 -left-3 w-0.5 rounded-full bg-[var(--color-accent)]"
                />
              )}
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: nodeTypeVar(r.type) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate" title={r.name}>
                {r.name}
              </span>
              {activity && (
                <span
                  role="img"
                  className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${ACTIVITY_DOT[activity].pulse ? "animate-pulse" : ""}`}
                  style={{ background: ACTIVITY_DOT[activity].color }}
                  title={ACTIVITY_DOT[activity].title}
                  aria-label={ACTIVITY_DOT[activity].title}
                />
              )}
              <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:inline-flex group-hover:inline-flex">
                {/* No working folder on an organization, so no task either --
                    same rule as DetailPane's NewTaskButton. */}
                {r.type !== "organization" && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewTask(r.id);
                    }}
                    title="Nový úkol pro tento uzel"
                    aria-label="Nový úkol"
                    className="text-muted-foreground"
                  >
                    <Plus />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseNode(r.id);
                  }}
                  title="Zavřít uzel"
                  aria-label="Zavřít uzel"
                  className="text-muted-foreground"
                >
                  <X />
                </Button>
              </span>
            </div>

            {tasks.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {tasks.map((s) => (
                  <li key={s.id}>
                    <TaskRow
                      session={s}
                      title={taskTitle(s)}
                      active={s.id === activeSessionId}
                      onClick={() => onOpenSessionChat(r.id, s.id)}
                      onRename={(name) => onRenameTask(s, name)}
                      onClose={() => onCloseTask(s)}
                      onHandoff={() => onHandoffTask(s)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function taskTitle(s: Pick<SessionSummary, "state" | "waiting_since">): string {
  switch (taskGroupOf(s)) {
    case "waiting":
      return "Čeká na odpověď";
    case "running":
      return "Běží";
    case "suspended":
      return "Pozastaveno";
    case "draft":
      return "Nový";
    default:
      return "Hotovo";
  }
}

// A task under its node: flush with the node name (no rail, no extra
// indent -- the column is narrow). State is in the tooltip, not a dot, so
// the only dots in a row are the node-type dot above and the node's own
// summary dot. Double-click renames inline; the × (revealed on hover,
// same pattern as the node row's own + / ×) closes the thread -- a draft
// is deleted outright, anything else asks first (#374's stand-in for
// #378's own confirmation).
function TaskRow({
  session,
  title,
  active,
  onClick,
  onRename,
  onClose,
  onHandoff,
}: {
  session: SessionSummary;
  title: string;
  active: boolean;
  onClick: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
  onHandoff: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(session.name);

  const startEditing = () => {
    setDraftName(session.name);
    setEditing(true);
  };
  const commit = () => {
    const trimmed = draftName.trim();
    setEditing(false);
    if (trimmed.length > 0 && trimmed !== session.name) onRename(trimmed);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="h-8 w-full pl-7 text-[12.5px]"
      />
    );
  }

  return (
    <div className="group/task relative flex items-center">
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--color-accent)]"
        />
      )}
      <Button
        variant="ghost"
        onClick={onClick}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEditing();
        }}
        title={title}
        aria-current={active ? "true" : undefined}
        className={`h-8 w-full min-w-0 justify-start gap-2.5 pr-13 pl-7 font-normal text-[12.5px] ${
          active
            ? "bg-[var(--color-surface-2)] font-medium text-[var(--color-text)]"
            : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{session.name}</span>
      </Button>
      {/* #459: Předat -- running and suspended threads only; a draft has
          nothing to summarise and a closed one is done. */}
      {(session.state === "running" || session.state === "suspended") && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onHandoff();
          }}
          title="Předat na jiné zařízení"
          aria-label="Předat na jiné zařízení"
          className="absolute right-7 hidden text-muted-foreground group-hover/task:inline-flex group-focus-within/task:inline-flex"
        >
          <Share2 />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Uzavřít vlákno"
        aria-label="Uzavřít vlákno"
        className="absolute right-1 hidden text-muted-foreground group-hover/task:inline-flex group-focus-within/task:inline-flex"
      >
        <X />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- Stav

function TaskList({ rows, threadsByNode, activeSessionId, onOpenSessionChat }: Props) {
  const byGroup = new Map<TaskGroupKey, { node: WorkspaceNodeRow; task: SessionSummary }[]>();
  for (const node of rows) {
    for (const task of threadsByNode[node.id] ?? []) {
      const key = taskGroupOf(task);
      const list = byGroup.get(key) ?? [];
      list.push({ node, task });
      byGroup.set(key, list);
    }
  }

  if (byGroup.size === 0) {
    return (
      <div className="px-4 py-6 text-[13px] text-[var(--color-text-dim)]">
        Žádné úkoly. Spusť úkol z detailu uzlu tlačítkem Nový úkol.
      </div>
    );
  }

  return (
    <ul className="flex flex-col px-3 pb-4">
      {TASK_GROUPS.map(({ key, label }) => {
        const items = byGroup.get(key);
        if (!items || items.length === 0) return null;
        const dim = key === "done";
        return (
          <li key={key} className={dim ? "opacity-60" : ""}>
            <GroupHeader label={label} count={items.length} />
            <ul className="flex flex-col gap-1">
              {items.map(({ node, task }) => (
                <li key={task.id}>
                  <Button
                    variant="ghost"
                    onClick={() => onOpenSessionChat(node.id, task.id)}
                    aria-current={task.id === activeSessionId ? "true" : undefined}
                    className={`h-auto w-full min-w-0 flex-col items-stretch gap-0.5 px-2.5 py-1.5 text-left font-normal hover:bg-[var(--color-surface-2)] ${
                      task.id === activeSessionId ? "bg-[var(--color-surface-2)]" : ""
                    }`}
                  >
                    <span className="truncate text-[13px] font-medium text-[var(--color-text)]">{task.name}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-[var(--color-text-dim)]">
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: nodeTypeVar(node.type) }}
                        aria-hidden
                      />
                      <span className="truncate">{node.name}</span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-dim)] first:pt-1">
      {label}
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-surface-2)] px-1 text-[10px] font-semibold text-[var(--color-text-dim)]">
        {count}
      </span>
    </div>
  );
}
