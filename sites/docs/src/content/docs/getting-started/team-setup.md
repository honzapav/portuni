---
title: Team Setup
description: How to run Portuni for an organization — a central server with Google sign-in, and the teammate desktop setup.
---

The [Setup](/getting-started/setup/) page covers the individual install. This page covers the organization: one **central Portuni server** that owns the database and enforces permissions, and teammates who connect to it with their Google accounts — never holding shared database or Drive credentials.

If you're a teammate whose organization already runs a server, skip to [Join as a teammate](#join-as-a-teammate).

## Two ways to share a graph

- **Central server (recommended).** The org deploys the Portuni server with `PORTUNI_AUTH_MODE=google`. Teammates sign in with Google; the server checks Google Workspace group membership on every request and enforces per-user permissions and node visibility. Graph and file content both travel through the server.
- **Shared credentials (small-team shortcut).** Everyone runs local mode against the same Turso database and the same Drive Service Account. It works, but every teammate holds the raw database token — full, unrestricted access, no per-user permissions. Treat it as a stopgap, not a destination. See [Data Modes](/concepts/data-modes/) for the full comparison.

The rest of this page describes the central-server path.

## Run the central server

The central server is the same codebase as the standalone install — deployed to a host of your choosing and switched into Google auth mode. A single small VPS with a systemd unit is enough; `scripts/deploy-vps.sh` in the repo shows the shape (build locally, rsync `dist/`, restart the unit, smoke-check `/health`).

### Google Workspace prerequisites

You'll need three things from Google Cloud / Workspace admin:

1. **An OAuth client ID** for the desktop app sign-in flow (created in Google Cloud Console). Its ID goes into the server's `PORTUNI_GOOGLE_CLIENT_IDS` and into each teammate's app config.
2. **A service account with domain-wide delegation**, scoped to `admin.directory.group.readonly`, so the server can read group memberships. The full key JSON goes into `PORTUNI_GOOGLE_SA_KEY_JSON`.
3. **Google Groups for permission tiers** — e.g. `portuni-admin@yourdomain`, `portuni-manage@yourdomain`, `portuni-write@yourdomain`. Membership in these groups is how you grant access; any authenticated user from an allowed domain gets read access.

### Server environment

Alongside the core variables from [Setup](/getting-started/setup/) (`TURSO_URL`, `TURSO_AUTH_TOKEN`, `PORTUNI_PORT`), google mode needs:

| Variable | What it's for |
|----------|---------------|
| `PORTUNI_AUTH_MODE` | Set to `google` |
| `PORTUNI_JWT_SECRET` | Secret for signing session JWTs (min 32 chars) |
| `PORTUNI_GOOGLE_CLIENT_IDS` | Comma-separated accepted OAuth client IDs |
| `PORTUNI_ALLOWED_DOMAINS` | Workspace domains users must belong to, e.g. `yourcompany.com` |
| `PORTUNI_GOOGLE_SA_KEY_JSON` | Service-account key JSON (single line) for group lookups |
| `PORTUNI_GOOGLE_IMPERSONATE` | Admin user the service account impersonates, e.g. `admin@yourcompany.com` |
| `PORTUNI_GROUPS_ADMIN` / `PORTUNI_GROUPS_MANAGE` / `PORTUNI_GROUPS_WRITE` | Google Group emails granting each Portuni scope |

For file content, the server also needs the Drive Service Account credentials of each configured remote, supplied as `PORTUNI_REMOTE_<NAME>__SERVICE_ACCOUNT_JSON` — teammates never see these.

The full variable inventory, including tunables not listed here, lives in [`docs/env-vars.md`](https://github.com/honzapav/portuni/blob/main/docs/env-vars.md) in the repo.

### What the groups grant

| Scope | Who | Capabilities |
|-------|-----|--------------|
| admin | `PORTUNI_GROUPS_ADMIN` members | Everything, including user management; bypasses node-level visibility checks |
| manage | `PORTUNI_GROUPS_MANAGE` members | Read + write + create/connect/update nodes |
| write | `PORTUNI_GROUPS_WRITE` members | Read + log events, resolve, supersede, store files |
| read | any authenticated user from an allowed domain | Get context, list nodes, get node |

Highest matching group wins. On top of these global scopes, individual nodes can be restricted with `group` visibility — a node a user can't see simply answers "not found."

One operational note: removing someone from a group takes effect within about an hour (group-membership cache, session JWT lifetime, and MCP session TTL each add delay). For immediate revocation, also delete the user's device tokens.

### Serve it over HTTPS

Put the server behind a reverse proxy with TLS (e.g. `api.yourcompany.com`). Teammates' desktop apps and agents will authenticate every request with Google-backed tokens, but the transport should still be encrypted end to end.

## Join as a teammate

As a teammate you install the regular desktop app and point a workspace at your organization's server. You need from your admin: the **server URL** and the **Google OAuth client ID and secret**.

1. Install `Portuni.app` from [GitHub releases](https://github.com/honzapav/portuni/releases) as in [Setup](/getting-started/setup/).
2. Create (or configure) a workspace with **central data mode**, entering the server URL and the OAuth client — in Settings → Workspaces, or directly in the app's `config.json` (`~/Library/Application Support/ooo.workflow.portuni/config.json`, keys `server_url`, `google_client_id`, `google_client_secret`, `data_mode: "central"`).
3. Sign in with your Google account (Settings → Account). The app stores a device token in the macOS Keychain; no database or Drive credentials ever touch your machine.

That's it. The graph you see — and everything your AI agents can do — is filtered through your permissions on the server.

Mirror folders work in central mode too: the local sidecar runs as a **sync agent** that keeps your mirror folders and file status current, brokering every read and write through the central server with your device token. Mirrors become available after you sign in.

## See also

- [Setup](/getting-started/setup/) — the individual install this builds on
- [Data Modes (Local vs Central)](/concepts/data-modes/) — the underlying model
- [Desktop App](/clients/desktop-app/) — workspaces, sidecar ports, and tokens
