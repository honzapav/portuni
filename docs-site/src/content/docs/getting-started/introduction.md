---
title: Introduction
description: What Portuni is and why it exists.
---

Portuni is a knowledge graph MCP server that gives AI agents structured access to organizational knowledge -- processes, decisions, methodology -- through a standard MCP interface.

## What it does

Portuni holds the **POPP structure** (Projects, Organizations, Processes, Principles, Areas) and connects them via edges. It is the single source of truth for how your organization is structured.

AI agents use Portuni to:

- **Navigate** the organizational graph (which projects belong to which areas, what processes apply)
- **Log knowledge** as time-ordered events on nodes (decisions, discoveries, blockers)
- **Store files** in structured local workspaces tied to graph nodes
- **Get context** automatically when starting work in a project folder

## Key principles

**Graph, not tree.** Nodes connect via typed edges in any direction. A project can relate to multiple processes, areas, and principles simultaneously.

**Intentional, not automatic.** Every piece of knowledge enters the system because a human decided it was worth keeping. No background sync, no auto-capture.

**Thin and pluggable.** Portuni owns the knowledge graph. Everything else (file storage, task management, Drive) stays in its own tool. Portuni connects them via edges and mirrors.

## Architecture

Portuni is a standalone HTTP server that speaks MCP (Model Context Protocol). It exposes 15 tools for graph manipulation, event logging, and file management.

Data lives in a database. Portuni is built for teams, so the intended deployment is a shared [Turso](https://turso.tech/) (libsql cloud) database that every teammate and every agent connects to. For trying Portuni out, running a personal graph, or developing the server itself, it also supports a local SQLite fallback – handy for a single machine, but not a long-term answer once more than one person is involved.

```
Claude Code  <--MCP-->  Portuni Server  <-->  Turso (shared, team)
                            |                    or SQLite (local, solo)
                       Local mirrors
                     (workspace folders)
```
