// The Files tab plan/node-id pairing (#451), spec
// docs/superpowers/specs/2026-09-22-files-organize-design.md, rule 8.
//
// syncFilePlanEntry is the pure core of useFilePlan's render-time reset: it
// decides whether an { nodeId, plan } pair still matches the node the
// component wants, without ever mixing one node's plan into another's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncFilePlanEntry, type FilePlanEntry } from "../apps/web/src/lib/use-file-plan.js";
import type { FilePlan } from "../apps/web/src/lib/file-plan.js";

const planA: FilePlan = { moves: { f1: { section: "outputs", subpath: "hotove" } }, folders: ["wip/nove"] };
const planB: FilePlan = { moves: {}, folders: [] };

function loaderFor(plans: Record<string, FilePlan>) {
  return (nodeId: string): FilePlan => plans[nodeId] ?? { moves: {}, folders: [] };
}

describe("syncFilePlanEntry", () => {
  it("keeps the same entry (by reference) when the node id has not changed", () => {
    const entry: FilePlanEntry = { nodeId: "node-a", plan: planA };
    const load = loaderFor({ "node-a": planA });
    const resolved = syncFilePlanEntry(entry, "node-a", load);
    assert.equal(resolved, entry);
  });

  it("a plan loaded for A, laid over B's files, resolves to B's own plan, not A's", () => {
    const entry: FilePlanEntry = { nodeId: "node-a", plan: planA };
    const load = loaderFor({ "node-a": planA, "node-b": planB });
    const resolved = syncFilePlanEntry(entry, "node-b", load);
    assert.equal(resolved.nodeId, "node-b");
    assert.deepEqual(resolved.plan, planB);
    // Not A's virtual folders or moves under B's id -- no write for B would
    // ever carry A's plan.
    assert.notDeepEqual(resolved.plan, planA);
  });

  it("switching A -> B -> A resolves back to A's own stored plan each time", () => {
    const stored: Record<string, FilePlan> = { "node-a": planA, "node-b": planB };
    const load = loaderFor(stored);
    let entry: FilePlanEntry = { nodeId: "node-a", plan: load("node-a") };
    entry = syncFilePlanEntry(entry, "node-b", load);
    assert.deepEqual(entry.plan, planB);
    entry = syncFilePlanEntry(entry, "node-a", load);
    assert.equal(entry.nodeId, "node-a");
    assert.deepEqual(entry.plan, planA);
  });
});
