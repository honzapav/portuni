# Artifacts — internal content hosting for Portuni

Spec for hosting and managing internal artifacts (HTML reports, markdown documents) with stable URLs, integrated into the Portuni knowledge graph.

## Problem

The team creates artifacts across multiple projects and tools:

- HTML files: reports from n8n, Claude outputs, debug visualizations, dashboards
- Markdown documents: process documentation, onboarding guides, methodologies

These artifacts:

- Are created in different projects, by different tools, by different people
- Need stable, shareable URLs (not local file paths or ephemeral links)
- Need to be discoverable — findable by project, area, person, or topic
- Evolve over time — they're living documents, not frozen outputs
- Are internal (team, not clients)

Today there's no single place for these. They end up in random Google Docs, local folders, or Slack messages — disconnected from the knowledge graph.

## Design

Two independent concerns, composed at the orchestration layer:

1. **Storage + hosting** — GitHub repo + Cloudflare Pages (external infrastructure, not Portuni)
2. **Meaning + discovery** — Portuni node with edges (existing primitives, no new tools)

Portuni doesn't own artifact storage. Consistent with the core principle: *"Thin and pluggable. Portuni owns the knowledge graph. Everything else stays in its own tool."*

## Portuni integration

### Artifact as a node type

`artifact` is a regular node type — the `type` field is an open string, no schema change required.

Convention for `meta` on artifact nodes:

| Field | Type | Description |
|---|---|---|
| url | string | Public URL on pages.workflow.ooo |
| format | string | "html" or "markdown" |
| github_path | string | Path within the workflow-pages repo (e.g. "adamai/q1-report.html") |

Example node:

```json
{
  "type": "artifact",
  "name": "ADAMAI Q1 Report",
  "description": "Quarterly report on AI competency assessment progress across Tempo clients",
  "status": "active",
  "meta": {
    "url": "https://pages.workflow.ooo/adamai/q1-report",
    "format": "html",
    "github_path": "adamai/q1-report.html"
  }
}
```

### Edges

Standard Portuni edges connect artifacts to context:

| Edge | Example |
|---|---|
| `belongs_to` → project | artifact → ADAMAI |
| `belongs_to` → area | artifact → AI transformation |
| `related_to` → methodology | artifact → OKR methodology |
| `informed_by` → artifact | new report → previous report |

No new edge types needed.

### No dedicated MCP tool

Publishing is orchestration of existing tools, not a new Portuni capability:

```
1. gh api → commit file to GitHub repo (storage)
2. portuni_create_node type=artifact → register in graph (meaning)
3. portuni_connect → wire edges to project/area/person (context)
```

Why not `publish_artifact`:

- Portuni server would need GitHub API credentials (new dependency)
- Portuni would make side effects outside its DB (violates "thin" principle)
- Error handling across two systems in one call is fragile (commit succeeds, node fails — now what?)
- Shell function or n8n workflow composes the same steps with better debuggability

If the two-step process becomes friction in practice, reconsider — but start without it.

### Search and traversal

Artifacts participate in search and traversal like any other node:

- `portuni_search` finds artifacts by name, description, or (later) embedding similarity
- `portuni_get_context` on a project shows connected artifacts at depth 1 (summary) or depth 0 (full)
- `portuni_list_nodes { type: "artifact" }` lists all artifacts

No special handling needed.

## External infrastructure

### Storage: GitHub repo `workflow-pages`

One central repo as storage backend for all artifacts. Organization: `workflowooo`.

```
workflow-pages/
├── adamai/
│   ├── q1-report.html
│   └── onboarding.md
├── evoluce/
│   ├── scoring-debug.html
│   └── metodika.md
├── naturamed/
│   └── analyza.html
└── index.html              ← auto-generated overview
```

Folder structure mirrors Portuni project slugs. Files are organized by project, not by format.

Why GitHub:

- Free versioning and history
- GitHub API allows commits without local git (important for n8n, Claude, tools without git)
- Branch protection + PR workflow for AI agents
- GitHub Actions for index generation

### Hosting: Cloudflare Pages

Connected to the `workflow-pages` repo. Automatic deployment on every push to main.

```
pages.workflow.ooo/adamai/q1-report
pages.workflow.ooo/evoluce/scoring-debug
pages.workflow.ooo/naturamed/analyza
```

- Custom domain: `pages.workflow.ooo`
- Stable URLs — updating a file keeps the same URL
- Practically free at expected scale

### Publish workflow

Shell function for publishing from anywhere (including projects without git):

```bash
artifact-publish() {
  local file="$1"       # local file path
  local dest="$2"       # e.g. "adamai/q1-report.html"
  local title="$3"      # e.g. "ADAMAI Q1 Report"
  local project="$4"    # optional: Portuni project node to connect to

  # 1. Commit to GitHub
  gh api repos/workflowooo/workflow-pages/contents/"$dest" \
    --method PUT \
    --field message="publish: $dest" \
    --field content="$(base64 < "$file")"

  echo "Published: https://pages.workflow.ooo/${dest%.*}"

  # 2. Register in Portuni (if MCP is available)
  # portuni_create_node type=artifact name="$title" \
  #   meta='{"url":"https://pages.workflow.ooo/...","format":"html","github_path":"..."}'
  # portuni_connect source=<artifact-id> target=<project-id> type=belongs_to
}
```

For n8n: GitHub node with direct commit via API, followed by HTTP node calling Portuni API.

For Claude Code: `gh` CLI for the commit, then MCP tools for the Portuni node.

### Index page

GitHub Action generates `index.html` on every push — an overview of all artifacts with:

- List of all files grouped by project folder
- Last updated timestamp per file
- Direct links to hosted versions

Simple, auto-generated. Not a search UI — Portuni search handles discovery by meaning.

## Markdown editing (Keystatic) — not decided

Keystatic (open-source, git-backed CMS) was identified as a good fit for WYSIWYG markdown editing:

- Browser-based editor, git fully abstracted
- Automatic commits to GitHub repo
- Schema-driven frontmatter from TypeScript definitions
- Supports PR workflow (good for AI agents)

Would run as a standalone app or Astro route at `admin.pages.workflow.ooo`, editing `.md` files in the same `workflow-pages` repo.

**Status: not decided.** Markdown files in the repo work fine without an editor. Keystatic can be added later without changing anything else. Decision deferred until there's real demand from non-technical team members editing docs in a browser.

Limits to consider: no Gitea support (GitHub/GitLab only), basic role management, potential GitHub API slowness at hundreds of files (TinaCMS as alternative if that happens).

## Relationship to Portuni phases

Artifacts are orthogonal to the implementation plan phases (0–6). They require:

- **Phase 1 minimum:** nodes + edges + basic search (to register and find artifacts)
- **Phase 3 benefit:** semantic search makes artifact discovery much better ("find reports about onboarding" finds artifacts even if titled differently)

No changes to `implementation.md` needed. Artifact hosting is external infrastructure + conventions on existing Portuni primitives.

## Open questions

1. **Update workflow** — when an artifact is updated (new commit to same path), should the Portuni node be updated too? The URL stays the same, but `updated_at` should change. This could be a GitHub Action webhook → Portuni API call.
2. **Access control** — `pages.workflow.ooo` is public by default on Cloudflare Pages. For internal-only artifacts, either use Cloudflare Access (auth layer) or accept that obscurity-by-URL is sufficient for non-sensitive internal reports.
3. **Artifact lifecycle** — when to archive? When the linked project is archived? Manual decision?
4. **Large artifacts** — GitHub has a 100MB file limit. HTML reports with embedded data could hit this. Consider: link to external data instead of embedding, or use Git LFS.

## Setup checklist

- [ ] Create GitHub repo `workflowooo/workflow-pages`
- [ ] Connect Cloudflare Pages to the repo
- [ ] Configure custom domain `pages.workflow.ooo`
- [ ] Create `artifact-publish` shell function
- [ ] Create GitHub Action for index page generation
- [ ] Test end-to-end: publish HTML file → stable URL → register as Portuni node → find via search
