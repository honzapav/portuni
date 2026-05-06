# Multi-instance (vaults) – design

> **Status:** Design draft, not implemented. Captured 2026-04-30 from a brainstorming session. Ratifies the direction; concrete schema, ports, and supervisor protocol still need to be specified before code lands.

Design for running multiple isolated Portuni instances on one machine, where each instance ("vault") corresponds to a separate life domain or context (e.g. primary work, personal business, household). Each vault has its own database, its own backend, its own MCP server. No cross-vault reads.

## Problem

Today Portuni is a single instance: one SQLite file (`./portuni.db`), one backend on port 4011, one MCP server in tmux on 3001, registered globally in Claude Code as `portuni-mcp`. That assumes the user has exactly one knowledge graph.

In practice the user wants to run multiple parallel graphs that must not bleed into each other:

- **Primary** – core work knowledge graph (current Portuni instance).
- **Personal business** – sole-proprietor admin, finance, side projects.
- **Household** – family logistics, home admin, recurring tasks.

The constraint is hard isolation. Cross-vault visibility from a single MCP query is explicitly out of scope; if the user occasionally needs to correlate across vaults, that happens ad hoc through an agent talking to multiple MCP endpoints, not through any built-in cross-vault query.

## Decisions

### 1. One vault = one database, full stack isolation

Each vault gets its own libSQL/Turso database, its own backend process, its own MCP server. There is no multi-tenant single-process model. Mental model is "vault per life domain", analogous to separate Obsidian vaults: each one is a self-contained world.

**Why:** The user explicitly does not want cross-vault data visibility. Multi-tenant in one process means ambient `vault_id` in every query and a single bug crossing the boundary; separate processes make accidental crossover impossible. Resource cost on a modern Mac is negligible (~50–100 MB RAM per vault, three vaults ≈ 250 MB).

### 2. Storage layout

```
~/Library/Application Support/Portuni/
├── vaults.json                    # registry: name, slug, port, color, icon
└── vaults/
    ├── primary/
    │   ├── portuni.db             # libSQL embedded replica (local cache)
    │   ├── sync.db                # per-device file-sync state
    │   ├── portuni_store/         # local file mirror
    │   └── config.json            # turso URL, auth token, per-vault settings
    ├── personal/
    │   └── ...
    └── household/
        └── ...
```

`vaults.json` is owned by the supervisor and is the single source of truth for "which vaults exist". Per-vault `config.json` holds the Turso connection string and any vault-specific settings (default agent, file-sync remotes, etc.).

### 3. Always-on, daemon-managed via launchd

Backends and MCP servers run as launchd-managed daemons, **not** tied to the desktop app's lifecycle. Login starts them; closing the desktop app does not stop them.

**Why:** The user expects non-local MCP clients in the future (Google Chat bot was the example). If MCP only runs when the desktop is open, those clients break the moment the laptop sleeps or the app is closed. Daemonizing the services and treating the desktop app as just another client (one that connects to running services rather than owning them) is the only model that survives the introduction of remote clients.

Always-on rather than on-demand because cold-start latency on every UI switch or agent query would be a constant annoyance, and the resource savings are not worth it at this scale.

### 4. Supervisor process

A single launchd-managed supervisor (`com.portuni.supervisor`) sits above all vaults and:

- Reads `vaults.json` on startup and spawns backend + MCP for each registered vault.
- Allocates ports (backends: 4011, 4012, 4013, …; MCPs: 3001, 3002, 3003, …).
- Exposes a small control API on a fixed port (e.g. `localhost:4000`) for: list vaults, create vault, delete vault, restart instance, get status.
- Watches child processes; restarts on crash.
- Persists vault registry mutations atomically (no partial state if create fails mid-flight).

**Why:** Vault creation must not be the desktop app mutating files directly – that races with the running daemons. The supervisor owns the registry, the desktop app calls the control API. This also means CLI tooling, scripts, and future remote management all use the same interface.

### 5. MCP integration: separate server per vault

Claude Code (and every other MCP client) registers each vault as a distinct MCP server: `portuni-primary`, `portuni-personal`, `portuni-household`. Each has its own URL on its own port.

**Why:** This is the cleanest path. The agent picks the vault explicitly when calling tools, no ambient state, no risk of "agent forgot which vault it was in". Registration cost is one-time per vault per client.

The discarded alternative was a single MCP endpoint with a `vault` parameter on every tool call. Rejected because it forces the agent to track context and gives a single bug a path to read across vaults.

### 6. libSQL embedded replicas, with hosted MCP deferred

Each vault's canonical database is a Turso (libSQL) database in the cloud. The local backend opens it as an **embedded replica**: reads are local-fast (zero network latency), writes propagate to Turso, offline reads work without modification, offline writes queue and replay when the network returns.

**Why this beats "MCP server in the cloud" for now:**

- libSQL embedded replicas already give the "MCP near DB" benefit locally, with no deploy, no auth layer, no monthly cost.
- Hosted MCP requires real authentication (OAuth, API keys, per-vault scopes), a deploy pipeline, secret management, monitoring – all for speculative future clients.
- Without a concrete remote client (Google Chat bot, mobile app, external agent) we do not know the actual auth requirements. Building them on guesses is the wrong order.
- Offline behavior is solved by the replica, not by a separate cache layer.

Hosted MCP is **deferred until a concrete remote client exists**. When that happens:

- The same MCP server code is deployed to Fly.io / Cloudflare Workers per vault.
- Hosted instance opens a direct Turso connection (no replica, fresh reads always).
- Local and hosted flavors share the codebase and coexist – local is the fast path for the desktop app and local Claude Code, hosted handles remote clients.
- Auth requirements are designed to fit the actual client, not invented in advance.

## Architecture

```
                                 launchd
                                    │
                                    ▼
                     ┌──────────────────────────┐
                     │  portuni-supervisor :4000│
                     │  reads vaults.json,      │
                     │  spawns and watches      │
                     │  child processes         │
                     └────────┬─────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
      ┌────────────┐   ┌────────────┐  ┌────────────┐
      │ primary    │   │ personal   │  │ household  │
      │ backend    │   │ backend    │  │ backend    │
      │ :4011      │   │ :4012      │  │ :4013      │
      │ MCP :3001  │   │ MCP :3002  │  │ MCP :3003  │
      └─────┬──────┘   └─────┬──────┘  └─────┬──────┘
            │                │               │
   embedded replica     embedded replica  embedded replica
            │                │               │
            ▼                ▼               ▼
       Turso DB         Turso DB        Turso DB
       (primary)        (personal)      (household)
```

### Clients

- **Desktop app** – on launch, queries supervisor for vault list, renders switcher, attaches to selected vault's backend. Closing the app does not affect daemons.
- **Claude Code** – each vault registered as a distinct MCP server in user config.
- **CLI / scripts** – talk to supervisor's control API or directly to a vault's backend by port.
- **Future remote clients** (Google Chat, mobile, external agents) – initially via tunnel/VPN to local MCP if needed; eventually via hosted MCP per vault.

## Open questions

These were flagged in the brainstorm and need resolution before implementation:

- **Auth for remote clients (when hosted MCP lands).** OAuth flow vs per-client API keys vs Turso direct access. Probably depends on the first concrete client.
- **Vault deletion semantics.** Soft-delete (mark inactive, keep DB and files), or hard-delete (drop Turso DB, remove local files)? Probably soft-delete with explicit purge, given irreversibility.
- **Conflict resolution on offline writes.** libSQL embedded replica handles append-mostly workloads cleanly. For tables with frequent updates (e.g. node attributes edited from two devices), need to decide last-write-wins vs CRDT vs explicit conflict markers. Likely fine with last-write-wins for single-user; revisit if it bites.
- **Supervisor control API surface.** Minimal viable set is `list / create / delete / restart / status`. Anything beyond that should wait for a real need.
- **Migration path from current single-instance setup.** The existing `./portuni.db` becomes the `primary` vault. Needs a one-shot migration script that moves the file, registers it in `vaults.json`, and updates the MCP registration.

## What is explicitly out of scope

- **Cross-vault queries.** No "find every meeting with person X across all vaults" feature. If needed, the user runs an agent that talks to multiple MCP endpoints sequentially.
- **Multi-tenant single-process model.** Considered and rejected; isolation guarantees are too valuable.
- **Cloud-only deployment.** Local-first remains the model; hosted is a complement, not a replacement.
- **Sharing vaults between users.** This design assumes a single human owner of all vaults. Team sharing is a separate problem with separate auth and visibility concerns.
