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

Portuni is a standalone HTTP server that speaks MCP (Model Context Protocol). It exposes 15 tools for working with the graph, logging events, and managing files.

The data itself lives in a database. Portuni is designed for teams, so the intended setup is a shared [Turso](https://turso.tech/) database – a libsql cloud – that everyone and every agent connects to. For trying things out, running a personal graph, or working on the server itself, there's also a local SQLite fallback. Handy on a single machine, but not where you want to stay once more than one person is involved.

```
Claude Code  <--MCP-->  Portuni Server  <-->  Turso (shared, team)
                            |                    or SQLite (local, solo)
                       Local mirrors
                     (workspace folders)
```

Ready to set it up? Head over to [Setup](/getting-started/setup/).
