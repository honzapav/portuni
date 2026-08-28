import assert from "node:assert/strict";
import { isLimitError, parseResetWaitMs } from "./limit.mts";

// isLimitError – pozitivní vzory
for (const text of [
  "Claude AI usage limit reached|1752241200",
  "You've reached your usage limit. Your limit will reset at 4pm.",
  "5-hour limit reached ∙ resets at 14:00",
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
  "Error: overloaded_error",
]) {
  assert.equal(isLimitError(text), true, `mělo být true: ${text}`);
}

// isLimitError – negativní vzory (běžné výstupy nesmí spouštět čekání)
for (const text of [
  "Testy zelené, zavírám issue #15.",
  "error TS2304: Cannot find name 'foo'",
  "npm ERR! code ELIFECYCLE",
]) {
  assert.equal(isLimitError(text), false, `mělo být false: ${text}`);
}

// parseResetWaitMs – "resets at 14:00", teď je 12:00 → ~2 h + 5 min rezerva
const noon = new Date("2026-07-11T12:00:00");
const twoH = parseResetWaitMs("limit reached ∙ resets at 14:00", noon);
assert.ok(twoH !== null && Math.abs(twoH - (2 * 60 + 5) * 60_000) < 1000, `čekání: ${twoH}`);

// parseResetWaitMs – "resets at 4pm" → ~4 h + rezerva
const fourPm = parseResetWaitMs("Your limit will reset at 4pm.", noon);
assert.ok(fourPm !== null && Math.abs(fourPm - (4 * 60 + 5) * 60_000) < 1000, `čekání: ${fourPm}`);

// parseResetWaitMs – čas v minulosti se bere jako zítřek, ale strop je 6 h
const past = parseResetWaitMs("resets at 11:00", noon);
assert.ok(past !== null && past <= 6 * 3_600_000, `strop 6 h: ${past}`);

// parseResetWaitMs – unixový timestamp za pipe (formát "usage limit reached|<ts>")
const ts = Math.floor(noon.getTime() / 1000) + 3 * 3600;
const fromTs = parseResetWaitMs(`Claude AI usage limit reached|${ts}`, noon);
assert.ok(fromTs !== null && Math.abs(fromTs - (3 * 60 + 5) * 60_000) < 1000, `čekání: ${fromTs}`);

// parseResetWaitMs – bez času → null (volající použije fallback)
assert.equal(parseResetWaitMs("usage limit reached", noon), null);

// Reálná hláška CLI ze zkušebního běhu 11. 7. 2026 – session limit + čas bez „at" v UTC
assert.equal(
  isLimitError("You've hit your session limit · resets 11:30pm (UTC)"),
  true,
  "session limit hláška musí být detekovaná",
);

// „resets <číslo>" bez času nesmí být limit (falešný poplach na běžném textu)
assert.equal(isLimitError("resets 3 counters and continues"), false);

// UTC čas: now 20:00 UTC, reset 11:30pm UTC → 3,5 h + 5 min rezerva
const utcNow = new Date("2026-07-11T20:00:00Z");
const utcWait = parseResetWaitMs("You've hit your session limit · resets 11:30pm (UTC)", utcNow);
assert.ok(
  utcWait !== null && Math.abs(utcWait - (3.5 * 60 + 5) * 60_000) < 1000,
  `UTC čekání: ${utcWait}`,
);

// UTC čas v minulosti → zítřek, ořezáno stropem 6 h
const utcPast = parseResetWaitMs("resets 1:00am (UTC)", utcNow);
assert.ok(utcPast !== null && utcPast <= 6 * 3_600_000, `UTC strop: ${utcPast}`);

console.log("limit.test.mts: všechny asserty prošly");
