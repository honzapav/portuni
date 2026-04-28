import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeJoin, isInside, ensureUnderRoot, PathTraversalError } from "../src/shared/safe-path.js";

describe("safeJoin", () => {
  it("joins normal segments", () => {
    assert.equal(safeJoin("/ws", "projects", "x"), "/ws/projects/x");
  });
  it("returns root for empty segments", () => {
    assert.equal(safeJoin("/ws"), "/ws");
  });
  it("rejects ../ traversal", () => {
    assert.throws(() => safeJoin("/ws", "..", "etc"), PathTraversalError);
  });
  it("rejects deeper ../ traversal", () => {
    assert.throws(() => safeJoin("/ws", "a", "..", "..", "etc"), PathTraversalError);
  });
  it("rejects absolute escape via segment", () => {
    assert.throws(() => safeJoin("/ws", "/etc/passwd"), PathTraversalError);
  });
  it("allows segments that resolve back inside", () => {
    assert.equal(safeJoin("/ws", "a", "..", "b"), "/ws/b");
  });
});

describe("isInside", () => {
  it("true for nested path", () => {
    assert.equal(isInside("/ws", "/ws/x/y"), true);
  });
  it("true for root itself", () => {
    assert.equal(isInside("/ws", "/ws"), true);
  });
  it("false for sibling", () => {
    assert.equal(isInside("/ws", "/wsx/y"), false);
  });
  it("false for parent", () => {
    assert.equal(isInside("/ws/sub", "/ws"), false);
  });
  it("false for absolute outside", () => {
    assert.equal(isInside("/ws", "/etc/passwd"), false);
  });
});

describe("ensureUnderRoot", () => {
  it("accepts absolute path inside root", () => {
    assert.equal(ensureUnderRoot("/ws", "/ws/projects/x"), "/ws/projects/x");
  });
  it("treats relative path as relative to root", () => {
    assert.equal(ensureUnderRoot("/ws", "projects/x"), "/ws/projects/x");
  });
  it("rejects absolute outside root", () => {
    assert.throws(() => ensureUnderRoot("/ws", "/etc/passwd"), PathTraversalError);
  });
  it("rejects relative ../ escape", () => {
    assert.throws(() => ensureUnderRoot("/ws", "../etc/passwd"), PathTraversalError);
  });
});
