# src/sync -- file sync foundation

Plumbing for the pluggable file-sync layer. No MCP tools yet -- later plans add store/pull/status (plan 2), the custom Drive adapter with service-account auth (plan 3), and move/rename/delete with confirm-first (plan 4).

## Modules

- `types.ts` -- `FileAdapter`, `RemoteConfig`, `DeviceTokens`.
- `hash.ts` -- SHA-256 / MD5 utilities.
- `sync-key.ts` -- immutable storage-key generator for nodes, with collision handling.
- `remote-path.ts` -- `buildNodeRoot`, `buildRemotePath`, `subpathFromMirror`, `deriveLocalPath`. Uses `sync_key`, never mutable display names.
- `opendal-adapter.ts` -- FS + memory backends via OpenDAL. Drive is NOT here (plan 3).
- `local-db.ts` -- per-device libSQL at `$PORTUNI_WORKSPACE_ROOT/.portuni/sync.db`: `file_state`, `remote_stat_cache`, `local_mirrors`.
- `routing.ts` -- `remotes` CRUD, `remote_routing` CRUD, `resolveRemote`.

## Path identity: sync_key vs name

Every node has an immutable `sync_key` (generated at create, unique, never changes). All remote paths and local mirror paths are built from `sync_key`. Display `name` can change freely; sync paths stay stable.

## State layout

| What | Where |
|---|---|
| Canonical remote hash per file | Turso `files.current_remote_hash` |
| Routing and remote configs | Turso `remotes`, `remote_routing` |
| Node path identity (`sync_key`) | Turso `nodes.sync_key` (NOT NULL UNIQUE) |
| "What I last saw" per device | Local `.portuni/sync.db` `file_state` |
| 30s remote stat cache per device | Local `.portuni/sync.db` `remote_stat_cache` |
| Local mirror paths per device | Local `.portuni/sync.db` `local_mirrors` |
