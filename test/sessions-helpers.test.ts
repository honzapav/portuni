import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  removeSession,
  markActivity,
  isSessionActive,
  nodeIsActive,
  countSessionsByNode,
} from "../app/src/lib/sessions.js";

const baseNode = {
  nodeId: "node_a",
  nodeName: "Node A",
  nodeType: "project" as const,
  cwd: "/tmp/a",
  command: "claude 'hello'",
};

describe("sessions helpers", () => {
  it("createSession assigns id, createdAt, lastOutputAt = createdAt", () => {
    const now = 1_000_000;
    const s = createSession(baseNode, now);
    assert.equal(s.nodeId, "node_a");
    assert.equal(s.createdAt, now);
    assert.equal(s.lastOutputAt, now);
    assert.match(s.id, /^term_node_a_/);
  });

  it("removeSession returns a new array without the matching id", () => {
    const a = createSession(baseNode, 1);
    const b = createSession(baseNode, 2);
    const out = removeSession([a, b], a.id);
    assert.deepEqual(out.map((s) => s.id), [b.id]);
  });

  it("markActivity updates lastOutputAt only for the target session", () => {
    const a = createSession(baseNode, 1);
    const b = createSession(baseNode, 2);
    const out = markActivity([a, b], a.id, 999);
    assert.equal(out.find((s) => s.id === a.id)!.lastOutputAt, 999);
    assert.equal(out.find((s) => s.id === b.id)!.lastOutputAt, 2);
  });

  it("isSessionActive uses 1500ms threshold by default", () => {
    assert.equal(isSessionActive(2000, 1000), true); // 1000ms ago
    assert.equal(isSessionActive(2600, 1000), false); // 1600ms ago
    assert.equal(isSessionActive(2000, 1000, 500), false); // tighter threshold
  });

  it("nodeIsActive is true if any session for that node is active", () => {
    const a = { ...createSession(baseNode, 1000), lastOutputAt: 1000 };
    const b = { ...createSession({ ...baseNode, nodeId: "node_b" }, 100), lastOutputAt: 100 };
    assert.equal(nodeIsActive([a, b], "node_a", 2000), true);
    assert.equal(nodeIsActive([a, b], "node_b", 2000), false);
  });

  it("countSessionsByNode returns a map of nodeId -> count", () => {
    const a = createSession(baseNode, 1);
    const b = createSession(baseNode, 2);
    const c = createSession({ ...baseNode, nodeId: "node_b" }, 3);
    const counts = countSessionsByNode([a, b, c]);
    assert.equal(counts.get("node_a"), 2);
    assert.equal(counts.get("node_b"), 1);
  });

  it("isSessionActive returns true at the threshold boundary", () => {
    // Default threshold is 1500ms; exactly 1500ms ago is still active.
    assert.equal(isSessionActive(2500, 1000), true);
  });

  it("markActivity is a silent no-op for unknown session ids", () => {
    // Race-condition contract: a pty-data event can arrive after the
    // session was removed from state. markActivity must tolerate it
    // without throwing or corrupting the array.
    const a = createSession(baseNode, 1);
    const out = markActivity([a], "term_does_not_exist", 999);
    assert.equal(out.length, 1);
    assert.equal(out[0].lastOutputAt, 1);
  });

  it("removeSession with unknown id returns the full array", () => {
    const a = createSession(baseNode, 1);
    const b = createSession(baseNode, 2);
    const out = removeSession([a, b], "nope");
    assert.equal(out.length, 2);
  });

  it("countSessionsByNode([]) returns an empty Map", () => {
    const counts = countSessionsByNode([]);
    assert.equal(counts.size, 0);
  });
});
