import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveWorkspaceNodeRows } from "../apps/web/src/lib/sessions.js";

describe("deriveWorkspaceNodeRows", () => {
  const resolve = (id: string) =>
    (
      {
        n1: { name: "One", type: "project" },
        n2: { name: "Two", type: "area" },
        org: { name: "Org", type: "organization" },
      } as Record<string, { name: string; type: string }>
    )[id];

  it("resolves open nodes in order, including organizations", () => {
    const rows = deriveWorkspaceNodeRows(["n2", "org", "n1"], resolve);
    assert.deepEqual(rows, [
      { id: "n2", name: "Two", type: "area" },
      { id: "org", name: "Org", type: "organization" },
      { id: "n1", name: "One", type: "project" },
    ]);
  });

  it("drops ids that resolve to nothing", () => {
    const rows = deriveWorkspaceNodeRows(["ghost", "n1"], resolve);
    assert.deepEqual(rows, [{ id: "n1", name: "One", type: "project" }]);
  });

  it("de-duplicates a node listed twice", () => {
    const rows = deriveWorkspaceNodeRows(["n1", "n1"], resolve);
    assert.equal(rows.length, 1);
  });
});
