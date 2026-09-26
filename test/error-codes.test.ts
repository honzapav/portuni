// #531: every error code the server can send has a message in the `errors`
// catalog, in both languages; the server's sources send no error body
// without a code, and no code outside the list; the web renders a code with
// its params, an unknown code as errors:UNKNOWN with the request id, and an
// error without a code as errors:UNKNOWN_DETAIL.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES, isErrorCode } from "../apps/server/shared/error-codes.js";
import { getFixedT } from "../apps/server/shared/i18n/server.js";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";
import { TRIGGER_ERROR_CODES, constraintViolation } from "../apps/server/infra/sql.js";
import {
  ALL_DISPLAY_ERROR_CODES,
  ApiError,
  ClientError,
  WEB_ERROR_CODES,
  errorText,
  parseApiError,
} from "../apps/web/src/lib/api-error.js";

const ROOT = join(import.meta.dirname, "..");
const LOCALES_DIR = join(ROOT, "apps/server/shared/i18n/locales");

function catalogKeys(locale: string): Set<string> {
  const json = JSON.parse(readFileSync(join(LOCALES_DIR, locale, "errors.json"), "utf8")) as Record<
    string,
    unknown
  >;
  // A plural message's forms (KEY_one, KEY_other...) all stand for KEY.
  return new Set(Object.keys(json).map((k) => k.replace(/_(zero|one|two|few|many|other)$/, "")));
}

function serverSources(dir = join(ROOT, "apps/server")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...serverSources(path));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

// An English t for the errors namespace, the same as the web's at "en".
const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "errors");
const tCs = i18n.getFixedT("cs", "errors");

describe("error codes and the errors catalog", () => {
  for (const locale of ["en", "cs"]) {
    it(`${locale}: every code the server or the web can produce has a message`, () => {
      const keys = catalogKeys(locale);
      const missing = [...ERROR_CODES, ...WEB_ERROR_CODES].filter((code) => !keys.has(code));
      assert.deepEqual(missing, [], `codes without a message in ${locale}/errors.json`);
    });

    it(`${locale}: every message belongs to a code`, () => {
      const known = new Set<string>(ALL_DISPLAY_ERROR_CODES);
      const extra = [...catalogKeys(locale)].filter((key) => !known.has(key));
      assert.deepEqual(extra, [], `keys in ${locale}/errors.json that no code uses`);
    });
  }

  it("server and web code lists do not overlap", () => {
    for (const code of WEB_ERROR_CODES) assert.equal(isErrorCode(code), false, code);
  });

  it("the server sources send no 4xx/5xx body without a code, and no code outside the list", () => {
    const uncoded: string[] = [];
    const unknown: string[] = [];
    for (const file of serverSources()) {
      const source = readFileSync(file, "utf8");
      const rel = file.slice(ROOT.length + 1);
      // respondJson with a literal error status is the old, code-less shape;
      // every error goes through respondApiError now.
      for (const m of source.matchAll(/respondJson\(\s*\w+,\s*[45]\d\d\b/g)) {
        uncoded.push(`${rel}: ${m[0]}`);
      }
      // A hand-written JSON error response must carry a code. (MCP tool
      // results are for the agent, not the web, and are not matched.)
      for (const m of source.matchAll(/\.end\(\s*JSON\.stringify\(\{\s*error:[^}]*\}/g)) {
        if (!/\bcode:/.test(m[0])) uncoded.push(`${rel}: ${m[0].slice(0, 80)}`);
      }
      for (const m of source.matchAll(/respondApiError\([^,]+,\s*[^,]+,\s*"([A-Z_]+)"/g)) {
        if (!isErrorCode(m[1])) unknown.push(`${rel}: ${m[1]}`);
      }
      for (const m of source.matchAll(/\bcode: "([A-Z][A-Z_]+)"/g)) {
        if (!isErrorCode(m[1])) unknown.push(`${rel}: ${m[1]}`);
      }
    }
    assert.deepEqual(uncoded, [], "error bodies without a code");
    assert.deepEqual(unknown, [], "codes missing from shared/error-codes.ts");
  });

  it("has no Czech text left in apps/server outside comments and catalogs", () => {
    // #539: the consent page, the handoff file and the default thread name
    // were the last Czech sentences; every line of code is held now, not
    // only the error paths.
    const czech = /[ěščřžýáíéúůťďňĚŠČŘŽÝÁÍÉÚŮ]/;
    const found: string[] = [];
    for (const file of serverSources()) {
      if (file.includes("/shared/i18n/")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "").trim();
          if (code.startsWith("*") || code.startsWith("/*")) return;
          if (czech.test(code)) {
            found.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
          }
        });
    }
    assert.deepEqual(found, []);
  });
});

describe("trigger constraint errors", () => {
  const sources = [
    readFileSync(join(ROOT, "apps/server/infra/schema-triggers.ts"), "utf8"),
    readFileSync(join(ROOT, "apps/server/infra/schema-triggers.pg.ts"), "utf8"),
  ];

  it("maps every trigger message the two dialects raise to its code", () => {
    for (const message of Object.keys(TRIGGER_ERROR_CODES)) {
      for (const source of sources) assert.ok(source.includes(`'${message}'`), message);
    }
    for (const source of sources) {
      for (const m of source.matchAll(/RAISE(?:\(ABORT,| EXCEPTION) '([^']+)'/g)) {
        if (m[1] === "msg") continue; // the files' header comments
        assert.ok(m[1] in TRIGGER_ERROR_CODES, `trigger message without a code: ${m[1]}`);
      }
    }
  });

  it("reads the code from a libsql and a Postgres trigger error", () => {
    const libsql = new Error(
      "SQLITE_CONSTRAINT: SQLite error: cannot remove last belongs_to -> organization edge; every non-organization node must belong to exactly one organization",
    );
    assert.equal(constraintViolation(libsql)?.code, "ORG_LAST_EDGE");
    const pg = Object.assign(new Error("tools can only attach to project/process/area nodes"), { code: "P0001" });
    assert.equal(constraintViolation(pg)?.code, "TOOL_TARGET_INVALID");
    const unique = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    assert.equal(constraintViolation(unique)?.code, "CONSTRAINT_VIOLATION");
    assert.equal(constraintViolation(new Error("boom")), null);
  });
});

describe("errorText (web)", () => {
  it("renders a server code with its params, in the language of t", () => {
    const err = parseApiError(
      409,
      JSON.stringify({ error: "run elsewhere", code: "HANDOFF_RUN_ELSEWHERE", params: { host: "mac-2" } }),
      "POST /sessions/s1/handoff",
    );
    assert.equal(err.code, "HANDOFF_RUN_ELSEWHERE");
    assert.equal(errorText(err, tEn), "The thread is running on the device mac-2; hand it off there.");
    assert.equal(errorText(err, tCs), "Vlákno právě běží na zařízení mac-2; předat ho jde jen tam.");
  });

  it("renders a code without params", () => {
    const err = parseApiError(404, JSON.stringify({ error: "node not found", code: "NODE_NOT_FOUND" }), "GET /nodes/x");
    assert.equal(errorText(err, tEn), "The node was not found.");
  });

  it("renders plurals from a count param", () => {
    const err = new ApiError(400, "ACCESS_UNKNOWN_USERS", "x", { count: 3, userIds: "a,b,c" });
    assert.equal(errorText(err, tEn), "3 users in the access list do not exist.");
    assert.equal(errorText(err, tCs), "3 uživatelé v seznamu přístupů neexistují.");
  });

  it("shows an unknown code as errors:UNKNOWN with the request id", () => {
    const err = parseApiError(
      500,
      JSON.stringify({ error: "x", code: "FROM_A_NEWER_SERVER", request_id: "ab12cd34" }),
      "GET /x",
    );
    assert.equal(errorText(err, tEn), "Something went wrong (request ab12cd34).");
  });

  it("shows INTERNAL_ERROR with the request id", () => {
    const err = parseApiError(
      500,
      JSON.stringify({ error: "Internal server error", code: "INTERNAL_ERROR", request_id: "r-1" }),
      "GET /x",
    );
    assert.equal(errorText(err, tEn), "Something went wrong on the server (request r-1).");
  });

  it("shows an error without a code as UNKNOWN_DETAIL with its text", () => {
    assert.equal(errorText(new TypeError("Failed to fetch"), tEn), "Something went wrong: Failed to fetch");
    assert.equal(errorText("plain", tEn), "Something went wrong: plain");
  });

  it("renders a client-side code", () => {
    assert.equal(
      errorText(new ClientError("REQUEST_TIMEOUT", "request_timeout: sessions.get"), tEn),
      "The server did not answer in time. Try again.",
    );
  });

  it("never shows the server's English `error` text", () => {
    const err = parseApiError(409, JSON.stringify({ error: "internal detail", code: "CONFLICT" }), "PUT /f");
    assert.doesNotMatch(errorText(err, tEn), /internal detail/);
  });

  it("the server's fixed t and the web's t agree", () => {
    const server = getFixedT("en", "errors");
    assert.equal(server(($) => $.NODE_NOT_FOUND), "The node was not found.");
  });
});
