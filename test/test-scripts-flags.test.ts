// Guards the V8 mitigation for #643: Node 24's wasm code GC can free a
// wrapper twice (nodejs/node#66366) and abort a PGlite test process with
// `Check failed: jit_page.has_value()`. Both test scripts must start node
// with --no-wasm-code-gc; `node --test` passes it on to each file's child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

for (const name of ["test", "test:pglite"]) {
  test(`npm script "${name}" starts node with --no-wasm-code-gc`, () => {
    const script = pkg.scripts[name];
    assert.ok(script, `script ${name} exists`);
    assert.match(script, /\bnode --no-wasm-code-gc\b.*--test\b/);
  });
}

test("the test runner hands --no-wasm-code-gc to this file's process", (t) => {
  // Only meaningful when started through the npm scripts.
  if (!process.env.npm_lifecycle_event?.startsWith("test")) {
    t.skip("not started through an npm test script");
    return;
  }
  assert.ok(process.execArgv.includes("--no-wasm-code-gc"), JSON.stringify(process.execArgv));
});
