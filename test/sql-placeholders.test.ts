// The pg/PGlite drivers rewrite libsql-style `?` placeholders to `$n`
// (infra/sql-placeholders.ts). A `?` that is not a placeholder -- inside a
// string, an identifier, a comment or a dollar-quoted function body --
// must not consume a number, or every real placeholder after it binds to
// the wrong argument.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewritePositionalPlaceholders } from "../apps/server/infra/sql-placeholders.js";

describe("rewritePositionalPlaceholders", () => {
  it("numbers bare placeholders in order", () => {
    assert.equal(rewritePositionalPlaceholders("SELECT ? , ?"), "SELECT $1 , $2");
  });

  it("leaves a ? inside a string or identifier literal alone", () => {
    assert.equal(
      rewritePositionalPlaceholders(`SELECT '?' AS q, "a?b" FROM t WHERE x = ? AND y = 'it''s ?' AND z = ?`),
      `SELECT '?' AS q, "a?b" FROM t WHERE x = $1 AND y = 'it''s ?' AND z = $2`,
    );
  });

  it("leaves a ? inside a -- line comment or a /* */ block comment alone", () => {
    assert.equal(
      rewritePositionalPlaceholders("SELECT ? -- is it ?\nFROM t /* why? */ WHERE x = ?"),
      "SELECT $1 -- is it ?\nFROM t /* why? */ WHERE x = $2",
    );
  });

  it("leaves a ? inside a dollar-quoted body alone", () => {
    assert.equal(
      rewritePositionalPlaceholders("CREATE FUNCTION f() RETURNS text AS $fn$ SELECT '?'; -- ? $fn$ LANGUAGE sql; SELECT ?"),
      "CREATE FUNCTION f() RETURNS text AS $fn$ SELECT '?'; -- ? $fn$ LANGUAGE sql; SELECT $1",
    );
    assert.equal(rewritePositionalPlaceholders("DO $$ BEGIN PERFORM ?; END $$; SELECT ?"), "DO $$ BEGIN PERFORM ?; END $$; SELECT $1");
  });

  it("does not treat an already-rewritten $1 as a dollar quote", () => {
    assert.equal(rewritePositionalPlaceholders("SELECT $1, ?"), "SELECT $1, $1");
  });
});
