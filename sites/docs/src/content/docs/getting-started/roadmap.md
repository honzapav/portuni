---
title: Project status & roadmap
description: Where Portuni is today, what works, what doesn't, and what's coming next.
---

Portuni is alpha software in active development. This page is the honest picture: the state of the codebase today, what's stable enough to build on, and what's still missing or in flight. Read it before you depend on Portuni.

## Where Portuni is today

The core ideas have been pressure-tested through daily use and several refactors – the POPP framework, the organization invariant, intentional capture, and the two-layer file sync are not whiteboard sketches. APIs are stable enough to use but not stable enough to lock down: MCP tool signatures and database schema can still change between minor versions. Treat Portuni as a research prototype with a real codebase behind it.

## What works today

**Graph model.** Five POPP node types (organization, project, process, area, principle) and four edge relations (`related_to`, `belongs_to`, `applies`, `informed_by`), strictly enforced via Zod schemas, database CHECK constraints, and a single source of truth in `src/popp.ts`. The organization invariant – every non-organization node belongs to exactly one organization – is enforced via atomic tool-level batches plus database triggers, with a startup integrity sweep that aborts on violations.

**MCP tools.** 46 tools covering nodes (create / update / list / get / delete + move), edges (connect / disconnect / move), actors (create / update / list / get / delete) and responsibilities (with assignment), data sources and tools as descriptive metadata, recursive context fetching, mirror folder management, file flow (store / pull / list / status / adopt / snapshot) and the destructive operations (move / rename / delete), remote configuration and routing policy, and the event timeline (log, list, resolve, supersede). Streamable HTTP transport on port 4011. Full reference: [Tools](/reference/nodes/).

**Events.** A time-ordered timeline of what happened on each node – decisions, blockers, discoveries – with status tracking and supersede semantics. Events ride along with `get_context` so agents see recent history.

**File sync.** A pluggable `FileAdapter` interface with Google Drive (Service Account) as the first concrete backend. Two-layer state: shared `files.current_remote_hash` in Turso, per-device sync state in `~/.portuni/sync.db`. Confirm-first move / rename / delete, hash-based conflict detection, native-format snapshots for Docs / Sheets / Slides.

**Integration glue.** Each mirror's per-harness MCP config carries `?home_node_id=<id>` in the server URL, so the Portuni server auto-seeds the read scope on connect – no harness-specific hooks needed.

**Desktop app.** `Portuni.app` is a Tauri-built macOS application with a Cytoscape graph view, a detail pane (events, files, responsibilities), multi-session terminal tabs, and an embedded MCP server sidecar — install one DMG and the server runs alongside the UI. Tag-triggered GitHub releases ship aarch64 + x86_64 DMGs. See [Desktop App](/clients/desktop-app/).

## Gaps and what's coming next

The roadmap is grouped by intent, not by version number. Each gap is stated once and tagged with how soon it's likely to move.

### Next (actively planned)

- **Search.** No search exists today – finding things means traversing the graph. Plan: SQLite FTS5 over nodes and events plus a `portuni_search` MCP tool, with semantic search via `sqlite-vec` once the keyword path is solid.
- **Test coverage.** The schema layer, the events module, and the sync engine are tested; the HTTP / MCP request boundary and parts of the frontend are not. Plan: integration tests against the real MCP HTTP endpoint using the request shapes the frontend sends, shared types between backend and `app/`, and a CI gate that blocks merges on red builds.
- **Lifecycle polish.** The lifecycle vocabulary (`active`, `paused`, `archived`, `done`) landed recently; threading its implications through events, mirroring, and search is in flight.

### Later (committed direction, not yet scheduled)

- **Multi-user mode.** Server-side Google OAuth identity and Google Groups permission model are implemented (`PORTUNI_AUTH_MODE=google`): per-request identity, session JWTs, global role enforcement, and node-level group visibility are all enforced server-side. Still pending: hosted deployment flow, desktop login UI for OAuth, and per-user client cutover. Rate limiting on the HTTP server is also outstanding.
- **Migrations and backups.** Schema auto-applies via `CREATE TABLE IF NOT EXISTS`; there is no proper migration framework, and backups aren't automated. Plan: a real migration tool and documented disaster recovery.
- **More file backends.** The adapter interface is ready; only Google Drive (Service Account) ships today. Concrete adapters for Dropbox, S3, WebDAV, and SFTP are committed.
- **Drive OAuth and domain-wide delegation.** Service Account is the only Drive auth path today. Per-user OAuth and DWD for Workspace deployments are planned.
- **Background sync.** Every file operation is explicit, triggered by an MCP tool call. A daemon that watches for changes is on the list.
- **Artifacts hosting.** A central `workflow-pages` GitHub repo and Cloudflare Pages target for AI-generated documents, with `artifact` nodes and a `publish_artifact` workflow.
- **Per-node summarization.** LLM-generated summaries on each node, regenerated lazily after events accumulate, usable as an embedding source.
- **Cross-platform desktop bundles.** `Portuni.app` (Tauri + React + Cytoscape) is the daily-driver client today and ships as macOS DMGs (aarch64 + x86_64) via tag-triggered GitHub releases. Linux and Windows bundles are not on the near roadmap; CLI install covers those platforms. Code-signing for macOS is also outstanding — first launch shows the Gatekeeper "unidentified developer" dialog until APPLE_CERTIFICATE secrets are wired into the release workflow.

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
- You can't securely run an HTTP service on your internal network (no auth means an exposed port is a public read / write graph).
- Your data is regulated and you need audit guarantees that go beyond Portuni's `audit_log` table.

If you're somewhere in between – strong opinions about how AI agents should work with organizational structure, looking for a system to evolve with – open an issue on [GitHub](https://github.com/honzapav/portuni).
