// The Synchronizovat button's enable condition. Reported from the app: three
// files whose remote state had never been established, the node reading "Vše
// synchronizováno", and the button disabled -- so the reconcile pass that is
// the only thing able to resolve them could not be started at all.
//
// #313: the button is always enabled -- a mirror with zero tracked files (or
// one where everything already reads clean) still needs a way to trigger a
// run, since its remote sweep is the only thing that ever adopts a file that
// showed up on Drive out of band. This module only reports the counts; SyncBar
// swaps the label to "Zkontrolovat remote" when noWork is true.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncBarState } from "../apps/web/src/lib/sync-bar-state.js";
import type { SyncClass } from "../apps/web/src/types.js";

const s = (...classes: SyncClass[]) => syncBarState(classes, true);

describe("syncBarState", () => {
  it("a fully clean node reports no work", () => {
    const r = s("clean", "clean", "native");
    assert.equal(r.noWork, true);
  });

  it("a node with zero tracked files at all reports no work", () => {
    // The reported gap: a mirror created but never populated/adopted has no
    // records to classify at all, so the button used to read as a dead end.
    const r = s();
    assert.equal(r.pending, 0);
    assert.equal(r.noWork, true);
  });

  it("push and pull are the run's own work", () => {
    const r = s("clean", "push", "pull");
    assert.equal(r.pending, 2);
    assert.equal(r.noWork, false);
  });

  it("a conflict keeps the node actionable without counting as pending", () => {
    const r = s("clean", "conflict");
    assert.equal(r.pending, 0);
    assert.equal(r.conflicts, 1);
  });

  it("remote_missing keeps the node from reading as no-work -- the reconcile pass is what resolves it", () => {
    // The reported shape: everything else clean, three records whose remote
    // hash was never established.
    const r = s("clean", "clean", "remote_missing", "remote_missing", "remote_missing");
    assert.equal(r.remoteMissing, 3);
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

  it("deleted_local alone is a decision, not run work, but still allows a run", () => {
    const r = s("clean", "deleted_local");
    assert.equal(r.deletedLocal, 1);
    // A run never restores it, but the button is not disabled by it either.
    assert.equal(r.noWork, true);
  });

  it("before the status map loads, the button is not pre-emptively disabled", () => {
    const r = syncBarState([], false);
    assert.equal(r.noWork, false);
  });
});
