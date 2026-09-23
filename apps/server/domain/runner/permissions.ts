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

// One dotaz of an AskUserQuestion ask: its text, its option labels and
// whether several of them may be picked. The answer to it is keyed by
// `question` (the tool reads `answers: { [question text]: answer }`).
export interface AskPrompt {
  question: string;
  options: string[];
  multi_select: boolean;
}

export interface AskQuestion {
  type: "approval" | "input";
  title: string;
  detail: string;
  options: string[] | null;
  // AskUserQuestion only (#492): every dotaz with its own options, so a
  // multi-question ask is answered question by question.
  questions?: AskPrompt[];
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

function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (typeof o === "string" ? o : typeof o === "object" && o !== null ? (o as Record<string, unknown>).label : null))
    .filter((l): l is string => typeof l === "string");
}

// Claude Code's AskUserQuestion input is `{ questions: [{ question, header?,
// options: [{ label, description? }], multiSelect? }] }` -- one or more
// questions, each with labelled options. Every question keeps its own
// options in `questions` (#492); `detail` joins the texts for a reader that
// shows only the flat fields (the transcript row, an older web), and the
// flat `options` are the single question's labels -- with several
// questions there is no one list that fits them all. A flat `{ question,
// options: string[] }` shape is still accepted for callers that
// pre-flatten.
export function askUserQuestionFields(
  input: Record<string, unknown>,
): { detail: string; options: string[] | null; questions: AskPrompt[] } {
  const questions = input.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const prompts: AskPrompt[] = [];
    for (const q of questions) {
      if (typeof q !== "object" || q === null) continue;
      const rec = q as Record<string, unknown>;
      const text = stringField(rec, "question");
      if (text === null) continue;
      prompts.push({ question: text, options: optionLabels(rec.options), multi_select: rec.multiSelect === true });
    }
    const single = prompts.length === 1 && prompts[0].options.length > 0 ? prompts[0].options : null;
    return { detail: prompts.map((p) => p.question).join("\n\n"), options: single, questions: prompts };
  }
  const detail = stringField(input, "question") ?? "";
  const options = stringArrayField(input, "options");
  return {
    detail,
    options,
    questions: detail === "" ? [] : [{ question: detail, options: options ?? [], multi_select: false }],
  };
}

// The tool's own answer shape (sdk-tools.d.ts `AskUserQuestionInput.answers`,
// keyed by question text). A string answers every question (the one-question
// case, or one typed reply for all); a map answers question by question and
// only its entries naming an asked question count.
export function askUserQuestionAnswers(
  input: Record<string, unknown>,
  value: string | Record<string, string>,
): Record<string, string> {
  const { questions } = askUserQuestionFields(input);
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const answer = typeof value === "string" ? value : Object.hasOwn(value, q.question) ? value[q.question] : undefined;
    if (typeof answer === "string" && answer.trim() !== "") answers[q.question] = answer;
  }
  return answers;
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
        questions: asked.questions,
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
