// apps/web/src/lib/format.ts: every standalone date, time, number and sort
// order in the UI language (spec: Formatting), checked in English and Czech.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareText,
  formatDate,
  formatDateTime,
  formatMonthYear,
  formatNumber,
  formatRelative,
  formatTokens,
  parseServerTimestamp,
  weekInfo,
  weekdayNames,
} from "../apps/web/src/lib/format.js";

// Built in local time, so the expectations hold in any time zone.
const LOCAL = new Date(2026, 8, 5, 14, 7);
const NOW = Date.parse("2026-09-19T10:05:00.000Z");

describe("parseServerTimestamp", () => {
  it("reads the server's zone-less timestamp as UTC", () => {
    assert.equal(parseServerTimestamp("2026-09-19 10:05:00")?.toISOString(), "2026-09-19T10:05:00.000Z");
  });
  it("passes a full ISO string through", () => {
    assert.equal(parseServerTimestamp("2026-09-19T12:05:00+02:00")?.toISOString(), "2026-09-19T10:05:00.000Z");
  });
  it("is null for nothing or garbage", () => {
    assert.equal(parseServerTimestamp(null), null);
    assert.equal(parseServerTimestamp(""), null);
    assert.equal(parseServerTimestamp("not a date"), null);
  });
});

describe("formatDate", () => {
  it("formats in English", () => {
    assert.equal(formatDate("en", LOCAL), "09/05/2026");
  });
  it("formats in Czech", () => {
    assert.equal(formatDate("cs", LOCAL), "05. 09. 2026");
  });
  it("takes options", () => {
    const short: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };
    assert.equal(formatDate("en", LOCAL, short), "9/5/2026");
    assert.equal(formatDate("cs", LOCAL, short), "5. 9. 2026");
  });
  it("shows an unparseable string as it came", () => {
    assert.equal(formatDate("en", "whenever"), "whenever");
  });
  it("formats the pseudo-locale as English", () => {
    assert.equal(formatDate("pseudo", LOCAL), formatDate("en", LOCAL));
  });
  it("parses a server timestamp as UTC", () => {
    const expected = formatDate("en", new Date(Date.UTC(2026, 8, 5, 23, 30)));
    assert.equal(formatDate("en", "2026-09-05 23:30:00"), expected);
  });
});

describe("formatDateTime", () => {
  it("formats in English", () => {
    assert.equal(formatDateTime("en", LOCAL), "09/05/2026, 02:07 PM");
  });
  it("formats in Czech", () => {
    assert.equal(formatDateTime("cs", LOCAL), "05. 09. 2026 14:07");
  });
});

describe("formatRelative", () => {
  it("reads under a minute as now", () => {
    assert.equal(formatRelative("en", NOW - 20_000, NOW), "now");
    assert.equal(formatRelative("cs", NOW - 20_000, NOW), "nyní");
  });
  it("formats the past and the future in English", () => {
    assert.equal(formatRelative("en", NOW - 2 * 60_000, NOW), "2 minutes ago");
    assert.equal(formatRelative("en", NOW + 30 * 60_000, NOW), "in 30 minutes");
    assert.equal(formatRelative("en", NOW - 6 * 3600_000, NOW), "6 hours ago");
    assert.equal(formatRelative("en", NOW - 3 * 24 * 3600_000, NOW), "3 days ago");
  });
  it("formats the past and the future in Czech, with its plural forms", () => {
    assert.equal(formatRelative("cs", NOW - 2 * 60_000, NOW), "před 2 minutami");
    assert.equal(formatRelative("cs", NOW + 5 * 60_000, NOW), "za 5 minut");
    assert.equal(formatRelative("cs", NOW - 24 * 3600_000, NOW), "včera");
    assert.equal(formatRelative("cs", NOW - 3 * 24 * 3600_000, NOW), "před 3 dny");
  });
});

describe("formatNumber", () => {
  it("groups and separates decimals by locale", () => {
    assert.equal(formatNumber("en", 12345.6), "12,345.6");
    assert.equal(formatNumber("cs", 12345.6), "12 345,6");
  });
  it("takes options", () => {
    assert.equal(formatNumber("en", 0.25, { style: "percent" }), "25%");
    assert.equal(formatNumber("cs", 0.25, { style: "percent" }), "25 %");
  });
});

describe("formatTokens", () => {
  it("is compact with an English decimal point", () => {
    assert.equal(formatTokens("en", 950), "950");
    assert.equal(formatTokens("en", 12_345), "12.3 k");
    assert.equal(formatTokens("en", 200_000), "200 k");
  });
  it("is compact with a Czech decimal comma", () => {
    assert.equal(formatTokens("cs", 950), "950");
    assert.equal(formatTokens("cs", 12_345), "12,3 k");
    assert.equal(formatTokens("cs", 200_000), "200 k");
  });
});

describe("compareText", () => {
  const names = ["hora", "chata", "cibule", "ivan", "Čáp"];
  it("sorts by English rules", () => {
    assert.deepEqual([...names].sort((a, b) => compareText("en", a, b)), ["Čáp", "chata", "cibule", "hora", "ivan"]);
  });
  it("sorts by Czech rules: č after c, ch after h", () => {
    assert.deepEqual([...names].sort((a, b) => compareText("cs", a, b)), ["cibule", "Čáp", "hora", "chata", "ivan"]);
  });
});

describe("weekInfo", () => {
  it("starts the week on Sunday in English and on Monday in Czech", () => {
    assert.equal(weekInfo("en").firstDay, 7);
    assert.equal(weekInfo("cs").firstDay, 1);
  });
});

describe("date picker labels", () => {
  it("names the month in the locale", () => {
    assert.equal(formatMonthYear("en", 2026, 8), "September 2026");
    assert.equal(formatMonthYear("cs", 2026, 8), "září 2026");
  });
  it("lists weekdays from the locale's first day", () => {
    assert.deepEqual(weekdayNames("en"), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    assert.deepEqual(weekdayNames("cs"), ["po", "út", "st", "čt", "pá", "so", "ne"]);
  });
});
