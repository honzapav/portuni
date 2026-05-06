# Conceptual Map

Portuni helps small teams work *with* AI the way they work with each other – around a shared structure. It holds your organization's map (processes, projects, areas, principles) in one graph, so a person and an agent always stand on the same ground. No re-briefing, no re-explaining, no tool-by-tool silos.

This document is the mental model behind that system – why it works the way it does.
It is not a technical spec; it describes how we think about organizing work, cooperation, and tools.

---

## Foundation: Why it works this way

### Natural structure
The system follows patterns found in nature: networks, fractals, emergence.
Structure is not imposed from above — it emerges from how people actually work.
When a system mirrors natural patterns (scale-free networks, self-similarity across scales, short paths between any two points), it feels intuitive.

Key references: rhizome (Deleuze & Guattari), scale-free networks (Barabasi), stigmergy (Grasse), pattern language (Christopher Alexander).

### Systems thinking
Understanding things by seeing how parts connect and influence each other — not by breaking them into isolated pieces. The graph is the method: you understand the organization by traversing connections, not by reading an org chart.

### Conway's Law (intentional + generative)
Conway's Law says an organization's products reflect its communication structure. We apply this deliberately: the folder structure, the drives, the tools all mirror how the organization works. But we go further — the structure is not just a mirror, it is a teaching tool. When people navigate it, they internalize how the organization thinks. The system makes people around it better.

### Work environment design
Acme's practice of designing physical and digital workspaces as interconnected, intentional patterns. Rooted in Christopher Alexander's Pattern Language — but applied to real work environments: office layout, folder structure, agent interaction, drive organization. The workspace shapes the work.

---

## Framework: POPP

### POPP as a mental model
Everything we do fits into five categories:

- **Process** — a repeatable way of doing something
- **Project** — a concrete effort with a start and end
- **Area** — a domain of ongoing responsibility
- **Principle** — a rule or belief that guides decisions
- **Organization** — a top-level entity (company, team)

These are not technical constructs. They are how we categorize all organizational activity. If someone understands these five words, they can navigate the entire system.

### Graph, not tree
POPP entities connect to each other many-to-many. A project can relate to multiple processes, multiple areas, multiple principles. There is no hierarchy — only connections. This matches reality: work does not fit neatly into one branch of a tree.

---

## How people work

### Symbiosis / middle space
Human and AI agent work together as a unit. The agent is not "someone else I delegate to" — it is my extension. I think, I direct, I decide. The agent searches, edits, implements, organizes.

This sits between two extremes:
- Copy-paste from chat (I do the work, AI gives suggestions)
- Full automation (the system does the work without me)

The middle space is: I stay at the wheel, the agent amplifies what I can do.

### Human decides
The agent assists, suggests, never acts alone. Every piece of knowledge enters the system because a person decided it was worth keeping. The agent can ask "should I log this?" — but the person says yes or no.

### Three executors
A task in a process can be done by:
- a **human**
- an **AI agent** (in symbiosis with a human)
- an **automation** (n8n, Make, script — runs without a human)

These are three execution modes, not three paradigms. No buzzwords. The process stays the same regardless of who or what does the work. Existing automations fit into the same structure.

### Context separation
The agent works within one project at a time. Other relevant context (process knowledge, principles, learnings from sibling projects) is managed — pulled in deliberately when needed, not dumped in wholesale. Focus on the work. The system brings context.

---

## How the system teaches

### Where things live
Every entity type has a predictable home:
- Projects are in the Projects Hub
- Shared processes are in the Shared Processes drive
- Org-specific things are in the org drive

This is the mirroring policy. It is consistent, it is flat, it has no exceptions. Learn it once, never guess again.

### Trust through predictability
People will use the system only if they trust it is consistent. The folder structure is the visible proof: if the structure is predictable, the system is trustworthy. If I can find things without asking, the system works. Predictability is the prerequisite for adoption.

---

## Owned vs. linked content

Not all content is the same, and pretending it is leads to bad systems. Two categories, two life cycles:

**Owned content** — lives in open, portable formats (markdown, HTML, JSON, code, PDF snapshots). Portuni and its agents can fully own the life cycle: create, edit, version, diff, archive. The hosting tool (Drive, Dropbox, S3, local FS) is just a place to keep the bytes. Swap the host, the content survives unchanged. This is where AI agents do real work.

**Linked content** — lives inside proprietary applications whose native format is the application itself (Google Docs, Notion pages, Figma files, Airtable bases, Asana projects). The application owns the format. Portuni holds only a pointer — URL, title, last-modified timestamp — not the content. Editing happens through the tool's own API or MCP, not through Portuni. No roundtrip, no mirror, no sync of structure.

**Rule of thumb:** if you want an AI agent to fully own a document's life cycle, push it toward an open format from the start. Use proprietary tools for collaboration surfaces with non-technical people, not as primary storage for AI-owned work.

This distinction is strategic, not technical. It keeps the system small and honest: Portuni doesn't pretend to solve the rich-format roundtrip problem (which no one has solved robustly). It respects the boundary and routes work accordingly.
