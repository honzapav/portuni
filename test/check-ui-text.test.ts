// The gate's "no Czech text outside the catalog" check
// (scripts/check-ui-text.mjs): comments pass, a literal in code or JSX fails.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- a plain .mjs gate script, no type declarations.
import { findCzech, stripRustComments } from "../scripts/check-ui-text.mjs";

describe("check-ui-text", () => {
  it("ignores Czech in TypeScript comments, JSX comments included", () => {
    const src = [
      "// Předat hands the thread over",
      "/* Uzavřít",
      "   ends it */",
      "export const A = <div>{/* Nová složka */}{t(($) => $.x)}</div>;",
    ].join("\n");
    assert.deepEqual(findCzech(src, "x.tsx"), []);
  });

  it("reports a Czech string or JSX text with its source line", () => {
    const src = ["// ok", 'const label = "výchozí instance";', "export const B = () => <p>Uložit změny</p>;"].join("\n");
    const hits = findCzech(`${src}\nexport { label };`, "x.tsx");
    assert.deepEqual(
      hits.map((h: { line: number }) => h.line),
      [2, 3],
    );
  });

  it("reports a Czech template literal in server code", () => {
    const src = ["export const m = (n: number) =>", "  `Přesun se nepovedl ($", "{n})`;"].join("");
    const hits = findCzech(src, "x.ts");
    assert.equal(hits.length, 1);
  });

  it("strips Rust comments but keeps strings, raw strings and chars", () => {
    const src = [
      '/// „Otevřít v Showtime"',
      "fn f<'a>(x: &'a str) -> char { // Předat",
      '    let s = "Přihlásit"; /* nested /* Zrušit */ comment */',
      '    let r = r#"// není komentář"#;',
      "    'č'",
      "}",
    ].join("\n");
    const out = stripRustComments(src);
    assert.ok(!out.includes("Otevřít"));
    assert.ok(!out.includes("Předat"));
    assert.ok(!out.includes("Zrušit"));
    assert.ok(out.includes('"Přihlásit"'));
    assert.ok(out.includes("není komentář"));
    assert.ok(out.includes("'č'"));
    assert.deepEqual(
      findCzech(src, "x.rs").map((h: { line: number }) => h.line),
      [3, 4, 5],
    );
  });
});
