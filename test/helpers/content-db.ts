// The device content db (content.db) for tests: an in-memory libsql client
// with the real DDL, installed as the process singleton so every code path
// that reaches for deviceSessionContentStore() (the session runtime, the
// suspend paths, the boot sweeps, the REST routes) writes here instead of
// creating a content.db in the repo root.

import { createClient } from "@libsql/client";
import { createLibsqlDbClient } from "../../apps/server/infra/db-libsql.js";
import {
  ensureDeviceContentSchema,
  setDeviceContentDbForTesting,
} from "../../apps/server/infra/device-content-db.js";
import type { DbClient } from "../../apps/server/infra/db.js";
import { SessionContentStore } from "../../apps/server/domain/runner/store-content.js";

export async function openMemoryContentDb(): Promise<DbClient> {
  const db = createLibsqlDbClient(createClient({ url: ":memory:" }));
  await ensureDeviceContentSchema(db);
  return db;
}

// Installs a fresh in-memory content db as the process singleton and hands
// back both it and a store over it.
export async function installTestContentDb(): Promise<{ db: DbClient; content: SessionContentStore }> {
  const db = await openMemoryContentDb();
  setDeviceContentDbForTesting(db);
  return { db, content: new SessionContentStore(db) };
}

export function clearTestContentDb(): void {
  setDeviceContentDbForTesting(null);
}
