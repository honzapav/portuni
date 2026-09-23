// The personal workspace's one-time copy of its session content out of the
// graph db and into content.db (#456, spec
// docs/superpowers/specs/2026-09-22-local-sessions-design.md, "The content
// store on the device"). A personal workspace has always kept everything on
// the device, so its transcripts, briefs and inline summaries are sitting
// in the graph db; the copy is what keeps them readable after the runtime
// moves to content.db, and it runs exactly once, keyed on
// device_schema.version.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { openDeviceContentDb, readDeviceContentSchemaVersion } from "../apps/server/infra/device-content-db.js";
import {
  DEVICE_CONTENT_IMPORTED_VERSION,
  importGraphDbSessionContentOnce,
} from "../apps/server/boot/content-import.js";
import { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { createSession } from "../apps/server/domain/sessions.js";
import { makeSharedDb } from "./helpers/shared-db.js";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "portuni-content-import-"));
}

test("copies the graph db's session_events, brief and handoff_inline into content.db, once", async () => {
  const { db, nodeId } = await makeSharedDb();
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await db.execute({
      sql: "UPDATE sessions SET brief = ?, handoff_inline = ? WHERE id = ?",
      args: ["Oprav ten test", "# Shrnutí\n\nrozpracováno", session.id],
    });
    // The graph db's own session_events table has the shape content.db
    // mirrors, so the content store writes it directly -- exactly the rows
    // a pre-#456 sidecar left behind.
    await new SessionContentStore(db).appendEvents(session.id, null, [
      { kind: "user_message", payload: { text: "Oprav ten test", source: "chat" } },
      { kind: "assistant_message", payload: { text: "Hotovo." } },
    ]);

    const first = await importGraphDbSessionContentOnce(contentDb, db);
    assert.equal(first.ran, true);
    assert.equal(first.events, 2);
    assert.equal(first.contentRows, 1);

    const content = new SessionContentStore(contentDb);
    const events = await content.listEvents(session.id);
    assert.deepEqual(
      events.map((e) => [e.seq, e.kind]),
      [
        [1, "user_message"],
        [2, "assistant_message"],
      ],
    );
    const row = await content.getContent(session.id);
    assert.equal(row?.brief, "Oprav ten test");
    assert.match(row!.handoff_inline!, /rozpracováno/);
    assert.equal(await readDeviceContentSchemaVersion(contentDb), DEVICE_CONTENT_IMPORTED_VERSION);

    // Second boot: nothing to do, and nothing duplicated.
    const second = await importGraphDbSessionContentOnce(contentDb, db);
    assert.equal(second.ran, false);
    assert.equal(second.events, 0);
    assert.equal((await content.listEvents(session.id)).length, 2);
  } finally {
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is a no-op on a graph db that has no session content left to copy", async () => {
  const { db } = await makeSharedDb();
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  try {
    // Nothing written: a fresh install, or a workspace already past the
    // central migration that dropped the table and the two columns.
    await db.executeMultiple("DROP TABLE session_events");
    const result = await importGraphDbSessionContentOnce(contentDb, db);
    assert.equal(result.ran, true);
    assert.equal(result.events, 0);
    assert.equal(result.contentRows, 0);
    assert.equal(await readDeviceContentSchemaVersion(contentDb), DEVICE_CONTENT_IMPORTED_VERSION);
  } finally {
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partially copied transcript resumes without duplicating a row", async () => {
  const { db, nodeId } = await makeSharedDb();
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await new SessionContentStore(db).appendEvents(session.id, null, [
      { kind: "user_message", payload: { text: "a", source: "chat" } },
      { kind: "assistant_message", payload: { text: "b" } },
    ]);
    // A previous, interrupted pass already carried seq 1 over.
    await contentDb.execute({
      sql: `INSERT INTO session_events (id, session_id, run_id, seq, kind, payload, created_at)
            VALUES (?, ?, NULL, 1, 'user_message', '{"text":"a","source":"chat"}', ?)`,
      args: [ulid(), session.id, new Date().toISOString()],
    });

    await importGraphDbSessionContentOnce(contentDb, db);

    const events = await new SessionContentStore(contentDb).listEvents(session.id);
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2],
    );
  } finally {
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
