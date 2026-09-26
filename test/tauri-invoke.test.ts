// #540: a failed Tauri command rejects with `{ code, params, message }`;
// the web turns it into a DesktopError that errorText renders from the
// errors catalog, keeps `message` for the log, and lets a string or an
// Error through unchanged. Every desktop code has a message in both
// languages.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isErrorCode } from "../apps/server/shared/error-codes.js";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";
import {
  DESKTOP_ERROR_CODES,
  WEB_ERROR_CODES,
  errorCode,
  errorText,
  isDisplayErrorCode,
} from "../apps/web/src/lib/api-error.js";
import { DesktopError, toDesktopError } from "../apps/web/src/lib/tauri-invoke.js";

const LOCALES_DIR = join(import.meta.dirname, "..", "apps/server/shared/i18n/locales");

function catalog(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, "errors.json"), "utf8")) as Record<string, string>;
}

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "errors");
const tCs = i18n.getFixedT("cs", "errors");

describe("toDesktopError", () => {
  it("turns a rejected { code, params, message } object into a DesktopError", () => {
    const err = toDesktopError({
      code: "DESKTOP_WORKSPACE_UNKNOWN",
      params: { id: "team" },
      message: "unknown workspace: team",
    });
    assert.ok(err instanceof DesktopError);
    assert.ok(err instanceof Error);
    assert.equal(err.code, "DESKTOP_WORKSPACE_UNKNOWN");
    assert.deepEqual(err.params, { id: "team" });
    assert.equal(err.message, "unknown workspace: team");
    assert.equal(errorCode(err), "DESKTOP_WORKSPACE_UNKNOWN");
  });

  it("tolerates missing params and message", () => {
    const err = toDesktopError({ code: "DESKTOP_WORKSPACE_LAST" });
    assert.ok(err instanceof DesktopError);
    assert.deepEqual(err.params, {});
    assert.equal(err.message, "DESKTOP_WORKSPACE_LAST");
  });

  it("passes a string and an Error through unchanged", () => {
    assert.equal(toDesktopError("legacy failure"), "legacy failure");
    const plain = new Error("boom");
    assert.equal(toDesktopError(plain), plain);
  });
});

describe("errorText for desktop errors", () => {
  it("renders a desktop code with its params in both languages", () => {
    const err = toDesktopError({ code: "DESKTOP_WORKSPACE_EXISTS", params: { id: "team" }, message: "x" });
    assert.equal(errorText(err, tEn), "A workspace “team” already exists.");
    assert.equal(errorText(err, tCs), "Workspace „team“ už existuje.");
  });

  it("renders a numeric-looking param and a detail param", () => {
    const exited = toDesktopError({ code: "DESKTOP_BACKEND_EXITED", params: { exitCode: "1" }, message: "x" });
    assert.equal(errorText(exited, tEn), "The local server stopped (exit code 1).");
    const unreachable = toDesktopError({
      code: "DESKTOP_SERVER_UNREACHABLE",
      params: { detail: "connection refused" },
      message: "x",
    });
    assert.equal(errorText(unreachable, tEn), "The server is unreachable: connection refused");
  });

  it("renders a server or web code the desktop passes through", () => {
    const err = toDesktopError({ code: "UNAUTHORIZED", params: {}, message: "not logged in" });
    assert.equal(errorText(err, tEn), errorText({ code: "UNAUTHORIZED" }, tEn));
    const detail = toDesktopError({ code: "UNKNOWN_DETAIL", params: { detail: "disk full" }, message: "x" });
    assert.equal(errorText(detail, tEn), "Something went wrong: disk full");
  });

  it("renders a legacy string rejection as UNKNOWN_DETAIL", () => {
    assert.equal(errorText(toDesktopError("legacy failure"), tEn), "Something went wrong: legacy failure");
  });
});

describe("desktop error codes and the errors catalog", () => {
  for (const locale of ["en", "cs"]) {
    it(`${locale}: every desktop code has a message`, () => {
      const messages = catalog(locale);
      const missing = DESKTOP_ERROR_CODES.filter((code) => typeof messages[code] !== "string" || !messages[code]);
      assert.deepEqual(missing, [], `desktop codes without a message in ${locale}/errors.json`);
    });
  }

  it("keeps the same placeholders in English and Czech", () => {
    const en = catalog("en");
    const cs = catalog("cs");
    const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const code of DESKTOP_ERROR_CODES) {
      assert.deepEqual(placeholders(cs[code]), placeholders(en[code]), code);
    }
  });

  it("does not overlap the server or web code lists, and is a display code", () => {
    for (const code of DESKTOP_ERROR_CODES) {
      assert.equal(isErrorCode(code), false, code);
      assert.equal((WEB_ERROR_CODES as readonly string[]).includes(code), false, code);
      assert.equal(isDisplayErrorCode(code), true, code);
    }
  });
});
