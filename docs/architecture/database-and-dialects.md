# Database, drivers and SQL dialects

The graph database is reached through one dialect-neutral client interface
(`apps/server/infra/db.ts`'s `DbClient`) with three drivers: libsql
(Turso or a local file), PGlite (embedded Postgres) and `pg` (a managed
Postgres). Every runtime query is written once and runs on both dialects;
the test suite runs on both drivers and the gate is green only when both
runs are. The cutover itself (libsql out, Postgres in) is tracked in
`docs/superpowers/plans/2026-09-12-infra-batch.md` (batch B) and executed
by hand per `docs/runbooks/postgres-cutover.md`; until B4 lands, libsql is
still the production driver everywhere.

## Which database runs where

| Runtime | Graph db | Per-device sync db |
|---|---|---|
| Personal workspace (desktop sidecar without `TURSO_URL`, or a standalone server with a `file:` URL) | `file:<dataDir>/portuni.db` via libsql (`apps/server/desktop.ts` sets `TURSO_URL` to that path when unset); PGlite after B4 | `<workspace>/.portuni/sync.db` |
| Central server (`PORTUNI_AUTH_MODE=google`) | Turso today; managed Postgres after B6 | none (no mirrors) |
| Team-workspace sidecar (`PORTUNI_AGENT_MODE=1`) | **none** | `<workspace>/.portuni/sync.db` |

Rules that follow:

- A sidecar with `TURSO_URL` pointing at Turso holds only an embedded
  replica; to answer "does node X exist?" ask Turso, the MCP server or the
  desktop app, never the local file under
  `~/Library/Application Support/ooo.workflow.portuni/`.
- A workspace without `TURSO_URL` has its local SQLite as the source of
  truth. No Turso is involved.
- A team-workspace sidecar has no graph db at all. New server code that reads
  the graph directly (`getDb()`, a `belongs_to` query, `session_scope`)
  needs a `CentralClient` counterpart or an injectable seam, or it silently
  breaks the one mode a team uses. The existing seams are listed in
  [`data-modes.md`](./data-modes.md) and
  [`sessions-and-runner.md`](./sessions-and-runner.md).
- `domain/sync/local-db.ts` (the per-device sync db) opens libsql's own
  `createClient` directly, wrapped in `createLibsqlDbClient`. It is not
  driven by `getDb()`'s driver selection and moves to PGlite together with
  the graph db in B4.
- A personal workspace cannot register or route to a remote; that rule and its
  legacy-row handling live in [`data-modes.md`](./data-modes.md).

## The `DbClient` interface and its drivers

`DbClient` (`infra/db.ts`) exposes `execute`, `batch`, `executeMultiple`,
`close` and a `dialect: "sqlite" | "postgres"` tag. `InValue`, `InArgs` and
`InStatement` keep libsql's names and shapes, so a call site reads
`db.execute({ sql, args })` regardless of driver. Every domain, api, mcp,
auth and infra file imports `DbClient` from `infra/db.js`; nothing outside
`infra/` imports `@libsql/client` types.

Drivers:

- `db-libsql.ts`: passthrough over a libsql `Client`, shallow-copying
  libsql's hybrid array/object `Row` into a plain object (the `DbClient`
  contract is plain objects).
- `db-pglite.ts`: `@electric-sql/pglite`, in-process Postgres. The local
  driver after B4.
- `db-pg.ts`: a `pg` `Pool`. The central driver after B6.

Both Postgres packages are pinned exact in `package.json`, like the Claude
SDK; bump them deliberately.

`getDb()` picks the driver from `PORTUNI_DATABASE_URL`:
`postgres://` or `postgresql://` selects `pg`, `pglite:<dir>` or a bare
`pglite:` selects PGlite, `file:` or `libsql:` selects libsql. Unset, it
falls back to `TURSO_URL` and then to `file:./portuni.db`, so production
stays on libsql until the cutover.

Placeholders are `?` everywhere. The pg and PGlite drivers rewrite them to
`$1, $2, ...` themselves (`infra/sql-placeholders.ts`'s
`rewritePositionalPlaceholders`, which skips string and identifier
literals, `--` and `/* */` comments and dollar-quoted bodies). Named
(object) args are not supported; both Postgres drivers throw on one rather
than mishandle it.

`infra/backup.ts` (the Turso SQL dump behind `scripts/backup-turso.ts` and
`npm run backup`) is the one file still written against the raw libsql
`Client`/`Transaction` types. It goes away with libsql in B4; do not port it.

## Schema and migrations

`ensureSchemaOn` (`infra/schema.ts`) branches on `dialect`.

**libsql path.** Fresh-install DDL (`schema-triggers.ts`'s `DDL` +
`DDL_MIGRATION_006`), then the numbered `MIGRATIONS` in
`schema-migrations.ts` (ids `NNN_name`, marker rows in `migrations`), then
`DDL_AFTER_MIGRATIONS`. That last list exists for one reason: anything that
needs a column a migration adds (an index on it, for instance) runs only
after every migration has run. A statement placed in plain `DDL` runs
*before* the migrations, so an index on a not-yet-existing column takes the
whole boot down on an upgrading install (that is how a production outage
and a locked 0.13.x install happened).

**Postgres path.** `infra/migrations/pg.ts`'s `ensurePgSchema` has its own
`migrations` bookkeeping with a disjoint id space (`pg-NNN`; a database
never holds both id shapes). `pg-001` is the whole baseline: every table
from `schema.pg.ts`'s `PG_BASELINE_DDL` and every trigger from
`schema-triggers.pg.ts`'s `PG_BASELINE_TRIGGERS`, applied as one
`executeMultiple` script together with its own marker row. Postgres wraps a
multi-statement simple-query script in an implicit transaction, so a
mid-baseline failure commits nothing and the next boot retries cleanly.
Every `CREATE TRIGGER` there is preceded by `DROP TRIGGER IF EXISTS`, so a
baseline that was applied without its marker still boots.

The baseline is what a *fresh* libsql install ends up with (DDL,
`DDL_MIGRATION_006`, `DDL_AFTER_MIGRATIONS`, plus every migration whose
`up()` still does something on an empty database), not a replay of the
libsql migration list. Translation rules, applied uniformly:

| SQLite | Postgres |
|---|---|
| `DATETIME`, `DEFAULT (datetime('now'))` | `TIMESTAMPTZ`, `DEFAULT now()` |
| `REAL` | `DOUBLE PRECISION` |
| `INTEGER ... CHECK(x IN (0,1))` | unchanged (call sites read and write 0/1) |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` (`remote_routing.id`; `BY DEFAULT` so the importer may insert an explicit id) |
| `CHECK(json_valid(x))` | `CHECK(x::jsonb IS NOT NULL)` |
| `GENERATED ... VIRTUAL` from `json_extract` | `GENERATED ALWAYS AS ((col::jsonb ->> 'key')) STORED` |
| `RAISE(ABORT, 'msg')` in a trigger | `RAISE EXCEPTION 'msg'` |
| `WHEN <cond> BEGIN ... END` trigger guard | `IF <cond> THEN ... END IF;` in the function body |
| `UPDATE OF col` trigger | unchanged |

Two deliberate differences from the libsql shape:

- `session_events`' primary key is `(session_id, seq)`; `id` stays a
  `NOT NULL` ULID column without its own uniqueness constraint.
- `nodes_owner_must_be_real_person` is ported (exported as
  `PG_TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON`) but not part of
  `PG_BASELINE_TRIGGERS`, matching a fresh libsql install where migration
  014 drops it. There is no FK on `nodes.owner_id` in either dialect's fresh
  shape.

`seedSoloUser` runs on both dialects (`INSERT OR IGNORE ... datetime('now')`
vs `ON CONFLICT (id) DO NOTHING ... now()`), unconditionally, whatever the
auth mode.

### Adding a migration today

1. Read `docs/lessons-learned.md` §7 first. A table rebuild is one
   `executeMultiple` script (Turso over HTTP does not keep `PRAGMA
   foreign_keys = OFF` across separate `execute` calls); test a migration
   against a real Turso fork, not only `:memory:`; run `npm run backup`
   before deploying one; write `isApplied` probes so they fail on an empty
   torso of a table.
2. Add the libsql entry to `MIGRATIONS` in `schema-migrations.ts` **and**
   extend `PG_BASELINE_DDL` (and `PG_BASELINE_TRIGGERS` if a trigger
   changes) in `schema.pg.ts`. Do not add a `pg-002` to `PG_MIGRATIONS`
   until the cutover has run; the baseline is still what a fresh Postgres
   gets.
3. An index or constraint on a column a migration adds goes into
   `DDL_AFTER_MIGRATIONS`, never into `DDL`.
4. If the change touches `sessions`, extend migration 030's rebuild too.
   That migration is written to carry the *current full shape* forward
   (its column list, its `state` CHECK), because a database that already
   passed later migrations may still need 030's own fix; a rebuild that
   drops a newer column or rejects a newer `state` value loses data.
5. `test/migration-*.test.ts` and `test/schema-pg-baseline.test.ts` are
   the two places a schema change is proven; see the test section below
   for which driver each one pins.

## Dialect-neutral SQL

Every query under `apps/server/{domain,api,mcp,auth,infra}` runs on both
dialects. The fragment helpers in `infra/sql.ts` take the client's
`dialect` and are the only permitted way to write the constructs that
differ:

| Need | Helper | Never write |
|---|---|---|
| current timestamp | `nowExpr(dialect)` | `datetime('now')`, `CURRENT_TIMESTAMP` inline |
| JSON field | `jsonField(dialect, col, key)` | `json_extract(...)`, `->>` inline |
| JSON array as rows (seeding a CTE) | `jsonArrayElementsText(dialect)` | `json_each(?)`, `jsonb_array_elements_text` inline |
| insert-or-skip | `insertIgnore(dialect, sql)` | `INSERT OR IGNORE` |
| audit remote path expression | `auditRemotePathExpr(dialect)` | a hand-written `json_extract` |
| schema introspection | `tableExistsSql(dialect)` | `sqlite_master`, `pg_tables` inline |

Constructs that need no translation and may be used directly: `?`
placeholders, `ON CONFLICT ... DO UPDATE`, `ROW_NUMBER() OVER`.

Constructs that break on Postgres and must not appear in runtime code:

- `PRAGMA` (only the libsql migration path uses it, after the
  `dialect === "postgres"` early return).
- `COLLATE NOCASE`; write `lower(col) = lower(?)`.
- A `GROUP BY` that selects un-aggregated columns; group by the table's
  primary key (`n.id`), which Postgres accepts through functional
  dependency, and select the other columns of that table.
- `SELECT DISTINCT ... ORDER BY` on a column not in the select list.
- SQL-side relative dates (`datetime('now', '-1 second')`); compute the
  timestamp in JS and bind it.

Exempt from the rule by design: `infra/schema.ts`,
`infra/schema-migrations.ts` and `infra/schema-triggers.ts` (the libsql-only
DDL and migration runner; `schema.pg.ts` and `schema-triggers.pg.ts` are
their Postgres counterparts, not a shared code path), `infra/backup.ts`, and
`domain/sync/local-db.ts`.

## Timestamps and row normalization

`DbValue` is `null | string | number | bigint | ArrayBuffer`. Postgres
returns `TIMESTAMPTZ` as a JS `Date`, so `infra/pg-row-normalize.ts`'s
`normalizePgRow` (called from both Postgres drivers' `toDbResultSet`)
renders any `Date` as `"YYYY-MM-DD HH:MM:SS"`: second precision, no zone
suffix, the same text SQLite's `datetime('now')` produces. Every Zod row
schema types a `*_at` column as `z.string()`, and the call sites that
string-compare two timestamps keep sorting correctly on both dialects.

Both Postgres drivers pin the session time zone to UTC (`SET TIME ZONE
'UTC'` after PGlite's `waitReady`; `options: "-c timezone=UTC"` on the `pg`
Pool). The normalized text is zone-less UTC and the importer feeds it back
as a bare literal, which Postgres reads in the session zone; without the
pin, a host outside UTC shifts every timestamp on each export/import round
trip.

## Errors and constraint detection

Never match a driver's error text. `infra/sql.ts` provides:

- `isUniqueViolation(err)`: libsql's `LibsqlError` code and message, or
  SQLSTATE `23505` from pg/PGlite. Used for the concurrent-invite race in
  `auth/users.ts` (`UserExistsError`).
- `constraintViolationMessage(err)`: a trigger or constraint rejection to
  surface as a friendly 409 (`http/middleware.ts`'s `respondError`).
  Matches libsql's `SQLITE_CONSTRAINT` wrapping (still needing the regex
  extraction of the inner text) and Postgres's `P0001` (`RAISE EXCEPTION`)
  or any `23xxx` class, whose message is already the trigger's own text.
- `CHECK(x::jsonb IS NOT NULL)` rejects invalid JSON with a cast error
  rather than a constraint violation; the row is refused either way.

## Tests on both drivers

`npm test` runs the suite on libsql; `npm run test:pglite` runs the same
files with `PORTUNI_TEST_DB=pglite`. `scripts/agent-gate.sh` runs `npm run
qa` (lint, typecheck, test on libsql, build) and then `npm run test:pglite`
as a separate step; `ci.yml`'s `server` job runs both as sequential steps
in one job. A change is green only when both runs are, and a PR that claims
"green on both drivers" carries both summary lines.

Conventions:

- A test opens its database with `test/helpers/db.ts`'s `openTestDb()`
  (driver from `PORTUNI_TEST_DB`, default libsql). `test/helpers/shared-db.ts`'s
  `makeSharedDb()` is built on it, so every fixture-based test is
  dialect-parametrized without doing anything.
- Pin `openTestDb("libsql")` (or `makeSharedDb("libsql")`) only in a test
  that *is* the libsql migration path: every `test/migration-*.test.ts`,
  and the specific cases in `test/files-unique-remote.test.ts` and
  `test/events-supersede.test.ts` that call `runMigrationNNN`/
  `runMigrations`, hand-write SQLite DDL, read `sqlite_master` or flip
  `PRAGMA foreign_keys`. Say so in a comment. `test/schema-pg-baseline.test.ts`
  is the Postgres counterpart: it boots a PGlite `:memory:` database,
  applies the baseline and exercises the same trigger behaviors the libsql
  trigger tests cover (org invariant, attachment validation, lifecycle
  derivation, `sync_key` guards, `idx_files_unique_remote`, the generated
  column, the `session_events` composite key, idempotency of a second
  `ensureSchemaOn`).
- A test that introspects the schema uses `tableExistsSql(dialect)`; one
  that inserts fixtures uses `insertIgnore`/`nowExpr` and skips `PRAGMA` on
  Postgres; one that needs a past or future timestamp computes it in JS
  (`new Date(...).toISOString().replace("T", " ").slice(0, 19)`) and binds
  it.
- `test/db-client-conformance.test.ts` runs the client contract
  (positional args, batch atomicity, `executeMultiple`) against all three
  drivers. The `pg` driver's run is skipped unless `PORTUNI_TEST_PG_URL`
  names a live server; the automated gate never exercises `pg` against a
  real Postgres.
- Both test scripts run with `--test-timeout=120000 --test-force-exit`. A
  stalled test fails with "test timed out" instead of hanging the run; a
  leaked socket or timer is still a bug to fix, it just cannot hide.
- `test:pglite` caps `--test-concurrency=2`. Each PGlite instance is a
  WASM Postgres; at `node --test`'s default concurrency the full suite
  OOM-kills the heavier files. Do not raise the cap to speed a run up.
- No fixed `sleep` in a test; wait for a signal, an event or an injected
  clock.

## Export and import (the cutover tool)

`apps/server/infra/db-export.ts` and `db-import.ts` hold the logic;
`scripts/db-export.ts` and `scripts/db-import.ts` are thin CLI wrappers.
Runbook: `docs/runbooks/postgres-cutover.md`.

- Export is dialect-agnostic: `SELECT * FROM t ORDER BY <pk>` against any
  `DbClient`, one JSON file per table in `TABLE_ORDER` (the FK-safe order
  the Postgres baseline creates tables in), plus `manifest.json`.
- `migrations` is not exported or imported. Its rows are dialect-specific
  bookkeeping; the target already holds the right state from applying its
  own baseline before the import. The source's ids are recorded in the
  manifest for reference only.
- `importDb` refuses a target holding any row beyond the one `seedSoloUser`
  always creates (`users` is counted excluding `SOLO_USER`). `users` is
  inserted as an upsert on `id` so a source's own solo-user row replaces
  the placeholder; every other table is a plain insert into a proven-empty
  table.
- Rows keep their original ids. `remote_routing.id` is therefore
  `GENERATED BY DEFAULT AS IDENTITY`, and `resyncIdentitySequence`
  fast-forwards the sequence past the highest imported id afterwards
  (a no-op on libsql).
- `session_runs.resumed_from_run_id` is the schema's one self-referencing
  FK. It is inserted as NULL in the main pass and backfilled in a second
  UPDATE pass once every `session_runs` row exists.

## See also

- `docs/superpowers/plans/2026-09-12-infra-batch.md`: batch B steps and
  their status.
- `docs/runbooks/postgres-cutover.md`: the manual cutover and rollback.
- `docs/lessons-learned.md` §7: the migration incident behind the
  `executeMultiple` rule.
- [`data-modes.md`](./data-modes.md): which runtime reaches which
  database, and the seams a team-workspace sidecar uses instead of a graph db.
- [`sessions-and-runner.md`](./sessions-and-runner.md): the session store
  and runtime seams.
