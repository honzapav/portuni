---
title: Introduction
description: What Portuni is and why it exists.
---

Portuni is a shared map of how your organization works – the projects, processes, areas, and principles that make the place tick. It's held as one graph, and every tool and every AI agent that you invite in draws from the same picture. No more rebuilding context app by app.

The idea is simple. Every tool you already use (Drive, Asana, Airtable) organizes work its own way, and important knowledge keeps falling through the cracks between them. Portuni is the backbone underneath – a structure they can all mirror. MCP is how AI agents plug in; the shared map is the point.

## What it does for you

Portuni holds the **POPP structure** (Projects, Organizations, Processes, Principles, Areas) and connects those pieces with typed edges. It becomes the single source of truth for how your organization is shaped.

Your AI agents then use Portuni to:

- **Find their way around** – which projects belong to which areas, what processes apply where
- **Remember what happened** – decisions, discoveries, and blockers logged as time-ordered events on the relevant nodes
- **Work with real files** – stored in structured local folders tied to the graph nodes
- **Show up ready** – automatic context when you start work in a project folder, so nobody has to re-explain everything

## A few principles to keep in mind

**It's a graph, not a tree.** Nodes connect in any direction, via typed edges. A project can belong to several areas, follow multiple processes, and reflect a handful of principles all at once. Real work looks like this – your map should too.

**It's intentional, not automatic.** Nothing slips into Portuni in the background. Every piece of knowledge lands here because someone decided it was worth keeping. No silent sync, no surprise captures.

**It stays thin, and plays well with others.** Portuni owns the knowledge graph and the relationships. Everything else – file storage, task management, documents – stays in the tool that does it best. Portuni just links them, through edges and mirrors.

## How it fits together

Portuni is an HTTP server that speaks MCP (Model Context Protocol). It exposes 46 tools for working with the graph, logging events, scope, files, remotes, actors, and responsibilities.

You can run it three ways:

- **Desktop app** (`Portuni.app`, macOS) — recommended for daily use. A Tauri-built UI with a graph view, detail pane, and built-in terminal tabs. Bundles the MCP server as an embedded sidecar, so you don't have to keep a separate process running. Downloads are on the [GitHub releases](https://github.com/honzapav/portuni/releases) page; see [Desktop App](/clients/desktop-app/) for the details.
- **Desktop app pointed at your organization's central server** — the teammate setup. You sign in with your Google account; the graph and file content live on the org's server, and you never handle database credentials at all. The local sidecar runs as a sync agent for your mirror folders.
- **CLI / standalone server** — clone the repo, `npm install && npm run build`, then `npx varlock run -- npm start`. The path most contributors and CI use; same MCP surface as the desktop app's sidecar.

The data itself lives in a database. For a solo setup that's a [Turso](https://turso.tech/) database (a libsql cloud) or a local SQLite fallback — handy for trying things out or working on the server itself. For a team, the intended shape is a **central Portuni server** run by the organization: it owns the database, authenticates people via Google, and teammates' apps and agents talk to it instead of holding shared credentials.

```
Portuni.app (desktop UI)
   │
   ├─ embedded sidecar ─┐
   │                    │
Claude Code  <--MCP-->  Portuni Server <-->  Turso (cloud) or SQLite (local)
Codex CLI               (HTTP)                or an org-run central server
Gemini CLI                    │                (Google sign-in, team)
Mistral Vibe           Local mirrors
                     (workspace folders)
```

Ready to set it up? Head over to [Setup](/getting-started/setup/) — or [Team Setup](/getting-started/team-setup/) if you're rolling it out to an organization.
