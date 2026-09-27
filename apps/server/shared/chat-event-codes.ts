// Codes for the runner's own text in the chat transcript (spec: Server ->
// Persisted events). The runner stores `{ code, params }` next to an English
// fallback text; the web renders the code from the `chat` namespace. An event
// stored without a code (written before #532) is shown as stored. Content
// (the agent's questions, options and answers, a provider's own error text)
// never gets a code: it is not translated.
//
// Shared by the runner (domain/runner) and the web (lib/chat-event-text.ts);
// no imports, like the rest of shared/.

// The title of a question card. `scope_expand` also covers the card's detail,
// which is the runner's own sentence; for every other question the detail is
// the agent's (or the MCP server's) and is shown as stored.
export const QUESTION_CODES = [
  "scope_expand",
  "agent_question",
  "plan_approval",
  // An MCP dialog without a title of its own; params: { server }.
  "mcp_confirmation",
] as const;
export type QuestionCode = (typeof QUESTION_CODES)[number];

// A runner error event written by the runner itself.
export const RUN_ERROR_CODES = [
  // A failed result without any text of its own; params: { subtype }.
  "provider_failed",
  "provider_not_logged_in",
  // A sign-in dialog in a browser, declined; params: { server }.
  "browser_sign_in_declined",
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

// Why a tool call was denied. The agent reads the English message as the
// tool result; the chat shows the failed call's output from the code.
export const DENY_CODES = [
  "connector_disabled",
  "run_ended",
  "turn_stopped",
  "denied_by_user",
  "not_answered",
  // params: { tool, field }
  "write_no_path",
  // params: { path }
  "write_outside_mirror",
  "write_outside_root",
] as const;
export type DenyCode = (typeof DENY_CODES)[number];

// The description of a runner model the runner knows without asking the
// provider. A model list the provider answered carries its own text.
export const MODEL_DESCRIPTION_CODES = ["balanced", "most_capable", "fastest"] as const;
export type ModelDescriptionCode = (typeof MODEL_DESCRIPTION_CODES)[number];

export type ChatEventParams = Record<string, string>;

export function isQuestionCode(value: unknown): value is QuestionCode {
  return typeof value === "string" && (QUESTION_CODES as readonly string[]).includes(value);
}

export function isRunErrorCode(value: unknown): value is RunErrorCode {
  return typeof value === "string" && (RUN_ERROR_CODES as readonly string[]).includes(value);
}

export function isDenyCode(value: unknown): value is DenyCode {
  return typeof value === "string" && (DENY_CODES as readonly string[]).includes(value);
}

export function isModelDescriptionCode(value: unknown): value is ModelDescriptionCode {
  return typeof value === "string" && (MODEL_DESCRIPTION_CODES as readonly string[]).includes(value);
}
