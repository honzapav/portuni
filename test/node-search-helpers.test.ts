import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_THRESHOLD,
  groupNodesByType,
  nodeTypeLabel,
} from "../apps/web/src/lib/node-search.js";

type N = { id: string; type: string };

function nodes(spec: Array<[string, number]>): N[] {
  const out: N[] = [];
  for (const [type, count] of spec) {
    for (let i = 0; i < count; i++) out.push({ id: `${type}-${i}`, type });
  }
  return out;
}

describe("groupNodesByType", () => {
  it("returns null at or below the threshold, so the list stays flat", () => {
    const short = nodes([
      ["project", 4],
      ["area", 4],
    ]);
    assert.equal(short.length, GROUP_THRESHOLD);
    assert.equal(groupNodesByType(short), null);
  });

  it("groups a longer list in the fixed POPP order with Czech labels", () => {
    const long = nodes([
      ["principle", 2],
      ["process", 2],
      ["project", 2],
      ["area", 2],
      ["organization", 2],
    ]);
    const groups = groupNodesByType(long);
    assert.ok(groups);
    assert.deepEqual(
      groups.map((g) => g.type),
      ["organization", "area", "project", "process", "principle"],
    );
    assert.deepEqual(
      groups.map((g) => g.label),
      ["Organizace", "Oblast", "Projekt", "Proces", "Princip"],
    );
    assert.deepEqual(
      groups.map((g) => g.nodes.length),
      [2, 2, 2, 2, 2],
    );
  });

  it("stays flat when a long list holds a single type, and sorts unknown types last", () => {
    assert.equal(groupNodesByType(nodes([["project", 12]])), null);
    const mixed = groupNodesByType(
      nodes([
        ["widget", 5],
        ["project", 5],
      ]),
    );
    assert.deepEqual(mixed?.map((g) => g.type), ["project", "widget"]);
    assert.equal(nodeTypeLabel("widget"), "widget");
  });
});
