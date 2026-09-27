// The personal workspace's one-time copy of its session content out of the
// graph db and into content.db (#456, spec
// docs/superpowers/specs/2026-09-22-local-sessions-design.md, "The content
// store on the device"). A personal workspace has always kept everything on
// the device, so its transcripts, briefs and inline summaries are sitting
// in the graph db; the copy is what keeps them readable after the runtime
// moves to content.db, and it runs exactly once, keyed on
// device_schema.version -- before migration 040 drops the same content from
// the graph db (#462), so every test that has content to copy starts from a
// graph db as it was before 040 (makeLegacySessionContentSchema).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { openDeviceContentDb, readDeviceContentSchemaVersion } from "../apps/server/infra/device-content-db.js";
import {
  DEVICE_CONTENT_IMPORTED_VERSION,
  ensurePersonalWorkspaceSchema,
  importGraphDbSessionContentOnce,
  importPersonalWorkspaceSessionContentOnBoot,
} from "../apps/server/boot/content-import.js";
import { readFileSync } from "node:fs";
import type { DbClient, InStatement } from "../apps/server/infra/db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { setDeviceContentDbForTesting } from "../apps/server/infra/device-content-db.js";
import { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { createSession } from "../apps/server/domain/sessions.js";
import { makeSharedDb } from "./helpers/shared-db.js";
import { makeLegacySessionContentSchema } from "./helpers/legacy-session-content.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";
import { SESSION_CONTENT_DROP_MIGRATION_ID } from "../apps/server/infra/schema-migrations.js";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "portuni-content-import-"));
}

test("copies the graph db's session_events, brief and handoff_inline into content.db, once", async () => {
  const { db, nodeId } = await makeSharedDb();
  await makeLegacySessionContentSchema(db);
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
    // A graph db past migration 040 (#462): no session_events, no brief,
    // no handoff_inline -- and a fresh install is the same shape.
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

// A thread that got new events on this device before an import that failed
// on an earlier boot finally ran keeps them -- after the imported ones.
test("a thread written here before a retried import keeps its new events after the imported ones", async () => {
  const { db, nodeId } = await makeSharedDb();
  await makeLegacySessionContentSchema(db);
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await new SessionContentStore(db).appendEvents(session.id, null, [
      { kind: "user_message", payload: { text: "a", source: "chat" } },
      { kind: "assistant_message", payload: { text: "b" } },
    ]);
    // Written on this device after the upgrade, before the import ran.
    await new SessionContentStore(contentDb).appendEvents(session.id, null, [
      { kind: "user_message", payload: { text: "c", source: "chat" } },
    ]);

    const result = await importGraphDbSessionContentOnce(contentDb, db);
    assert.equal(result.events, 2);

    const events = await new SessionContentStore(contentDb).listEvents(session.id);
    assert.deepEqual(
      events.map((e) => (JSON.parse(e.payload) as { text: string }).text),
      ["a", "b", "c"],
    );
    // A second pass copies nothing and duplicates nothing.
    await contentDb.execute("UPDATE device_schema SET version = 1");
    const again = await importGraphDbSessionContentOnce(contentDb, db);
    assert.equal(again.events, 0);
    assert.equal((await new SessionContentStore(contentDb).listEvents(session.id)).length, 3);
  } finally {
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A graph db whose reads fail on a statement matching `pattern`, `times`
// times -- the rest pass through.
function failingOn(db: DbClient, pattern: RegExp, times = 1): DbClient {
  let left = times;
  return {
    dialect: db.dialect,
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (left > 0 && pattern.test(sql)) {
        left--;
        throw new Error("simulated read failure");
      }
      return db.execute(stmt);
    },
    batch: (stmts, mode) => db.batch(stmts, mode),
    executeMultiple: (sql) => db.executeMultiple(sql),
    close: () => db.close(),
  };
}

test("a failed read of the graph db's sessions raises the version never; the next boot copies", async () => {
  const { db, nodeId } = await makeSharedDb();
  await makeLegacySessionContentSchema(db);
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await db.execute({ sql: "UPDATE sessions SET brief = ? WHERE id = ?", args: ["první zpráva", session.id] });

    await assert.rejects(() =>
      importGraphDbSessionContentOnce(contentDb, failingOn(db, /FROM sessions WHERE brief IS NOT NULL/)),
    );
    assert.equal(await readDeviceContentSchemaVersion(contentDb), 1, "nothing copied, nothing marked");

    const retry = await importGraphDbSessionContentOnce(contentDb, db);
    assert.equal(retry.contentRows, 1);
    assert.equal((await new SessionContentStore(contentDb).getContent(session.id))?.brief, "první zpráva");
    assert.equal(await readDeviceContentSchemaVersion(contentDb), DEVICE_CONTENT_IMPORTED_VERSION);
  } finally {
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A content db whose write transaction fails once for statements naming
// `sessionId` -- the thread's copy is one transaction, so none of it lands.
function failingBatchFor(contentDb: DbClient, sessionId: string): DbClient {
  let failed = false;
  return {
    dialect: contentDb.dialect,
    execute: (stmt) => contentDb.execute(stmt),
    batch: async (stmts: InStatement[], mode) => {
      const names = stmts.some((s) => typeof s !== "string" && (s.args as unknown[] | undefined)?.includes(sessionId));
      if (!failed && names) {
        failed = true;
        // Run the transaction with a statement that breaks it at the end,
        // so a copy that were not one transaction would leave rows behind.
        await contentDb.batch([...stmts, { sql: "INSERT INTO no_such_table VALUES (1)", args: [] }], mode);
      }
      return contentDb.batch(stmts, mode);
    },
    executeMultiple: (sql) => contentDb.executeMultiple(sql),
    close: () => contentDb.close(),
  };
}

test("a thread whose copy fails is not half-copied; the rest go through and the retry finishes it", async () => {
  const { db, nodeId } = await makeSharedDb();
  await makeLegacySessionContentSchema(db);
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  try {
    const a = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    const b = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    for (const s of [a, b]) {
      await new SessionContentStore(db).appendEvents(s.id, null, [
        { kind: "user_message", payload: { text: `ahoj ${s.id}`, source: "chat" } },
        { kind: "assistant_message", payload: { text: "ok" } },
      ]);
    }

    const first = await importGraphDbSessionContentOnce(failingBatchFor(contentDb, a.id), db);
    assert.equal(first.failed, 1);
    assert.equal(first.events, 2, "only the rows actually copied count");
    const content = new SessionContentStore(contentDb);
    assert.equal((await content.listEvents(a.id)).length, 0, "the failed thread is all or nothing");
    assert.equal((await content.listEvents(b.id)).length, 2);
    assert.equal(await readDeviceContentSchemaVersion(contentDb), 1, "a failure never marks the import done");

    const retry = await importGraphDbSessionContentOnce(contentDb, db);
    assert.equal(retry.failed, 0);
    assert.equal(retry.events, 2, "b was copied already and counts zero");
    assert.equal((await content.listEvents(a.id)).length, 2);
    assert.equal((await content.listEvents(b.id)).length, 2);
    assert.equal(await readDeviceContentSchemaVersion(contentDb), DEVICE_CONTENT_IMPORTED_VERSION);
  } finally {
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an imported event's ISO timestamp reads back as YYYY-MM-DD HH:MM:SS", async () => {
  const { db, nodeId } = await makeSharedDb();
  await makeLegacySessionContentSchema(db);
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await db.execute({
      sql: `INSERT INTO session_events (id, session_id, run_id, seq, kind, payload, created_at)
            VALUES (?, ?, NULL, 1, 'user_message', '{"text":"a","source":"chat"}', ?)`,
      args: [ulid(), session.id, "2026-09-20T08:15:30.123Z"],
    });
    await importGraphDbSessionContentOnce(contentDb, db);
    const [event] = await new SessionContentStore(contentDb).listEvents(session.id);
    assert.equal(event.created_at, "2026-09-20 08:15:30");
  } finally {
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- One boot step for a personal workspace, whichever entry point -------

test("the personal-workspace boot step copies the graph db's content into the process content db", async () => {
  const { db, nodeId } = await makeSharedDb();
  await makeLegacySessionContentSchema(db);
  const dir = tempDataDir();
  const contentDb = await openDeviceContentDb(dir);
  setDbForTesting(db);
  setDeviceContentDbForTesting(contentDb);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await db.execute({ sql: "UPDATE sessions SET brief = ? WHERE id = ?", args: ["ahoj", session.id] });
    await importPersonalWorkspaceSessionContentOnBoot();
    assert.equal((await new SessionContentStore(contentDb).getContent(session.id))?.brief, "ahoj");
  } finally {
    setDbForTesting(null);
    setDeviceContentDbForTesting(null);
    await contentDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Both entry points that can be a personal workspace run that one step: the
// standalone server (index.ts) and the desktop sidecar's local branch.
test("index.ts and desktop.ts both run the personal-workspace import at boot", () => {
  for (const entry of ["apps/server/index.ts", "apps/server/desktop.ts"]) {
    const source = readFileSync(join(process.cwd(), entry), "utf8");
    assert.match(source, /await ensurePersonalWorkspaceSchema\(\)/, entry);
  }
});

// --- #462: copy first, migrate second -------------------------------------

async function hasSessionContentInGraphDb(db: DbClient): Promise<{ events: boolean; brief: boolean; inline: boolean }> {
  const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='session_events'");
  const cols = new Set((await db.execute("PRAGMA table_info(sessions)")).rows.map((r) => String(r.name)));
  return { events: tables.rows.length > 0, brief: cols.has("brief"), inline: cols.has("handoff_inline") };
}

async function migrationRecorded(db: DbClient): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT 1 FROM migrations WHERE id = ?", args: [SESSION_CONTENT_DROP_MIGRATION_ID] });
  return r.rows.length > 0;
}

test("a device booting with an old graph db copies its content into content.db first, then migration 040 drops it", async () => {
  // libsql: migration 040 and the personal workspace's graph db are libsql.
  const { db, nodeId } = await makeSharedDb("libsql");
  await makeLegacySessionContentSchema(db);
  const { db: contentDb, content } = await installTestContentDb();
  setDbForTesting(db);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await db.execute({
      sql: "UPDATE sessions SET brief = ?, handoff_inline = ? WHERE id = ?",
      args: ["Oprav ten test", "# Shrnutí", session.id],
    });
    await new SessionContentStore(db).appendEvents(session.id, null, [
      { kind: "user_message", payload: { text: "Oprav ten test", source: "chat" } },
      { kind: "assistant_message", payload: { text: "Hotovo." } },
    ]);

    await ensurePersonalWorkspaceSchema();

    assert.equal((await content.getContent(session.id))?.brief, "Oprav ten test");
    assert.equal((await content.getContent(session.id))?.handoff_inline, "# Shrnutí");
    assert.deepEqual(
      (await content.listEvents(session.id)).map((e) => e.kind),
      ["user_message", "assistant_message"],
    );
    assert.equal(await readDeviceContentSchemaVersion(contentDb), DEVICE_CONTENT_IMPORTED_VERSION);
    assert.deepEqual(await hasSessionContentInGraphDb(db), { events: false, brief: false, inline: false });
    assert.equal(await migrationRecorded(db), true);
    assert.equal((await db.execute({ sql: "SELECT name FROM sessions WHERE id = ?", args: [session.id] })).rows.length, 1);
  } finally {
    setDbForTesting(null);
    clearTestContentDb();
  }
});

test("a boot whose copy did not complete holds migration 040 back; the next boot copies and migrates", async () => {
  const { db, nodeId } = await makeSharedDb("libsql");
  await makeLegacySessionContentSchema(db);
  const { db: contentDb, content } = await installTestContentDb();
  setDbForTesting(db);
  try {
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await db.execute({ sql: "UPDATE sessions SET brief = ? WHERE id = ?", args: ["první zpráva", session.id] });
    // content.db cannot take the thread on this boot.
    await contentDb.execute("ALTER TABLE session_content RENAME TO session_content_away");

    await ensurePersonalWorkspaceSchema();

    assert.equal(await readDeviceContentSchemaVersion(contentDb), 1, "the copy is not marked done");
    assert.deepEqual(await hasSessionContentInGraphDb(db), { events: true, brief: true, inline: true });
    assert.equal(await migrationRecorded(db), false);
    const kept = await db.execute({ sql: "SELECT brief FROM sessions WHERE id = ?", args: [session.id] });
    assert.equal(kept.rows[0]?.brief, "první zpráva");

    await contentDb.execute("ALTER TABLE session_content_away RENAME TO session_content");
    await ensurePersonalWorkspaceSchema();

    assert.equal((await content.getContent(session.id))?.brief, "první zpráva");
    assert.deepEqual(await hasSessionContentInGraphDb(db), { events: false, brief: false, inline: false });
    assert.equal(await migrationRecorded(db), true);
  } finally {
    setDbForTesting(null);
    clearTestContentDb();
  }
});
