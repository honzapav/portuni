// #532: the runner stores its own text in the chat as a code with params;
// the web renders it from the `chat` namespace in the UI language. An event
// written before codes existed (a Czech title, a Czech error) is shown as
// stored, and content from the agent is never replaced.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";
import {
  DENY_CODES,
  MODEL_DESCRIPTION_CODES,
  QUESTION_CODES,
  RUN_ERROR_CODES,
} from "../apps/server/shared/chat-event-codes.js";
import {
  modelDescriptionText,
  questionDetailIsContent,
  questionDetailText,
  questionTitleText,
  runErrorText,
  toolOutputText,
} from "../apps/web/src/lib/chat-event-text.js";
import { deriveTranscriptRows, type ChatEvent } from "../apps/web/src/lib/session-chat.js";

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "chat");
const tCs = i18n.getFixedT("cs", "chat");

describe("chat event text (#532)", () => {
  it("a coded question title renders in en and cs", () => {
    const question = { title: "Expand the thread's scope?", code: "scope_expand", params: {}, detail: "x" };
    assert.equal(questionTitleText(question, tEn), "Expand the thread's scope?");
    assert.equal(questionTitleText(question, tCs), "Rozšířit rozsah vlákna?");
    assert.equal(
      questionDetailText(question, tCs),
      "Agent chce přečíst uzel mimo aktuální rozsah tohoto vlákna.",
      "the scope card's detail is the runner's own sentence",
    );
    assert.equal(questionDetailIsContent(question), false);
  });

  it("an MCP confirmation without a title names the server in the sentence", () => {
    const question = { title: "Confirm: Drive", code: "mcp_confirmation", params: { server: "Drive" } };
    assert.equal(questionTitleText(question, tEn), "Confirm for Drive");
    assert.equal(questionTitleText(question, tCs), "Potvrzení pro Drive");
  });

  it("an agent question keeps the agent's detail as it came", () => {
    const question = { title: "Question from the agent", code: "agent_question", detail: "Which branch?" };
    assert.equal(questionTitleText(question, tCs), "Otázka od agenta");
    assert.equal(questionDetailText(question, tCs), "Which branch?");
    assert.equal(questionDetailIsContent(question), true);
  });

  it("an event stored without a code (written before #532) is shown as stored", () => {
    assert.equal(questionTitleText({ title: "Rozšířit rozsah relace?" }, tEn), "Rozšířit rozsah relace?");
    assert.equal(
      questionDetailText({ detail: "Agent chce přečíst uzel mimo aktuální rozsah této relace." }, tEn),
      "Agent chce přečíst uzel mimo aktuální rozsah této relace.",
    );
    assert.equal(
      runErrorText({ message: "Claude Code není přihlášený na tomto zařízení." }, tEn),
      "Claude Code není přihlášený na tomto zařízení.",
    );
    assert.equal(
      toolOutputText({ output_excerpt: "Zamítnuto uživatelem." }, tEn),
      "Zamítnuto uživatelem.",
    );
    // A code a newer runner sends and this build does not know: as stored.
    assert.equal(questionTitleText({ title: "Stored title", code: "from_the_future" }, tCs), "Stored title");
  });

  it("a coded runner error renders with its params; a provider's own text stays as it came", () => {
    const coded = { message: "x", code: "provider_failed", params: { subtype: "error_max_turns" } };
    assert.equal(runErrorText(coded, tEn), "The run ended with a provider error (error_max_turns).");
    assert.equal(runErrorText(coded, tCs), "Běh skončil chybou poskytovatele (error_max_turns).");
    assert.equal(runErrorText({ message: "Overloaded" }, tCs), "Overloaded");
  });

  it("a denied tool call shows the denial in the UI language; other output is the tool's", () => {
    const denied = {
      output_excerpt: "Target is outside PORTUNI_ROOT (/root). Confirm the write is intended.",
      output_code: "write_outside_root",
      output_params: { path: "/elsewhere/x.md" },
    };
    assert.equal(toolOutputText(denied, tEn), "Writing to /elsewhere/x.md was blocked: it is outside the Portuni folder.");
    assert.equal(toolOutputText(denied, tCs), "Zápis do /elsewhere/x.md byl zablokován: je mimo složku Portuni.");
    assert.equal(toolOutputText({ output_excerpt: "file1\nfile2" }, tCs), "file1\nfile2");
    assert.equal(toolOutputText({ output_excerpt: null }, tCs), null);
  });

  it("a model description renders from its code; a provider's description stays", () => {
    assert.equal(modelDescriptionText({ description: "", description_code: "fastest" }, tCs), "Nejrychlejší a nejlevnější model.");
    assert.equal(modelDescriptionText({ description: "Opus 4.7 with 1M context" }, tCs), "Opus 4.7 with 1M context");
    assert.equal(modelDescriptionText({ description: "" }, tCs), undefined);
  });

  it("every code has a message in both languages", () => {
    for (const t of [tEn, tCs]) {
      for (const code of QUESTION_CODES) {
        const title = questionTitleText({ title: "FALLBACK", code, params: { server: "S" } }, t);
        assert.notEqual(title, "FALLBACK", code);
        assert.doesNotMatch(title, /event\.question/, code);
      }
      for (const code of RUN_ERROR_CODES) {
        assert.doesNotMatch(runErrorText({ message: "FALLBACK", code, params: {} }, t), /FALLBACK|event\.error/, code);
      }
      for (const code of DENY_CODES) {
        assert.doesNotMatch(toolOutputText({ output_excerpt: "FALLBACK", output_code: code }, t) ?? "", /FALLBACK|event\.denied/, code);
      }
      for (const code of MODEL_DESCRIPTION_CODES) {
        assert.doesNotMatch(modelDescriptionText({ description: "", description_code: code }, t) ?? "", /^$|model\.description/, code);
      }
    }
  });

  it("transcript rows keep the code of a question and an error, and mark uncoded errors as content", () => {
    const events: ChatEvent[] = [
      {
        seq: 1,
        event: {
          kind: "question",
          payload: {
            request_id: "r",
            type: "approval",
            tool: "ExitPlanMode",
            title: "Approve the plan?",
            code: "plan_approval",
            params: {},
            detail: "plan",
            options: null,
            decision: null,
          },
        },
      },
      { seq: 2, event: { kind: "error", payload: { class: "provider", message: "Overloaded" } } },
      {
        seq: 3,
        event: {
          kind: "error",
          payload: { class: "provider", message: "Claude Code is not signed in on this device.", code: "provider_not_logged_in", params: {} },
        },
      },
    ];
    const rows = deriveTranscriptRows(events, null);
    const question = rows.find((r) => r.kind === "question");
    assert.equal(question?.kind === "question" && questionTitleText(question, tCs), "Schválit plán?");
    const errors = rows.filter((r) => r.kind === "error");
    assert.deepEqual(
      errors.map((r) => r.kind === "error" && [r.content, runErrorText(r, tCs)]),
      [
        [true, "Overloaded"],
        [false, "Claude Code není na tomto zařízení přihlášený."],
      ],
    );
  });
});
