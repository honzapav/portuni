// The Synchronizovat button's enable condition. Reported from the app: three
// files whose remote state had never been established, the node reading "Vše
// synchronizováno", and the button disabled -- so the reconcile pass that is
// the only thing able to resolve them could not be started at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncBarState } from "../apps/web/src/lib/sync-bar-state.js";
import type { SyncClass } from "../apps/web/src/types.js";

const s = (...classes: SyncClass[]) => syncBarState(classes, true);

describe("syncBarState", () => {
  it("a fully clean node offers nothing", () => {
    const r = s("clean", "clean", "native");
    assert.equal(r.noWork, true);
    assert.equal(r.canRun, false);
  });

  it("push and pull are the run's own work", () => {
    const r = s("clean", "push", "pull");
    assert.equal(r.pending, 2);
    assert.equal(r.canRun, true);
    assert.equal(r.noWork, false);
  });

  it("a conflict keeps the node actionable without counting as pending", () => {
    const r = s("clean", "conflict");
    assert.equal(r.pending, 0);
    assert.equal(r.conflicts, 1);
    assert.equal(r.canRun, true);
  });

  it("remote_missing enables the run -- the reconcile pass is what resolves it", () => {
    // The reported shape: everything else clean, three records whose remote
    // hash was never established.
    const r = s("clean", "clean", "remote_missing", "remote_missing", "remote_missing");
    assert.equal(r.remoteMissing, 3);
    assert.equal(r.canRun, true, "the button must be clickable");
    assert.equal(r.noWork, false, 'and must not claim "Vše synchronizováno"');
  });

  it("remote_missing stays out of pending and conflicts", () => {
    // It drives no badge and no label: an object that is genuinely gone must
    // not produce a pill that can never clear.
    const r = s("remote_missing");
    assert.equal(r.pending, 0);
    assert.equal(r.conflicts, 0);
    assert.equal(r.deletedLocal, 0);
  });

  it("deleted_local alone is a decision, not run work", () => {
    const r = s("clean", "deleted_local");
    assert.equal(r.deletedLocal, 1);
    // A run never restores it; nothing for the button to do.
    assert.equal(r.canRun, false);
    assert.equal(r.noWork, true);
  });

  it("before the status map loads, the button is not pre-emptively disabled", () => {
    const r = syncBarState([], false);
    assert.equal(r.noWork, false);
    assert.equal(r.canRun, true);
  });
});
