// The runner's own text in the chat, from the code it stored (spec: Server ->
// Persisted events, #532). An event written before codes existed, or one
// whose code this build does not know, is shown as stored; content from the
// agent, an MCP server or the provider never has a code and is shown as is.
//
// Pure: `t` is a parameter, so the server's node:test runner tests this with
// both catalogs (test/chat-event-text.test.ts). SessionChat binds its own t
// for the `chat` namespace, which loads with its chunk.

import type { TFunction } from "i18next";
import {
  isDenyCode,
  isModelDescriptionCode,
  isQuestionCode,
  isRunErrorCode,
  type ChatEventParams,
  type DenyCode,
  type ModelDescriptionCode,
  type QuestionCode,
  type RunErrorCode,
} from "../../../server/shared/chat-event-codes";

type ChatT = TFunction<"chat">;

// A param as display text; a missing one shows as "-" rather than "undefined".
function p(params: ChatEventParams | undefined, name: string): string {
  const value = params?.[name];
  return typeof value === "string" ? value : "-";
}

// Complete Records, so a code added to shared/chat-event-codes.ts fails the
// typecheck until it has a message; every entry is a literal selector.
const QUESTION_TITLES: Record<QuestionCode, (t: ChatT, params?: ChatEventParams) => string> = {
  scope_expand: (t) => t(($) => $.event.question.scope_expand.title, { ns: "chat" }),
  agent_question: (t) => t(($) => $.event.question.agent_question.title, { ns: "chat" }),
  plan_approval: (t) => t(($) => $.event.question.plan_approval.title, { ns: "chat" }),
  mcp_confirmation: (t, params) => t(($) => $.event.question.mcp_confirmation.title, { ns: "chat", server: p(params, "server") }),
};

const RUN_ERRORS: Record<RunErrorCode, (t: ChatT, params?: ChatEventParams) => string> = {
  provider_failed: (t, params) => t(($) => $.event.error.provider_failed, { ns: "chat", subtype: p(params, "subtype") }),
  provider_not_logged_in: (t) => t(($) => $.event.error.provider_not_logged_in, { ns: "chat" }),
  browser_sign_in_declined: (t, params) =>
    t(($) => $.event.error.browser_sign_in_declined, { ns: "chat", server: p(params, "server") }),
};

const DENIALS: Record<DenyCode, (t: ChatT, params?: ChatEventParams) => string> = {
  connector_disabled: (t) => t(($) => $.event.denied.connector_disabled, { ns: "chat" }),
  run_ended: (t) => t(($) => $.event.denied.run_ended, { ns: "chat" }),
  turn_stopped: (t) => t(($) => $.event.denied.turn_stopped, { ns: "chat" }),
  denied_by_user: (t) => t(($) => $.event.denied.denied_by_user, { ns: "chat" }),
  not_answered: (t) => t(($) => $.event.denied.not_answered, { ns: "chat" }),
  write_no_path: (t, params) =>
    t(($) => $.event.denied.write_no_path, { ns: "chat", tool: p(params, "tool"), field: p(params, "field") }),
  write_outside_mirror: (t, params) => t(($) => $.event.denied.write_outside_mirror, { ns: "chat", path: p(params, "path") }),
  write_outside_root: (t, params) => t(($) => $.event.denied.write_outside_root, { ns: "chat", path: p(params, "path") }),
};

const MODEL_DESCRIPTIONS: Record<ModelDescriptionCode, (t: ChatT) => string> = {
  balanced: (t) => t(($) => $.model.description.balanced, { ns: "chat" }),
  most_capable: (t) => t(($) => $.model.description.most_capable, { ns: "chat" }),
  fastest: (t) => t(($) => $.model.description.fastest, { ns: "chat" }),
};

export interface CodedQuestion {
  title: string;
  detail: string;
  code?: string;
  params?: ChatEventParams;
}

// The title of a question card.
export function questionTitleText(question: Pick<CodedQuestion, "title" | "code" | "params">, t: ChatT): string {
  return isQuestionCode(question.code) ? QUESTION_TITLES[question.code](t, question.params) : question.title;
}

// The detail of a question card: the runner's own sentence for a scope
// expansion, otherwise the agent's or the MCP server's text as stored.
export function questionDetailText(question: Pick<CodedQuestion, "detail" | "code">, t: ChatT): string {
  return question.code === "scope_expand" ? t(($) => $.event.question.scope_expand.detail, { ns: "chat" }) : question.detail;
}

// Whether the detail is content (the agent's or a server's text, never
// translated) rather than the runner's own sentence.
export function questionDetailIsContent(question: Pick<CodedQuestion, "code">): boolean {
  return question.code !== "scope_expand";
}

// The text of a runner error event.
export function runErrorText(
  payload: { message: string; code?: string; params?: ChatEventParams },
  t: ChatT,
): string {
  return isRunErrorCode(payload.code) ? RUN_ERRORS[payload.code](t, payload.params) : payload.message;
}

// The output of a finished tool call: for a call the runner denied, the
// denial in the UI language; otherwise the excerpt as stored.
export function toolOutputText(
  payload: { output_excerpt: string | null; output_code?: string; output_params?: ChatEventParams },
  t: ChatT,
): string | null {
  return isDenyCode(payload.output_code) ? DENIALS[payload.output_code](t, payload.output_params) : payload.output_excerpt;
}

// A model's description in the picker: the catalog's for a code, otherwise
// the provider's own text (none when empty).
export function modelDescriptionText(
  model: { description: string; description_code?: string },
  t: ChatT,
): string | undefined {
  if (isModelDescriptionCode(model.description_code)) return MODEL_DESCRIPTIONS[model.description_code](t);
  return model.description === "" ? undefined : model.description;
}
