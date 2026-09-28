// The device content database (content.db): its own DDL, its own version
// row, never a MIGRATIONS entry. Spec:
// docs/superpowers/specs/2026-09-22-local-sessions-design.md, "The content
// store on the device". Issue #455.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_CONTENT_SCHEMA_VERSION,
  openDeviceContentDb,
  readDeviceContentSchemaVersion,
  resolveDeviceContentDbPath,
} from "../apps/server/infra/device-content-db.js";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "portuni-content-db-"));
}

async function tableNames(db: Awaited<ReturnType<typeof openDeviceContentDb>>): Promise<string[]> {
  const res = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  return res.rows.map((r) => String(r.name));
}

test("content.db is created on first open with its three tables and the version row", async () => {
  const dir = tempDataDir();
  try {
    assert.equal(existsSync(join(dir, "content.db")), false);
    const db = await openDeviceContentDb(dir);
    try {
      const names = await tableNames(db);
      for (const expected of ["device_schema", "session_content", "session_events"]) {
        assert.ok(names.includes(expected), `missing table ${expected} in ${names.join(",")}`);
      }
      assert.equal(await readDeviceContentSchemaVersion(db), DEVICE_CONTENT_SCHEMA_VERSION);
      const versionRows = await db.execute("SELECT version FROM device_schema");
      assert.equal(versionRows.rows.length, 1, "device_schema holds exactly one row");
    } finally {
      await db.close();
    }
    assert.equal(existsSync(join(dir, "content.db")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening content.db keeps its rows and does not duplicate the version row", async () => {
  const dir = tempDataDir();
  try {
    const first = await openDeviceContentDb(dir);
    await first.execute({
      sql: "INSERT INTO session_content (session_id, brief, handoff_inline) VALUES (?, ?, ?)",
      args: ["s1", "první zpráva", null],
    });
    await first.close();

    const second = await openDeviceContentDb(dir);
    try {
      const res = await second.execute("SELECT brief FROM session_content WHERE session_id = 's1'");
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].brief, "první zpráva");
      const versionRows = await second.execute("SELECT version FROM device_schema");
      assert.equal(versionRows.rows.length, 1, "re-open never inserts a second version row");
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("content.db sits next to runners.json: PORTUNI_DATA_DIR when set, cwd otherwise", () => {
  const before = process.env.PORTUNI_DATA_DIR;
  try {
    process.env.PORTUNI_DATA_DIR = "/tmp/portuni-data-dir-probe";
    assert.equal(
      resolveDeviceContentDbPath(),
      join("/tmp/portuni-data-dir-probe", "content.db"),
    );
    delete process.env.PORTUNI_DATA_DIR;
    assert.equal(resolveDeviceContentDbPath(), join(process.cwd(), "content.db"));
  } finally {
    if (before === undefined) delete process.env.PORTUNI_DATA_DIR;
    else process.env.PORTUNI_DATA_DIR = before;
  }
});
