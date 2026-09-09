import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterStatusResult } from "../apps/server/domain/sync/status-filter.js";
import type { StatusResult, StatusFileEntry, NewLocalEntry } from "../apps/server/domain/sync/engine.js";

function fileEntry(overrides: Partial<StatusFileEntry> & { file_id: string }): StatusFileEntry {
  return {
    node_id: "N1",
    filename: overrides.file_id,
    local_path: null,
    remote_name: "test-fs",
    remote_path: `wip/${overrides.file_id}.md`,
    local_hash: null,
    remote_hash: null,
    last_synced_hash: null,
    class: "clean",
    ...overrides,
  };
}

function emptyResult(): StatusResult {
  return {
    clean: [],
    push_candidates: [],
    pull_candidates: [],
    conflicts: [],
    remote_missing: [],
    remote_error: [],
    native: [],
    new_local: [],
    new_remote: [],
    deleted_local: [],
    deleted_remote: [],
  };
}

describe("filterStatusResult", () => {
  it("with no options, counts equal the full sizes and nothing is dropped", () => {
    const result = emptyResult();
    result.push_candidates = [fileEntry({ file_id: "a" }), fileEntry({ file_id: "b" })];
    result.clean = [fileEntry({ file_id: "c" })];
    const out = filterStatusResult(result);
    assert.equal(out.push_candidates.length, 2);
    assert.equal(out.clean.length, 1);
    assert.equal(out.counts.push_candidates, 2);
    assert.equal(out.counts.clean, 1);
    assert.equal(out.counts.conflicts, 0);
    assert.equal(out.truncated, false);
  });

  it("classes restricts which buckets return entries, but counts still cover every bucket", () => {
    const result = emptyResult();
    result.push_candidates = [fileEntry({ file_id: "a" })];
    result.conflicts = [fileEntry({ file_id: "b" })];
    const out = filterStatusResult(result, { classes: ["push"] });
    assert.equal(out.push_candidates.length, 1);
    assert.equal(out.conflicts.length, 0);
    // counts are unaffected by the class restriction.
    assert.equal(out.counts.push_candidates, 1);
    assert.equal(out.counts.conflicts, 1);
  });

  it("deleted_remote is not filtered out by a class restriction", () => {
    const result = emptyResult();
    result.deleted_remote = [
      { file_id: "x", node_id: "N1", filename: "x.md", local_path: "/m/x.md", remote_path: "wip/x.md", hash: "h", record_alive: false },
    ];
    const out = filterStatusResult(result, { classes: ["push"] });
    assert.equal(out.deleted_remote.length, 1);
  });

  it("path_prefix filters entries by remote_path (or local_path for new_local)", () => {
    const result = emptyResult();
    result.push_candidates = [
      fileEntry({ file_id: "a", remote_path: "wip/keep/a.md" }),
      fileEntry({ file_id: "b", remote_path: "wip/drop/b.md" }),
    ];
    const newLocal: NewLocalEntry = {
      node_id: "N1",
      local_path: "/mirror/wip/keep/c.md",
      section: "wip",
      subpath: "keep",
      filename: "c.md",
      hash: "h",
    };
    result.new_local = [newLocal];
    const out = filterStatusResult(result, { pathPrefix: "wip/keep" });
    assert.deepEqual(
      out.push_candidates.map((e) => e.file_id),
      ["a"],
    );
    assert.equal(out.new_local.length, 0); // local_path does not start with "wip/keep"
  });

  it("limit/offset paginate each included bucket independently and set truncated", () => {
    const result = emptyResult();
    result.push_candidates = [
      fileEntry({ file_id: "a" }),
      fileEntry({ file_id: "b" }),
      fileEntry({ file_id: "c" }),
    ];
    const out = filterStatusResult(result, { limit: 1, offset: 1 });
    assert.deepEqual(
      out.push_candidates.map((e) => e.file_id),
      ["b"],
    );
    assert.equal(out.counts.push_candidates, 3);
    assert.equal(out.truncated, true);
  });

  it("limit large enough to cover everything leaves truncated false", () => {
    const result = emptyResult();
    result.push_candidates = [fileEntry({ file_id: "a" })];
    const out = filterStatusResult(result, { limit: 100 });
    assert.equal(out.truncated, false);
  });
});
