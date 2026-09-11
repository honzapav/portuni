// The outcome line next to Synchronizovat describes ONE run. A clean one
// fades after five seconds; one reporting a failure stays until something
// changes (#267). That stickiness is what made it repeat live state as a
// permanent claim: "2 konflikty · nedokončeno 7" kept saying two conflicts
// after both were resolved, with the live pill beside it already at zero.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeSyncRun } from "../apps/web/src/lib/sync-run-summary.js";
import type { SyncRunResponse } from "../apps/web/src/types.js";

function run(over: Partial<SyncRunResponse> = {}): SyncRunResponse {
  return {
    pushed: [],
    pulled: [],
    adopted: [],
    adopted_remote: [],
    conflicts: [],
    deleted_local: [],
    deleted_remote: [],
    deleted_on_remote: [],
    repaired: [],
    pending_repairs: [],
    sweep_errors: [],
    errors: [],
    skipped: [],
    ...over,
  } as SyncRunResponse;
}

const file = (id: string) => ({ file_id: id, filename: `${id}.md` });

describe("summarizeSyncRun", () => {
  it("an empty run reports everything synced", () => {
    const o = summarizeSyncRun(run());
    assert.equal(o.text, "Vše synchronizováno");
    assert.equal(o.hasError, false);
    assert.equal(o.detail, null);
  });

  it("a fading line may carry live counts -- it is gone in five seconds", () => {
    const o = summarizeSyncRun(run({ pushed: [file("a")], conflicts: [file("b")] }));
    assert.equal(o.hasError, false);
    assert.match(o.text, /Push 1/);
    assert.match(o.text, /1 konflikt/);
  });

  it("a sticky line reports the run, never the live conflict count", () => {
    // The exact shape the user hit: a run that pushed nothing, saw two
    // conflicts and could not finish seven repairs.
    const o = summarizeSyncRun(
      run({
        conflicts: [file("a"), file("b")],
        pending_repairs: Array.from({ length: 7 }, (_, i) => ({
          op: "move",
          attempts: i + 1,
          last_error: "boom",
        })) as SyncRunResponse["pending_repairs"],
      }),
    );
    assert.equal(o.hasError, true, "unfinished repairs make it stick");
    assert.match(o.text, /nedokončeno 7/, "what the run could not finish stays");
    assert.doesNotMatch(
      o.text,
      /konflikt/,
      "conflicts have a live pill -- a frozen count would contradict it",
    );
  });

  it("a sticky line drops deleted_local for the same reason", () => {
    const o = summarizeSyncRun(
      run({ deleted_local: [file("a")], errors: [{ file_id: "c", filename: "c.md", error: "x" }] }),
    );
    assert.equal(o.hasError, true);
    assert.doesNotMatch(o.text, /smazáno lokálně/);
    assert.match(o.text, /chyby 1/);
  });

  it("keeps per-item detail for the tooltip", () => {
    const o = summarizeSyncRun(
      run({
        errors: [{ file_id: "a", filename: "a.md", error: "nope" }],
        sweep_errors: [{ remote_path: "org/p/wip/x.md", error: "could not verify" }],
      }),
    );
    assert.ok(o.detail?.includes("a.md: nope"));
    assert.ok(o.detail?.includes("org/p/wip/x.md: could not verify"));
  });
});
