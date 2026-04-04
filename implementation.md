# Portuni — Implementation Plan

Strict MVP approach. Each phase ends with something usable — you must be able to do real work with it.

## Phase 0 — Validate the loop

**Goal:** Create a node and get it back via MCP from a terminal agent.

1. Init Node.js/TS project (ESM, strict)
2. Turso DB — provision, create `nodes` table only (id, type, name, description, status, meta, created_by, created_at, updated_at)
3. MCP server (SSE transport) with exactly 2 tools: `portuni_create_node`, `portuni_get_node`
4. Connect from your terminal agent — create a node, read it back
5. Varlock setup for Turso credentials

**Done when:** You say "create an organization node called Workflow" to your agent and it appears in the DB, then you ask "show me Workflow" and get it back.

**Node types available from the start:** organization, process, process_instance, area, project, principle, methodology — but don't enforce. The `type` field is a string, not an enum.

---

## Phase 1 — Usable graph + local files

**Goal:** Model your real POPP structure, navigate it, and work with actual files. You must be able to use this for real work from day one.

### Graph

1. `edges` table + `portuni_connect`, `portuni_disconnect`
2. `portuni_list_nodes` with type/status filters
3. `portuni_update_node` (name, description, status, meta)
4. `portuni_get_context` — recursive CTE traversal, depth parameter. No summaries yet — returns node descriptions + edges at each depth
5. `audit_log` table — log every mutation from this point

### Local files

6. `files` table (node_id, path, status, created_at, updated_at)
7. `portuni_store` — attach a file to a node, store in local node folder
8. `portuni_pull` — retrieve/list files from a node folder
9. `portuni_list_files` — list files attached to a node
10. Local folder structure: `~/work/{node-slug}/` with internal structure (outputs/, wip/, resources/)
11. `portuni_mirror { targets: ["local"] }` — create local folder for a node, register path in `local_mirrors` table (per-user)
12b. `local_mirrors` table (user_id, node_id, local_path, registered_at) — per-user tracking of where nodes live locally. Path resolution: check stored path → if missing, ask user → update mapping.

### Seed

12. Seed initial POPP structure: create org nodes (Workflow, Tempo, Nautie, Evoluce), areas, processes, principles. Connect them via edges. Shared processes get `belongs_to` edges to multiple orgs. This is your first real test of the graph model.

### Edge management

13. All edges are manual in this phase. You wire connections as you learn them. The system is designed for edges to emerge from work later (AI-suggested, event-driven) — but that's not this phase.

**Done when:** You traverse from `project:stan-gws` and see connected methodology, process, area, principle, and organization. You can store a file in the project's local folder, list it, pull it back. Real work happens here.

---

## Phase 2 — Knowledge capture

**Goal:** Log events, find them again.

1. `events` table + `portuni_log`, `portuni_list_events`
2. `portuni_resolve`, `portuni_supersede`
3. FTS5 index on event content + node name/description
4. `portuni_search` — keyword mode only first
5. Add events to `portuni_get_context` output:
   - depth 0: full events
   - depth 1: recent events only
   - depth 2: nothing (summaries come later)

**Done when:** You log a decision on a project, search for it by keyword, and find it with its node context.

---

## Phase 3 — Semantic search

**Goal:** Find things by meaning, not just exact words.

1. Pick embedding model (evaluate text-embedding-3-small vs alternatives for CZ/EN mixed content)
2. `node_embeddings` + `event_embeddings` tables with sqlite-vec
3. Generate embeddings on create/update
4. Extend `portuni_search` with semantic mode + auto (merged) mode

**Done when:** You search "problémy s onboardingem" and find an English event about "client onboarding issues."

---

## Phase 4 — Summaries + embedding cascade

**Goal:** Nodes self-describe based on their events.

1. Summary generation — pick a cheap LLM, wire it up
2. Dirty flag + lazy regeneration on `portuni_get_context` / `portuni_get_node`
3. Debouncing (30s after last event)
4. Embedding cascade: event → summary regen → node embedding regen
5. `portuni_refresh_summary`
6. `max_tokens` parameter on `portuni_get_context` (intelligent truncation)
7. Update depth levels:
   - depth 0: full events + all files + mirrors
   - depth 1: recent events + summary + outputs only
   - depth 2: summary only

**Done when:** A node with 20 events shows a coherent summary that updates when you log new events.

---

## Phase 5 — Google Drive mirroring

**Goal:** Publish files to shared drives, mirror structure to Drive.

### Infrastructure

1. Google OAuth setup
2. Create shared drives:
   - **Projects Hub** — all projects, flat, one folder per project
   - **Shared Processes** — cross-org processes, flat
   - **Per-org drives** (Tempo, Workflow, Nautie, Evoluce) — org-internal processes, areas, principles
3. Configure mirroring policy: which node types map to which drives

### Implementation

4. `file_sync` table for conflict detection
5. Google Drive mirroring adapter — flat folder creation per the mirroring policy
6. `portuni_mirror { targets: ["files"] }` — creates folder in the correct shared drive based on policy
7. `portuni_store` extended — uploads file to Drive (into the node's mirrored folder)
8. `portuni_pull` extended — conflict detection (remote vs local)
9. `portuni_promote` — change WIP to output
10. `portuni_sync_mirrors` (rename detection)
11. Node folder internal structure in Drive mirrors local: outputs/, wip/, resources/

### Mirroring policy

| Node type | Condition | Target drive |
|---|---|---|
| project | any org | Projects Hub |
| process | shared (belongs_to multiple orgs) | Shared Processes |
| process | org-internal | That org's drive |
| area | any | The org's drive it belongs_to |
| principle | any | The org's drive it belongs_to |
| methodology | any | The org's drive it belongs_to |

**Done when:** You `portuni_store` a file on a project and it lands in the Projects Hub. A shared process's files go to the Shared Processes drive. Single source of truth — no copies.

---

## Phase 6 — Auth + hardening (= spec Phase 1 complete)

**Goal:** Production-ready solo deployment.

1. Google OAuth login flow (replaces hardcoded user)
2. Permission scopes scaffolded (not enforced — solo = admin)
3. Simple web UI for graph browsing (read-mostly, "mirror locally" action)
4. Deploy to VPS
5. Secrets via Varlock in production

**Done when:** Portuni runs on VPS, you connect from any MCP agent via SSE, browse the graph in a browser.

---

## What's NOT in this plan

- Messaging agent (spec Phase 2)
- Multi-user permissions / Google Groups enforcement (spec Phase 2)
- Graph insight tools — `portuni_related`, `portuni_hub_nodes` (spec Phase 3)
- Multi-tenant (spec Phase 4)
- Organization-level access control (deferred — orgs are just nodes for now)
- AI-driven edge suggestions (deferred — designed for, not implemented yet)

Don't even think about these until Phase 6 is running.