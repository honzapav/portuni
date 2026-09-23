// SessionContentStore over a temp content.db: the transcript and the two
// content columns the device keeps for a thread. Spec:
// docs/superpowers/specs/2026-09-22-local-sessions-design.md, "The content
// store on the device". Issue #455.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDeviceContentDb } from "../apps/server/infra/device-content-db.js";
import { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import type { CanonicalEvent } from "../apps/server/domain/runner/types.js";

async function withStore(
  fn: (store: SessionContentStore) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "portuni-content-store-"));
  const db = await openDeviceContentDb(dir);
  try {
    await fn(new SessionContentStore(db));
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function userMessage(text: string): CanonicalEvent {
  return { kind: "user_message", payload: { text, source: "chat" } };
}

function assistantMessage(text: string): CanonicalEvent {
  return { kind: "assistant_message", payload: { text } };
}

test("appendEvents assigns increasing seq per session, independently across sessions", async () => {
  await withStore(async (store) => {
    const first = await store.appendEvents("s1", "run-1", [userMessage("ahoj"), assistantMessage("zdravím")]);
    assert.deepEqual(first, [1, 2]);
    const second = await store.appendEvents("s1", "run-1", [assistantMessage("ještě něco")]);
    assert.deepEqual(second, [3]);
    // A different session starts its own sequence.
    const other = await store.appendEvents("s2", null, [userMessage("jiné vlákno")]);
    assert.deepEqual(other, [1]);

    const rows = await store.listEvents("s1");
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.kind), ["user_message", "assistant_message", "assistant_message"]);
    assert.equal(rows[0].run_id, "run-1");
    assert.equal(JSON.parse(rows[0].payload).text, "ahoj");
    assert.equal((await store.appendEvents("s1", null, [])).length, 0);

    const orphan = await store.listEvents("s2");
    assert.equal(orphan.length, 1);
    assert.equal(orphan[0].run_id, null);
  });
});

test("listEvents honours after and limit the way the record store does", async () => {
  await withStore(async (store) => {
    await store.appendEvents("s1", "run-1", [
      userMessage("a"),
      assistantMessage("b"),
      assistantMessage("c"),
      assistantMessage("d"),
    ]);
    assert.deepEqual((await store.listEvents("s1", { after: 2 })).map((r) => r.seq), [3, 4]);
    assert.deepEqual((await store.listEvents("s1", { limit: 2 })).map((r) => r.seq), [1, 2]);
    assert.deepEqual(
      (await store.listEvents("s1", { after: 1, limit: 2 })).map((r) => r.seq),
      [2, 3],
    );
    assert.deepEqual(await store.listEvents("s1", { after: 99 }), []);
  });
});

test("appendEvents caps an oversized assistant payload", async () => {
  await withStore(async (store) => {
    await store.appendEvents("s1", null, [assistantMessage("x".repeat(70 * 1024))]);
    const [row] = await store.listEvents("s1");
    const text = JSON.parse(row.payload).text as string;
    assert.equal(Buffer.byteLength(text, "utf8"), 64 * 1024);
  });
});

test("setContent upserts brief and handoff_inline without clobbering each other", async () => {
  await withStore(async (store) => {
    assert.equal(await store.getContent("s1"), null);

    const afterBrief = await store.setContent("s1", { brief: "první zpráva" });
    assert.deepEqual(afterBrief, { session_id: "s1", brief: "první zpráva", handoff_inline: null });

    const afterHandoff = await store.setContent("s1", { handoff_inline: "shrnutí" });
    assert.deepEqual(afterHandoff, {
      session_id: "s1",
      brief: "první zpráva",
      handoff_inline: "shrnutí",
    });

    const cleared = await store.setContent("s1", { handoff_inline: null });
    assert.equal(cleared.handoff_inline, null);
    assert.equal(cleared.brief, "první zpráva");
  });
});

test("deleteContent drops the thread's content row and its transcript", async () => {
  await withStore(async (store) => {
    await store.setContent("s1", { brief: "první zpráva" });
    await store.appendEvents("s1", null, [userMessage("ahoj")]);
    await store.setContent("s2", { brief: "jiné vlákno" });
    await store.appendEvents("s2", null, [userMessage("ahoj odjinud")]);

    await store.deleteContent("s1");

    assert.equal(await store.getContent("s1"), null);
    assert.deepEqual(await store.listEvents("s1"), []);
    assert.notEqual(await store.getContent("s2"), null);
    assert.equal((await store.listEvents("s2")).length, 1);
  });
});
