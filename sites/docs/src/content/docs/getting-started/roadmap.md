---
title: Project status & roadmap
description: Where Portuni is today, what works, what doesn't, and what's coming next.
---

Portuni is alpha software in active development. This page is the honest picture: the state of the codebase today, what's stable enough to build on, and what's still missing or in flight. Read it before you depend on Portuni.

## Where Portuni is today

The core ideas have been pressure-tested through daily use and several refactors – the POPP framework, the organization invariant, intentional capture, and the two-layer file sync are not whiteboard sketches. APIs are stable enough to use but not stable enough to lock down: MCP tool signatures and database schema can still change between minor versions. Treat Portuni as a research prototype with a real codebase behind it.

## What works today

**Graph model.** Five POPP node types (organization, project, process, area, principle) and four edge relations (`related_to`, `belongs_to`, `applies`, `informed_by`), strictly enforced via Zod schemas, database CHECK constraints, and a single source of truth in `apps/server/shared/popp.ts`. The organization invariant – every non-organization node belongs to exactly one organization – is enforced via atomic tool-level batches plus database triggers, with a startup integrity sweep that aborts on violations.

**MCP tools.** 47 tools covering nodes (create / update / list / get / delete + move), edges (connect / disconnect / move), actors (create / update / list / get / delete) and responsibilities (with assignment), data sources and tools as descriptive metadata, recursive context fetching, mirror folder management, file flow (store / pull / list / status / adopt / snapshot) and the destructive operations (move / rename / delete), remote configuration and routing policy, and the event timeline (log, list, resolve, supersede). Streamable HTTP transport on port 4011 (standalone; the desktop app assigns each workspace its own sidecar port from 47011 up). Full reference: [Tools](/reference/nodes/).

**Events.** A time-ordered timeline of what happened on each node – decisions, blockers, discoveries – with status tracking and supersede semantics. Events ride along with `get_context` so agents see recent history.

**File sync.** A pluggable `FileAdapter` interface with Google Drive (Service Account) as the first concrete backend. Two-layer state: shared `files.current_remote_hash` in Turso, per-device sync state in `.portuni/sync.db` under your workspace root. Confirm-first move / rename / delete, hash-based conflict detection, native-format snapshots for Docs / Sheets / Slides. A mirror watcher registers new files and reconciles edits automatically (on by default in the desktop sidecar), so file status stays current without an agent doing anything; only the push to the remote remains a deliberate action.

**Integration glue.** Each mirror's per-harness MCP config carries `?home_node_id=<id>` in the server URL, so the Portuni server auto-seeds the read scope on connect – no harness-specific hooks needed.

**Desktop app.** `Portuni.app` is a Tauri-built macOS application with a Cytoscape graph view, a detail pane (events, files, responsibilities), multi-session terminal tabs, and an embedded MCP server sidecar — install one DMG and the server runs alongside the UI. The app manages multiple **workspaces** (each with its own database, workspace root, sidecar port, and Keychain-held tokens) running side by side. Tag-triggered GitHub releases ship signed and notarized aarch64 DMGs. See [Desktop App](/clients/desktop-app/).

**Team / central mode.** Server-side Google OAuth identity and Google Groups permissions (`PORTUNI_AUTH_MODE=google`): per-request identity, session JWTs, global role enforcement, node-level group visibility, and rate limiting are enforced server-side. The desktop app signs in with Google (Settings → Account), holds a device token, and can run a workspace in **central data mode**: the graph and file content go through the org's server, while the local sidecar acts as a sync agent for mirror folders — teammates never hold database or Drive credentials. See [Data Modes](/concepts/data-modes/).

## Gaps and what's coming next

The roadmap is grouped by intent, not by version number. Each gap is stated once and tagged with how soon it's likely to move.

### Next (actively planned)

- **Search.** No search exists today – finding things means traversing the graph. Plan: SQLite FTS5 over nodes and events plus a `portuni_search` MCP tool, with semantic search via `sqlite-vec` once the keyword path is solid.
- **Test coverage.** The schema layer, the events module, and the sync engine are tested; the HTTP / MCP request boundary and parts of the frontend are not. Plan: integration tests against the real MCP HTTP endpoint using the request shapes the frontend sends, shared types between backend and `app/`, and a CI gate that blocks merges on red builds.
- **Lifecycle polish.** The lifecycle vocabulary landed recently with per-type states (e.g. `backlog / planned / in_progress / on_hold / done / cancelled` for projects, `not_implemented / implementing / operating / at_risk / broken / retired` for processes) derived into a coarse `active / completed / archived` status; threading its implications through events, mirroring, and search is in flight.

### Later (committed direction, not yet scheduled)

- **Multi-user polish.** The multi-user foundation shipped (see "Team / central mode" above): Google OAuth, Groups-based permissions, desktop login, device tokens, central data mode, and file content over the central server all work today. Admin tooling is partial — admins can list accounts and invite new users by email (Settings → Users, gated to the `admin` role), and each user manages their own device tokens. What's still missing: an admin endpoint to revoke another user's device tokens (today that's a direct DB op), account deletion, and a smooth org-onboarding flow.
- **Migrations.** A numbered migration framework runs on every server boot: 20 idempotent migrations in `apps/server/infra/schema-migrations.ts`, each with an `isApplied()` probe, applied in order and tracked in a `migrations` table. Fresh installs get the DDL via `CREATE TABLE IF NOT EXISTS`, existing databases are brought up to date migration by migration. A daily Turso backup script ships (`npm run backup`, scheduled via launchd on the host). Plan: documented disaster recovery and restore procedures.
- **More file backends.** The adapter interface is ready; only Google Drive ships today. Concrete adapters for Dropbox, S3, WebDAV, and SFTP are committed.
- **Drive auth.** Two paths ship today: per-user **OAuth** (one click in the desktop app's Settings → Synchronizace, targets My Drive or a Shared Drive) and **Service Account** (headless servers, CI, and multi-remote routing). Domain-wide delegation is already configured for Google Groups — the SA impersonates an admin via `PORTUNI_GOOGLE_IMPERSONATE` to read Directory API — but the same DWD flow is not yet wired into the Drive adapter (`drive-sa-auth.ts` signs JWTs without a `sub` claim). Extending DWD to Drive would let a headless central server access any Workspace user's files without each user doing the OAuth dance.
- **Background push.** The mirror watcher already registers and reconciles file changes automatically; pushing to the remote is still a deliberate action (an MCP tool call or the Synchronize button). Whether pushes should ever happen automatically is an open design question — intentional capture is a principle, not an accident.
- **Artifacts hosting.** A central `workflow-pages` GitHub repo and Cloudflare Pages target for AI-generated documents, with `artifact` nodes and a `publish_artifact` workflow.
- **Per-node summarization.** LLM-generated summaries on each node, regenerated lazily after events accumulate, usable as an embedding source.
- **Cross-platform desktop bundles.** `Portuni.app` (Tauri + React + Cytoscape) is the daily-driver client today and ships as signed, notarized macOS DMGs (aarch64) via tag-triggered GitHub releases. Intel Macs are no longer targeted (the user base has none, and GitHub retired the `macos-13` runner in 2025-12); Linux and Windows bundles are not on the near roadmap; CLI install covers those platforms.

### Exploring (open questions)

- Whether to ship a hosted Portuni or keep the project self-hosted only.
- How shared processes are owned across organizations – does a process belong to one org and get linked, or does it float?
- Permission model: node-level groups extending the global scope, or replacing it?
- How event supersede should render in the UI – hide or fold?

## Who Portuni is for right now

Portuni is for you if:

- You want to experiment with a graph-shaped knowledge layer for AI agents in your own organization.
- You're comfortable reading TypeScript and SQL when something surprises you.
- You can absorb the occasional schema migration or breaking tool change.

Portuni is not yet for you if:

- You need a turnkey, hosted product with SLAs.
- You need enterprise-grade identity beyond what's built in (bearer-token auth for solo use, Google OAuth + Groups for teams; no SAML/OIDC-generic SSO).
- Your data is regulated and you need audit guarantees that go beyond Portuni's `audit_log` table.

If you're somewhere in between – strong opinions about how AI agents should work with organizational structure, looking for a system to evolve with – open an issue on [GitHub](https://github.com/honzapav/portuni).
