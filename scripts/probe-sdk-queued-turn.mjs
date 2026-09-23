#!/usr/bin/env node
// #490: the live probe for "how many results does the SDK send when a
// second message arrives mid-turn". Needs a logged-in `claude` CLI; in the
// agent container the SDK answers every turn with "Not logged in · Please
// run /login", so the turns are too short to queue into and only the
// plumbing can be read off it (see below). Run it where a login exists:
//
//   node scripts/probe-sdk-queued-turn.mjs          # PROBE_TRACE=1 for every message
//
// It starts one streaming-input run, sends a first message that takes a
// while, pushes a second one once the first turn is provably running, and
// prints one line per `result`: its subtype, the uuids it says it consumed
// (`user_message_uuid` / `user_message_uuids`) and how many sends were
// still queued when it was produced (`queued_turn_count`).
//
// What a run in the container already shows: the uuid this file mints for
// each pushed SDKUserMessage comes back on the result that answers it, in
// both `user_message_uuid` and `user_message_uuids`, with
// `queued_turn_count: 0` -- the join key `consumeSendUuids`
// (apps/server/domain/runner/adapters/claude.ts) is built on. What still
// needs a logged-in run: whether a message pushed into a LONG turn comes
// back as its own result or folded into the running turn's result (the
// SDK's own docs say both are possible -- "queued sends may coalesce into
// fewer turns"), which is why the adapter reports `consumed_messages`
// instead of assuming one message per turn.

import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Long enough that the second message provably lands mid-turn: the model
// runs a sleeping command before it answers.
const FIRST = process.env.PROBE_FIRST ?? "Spusť příkaz `sleep 20` (Bash) a potom odpověz slovem hotovo.";
const SECOND = process.env.PROBE_SECOND ?? "A ještě pozdrav slovem ahoj.";
// How long to wait before the second message, i.e. how deep into the first
// turn it lands. A manual probe, so a plain timer is fine here.
const SECOND_AFTER_MS = Number(process.env.PROBE_SECOND_AFTER_MS ?? 100);

function pushQueue() {
  const buffer = [];
  let waiter = null;
  let ended = false;
  return {
    push(item) {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: item, done: false });
      } else buffer.push(item);
    },
    end() {
      ended = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
      };
    },
  };
}

const sent = [];
const prompt = pushQueue();
const send = (text) => {
  const uuid = randomUUID();
  sent.push({ uuid, text });
  prompt.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid });
  console.log(`-> send ${uuid} ${JSON.stringify(text)}`);
};

send(FIRST);
const q = query({
  prompt,
  options: { permissionMode: "bypassPermissions", allowedTools: ["Bash"], includePartialMessages: true },
});

// The second message goes in once the first turn is provably running --
// on the turn's first assistant message, not on a hopeful timer (the first
// turn can finish faster than any delay picked in advance).
let secondSent = false;
const sendSecondLater = () => {
  if (secondSent) return;
  secondSent = true;
  setTimeout(() => send(SECOND), SECOND_AFTER_MS).unref?.();
};

let results = 0;
const answeredUuids = [];
for await (const msg of q) {
  if (process.env.PROBE_TRACE === "1") {
    const text =
      msg.type === "assistant"
        ? JSON.stringify(msg.message.content.map((b) => (b.type === "text" ? b.text : b.type)).join(" | ")).slice(0, 160)
        : "";
    console.log(`   .. ${msg.type}${msg.subtype ? "/" + msg.subtype : ""} ${text}`);
  }
  if (msg.type === "assistant" || msg.type === "stream_event") sendSecondLater();
  if (msg.type !== "result") continue;
  results += 1;
  console.log(
    `<- result #${results} subtype=${msg.subtype} user_message_uuid=${msg.user_message_uuid ?? "-"} ` +
      `user_message_uuids=${JSON.stringify(msg.user_message_uuids ?? null)} ` +
      `queued_turn_count=${msg.queued_turn_count ?? "-"}`,
  );
  answeredUuids.push(...(msg.user_message_uuids ?? [msg.user_message_uuid]).filter(Boolean));
  if (sent.length > 1 && sent.every((s) => answeredUuids.includes(s.uuid))) break;
}
prompt.end();
console.log(`sent ${sent.length} messages, got ${results} results`);
