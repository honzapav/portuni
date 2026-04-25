---
title: Setting Up Remotes
description: Step-by-step Google Drive Service Account setup, then per-remote registration and routing.
---

This guide walks through the full path from "I have a fresh Google account" to "Portuni is pushing files to a Shared Drive on my behalf." Most of the work is one-time admin in the Google Cloud Console; the Portuni-side configuration is two MCP calls.

## What you'll end up with

- A Service Account (SA) with a JSON key, stored on each device that needs to sync.
- One or more Google Shared Drives that the SA is a member of.
- A registered Portuni remote pointing at each Shared Drive.
- Routing rules that send each node type to the right remote.

## Why Service Account, not OAuth

Phase 1 supports SA-only authentication. The trade-offs:

| | Service Account | OAuth (later) |
|--|---|---|
| Setup | One-time admin in Cloud Console | Per-user "connect" flow |
| Identity | Fixed SA email, all actions attributed to SA | Per-user, real audit on Drive's side |
| Scope | Only Shared Drives the SA is a member of | Anything the user can see |
| Compromise blast radius | Drives the SA is in | The user's whole Drive |

For one user across many devices, or a small team using shared infrastructure, SA is simpler and the security trade-off is fine. OAuth is on the roadmap for cases where per-user identity matters.

## One-time admin setup (per Portuni deployment)

### 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com.
2. Create a new project. Pick any name – this is internal scaffolding. ("Portuni" is fine.)
3. With the project selected, enable the **Google Drive API**:
   - Search for "Google Drive API" in the API library.
   - Click "Enable."

### 2. Create the Service Account

1. Cloud Console -> IAM & Admin -> Service Accounts.
2. "Create Service Account."
3. Name it something memorable like `portuni-sync`. The full email becomes `portuni-sync@<project>.iam.gserviceaccount.com` – note this address; you'll need it next.
4. Skip the optional "grant access" steps. Portuni only needs the SA's identity, not project-level permissions.

### 3. Generate a JSON key

1. Click into the new Service Account -> "Keys" tab -> "Add Key" -> "Create new key" -> JSON.
2. Download the JSON file.
3. Keep it somewhere safe but accessible – you'll paste its contents into `portuni_setup_remote` shortly. Do NOT commit it to a git repo; treat it like a password.

### 4. Add the SA to each Shared Drive

For every Shared Drive Portuni will manage:

1. Open the Shared Drive in Google Drive.
2. "Manage members."
3. Add the SA's email (`portuni-sync@<project>.iam.gserviceaccount.com`).
4. Role: **Content Manager** (typically). Higher roles work; "Viewer" or "Commenter" don't.

You'll need the Shared Drive's **ID** for each one. To get it:

- Open the Shared Drive in your browser.
- The URL looks like `https://drive.google.com/drive/folders/0AXyz...` – the long ID after `/folders/` is the Shared Drive ID.

Optional: if you want Portuni to use a specific subfolder inside the Shared Drive as its root (instead of the drive's root), grab that folder's ID the same way. This is the `root_folder_id` parameter below.

## Per-remote setup

Once admin work is done, each Shared Drive becomes a Portuni remote:

```
portuni_setup_remote {
  "name": "drive-workflow",
  "type": "gdrive",
  "config": {
    "shared_drive_id": "0AXyz...",
    "root_folder_id": "1Abc..."        // optional
  },
  "service_account_json": "<paste the entire JSON file contents here>"
}
```

What happens:

- The public configuration (name, type, `shared_drive_id`, `root_folder_id`) is written to the `remotes` table in Turso.
- The SA JSON is stored via the configured TokenStore (file / keychain / varlock) – **never** in Turso.

Repeat for each Shared Drive you're registering.

## TokenStore tiers

How the SA JSON is stored on each device is controlled by `PORTUNI_TOKEN_STORE`:

| Store | Where | When to pick |
|-------|-------|--------------|
| `file` (default) | `$PORTUNI_WORKSPACE_ROOT/.portuni/tokens.json`, mode `0600` | Single-user laptop. Easy backup. |
| `keychain` | OS keychain (macOS Keychain, libsecret, Windows Credential Manager) | Hardened single-user device. |
| `varlock` | Env vars populated by a password manager | Team machines, CI, or 1Password / Bitwarden as source of truth |

For the file store you don't need to do anything – Portuni writes the JSON the first time `portuni_setup_remote` runs.

For keychain: set `PORTUNI_TOKEN_STORE=keychain` and re-run `portuni_setup_remote` to write through the keychain instead of a file.

For varlock: set `PORTUNI_TOKEN_STORE=varlock` plus `PORTUNI_VARLOCK_WRITE_PROGRAM` and `PORTUNI_VARLOCK_WRITE_ARGS` to teach Portuni how to write into your password manager. A typical 1Password setup:

```
op run -- env \
  PORTUNI_TOKEN_STORE=varlock \
  PORTUNI_VARLOCK_WRITE_PROGRAM=op \
  PORTUNI_VARLOCK_WRITE_ARGS='item edit "portuni/{name}" {field}={value}' \
  npm start
```

## Routing rules

A registered remote does nothing until a routing rule sends nodes to it. Add rules for each `(node_type, org_slug)` combination:

```
portuni_set_routing_policy {
  node_type:   "project",
  org_slug:    "*",
  remote_name: "projects-hub",
  priority:    100
}

portuni_set_routing_policy {
  node_type:   "process",
  org_slug:    "workflow",
  remote_name: "drive-workflow",
  priority:    10
}

portuni_set_routing_policy {
  node_type:   "process",
  org_slug:    "*",
  remote_name: "shared-processes",
  priority:    100
}
```

`*` is a wildcard. Lower priority wins – use `10` for org-specific overrides and `100` for catch-all defaults.

Verify with `portuni_list_remotes` – each remote shows the routing rules pointing at it.

## A working example

Workflow's setup ends up looking roughly like this:

| Remote | Holds |
|--------|-------|
| `projects-hub` | All projects across all orgs |
| `drive-workflow` | Workflow's own processes, areas, principles |
| `drive-tempo` | Tempo's processes, areas, principles |
| `drive-nautie` | Nautie's processes, areas, principles |

Routing rules:

```
project / *           -> projects-hub      / 100
process / workflow    -> drive-workflow    / 10
process / tempo       -> drive-tempo       / 10
process / nautie      -> drive-nautie      / 10
area    / workflow    -> drive-workflow    / 10
area    / tempo       -> drive-tempo       / 10
area    / nautie      -> drive-nautie      / 10
principle / *         -> drive-workflow    / 100  (or wherever)
```

After this, `portuni_store` and `portuni_pull` "just work" – Portuni picks the right Shared Drive based on the node and pushes / pulls there.

## Per-device distribution

Each device that runs Portuni needs the SA JSON via its own TokenStore. The recommended pattern is "one SA shared across all your devices" – distribute the same JSON to each machine. Per-device SAs add admin overhead without meaningfully changing the security picture in Phase 1.

## Workspace deployments with restricted Shared Drives

Some Google Workspace setups configure Shared Drives so external members – which the SA technically is – can't be added. In that case the SA-only flow won't work. Two workarounds:

1. **Remove the external-member restriction** on the target drives (admin setting in Google Admin Console).
2. **Use a dedicated Workspace user** (e.g. `portuni-sync@yourdomain.com`) and run OAuth on its behalf in a future plan. Domain-wide delegation lands when OAuth does.

Phase 1 does not implement domain-wide delegation. If your org needs it, this becomes the gating reason to wait for Phase 2.

## What Drive users should expect

- **Delete is soft.** Portuni's `portuni_delete_file` moves files to Drive Trash (30-day recovery). Portuni never hard-deletes.
- **Rename of a node does NOT rename the Drive folder.** Folder paths are anchored on the immutable `sync_key`. Use `portuni_rename_folder` for an explicit, atomic rename of the visible folder name.
- **Native files (Docs / Sheets / Slides) are tracked but not round-trip synced.** They have URL + modified-at metadata. Use `portuni_snapshot` to export a PDF / markdown / docx copy as a regular tracked file.
- **Drive versioning is the safety net.** 30-day version history under Portuni's audit log gives a second line of defense for anything overwritten.

## See also

- [Files & Mirrors](/reference/files/) – the basic file flow
- [Sync Tools](/reference/sync/) – the rest of the tool surface
- [Local Mirrors](/concepts/mirrors/) – how mirrors and remotes fit together
