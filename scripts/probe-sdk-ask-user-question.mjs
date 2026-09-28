#!/usr/bin/env node
// #492: the live probe for "does the AskUserQuestion answer reach the
// model". Needs a logged-in `claude` CLI (in the agent container the SDK
// answers every turn with "Not logged in · Please run /login", so the model
// never calls the tool). Run it where a login exists:
//
//   node scripts/probe-sdk-ask-user-question.mjs     # PROBE_TRACE=1 for every message
//
// It asks the model to put one question through AskUserQuestion, answers
// it from canUseTool exactly the way the Claude adapter does
// (updatedInput = { ...input, answers: { [question text]: label } },
// apps/server/domain/runner/permissions.ts askUserQuestionAnswers), and
// prints the tool_result the model got back plus its final reply. A working
// answer shows the chosen label in both; the old `answer` field showed
// "The user did not answer the questions."

import { query } from "@anthropic-ai/claude-agent-sdk";

const PICK = process.env.PROBE_PICK ?? "Modrá";
const PROMPT =
  process.env.PROBE_PROMPT ??
  `Zeptej se mě nástrojem AskUserQuestion na jednu otázku "Jakou barvu chceš?" s možnostmi "Červená" a "${PICK}". ` +
    "Potom odpověz jen tou barvou, kterou jsem vybral, nebo slovem NEVÍM, když odpověď nepřišla.";

function answersFor(input, label) {
  const answers = {};
  for (const q of Array.isArray(input.questions) ? input.questions : []) {
    if (q && typeof q.question === "string") answers[q.question] = label;
  }
  return answers;
}

const q = query({
  prompt: PROMPT,
  options: {
    permissionMode: "default",
    canUseTool: async (tool, input) => {
      if (tool !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
      const answers = answersFor(input, PICK);
      console.log(`<- AskUserQuestion ${JSON.stringify(input.questions?.map((x) => x.question))}`);
      console.log(`-> answers ${JSON.stringify(answers)}`);
      return { behavior: "allow", updatedInput: { ...input, answers } };
    },
  },
});

for await (const message of q) {
  if (process.env.PROBE_TRACE === "1") console.log(JSON.stringify(message));
  if (message.type === "user" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        console.log(`tool_result: ${text}`);
      }
    }
  }
  if (message.type === "result") {
    console.log(`result: ${message.subtype} ${JSON.stringify(message.result ?? message.errors ?? null)}`);
  }
}
