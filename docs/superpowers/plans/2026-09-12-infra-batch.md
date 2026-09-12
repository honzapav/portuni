# Infra batch: one collaboration mode, Postgres, remote watcher

**Goal:** Central is the only place Portuni data is shared; central runs on
managed Postgres, local mode on embedded Postgres (PGlite); the remote side of
file state is maintained on central.

**Specs:** `docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md`,
`docs/superpowers/specs/2026-09-12-remote-watcher-design.md`.

**Shape:** three batches, each a sandcastle run on its own branch and PR,
in this order. Every item below becomes one GitHub issue (`ready-for-agent`)
unless marked **human**. Issues carry the same sections as this plan
(context, files, change, tests, docs). Docs site changes ride in the same
branch as the behaviour change.

## Global constraints

- One SQL dialect in the codebase after batch B: Postgres. Central =
  managed Postgres over `pg`; local sidecar and the test suite =
  `@electric-sql/pglite` (in-process, persisted under the workspace data
  dir). No libsql/Turso left anywhere.
- One implementation of everything new, running on central and in the local
  sidecar alike; local-only branches are removals, never a second path.
- `scripts/agent-gate.sh` green at every PR; CI adds no services (PGlite is
  in-process).
- Never edit release-please files or manifest versions.
- UI strings in Czech with diacritics.

## Decisions taken outside the specs

- Local mode keeps a database of its own but it is PGlite, not SQLite.
  The spec's "local mode stays on Turso" is superseded: two dialects would
  mean every SQL site twice.
- Postgres hosting: managed Postgres (Tempo already runs one). Cutover is
  a one-off with nobody using central at the time.
- The 34 libsql migrations are not ported. Batch B ships a fresh Postgres
  baseline DDL; existing data (central and every local workspace) enters
  through export/import. The migration framework continues from the
  baseline with new numbers.

---

## Batch A: one collaboration mode (spec steps 1 to 3)

### A1. feat(sync): a local workspace cannot register or route to a remote

Context: rule 2 of the spec. Today an unenforced convention; the first Drive
connect on a local workspace reintroduces the split.

Files: `apps/server/domain/sync/remote-service.ts` (`setDriveTarget`,
`connectDrive`), `apps/server/domain/sync/remotes.ts` (`upsertRemote`,
routing policy writer), `apps/server/mcp/tools/sync-remotes.ts`
(`portuni_setup_remote`, `portuni_set_routing_policy`),
`apps/server/api/sync-drive.ts`, `apps/server/desktop.ts` (mode detection).

Change: a server that is neither `PORTUNI_AUTH_MODE=google` nor
`PORTUNI_AGENT_MODE=1` is a local workspace. In that mode every remote
registration and routing write throws `LOCAL_MODE_NO_REMOTE` with a message
that names central mode as the way to share. One predicate in the domain
layer (`isLocalWorkspace()`), called from the domain functions, not from
each tool. Existing rows: a local workspace that already has a remote logs a
warning at boot and behaves as if it had none (the engine change is A3).

Tests: domain-level refusal for `upsertRemote`, routing policy, Drive
target; MCP tool and REST route surface the same code; google-mode and
agent-mode servers unaffected.

Docs: `sites/docs` `concepts/data-modes.md` (local mode has no remote),
`reference/sync.md` error code.

### A2. refactor(sync,desktop,web): retire the per-user Drive OAuth path

Context: spec "What this removes". Drive credentials live on central only.

Files: delete `apps/server/domain/sync/remote-service.ts`,
`apps/server/api/sync-drive.ts`, `apps/server/domain/sync/drive-user-auth.ts`,
`apps/web/src/components/SyncSection.tsx`, `apps/web/src/lib/sync-drive.ts`;
modify `apps/desktop/src/auth.rs` (remove `google_drive_connect` and the
Drive-scope PKCE variant, keep `google_login`), `apps/desktop/src/lib.rs`
(command registration, `is_local_only_path` entries for `/sync/drive/*`),
`apps/server/domain/sync/drive-adapter.ts` (auth is service-account only;
`refresh_token` token mode removed), `apps/server/auth/min-scopes.ts`,
`apps/web/src/components/SettingsPage.tsx` (Synchronizace tab shows only the
watcher status line from C4, until then nothing), `CLAUDE.md` gotcha "Drive
sync has two auth paths".

Change: remove the code paths above and their tests. The service-account
path (`portuni_setup_remote`, `setup-drive-remote` prompt) is the only Drive
auth and it is central-only after A1.

Tests: remove `test/sync-drive-*`, `drive-user-auth` tests; adapter test
asserts the token mode enum no longer accepts `refresh_token`.

Docs: `guides/setting-up-remotes.md` (service account on central is the
path), `clients/desktop-app.md`, `guides/working-in-the-app.md`
(Synchronizace section), `getting-started/roadmap.md` line 43.

### A3. refactor(sync): the local engine becomes a file tracker

Context: spec step 2, second half. Local mode has no remote, so the local
engine's remote half (27 adapter call sites in `engine.ts`,
`cachedRemoteStat`, `remote_stat_cache`, the `fast` parameter, local
push/pull) goes.

Files: `apps/server/domain/sync/engine.ts`, `engine-mutations.ts`,
`local-db.ts` (`RemoteStatRow`, `remote_stat_cache` table),
`sync-run.ts` (`runNodeSync` local), `remote-sweep.ts` (local caller),
`mcp/tools/{files,sync-status,sync-snapshot}.ts` (`portuni_store`,
`portuni_pull`, `portuni_snapshot` in local mode), `api/nodes.ts`
(`POST /nodes/:id/sync`, `/files/:fileId/resolve` local), `apps/web`
`SyncBar`, `SyncOverview`, `DetailPane.files.tsx` (local mode hides push,
pull, resolve, keeps the file list and the tracked/untracked state).

Change: `statusScan` in local mode reads only maintained local state
(`file_state.cached_local_hash` + disk). The class vocabulary is unchanged;
a local workspace can only ever report `clean` (tracked, on disk),
`new_local` (untracked) and `deleted_local` (tracked, gone from disk).
`push`, `pull`, `conflict`, `remote_*` never occur without a remote.
`portuni_store`/`portuni_pull`/`POST /sync` in local mode return
`LOCAL_MODE_NO_REMOTE`. Central-mode code (`engine-central.ts`) is
untouched. `remote_stat_cache` is dropped from the per-device DB.

Tests: local `statusScan` never touches an adapter (fake adapter throws on
any call); tracked/untracked classification from disk + cache; MCP and REST
refusals; central suite unchanged.

Docs: `concepts/mirrors.md`, `reference/sync.md`, `concepts/data-modes.md`
2×2 cell "Local mode → sync engine → Drive", `docs/architecture/file-sync.md`
setup sections, `CLAUDE.md` gotcha "Source of truth depends on the
workspace's DB mode".

### A4. docs: one collaboration mode sweep

Context: spec "Docs site". After A1 to A3 land, one pass over the listed
pages for leftovers, plus `docs/architecture/data-modes.md`.

Files: `sites/docs/src/content/docs/{getting-started/roadmap,guides/setting-up-remotes,concepts/data-modes,clients/desktop-app,guides/working-in-the-app,concepts/mirrors,reference/sync}.md`,
`docs/architecture/data-modes.md`.

Change: grep for "OAuth", "My Drive", "local mode … Drive", "fast";
rewrite; `npm --prefix sites/docs run build`.

---

## Batch B: Postgres

Order matters: every step leaves the suite green on the driver in use.

### B1. refactor(infra): database client interface with libsql and PGlite implementations

Context: 65 of 67 `@libsql/client` imports are `import type { Client }`;
two files call `createClient` (`infra/db.ts`, `domain/sync/local-db.ts`).

Files: `apps/server/infra/db.ts` (new `DbClient` type: `execute(sql,
args?)`, `batch(stmts, mode?)`, `executeMultiple(sql)`, `close()`; rows as
plain objects, `rowsAffected`, `lastInsertRowid` where used),
`apps/server/infra/db-libsql.ts`, `apps/server/infra/db-pglite.ts`,
`apps/server/infra/db-pg.ts` (`pg` Pool; `batch` = one transaction),
`test/helpers/db.ts` (`openTestDb(): Promise<DbClient>` choosing the
driver from `PORTUNI_TEST_DB=libsql|pglite`, default libsql in this step),
every `import type { Client } from "@libsql/client"` → `DbClient`.

Change: add `@electric-sql/pglite` and `pg` as dependencies; the singleton
`getDb()` picks the driver from `PORTUNI_DATABASE_URL` (`postgres://…` →
pg, `pglite:<dir>` → PGlite, `file:`/`libsql:` → libsql for this step
only). `setDbForTesting` keeps working. No SQL text changes yet.

Tests: driver conformance test run against all three (`execute` with
positional args, `batch` atomicity: a failing statement rolls back the
batch, `executeMultiple`); the whole existing suite still green on libsql.

### B2. feat(infra): Postgres baseline schema and triggers

Context: the 34 libsql migrations use the `nodes_new` rebuild pattern that
cost production data once; they are not ported.

Files: `apps/server/infra/schema.pg.ts` (baseline DDL: every table as it
exists after migration 034, `TIMESTAMPTZ` columns, `GENERATED ALWAYS AS
IDENTITY` for the two `AUTOINCREMENT` sites, CHECK constraints from
`shared/popp.ts`), `apps/server/infra/schema-triggers.pg.ts` (the 10
triggers as PL/pgSQL functions, same names), `apps/server/infra/migrations/`
(new framework entry: `migrations` table with `applied_at`; baseline is
migration `pg-001`), `apps/server/infra/schema-migrations.ts` untouched.

Change: `ensureSchema(db)` applies the baseline when the `migrations` table
is absent, then any later `pg-NNN`. Only the PGlite/pg drivers use it; the
libsql path still runs the old file.

Tests: boot a PGlite `:memory:` DB, apply baseline, assert table list and
trigger behaviour (organization invariant trigger, sessions terminal
index, files unique remote path) against the existing trigger tests
re-pointed at PGlite. The rest of the suite still on libsql.

### B3. refactor(server): dialect-neutral SQL, suite green on both drivers

Context: 83 `datetime('now')`, 14 `json_extract`, 8 `INSERT OR IGNORE`,
56 `PRAGMA`, 11 `db.batch`, 6 `executeMultiple`.

Files: `apps/server/infra/sql.ts` (helpers: `NOW` = `CURRENT_TIMESTAMP`,
`jsonField(col, path)` emitting `json_extract` or `->>` by driver,
`insertIgnore` → `ON CONFLICT DO NOTHING`), every query site under
`apps/server/{domain,api,mcp,auth,infra}`.

Change: replace the constructs listed; `PRAGMA` sites are removed (they
belong to the rebuild machinery and `foreign_keys`, both gone with the
baseline); `db.batch` stays (it is a transaction on pg/PGlite and a batch on
libsql). `ROW_NUMBER() OVER` and `ON CONFLICT … DO UPDATE` unchanged.
Parameter placeholders: libsql `?` vs pg `$1` is handled in the driver
(`db-pg.ts` rewrites `?` → `$n`), not at call sites.

Tests: `npm test` runs the whole suite twice in CI: `PORTUNI_TEST_DB=libsql`
and `PORTUNI_TEST_DB=pglite` (matrix in `ci.yml`, both in `agent-gate.sh`).
Green on both is the exit criterion.

### B4. feat(infra,desktop): PGlite is the local database, libsql is gone

Context: one dialect. Local workspaces move from `portuni.db` to a PGlite
directory; the desktop's Turso layer has no purpose.

Files: `apps/server/desktop.ts` (`PORTUNI_DATABASE_URL=pglite:<dataDir>/db`
default; first boot with a legacy `portuni.db` present and no `db/`
directory runs the import from B5's tool in-process, then renames
`portuni.db` → `portuni.db.migrated`), `apps/server/domain/sync/local-db.ts`
(`.portuni/sync.db` → PGlite dir `.portuni/sync/`, same tables), delete
`infra/db-libsql.ts`, `infra/schema-migrations.ts`, `infra/schema.ts`
libsql DDL, `scripts/backup-turso.*`, `apps/desktop/src/lib.rs`
(`set_turso_token`, `clear_turso_token`, `get_turso_status`,
`migrate_turso_token_to_keychain`, `TURSO_*` envs at sidecar spawn),
`apps/web/src/components/TursoSetupGate.tsx`, `WorkspacesSection.tsx` and
`lib/workspaces.ts` Turso fields, `.env.schema`, `docs/env-vars.md`,
`README.md` quickstart, `CLAUDE.md` (Turso mentions).

Change: remove libsql from `package.json`; `PORTUNI_TEST_DB` goes away
(PGlite only); CI matrix collapses. Central deployment reads
`PORTUNI_DATABASE_URL=postgres://…` (B5).

Tests: fresh local boot creates the PGlite dir and passes the smoke suite;
legacy-import boot test with a fixture `portuni.db` exported from the
current schema; Rust tests for the removed commands deleted.

Docs: `getting-started/setup.md` (no Turso), `team-setup.md` (Postgres
URL), `concepts/data-modes.md`.

### B5. feat(infra): export and import tools for the cutover

Context: central data leaves Turso once; every local workspace leaves its
SQLite once. Same tool both ways.

Files: `scripts/db-export.ts` (reads any `DbClient`, writes one JSON file
per table, row order by primary key, includes `migrations` state),
`scripts/db-import.ts` (reads the JSON into an empty Postgres/PGlite with
the baseline applied; FK-ordered; refuses a non-empty target),
`docs/release-process.md` or a new `docs/runbooks/postgres-cutover.md`
(steps for central: stop server, export from Turso, import to managed
Postgres, set `PORTUNI_DATABASE_URL` on the VPS, deploy, `/health`; and
the rollback: point the URL back at Turso until libsql is removed by B4
— so B5 lands before B4).

Tests: round-trip export → import on PGlite equals the source (row counts
and a checksum per table); import refuses a non-empty target.

### B6. human: provision managed Postgres and run the cutover

Managed Postgres instance (Tempo account), `PORTUNI_DATABASE_URL` in the VPS
env, run the runbook from B5, backups on the provider side, then merge B4.

---

## Batch C: remote watcher (after B, spec rule 5)

### C1. fix(web): SyncBar mounts for any node with a mirror, "Zkontrolovat remote" when nothing is pending

Context: spec "API and UI", second bullet, and Asana task "Node bez souborů
nemá jak spustit synchronizaci". Independent of the watcher; can run in
batch A instead.

Files: `apps/web/src/components/DetailPane.tsx` (mount condition),
`apps/web/src/lib/sync-bar-state.ts` (`canRun`), `apps/web/src/components/SyncBar.tsx`
(label), `test/sync-bar-state.test.ts`.

Change: mount whenever the node has a mirror; `canRun` true with the label
„Zkontrolovat remote" at zero pending; `POST /sync/jobs` default unchanged.

### C2. feat(sync): Drive adapter `changes()` over the Changes API

Files: `apps/server/domain/sync/adapter.ts` (`StorageAdapter.changes?`,
`RemoteChange` type as in the spec), `apps/server/domain/sync/drive-adapter.ts`
(`changes.getStartPageToken`, `changes.list` with `driveId`, pagination,
`removed`/`trashed`, ancestor cache → path, `reset` on invalid token),
`apps/server/domain/sync/opendal-adapter.ts` (no `changes`; capability
absent).

Tests: against the mocked `driveFetch` per spec "Testing" bullet 1.

### C3. feat(sync): remote watcher on central

Files: `apps/server/domain/sync/remote-watcher.ts` (pure reducer over
`RemoteChange[]` reusing the sweep's adopt / hash-refresh / delete +
tombstone functions from `remote-sweep.ts`; out-of-root and out-of-section
drop; cursor persisted after a full batch), `apps/server/boot/remote-watch.ts`
(60 s tick, exponential backoff, full sweep at boot, on `reset`, every 6 h;
started from `index.ts` only when `PORTUNI_AUTH_MODE=google`), migration
`pg-002`: `remote_cursors`, `remote_folder_cache`, `apps/server/domain/sync/sync-jobs.ts`
(catch-up sweep never overlaps a user job on the same node).

Tests: spec "Testing" bullets 2 to 4, including the end-to-end on the fake
central (`test/central/*`): a file added to the fake Drive reads as `pull`
on the device's next status read without a sync run.

### C4. feat(api,web): watcher status

Files: `apps/server/api/router.ts` (`GET /sync/watch`), `shared/api-types.ts`,
`apps/web/src/components/SettingsPage.tsx` Synchronizace tab (one line per
remote: „Drive sledován, poslední změna před 2 min", error and backoff
states), `SyncOverview.tsx` and `Sidebar.tsx` (count of nodes with `pull`
records as the signal outside node detail).

Docs: `reference/sync.md`, `concepts/mirrors.md` (remote side is
maintained), `docs/architecture/file-sync.md`.

### C5. human: verify against the real Drive

Add, edit, rename, trash a file in the shared drive; watch `GET /sync/watch`
and the device's Files tab. Quota check in the Cloud console after a day.

---

## Order and dependencies

```
A1 → A2 → A3 → A4        (batch A, one sandcastle run)
C1 can join batch A
B1 → B2 → B3 → B5 → B6(human) → B4     (batch B; B4 last, after cutover)
C2 → C3 → C4 → C5(human)                (batch C, after B)
```

Runner and task work (vision, next plan) starts in parallel with batch A;
it touches `apps/web` Práce/Relace and the sidecar spawn path, not the
sync engine or the database driver.
