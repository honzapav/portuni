# One collaboration mode: retire local mode's remote half

Central mode becomes the only way Portuni data is shared. Local mode keeps
direct Turso access and mirror folders on one machine, and stops touching a
remote at all: no Drive credentials, no push, no pull. Drive access
consolidates on the central server, which already reaches it adapter-direct.

The database question follows from this one and is settled here too.

## Decision

1. **Collaboration is central mode.** This is already true of teammates;
   what changes is that the owner joins them for anything shared. A
   workspace that syncs files to Drive runs `data_mode: "central"`.
2. **Local mode means one machine.** Direct Turso, mirror folders, watcher,
   no remote. Routing a local workspace to a remote stops being possible
   rather than merely discouraged — an unenforced rule returns as a bug the
   first time somebody connects Drive to a local workspace.
3. **Drive is Shared Drives only, on Google Workspace.** My Drive targets
   are not supported. Personal Google accounts are out of scope for file
   sync. This is what makes service-account auth sufficient and retires the
   per-user OAuth path.
4. **Drive credentials live on the central server only.** No device ever
   holds them.

## What this removes

| Surface | Lines |
|---|---|
| `domain/sync/remote-service.ts` (connect/target/status/test/disconnect) | 301 |
| `web/components/SyncSection.tsx` (Nastavení → Synchronizace) | 512 |
| `web/lib/sync-drive.ts` | 132 |
| `api/sync-drive.ts` | 77 |
| `domain/sync/drive-user-auth.ts` | 53 |
| PKCE loopback in `apps/desktop/src/auth.rs` | part of 759 |

Plus the remote half of the local engine: the 17 adapter/stat call sites in
`engine.ts`, `cachedRemoteStat`, the `remote_stat_cache` table, the `fast`
parameter, and local push/pull. The local engine becomes a file tracker
rather than a sync engine.

The "two auth paths sharing one adapter" rule in `CLAUDE.md` collapses to
one path.

## What this does not remove

**The two engines do not merge.** `central/engine-central.ts` (1656 lines)
exists because the graph plane is remote; `engine.ts` + `engine-mutations.ts`
(2684) exist because local mode talks straight to Turso. Removing the remote
half of the local one still leaves two classification and reconcile paths.
The prize is the Drive surface plus roughly a third of the local engine, not
half the codebase.

**Best-effort ordering around Drive stays.** `pending_file_ops`, the
`repair_needed` contract and the remote sweep exist because no database
offers a transaction spanning a Drive API call. That is unchanged by any
decision here, including the database one.

## Costs accepted

1. **The owner cannot push while central is unreachable.** Today a local
   workspace pushes to Drive on its own. This is not hypothetical on a
   laptop: one sidecar log carried 12 451 failed calls to `api.portuni.com`
   — 2 019 `ENOTFOUND`, 3 400 `FailedToOpenSocket`, 7 030 refused
   connections — all of them this machine being offline, not the server
   being down.
2. **Drive-side attribution becomes the service account**, not the person.
   Portuni's own `audit_log` still records who did what. Restoring per-user
   attribution needs domain-wide delegation (below) and is not a blocker.

## Domain-wide delegation

Optional, not a prerequisite. `drive-sa-auth.ts`'s `signJwt` already accepts
a `sub` claim (lines 13 and 19) and nothing passes it, so the service
account acts as itself. Passing `sub` lets central act as each user, which
restores per-user identity on Drive. `PORTUNI_GOOGLE_IMPERSONATE` already
configures DWD for the Directory API, so the Workspace-side setup exists.

## Database

**Turso and the mode decision are one question, not two.** Local mode reaches
the database directly and the desktop keeps a local SQLite file. Postgres has
no embedded or offline replica, and a desktop app must not hold a credential
to the production database. So:

- Local mode stays a full peer → keep Turso. HTTP-reachable SQLite with
  per-client tokens is exactly what makes that mode possible.
- Central-only (this spec) → the desktop never touches the database and
  Postgres becomes the natural choice.

### Why Postgres, once central-only

One recorded structural problem, and it cost production data once —
`docs/lessons-learned.md` §7, incident 2026-06-10, migration 017 emptying
`nodes`:

> Turso přes HTTP nedrží `PRAGMA foreign_keys = OFF` mezi jednotlivými
> `db.execute()` voláními (každý statement může jít jiným spojením)

No session state across statements is the model, not a bug. It is also why
this codebase has no write transactions: one `db.transaction()` in the whole
server and it is read-only (`backup.ts:73`); everything else is `db.batch()`
(11 sites). Two of the three recurring taxes in lessons-learned share that
root — no `ALTER TABLE` (line 259) and the `nodes_new`/`files_new` rebuild
pattern that caused the incident. Postgres removes both with real
`ALTER TABLE` and transactional DDL.

### Migration cost

The driver binding is shallow: 65 of the 67 `@libsql/client` import lines
are `import type { Client }`; two files call `createClient`. The work is
`infra/db.ts` plus adapting the `Client` shape (`execute`, `batch`,
`executeMultiple`).

| Construct | Sites | Postgres |
|---|---|---|
| `datetime('now')` | 83 | `now()` |
| `json_extract` | 14 | `->>` / `jsonb` |
| `ON CONFLICT` | 13 | unchanged |
| `CREATE TRIGGER` | 10 | rewrite as PL/pgSQL functions |
| `INSERT OR IGNORE` | 8 | `ON CONFLICT DO NOTHING` |
| `ROW_NUMBER() OVER` | 4 | unchanged |
| `AUTOINCREMENT` | 2 | `GENERATED` / `serial` |
| `PRAGMA` | 54 | removed with the rebuild machinery |

Triggers are the only non-mechanical item.

## Sequence

1. Enforce rule 2: a local workspace cannot register or route to a remote.
2. Retire the per-user OAuth Drive path and the local engine's remote half.
   `fast` and the local remote check go with it, as a consequence.
3. Rewrite the docs pages listed below.
4. Migrate to Postgres. Not before step 1 — choosing Postgres while local
   mode is still a full peer forces a return to SQLite from a worse
   position.

Domain-wide delegation can land at any point after step 2.

## Already shipped

Central-mode classification no longer guesses at the remote. A missing
`files.current_remote_hash` means **unknown**, never absent: the record-only
registration paths write NULL to mean "never pushed", and the only path that
proves absence (the remote sweep) deletes the record instead.

- `domain/sync/remote-knowledge.ts` names the three states.
- `statusScanCentral` has no `fast` parameter. The scan is a read of
  maintained state; re-deriving is `resolveUnknownRemotes`, the sync run's
  reconcile pass, which resolves records central has no hash for instead of
  skipping them forever.
- A push the remote refuses because it holds different content is reported
  as a conflict, not an error, and the device records the hash it observed
  — so the file becomes resolvable instead of retrying a push that cannot
  land.
- The periodic backfill sweep stops after the first network failure and
  backs off exponentially; sidecar logs rotate at 8 MB.

The local engine keeps `fast` until step 2. It is not broken there: its slow
path stats the remote live, so the wrong guess self-corrects.

## Docs site

Step 3 rewrites, in this order:

- `getting-started/roadmap.md` — line 43 documents both Drive auth paths as
  shipped and names DWD as the unshipped enabler.
- `guides/setting-up-remotes.md` — currently recommends the path being
  removed ("Desktop, one click (recommended for most people)").
- `concepts/data-modes.md` — the 2×2's "Local mode → sync engine → Drive"
  cell.
- `clients/desktop-app.md`, `guides/working-in-the-app.md` (Synchronizace),
  `concepts/mirrors.md`, `reference/sync.md`.

## Explicitly out of scope

- Merging the two sync engines.
- Removing `pending_file_ops` and the `repair_needed` contract.
- A hash-only stat endpoint on central. It would make
  `resolveUnknownRemotes` cheaper than a download; it needs a central
  deployment, and the bounded download works without one.
- File backends other than Drive. The adapter interface is ready; nothing
  here changes it.

## References

- `docs/architecture/data-modes.md` — the canonical local-vs-central model.
- `docs/lessons-learned.md` §7 — the migration 017 incident.
- `docs/archive/plans/2026-07-03-teammate-mirrors.md` — central-mode sync
  agent.
