// Picks the DbClient driver a test runs against, controlled by
// PORTUNI_TEST_DB=libsql|pglite (default libsql for this step of the infra
// batch, docs/superpowers/plans/2026-09-12-infra-batch.md B1). Both are
// in-memory/in-process -- no external service, no cleanup needed. B3 is
// what actually runs the whole suite under both values; for now this is
// only exercised by the driver conformance test itself.
import { createClient } from "@libsql/client";
import { createLibsqlDbClient } from "../../apps/server/infra/db-libsql.js";
import { createPgliteDbClient } from "../../apps/server/infra/db-pglite.js";
import type { DbClient } from "../../apps/server/infra/db.js";

export type TestDbDriver = "libsql" | "pglite";

export function testDbDriver(): TestDbDriver {
  const raw = process.env.PORTUNI_TEST_DB?.trim();
  return raw === "pglite" ? "pglite" : "libsql";
}

export async function openTestDb(driver: TestDbDriver = testDbDriver()): Promise<DbClient> {
  if (driver === "pglite") {
    return createPgliteDbClient();
  }
  return createLibsqlDbClient(createClient({ url: ":memory:" }));
}
