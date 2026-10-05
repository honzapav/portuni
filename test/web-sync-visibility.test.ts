import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fileRowBadges,
  showsPersonalWorkspaceBanner,
  showsSyncSurfaces,
} from "../apps/web/src/lib/sync-visibility.js";
import type { SyncClass } from "../apps/web/src/types.js";

const ALL_CLASSES: SyncClass[] = [
  "clean",
  "push",
  "pull",
  "conflict",
  "remote_missing",
  "remote_error",
  "native",
  "deleted_local",
];

describe("sync surface visibility (#575)", () => {
  it("shows sync surfaces only in a team workspace", () => {
    assert.equal(showsSyncSurfaces("central"), true);
    assert.equal(showsSyncSurfaces("local"), false);
  });

  it("hides sync surfaces while the mode is still unknown", () => {
    assert.equal(showsSyncSurfaces(null), false);
    assert.equal(showsSyncSurfaces(undefined), false);
  });

  it("shows the personal-workspace banner only once known personal", () => {
    assert.equal(showsPersonalWorkspaceBanner("local"), true);
    assert.equal(showsPersonalWorkspaceBanner("central"), false);
    assert.equal(showsPersonalWorkspaceBanner(null), false);
  });
});

describe("fileRowBadges", () => {
  it("personal workspace: untracked file gets only the untracked badge", () => {
    assert.deepEqual(fileRowBadges("local", false, undefined), {
      untracked: true,
      missing: false,
      syncStatus: false,
    });
  });

  it("personal workspace: deleted_local gets the missing badge", () => {
    assert.deepEqual(fileRowBadges("local", true, "deleted_local"), {
      untracked: false,
      missing: true,
      syncStatus: false,
    });
  });

  it("personal workspace: every other class gets no badge", () => {
    for (const c of ALL_CLASSES.filter((c) => c !== "deleted_local")) {
      assert.deepEqual(
        fileRowBadges("local", true, c),
        { untracked: false, missing: false, syncStatus: false },
        c,
      );
    }
    assert.deepEqual(fileRowBadges("local", true, undefined), {
      untracked: false,
      missing: false,
      syncStatus: false,
    });
  });

  it("team workspace: tracked files keep the full sync badge, no separate missing badge", () => {
    for (const c of ALL_CLASSES) {
      assert.deepEqual(
        fileRowBadges("central", true, c),
        { untracked: false, missing: false, syncStatus: true },
        c,
      );
    }
    assert.deepEqual(fileRowBadges("central", false, undefined), {
      untracked: true,
      missing: false,
      syncStatus: false,
    });
    assert.deepEqual(fileRowBadges("central", true, undefined), {
      untracked: false,
      missing: false,
      syncStatus: false,
    });
  });
});
