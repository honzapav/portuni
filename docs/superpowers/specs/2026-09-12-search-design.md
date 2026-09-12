# Search: full-text and semantic, over nodes and file contents

One search over everything the caller may see: node fields, events,
responsibilities, and the contents of files in mirrors and on Drive,
including PDFs, Office documents and native Google Docs. Full-text and
vector search in the same Postgres the rest of the data lives in, an
index that is updated deterministically from the same signals file state
already produces, and results that respect node visibility exactly as
every other read does.

Vision: `docs/vision/portuni-as-workspace.md` (Otevřené otázky 2).
Depends on batch B of `docs/superpowers/plans/2026-09-12-infra-batch.md`
(Postgres on central, PGlite locally: `tsvector` and `pgvector` are
available in both, so the index is one implementation). Today:
`portuni_search_files` delegates to Drive's `fullText contains` and to
grep on fs remotes; there is no UI and no node-field search.

## Rules

1. **The index is derived state, rebuilt deterministically.** Every
   indexed unit carries the hash of its source; a unit is re-embedded
   only when its hash changes and is deleted when its source is gone.
   Reindexing from scratch produces the same rows. No timers decide
   what is current; the file-state and graph write paths do.
2. **Visibility at query time, not at index time.** Rows carry
   `node_id`; the query joins the caller's visible node set
   (`nodeVisibleTo`, the same filter events and files use). One index
   for the workspace, never a per-user copy.
3. **Discovery, not ingestion.** A hit returns node, path, a bounded
   snippet and the unit's summary; reading the file goes through
   `portuni_read_file` and the scope rules. Search is permission-only in
   every session type, as `portuni_search_files` is today.
4. **Content leaves the workspace only with consent.** Embeddings are
   computed by OpenAI (`text-embedding-3-large`, 1024 dimensions via
   the `dimensions` parameter; 8 192-token input cap) and summaries by
   a small OpenAI model; both send content to OpenAI. An organization
   opts in (`org_settings.semantic_index = true`, `manage` scope);
   without it that organization's content gets full-text only. Nodes
   with `visibility = private` are never embedded.
5. **Central computes, everyone queries.** Extraction, chunking,
   summaries and embeddings run on central (it has the Drive credentials
   and the API key). Local mode runs the same code in the sidecar
   against PGlite with the user's own API key, or full-text only.

## Model

`search_units` (Postgres):

| column | meaning |
|---|---|
| `id` | ULID |
| `node_id` | owner node; visibility filter key |
| `kind` | `node` \| `event` \| `responsibility` \| `file_chunk` |
| `source_id` | node id, event id, responsibility id, or `files.id` |
| `chunk_index`, `chunk_count` | for `file_chunk`; `0/1` otherwise |
| `path` | file path for chunks |
| `source_hash` | sha256 of the extracted text of the whole source (file) or the row (graph) |
| `text` | the chunk text (bounded, see Chunking) |
| `summary` | one or two sentences describing the whole document, produced once per source, stored on every chunk of it |
| `tsv` | `tsvector` over `text`, `summary`, `path` (config `simple` + unaccent; Czech has no stemmer in core Postgres, unaccent gives most of the benefit) |
| `embedding` | `vector(1024)` NULL when the organization has not opted in |
| `embedded_at`, `updated_at` | |

Indexes: GIN on `tsv`, HNSW on `embedding` (cosine), btree on
`(node_id)`, unique on `(kind, source_id, chunk_index)`.

`search_jobs`: a queue of `(kind, source_id, reason)` rows written by the
signals below and drained by one worker on central (or the sidecar in
local mode), idempotent per `source_id`, retried with backoff on API
errors, dead-lettered after 5 attempts with the error visible in
Nastavení › Vyhledávání.

## Pipeline

### Signals

- Graph: `createNode`/`updateNode`/`archiveNode`, events, responsibilities
  → one job per row (kind `node|event|responsibility`).
- Files: the remote watcher (`2026-09-12-remote-watcher-design.md`)
  on central for Drive-side changes, `storeFile`/`putFileRaw` for pushes,
  delete paths for removals → one job per `files.id`. Local mode: the
  mirror watcher's reconcile.
- Never the mirror watcher on a central-mode device: content is indexed
  from the remote, once, not from every device's copy.

### Extraction

By MIME/extension, on central: Markdown and text as is; PDF through
`pdf-parse`; `.docx`/`.pptx`/`.xlsx` through `mammoth`/`officeparser`;
native Google Docs/Sheets/Slides through Drive `files.export` as
`text/plain`/CSV; images and binaries skipped (`source_hash` recorded
with an empty text, so they are not retried). Cap 2 MB of extracted text
per source; beyond that the head is indexed and `truncated` is set on the
units.

### Chunking

Markdown by headings first, then by paragraphs, targeting 600–900 tokens
with a 100-token overlap; a heading path (`# A › ## B`) is prepended to
each chunk's `text` so a chunk carries its position. Plain text and
extracted documents by paragraphs with the same target. Tables kept whole
up to the cap. Chunk boundaries are a pure function of the text, so the
same file yields the same chunks on every run.

### Summary

One call per source per `source_hash` change: `gpt-5-mini` (or the
current small model, pinned in config), prompt "two sentences: what this
document is and what it is for", input the first 6 000 tokens. Stored on
every chunk and prepended to the chunk text before embedding
(`summary + "\n\n" + chunk`), which is what makes a chunk retrievable by
what the document is about, not only by its local words.

### Embedding

Batched (up to 64 inputs per request), `text-embedding-3-large` with
`dimensions: 1024`, the model and dimension pinned in
`search_config` so a model change triggers a full re-embed rather than
a mixed index. Cost guard: an organization's daily token budget
(`org_settings.semantic_daily_tokens`, default 5 M) pauses its jobs
until the next day when exceeded and shows the pause in Nastavení.

## Query

`GET /search?q=&node_id=&kind=&limit=` (read) and MCP
`portuni_search { query, node_id?, kinds?, limit? }` (replaces
`portuni_search_files`; the old name stays as an alias for one release):

1. Visible node set from `nodeVisibleTo`; `node_id` narrows it (with the
   node's depth-1 neighbours when `include_neighbours`).
2. Full-text: `ts_rank_cd` over `tsv` with `websearch_to_tsquery`.
3. Semantic (when the query's organization(s) opted in and the API key is
   present): embed the query once, cosine over `embedding` limited to
   the visible set.
4. Merge by reciprocal rank fusion, group chunks by source (best chunk
   wins, `matches` counts the rest), return `{ kind, node_id, node_name,
   path, snippet (highlighted for full-text, chunk head for semantic),
   summary, score, source_id }`, at most `limit` (default 20, max 100).
5. Audit: `search` action with the query hash and result count, no
   query text.

Local mode without an API key answers step 2 only and says so in the
response (`semantic: false, reason`).

## Web

- **Global search** (Cmd+K in every window): one field, results grouped
  by node with the kind badge; a file hit opens the editor at the chunk's
  heading (Markdown) or the file (others); a node hit opens the node.
- **Node detail › Soubory**: the same search scoped to the node.
- **Nastavení › Vyhledávání** (central admin): index size per
  organization, jobs pending/failed with retry, semantic opt-in per
  organization, daily budget and today's usage, "Přeindexovat organizaci".

## Testing

- Chunking is deterministic (golden files) and heading paths are
  prepended.
- Signals write exactly one job per change; a re-run with the same
  `source_hash` does nothing; deletion removes all units of the source.
- Visibility: a private node's units never embed; a hit outside the
  caller's visible set never returns, including via `node_id`.
- RRF merge with fake scores; full-text only when the organization did
  not opt in.
- Extraction per format on fixture files; the 2 MB cap sets `truncated`.
- Budget pause and resume; dead-letter after 5 failures.
- Local mode on PGlite: the same suite with the embedding client faked.

## Phases

1. **Full-text**: `search_units` without `embedding`, graph signals,
   file extraction for Markdown/text, `GET /search`, `portuni_search`,
   Cmd+K.
2. **Documents**: PDF, Office, Google export; remote-watcher signal.
3. **Semantic**: summaries, embeddings, opt-in, budget, RRF.
4. **Docs**: reference page for the tool and the settings.

## Known gaps, accepted

- No Czech stemming; `unaccent` + `simple` misses inflected forms in
  full-text, which semantic search covers once opted in.
- Summaries and embeddings go to OpenAI; organizations that cannot
  accept that stay on full-text. A local embedding model is a later
  adapter behind the same `EmbeddingProvider` interface, not a second
  index.
