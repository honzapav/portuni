// The outcome line next to the Sync button describes ONE run. A clean one
// fades after five seconds; one reporting a failure stays until something
// changes (#267). That stickiness is what made it repeat live state as a
// permanent claim: "2 conflicts · 7 unfinished" kept saying two conflicts
// after both were resolved, with the live pill beside it already at zero.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeSyncRun } from "../apps/web/src/lib/sync-run-summary.js";
import type { SyncRunResponse } from "../apps/web/src/types.js";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";

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

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "files");
const tCs = i18n.getFixedT("cs", "files");

const file = (id: string) => ({ file_id: id, filename: `${id}.md` });

describe("summarizeSyncRun", () => {
  it("an empty run reports everything synced", () => {
    const o = summarizeSyncRun(run(), tEn);
    assert.equal(o.text, "All synced");
    assert.equal(o.hasError, false);
    assert.equal(o.detail, null);
  });

  it("a fading line may carry live counts -- it is gone in five seconds", () => {
    const o = summarizeSyncRun(run({ pushed: [file("a")], conflicts: [file("b")] }), tEn);
    assert.equal(o.hasError, false);
    assert.equal(o.text, "1 pushed · 1 conflict");
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
      tEn,
    );
    assert.equal(o.hasError, true, "unfinished repairs make it stick");
    assert.match(o.text, /7 unfinished/, "what the run could not finish stays");
    assert.doesNotMatch(
      o.text,
      /conflict/,
      "conflicts have a live pill -- a frozen count would contradict it",
    );
  });

  it("a sticky line drops deleted_local for the same reason", () => {
    const o = summarizeSyncRun(
      run({ deleted_local: [file("a")], errors: [{ file_id: "c", filename: "c.md", error: "x" }] }),
      tEn,
    );
    assert.equal(o.hasError, true);
    assert.doesNotMatch(o.text, /deleted locally/);
    assert.match(o.text, /1 error/);
  });

  it("keeps per-item detail for the tooltip", () => {
    const o = summarizeSyncRun(
      run({
        errors: [{ file_id: "a", filename: "a.md", error: "nope" }],
        sweep_errors: [{ remote_path: "org/p/wip/x.md", error: "could not verify" }],
      }),
      tEn,
    );
    assert.ok(o.detail?.includes("a.md: nope"));
    assert.ok(o.detail?.includes("org/p/wip/x.md: could not verify"));
  });

  it("counts use every Czech plural form", () => {
    const conflicts = (n: number) =>
      summarizeSyncRun(run({ conflicts: Array.from({ length: n }, (_, i) => file(`f${i}`)) }), tCs).text;
    assert.equal(conflicts(1), "1 konflikt");
    assert.equal(conflicts(3), "3 konflikty");
    assert.equal(conflicts(5), "5 konfliktů");
    assert.equal(summarizeSyncRun(run(), tCs).text, "Vše synchronizováno");
  });
});
