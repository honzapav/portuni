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

## Google Drive backend (Service Account only)

Phase 1 supports Google Drive via Service Account (SA) authentication against Shared Drives.
User "My Drive" is explicitly not supported: the SA's `shared_drive_id` is required,
and every Drive API call sets `supportsAllDrives=true` + `driveId=<shared_drive_id>` + `corpora=drive`.

### Security model

- The SA has a fixed identity (an email like `portuni@<project>.iam.gserviceaccount.com`).
- Access is granted by **adding the SA as a member of each Shared Drive** Portuni manages (Content Manager role typically suffices).
- Compromise blast radius = those Shared Drives. Nothing outside the drives the admin explicitly granted is reachable.
- OAuth is NOT used. No per-user consent, no refresh-token revocation handling, no "connect device" dance.

### One-time admin setup (per Portuni deployment)

1. In Google Cloud Console, create a project and enable the Drive API.
2. Create a service account. Generate a JSON key.
3. For each Shared Drive Portuni will manage: Share -> Add the SA email -> give Content Manager.
4. Optionally, pick a subfolder within the Shared Drive to serve as the Portuni root (`root_folder_id`).

### Per-remote setup

Call `portuni_setup_remote` with:
```
{
  "name": "drive-workflow",
  "type": "gdrive",
  "config": { "shared_drive_id": "0AXyz...", "root_folder_id": "1Abc..." },
  "service_account_json": "<contents of the JSON key file>"
}
```

The SA JSON is stored via the TokenStore (see below), not in plaintext in Turso.
The remote config in Turso holds only public metadata: name, type, `shared_drive_id`, optional `root_folder_id`.

### Per-device distribution of credentials

Each device needs access to the SA JSON. Recommended: one SA shared across devices
(each device gets the same JSON via the TokenStore of its choice). Distinct per-device
SAs are possible but add admin overhead without material security benefit in Phase 1.

### TokenStore tiers

Set `PORTUNI_TOKEN_STORE` to choose:

| Kind | Storage | When to pick | Threat model |
|---|---|---|---|
| `file` (default) | `$PORTUNI_WORKSPACE_ROOT/.portuni/tokens.json` mode 0600 | Simple single-user laptop. Easy backup/restore. | Anyone with read access to the file reads the SA JSON. Keep the workspace on disks you control. |
| `keychain` | OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager) | Hardened single-user device. | OS-level protection; SA JSON is tied to the login user; still exportable by that user. |
| `varlock` | Env vars populated by a password-manager integration | Team machines, CI, or when you want 1Password / Bitwarden as the source of truth. Requires `PORTUNI_VARLOCK_WRITE_PROGRAM` + `PORTUNI_VARLOCK_WRITE_ARGS` for write paths. | The SM's threat model applies; env vars are process-visible but never persisted to disk by Portuni. |

### Running a single command with varlock + 1Password

```
op run -- env PORTUNI_TOKEN_STORE=varlock \
  PORTUNI_VARLOCK_WRITE_PROGRAM=op \
  PORTUNI_VARLOCK_WRITE_ARGS='item edit "portuni/{name}" {field}={value}' \
  npm start
```

### Workspace deployments that require domain-wide delegation

In some Google Workspace configurations, shared drive access cannot be granted
to external service accounts directly -- the drive ACL enforces that members
must be part of the Workspace domain. In that case, Portuni's simple SA-only
flow does not work; you need domain-wide delegation (DWD): the admin authorizes
the service account to impersonate a Workspace user, and the SA's Drive calls
are made in that user's context.

**Phase 1 scope:** Portuni supports SA-only flow (no impersonation). Shared
drives with external-member restrictions are **not supported** in Phase 1.

**Workaround for restricted drives:** create a dedicated Workspace user
(e.g. `portuni-sync@yourdomain.com`), make that user a member of each
restricted drive, and use OAuth on that user's behalf in a future plan.
Alternatively, remove the external-member restriction on the target drive
(admin setting in Google Admin Console).

DWD (subject impersonation) is on the roadmap for a future plan but is not
implemented in v3.

### What Drive users should know

- Delete is soft (Drive Trash, 30-day recovery). Portuni never hard-deletes.
- Rename of a Portuni node does NOT rename anything on Drive -- Portuni uses immutable `sync_key` for paths, not display names.
- Native files (Google Docs/Sheets/Slides) are tracked by URL + modified_at but not round-trip synced. Use `portuni_snapshot` to export + store a PDF/markdown/docx copy as a regular tracked file.
- Drive versioning (30 days) is Portuni's safety net under the explicit audit log.
