// Permission policy for runner-adapted tool calls (spec: "permissions.ts").
// Pure decision function: an adapter's own permission callback (the Claude
// adapter's canUseTool, later Codex/OpenCode equivalents) maps its
// provider-specific shape onto this input and translates the decision back
// -- no SDK type appears here.

import { classifyWrite } from "../write-scope.js";
import type { PermissionPolicy } from "./types.js";

export interface DecidePermissionInput {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  portuniRoot: string;
  mirrors: readonly string[];
  policy: PermissionPolicy;
}

export interface AskQuestion {
  type: "approval" | "input";
  title: string;
  detail: string;
  options: string[] | null;
}

export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; question: AskQuestion };

// file_path for Edit/Write/MultiEdit, notebook_path for NotebookEdit --
// Claude Code's own built-in tool schemas.
const WRITE_TOOL_PATH_KEY: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function stringArrayField(input: Record<string, unknown>, key: string): string[] | null {
  const value = input[key];
  if (!Array.isArray(value)) return null;
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : null;
}

// Claude Code's AskUserQuestion input is `{ questions: [{ question, header?,
// options: [{ label, description? }], multiSelect? }] }` -- one or more
// questions, each with labelled options. The canonical question event
// carries one detail string and a flat option list, so the first question
// is the one surfaced (its text as detail, its option labels as options;
// further questions are appended to the detail so nothing is lost). A flat
// `{ question, options: string[] }` shape is still accepted for callers
// that pre-flatten.
function askUserQuestionFields(input: Record<string, unknown>): { detail: string; options: string[] | null } {
  const questions = input.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const texts: string[] = [];
    let options: string[] | null = null;
    for (const [i, q] of questions.entries()) {
      if (typeof q !== "object" || q === null) continue;
      const rec = q as Record<string, unknown>;
      const text = stringField(rec, "question");
      if (text !== null) texts.push(text);
      if (i === 0 && Array.isArray(rec.options)) {
        const labels = rec.options
          .map((o) => (typeof o === "string" ? o : typeof o === "object" && o !== null ? (o as Record<string, unknown>).label : null))
          .filter((l): l is string => typeof l === "string");
        options = labels.length > 0 ? labels : null;
      }
    }
    return { detail: texts.join("\n\n"), options };
  }
  return {
    detail: stringField(input, "question") ?? "",
    options: stringArrayField(input, "options"),
  };
}

export function decidePermission(input: DecidePermissionInput): PermissionDecision {
  const pathKey = WRITE_TOOL_PATH_KEY[input.tool];
  if (pathKey !== undefined) {
    const target = stringField(input.input, pathKey);
    if (target === null) {
      return { kind: "deny", message: `${input.tool} call has no ${pathKey} to classify` };
    }
    const classification = classifyWrite({
      cwd: input.cwd,
      target,
      portuniRoot: input.portuniRoot,
      mirrors: input.mirrors,
    });
    if (classification.tier === "tier1_current") return { kind: "allow" };
    return { kind: "deny", message: classification.reason };
  }

  // Bash: allow, parity with today -- the guard hook (portuni-guard.sh)
  // never inspected shell writes either, so this isn't a new gap. Recorded
  // in the spec as accepted, not fixed here.
  if (input.tool === "Bash") return { kind: "allow" };

  if (input.tool === "mcp__portuni__portuni_expand_scope") {
    if (input.policy === "auto") return { kind: "allow" };
    return {
      kind: "ask",
      question: {
        type: "approval",
        title: "Rozšířit rozsah relace?",
        detail: "Agent chce přečíst uzel mimo aktuální rozsah této relace.",
        options: null,
      },
    };
  }

  if (input.tool === "AskUserQuestion") {
    const asked = askUserQuestionFields(input.input);
    return {
      kind: "ask",
      question: {
        type: "input",
        title: "Otázka od agenta",
        detail: asked.detail,
        options: asked.options,
      },
    };
  }

  if (input.tool === "ExitPlanMode") {
    return {
      kind: "ask",
      question: {
        type: "approval",
        title: "Schválit plán?",
        detail: stringField(input.input, "plan") ?? "",
        options: null,
      },
    };
  }

  return { kind: "allow" };
}
