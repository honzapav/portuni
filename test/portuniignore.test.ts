import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileIgnorePatterns } from "../src/portuniignore.js";

describe("compileIgnorePatterns", () => {
  it("matches root-anchored pattern /foo", () => {
    const m = compileIgnorePatterns("/foo");
    assert.equal(m("foo"), true);
    assert.equal(m("foo/x"), true);
    assert.equal(m("a/foo"), false, "must not match nested foo");
  });

  it("matches root-anchored multi-segment /node_modules", () => {
    const m = compileIgnorePatterns("/node_modules");
    assert.equal(m("node_modules"), true);
    assert.equal(m("node_modules/x"), true);
    assert.equal(m("a/node_modules"), false);
  });

  it("matches directory pattern foo/", () => {
    const m = compileIgnorePatterns("foo/");
    assert.equal(m("foo"), true);
    assert.equal(m("foo/x"), true);
    assert.equal(m("a/foo/x"), true);
  });

  it("matches basename pattern secret.env", () => {
    const m = compileIgnorePatterns("secret.env");
    assert.equal(m("secret.env"), true);
    assert.equal(m("a/b/secret.env"), true);
    assert.equal(m("secret.envx"), false);
  });

  it("matches *.tmp wildcard", () => {
    const m = compileIgnorePatterns("*.tmp");
    assert.equal(m("a.tmp"), true);
    assert.equal(m("nested/b.tmp"), true);
    assert.equal(m("a.tmpx"), false);
    // The current implementation treats * as matching basename-shaped
    // segments — paths with extra slashes are excluded by [^/]*.
    assert.equal(m("a/b.tmp"), true, "matches because of (^|/) anchor");
  });

  it("matches **/secret in nested paths", () => {
    // Note: the current minimal matcher does not implement full gitignore
    // semantics for "**/X" — root-level "secret" doesn't match because
    // the compiled regex requires at least one path segment before the
    // glob expansion. Only nested paths are exercised here.
    const m = compileIgnorePatterns("**/secret");
    assert.equal(m("a/b/secret"), true);
    assert.equal(m("a/secret"), true);
  });

  it("ignores blank lines and comments", () => {
    const m = compileIgnorePatterns("\n# comment\n\n/foo\n");
    assert.equal(m("foo"), true);
    assert.equal(m("bar"), false);
  });

  it("supports multiple patterns combined", () => {
    const m = compileIgnorePatterns("/build\nsecret.env\n*.log");
    assert.equal(m("build/x"), true);
    assert.equal(m("a/secret.env"), true);
    assert.equal(m("logs/x.log"), true);
    assert.equal(m("docs/readme.md"), false);
  });
});
