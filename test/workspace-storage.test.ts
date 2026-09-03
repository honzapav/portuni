import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  namespacedKey,
  migrateUnscopedStorage,
  type StorageLike,
} from "../apps/web/src/lib/workspace-storage.js";

// Minimal in-memory StorageLike so the migration is tested as a pure
// function, without a real (or even DOM-shaped) localStorage.
function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  dump: () => Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe("namespacedKey", () => {
  it("builds portuni:<ws_id>:<key>", () => {
    assert.equal(namespacedKey("acme", "openNodes"), "portuni:acme:openNodes");
  });
});

describe("migrateUnscopedStorage", () => {
  it("moves every unscoped key into the workspace namespace and deletes the old ones", () => {
    const storage = fakeStorage({
      "portuni:openNodes": '["n1","n2"]',
      "portuni:fileTreeCollapsed": '{"n1":["wip"]}',
      "portuni:workspace.detailVisible": "false",
      "portuni.first-steps-pending": "1",
    });

    migrateUnscopedStorage(storage, "acme");

    assert.deepEqual(storage.dump(), {
      "portuni:acme:openNodes": '["n1","n2"]',
      "portuni:acme:fileTreeCollapsed": '{"n1":["wip"]}',
      "portuni:acme:workspace.detailVisible": "false",
      "portuni:acme:first-steps-pending": "1",
    });
  });

  it("is a no-op when there is nothing unscoped to migrate", () => {
    const storage = fakeStorage({ "portuni:acme:openNodes": '["n1"]' });
    migrateUnscopedStorage(storage, "acme");
    assert.deepEqual(storage.dump(), { "portuni:acme:openNodes": '["n1"]' });
  });

  it("migrates only the keys that are actually present, leaving unrelated keys alone", () => {
    const storage = fakeStorage({
      "portuni:openNodes": '["n1"]',
      "portuni:theme": "light",
    });
    migrateUnscopedStorage(storage, "acme");
    assert.deepEqual(storage.dump(), {
      "portuni:acme:openNodes": '["n1"]',
      "portuni:theme": "light",
    });
  });

  it("never clobbers a namespaced value that already exists (first write wins)", () => {
    const storage = fakeStorage({
      "portuni:openNodes": '["stale"]',
      "portuni:acme:openNodes": '["already-current"]',
    });
    migrateUnscopedStorage(storage, "acme");
    assert.equal(storage.getItem("portuni:acme:openNodes"), '["already-current"]');
    // The stale unscoped key is still deleted -- it must never resurface.
    assert.equal(storage.getItem("portuni:openNodes"), null);
  });

  it("is idempotent -- running it twice is the same as running it once", () => {
    const storage = fakeStorage({ "portuni:openNodes": '["n1"]' });
    migrateUnscopedStorage(storage, "acme");
    const afterFirst = storage.dump();
    migrateUnscopedStorage(storage, "acme");
    assert.deepEqual(storage.dump(), afterFirst);
  });

  it("scopes to the given workspace id, not some other one", () => {
    const storage = fakeStorage({ "portuni:openNodes": '["n1"]' });
    migrateUnscopedStorage(storage, "beta");
    assert.equal(storage.getItem("portuni:beta:openNodes"), '["n1"]');
    assert.equal(storage.getItem("portuni:acme:openNodes"), null);
  });
});
