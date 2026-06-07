# Markdown Editor + Deterministic File Registration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read/edit local markdown files registered to a Portuni node in an in-app source editor (workspace right-pane that swaps with the node detail, expandable to a distraction-free full-window view), and make file registration deterministic so agent-written files appear and get adopted without any MCP call.

**Architecture:** All file I/O goes through new Node-backend REST endpoints (via the existing `apiFetch` bridge) — no Tauri fs plugin. Content I/O is path-based (relative to the node mirror) so it serves tracked and untracked files uniformly. The file tree reflects disk truth (registered `files` rows + untracked `new_local` discovery). Registration happens in code: editor "create" registers immediately, the sync run auto-adopts untracked files. Edits are local-only (write the mirror; existing Synchronizovat pushes). Live refresh (focus + visibility + ~5s poll) surfaces externally-registered and agent-written files.

**Tech Stack:** Node + libSQL (Turso), TypeScript, `node:test`; React 19 + Vite 6 + Tailwind 4; CodeMirror 6 via `@uiw/react-codemirror`. Source spec: `docs/superpowers/specs/2026-06-07-markdown-editor-design.md`. Branch: `feat/markdown-editor`.

---

## File Structure

**Backend — create:**
- `src/domain/sync/file-content.ts` — read/write/create file content in a node mirror (path-based, conflict detection, editable guard). Owns `FileContentError`.
- `src/domain/sync/discover-local.ts` — `listUntrackedLocal()`: cheap, no-hash filesystem walk for untracked files.
- `src/api/files.ts` — REST handlers for `/nodes/:id/file` (GET/PUT), `/nodes/:id/files` (POST), `/nodes/:id/files/:fileId/rename` (POST), `/nodes/:id/files/:fileId` (DELETE).
- `test/file-content.test.ts`, `test/discover-local.test.ts`, `test/sync-rename.test.ts`, `test/sync-autoadopt.test.ts`.

**Backend — modify:**
- `src/domain/sync/engine.ts` — export `mimeFor`.
- `src/domain/sync/engine-mutations.ts` — add `renameFile()`.
- `src/api/nodes.ts` — `handleSyncStatus` adds `untracked`; `handleSyncRun` auto-adopts (`adopted`).
- `src/api/router.ts` — add `routeFiles` group **before** `routeNodes`.
- `src/shared/api-types.ts` — add `UntrackedFile`, `FileContentResponse`; extend `SyncStatusResponse`, `SyncRunResponse`.

**Frontend — create:**
- `app/src/components/MarkdownEditor.tsx` — CodeMirror 6 source editor (controlled, Cmd/Ctrl+S).
- `app/src/lib/use-file-editor.ts` — load/save/conflict hook shared by both editor shells.
- `app/src/components/EditorPane.tsx` — compact editor for the workspace right column.
- `app/src/components/EditorFullscreen.tsx` — distraction-free full-window overlay.

**Frontend — modify:**
- `app/src/api.ts` — `fetchFileContent`, `saveFileContent`, `createFile`, `renameFile`, `deleteFile`; `FileConflictError`.
- `app/src/components/DetailPane.files.tsx` — clickable rows, untracked merge + badge, `onOpenFile`.
- `app/src/components/DetailPane.tsx` — thread `onOpenFile`; untracked state; sync-status polling; create/rename/delete actions.
- `app/src/components/WorkspaceView.tsx` — render `EditorPane` in place of `DetailPane` when a file is open.
- `app/src/App.tsx` — editor state + `openFileInEditor`; fullscreen overlay; live-refresh (focus/visibility/poll).
- `app/package.json` — CodeMirror deps.

---

## Phase 0 — Dependencies & shared types

### Task 0.1: Install CodeMirror packages

**Files:**
- Modify: `app/package.json` (via npm)

- [ ] **Step 1: Install (verified versions, React 19 compatible — no `--legacy-peer-deps`)**

Run:
```bash
npm --prefix app install \
  @uiw/react-codemirror@4.25.10 \
  @codemirror/lang-markdown@6.5.0 \
  @codemirror/theme-one-dark@6.1.3 \
  @codemirror/view@6.43.0 \
  @codemirror/state@6.6.0
```

- [ ] **Step 2: Verify a single deduped CodeMirror core**

Run: `npm --prefix app ls @codemirror/state @codemirror/view`
Expected: each appears once (the second occurrence, if any, shows `deduped`). No `UNMET` / conflicting-version lines.

- [ ] **Step 3: Commit**

```bash
git add app/package.json app/package-lock.json
git commit -m "build(app): add CodeMirror 6 for the markdown editor"
```

### Task 0.2: Shared API types

**Files:**
- Modify: `src/shared/api-types.ts`

- [ ] **Step 1: Add new types and extend existing ones**

Add `UntrackedFile` and `FileContentResponse` near `DetailFile` (after the `DetailFile` block, around line 80):

```ts
// A file present on disk in the node mirror but not yet registered in the
// `files` table. Surfaced so the UI tree reflects disk truth; adopted by the
// sync run. No file_id (it isn't tracked yet).
export type UntrackedFile = {
  relative_path: string; // "wip/docs/x.md" — same shape as DetailFile.relative_path
  section: string; // wip | outputs | resources
  subpath: string | null;
  filename: string;
  local_path: string;
  mime_type: string | null;
};

// Response of GET /nodes/:nodeId/file?path=<rel>.
export type FileContentResponse = {
  content: string;
  version: string; // sha256 of the on-disk bytes; pass back as baseVersion on save
  filename: string;
  mime_type: string | null;
};
```

Change `SyncStatusResponse` (lines 106-108) to:

```ts
export type SyncStatusResponse = {
  files: SyncStatusFile[];
  untracked: UntrackedFile[];
};
```

Change `SyncRunResponse` (lines 123-129) to add `adopted`:

```ts
export type SyncRunResponse = {
  pushed: SyncRunFile[];
  pulled: SyncRunFile[];
  adopted: SyncRunFile[];
  conflicts: SyncRunFile[];
  errors: SyncRunErrorFile[];
  skipped: SyncRunSkippedFile[];
};
```

- [ ] **Step 2: Verify the project still typechecks (these edits will surface the handlers we must update next — expected)**

Run: `npm run typecheck`
Expected: errors ONLY in `src/api/nodes.ts` (`handleSyncStatus` missing `untracked`, `handleSyncRun` missing `adopted`). No errors elsewhere. These are fixed in Phase 2 / Phase 4.

> Note: do not commit yet — Step 2 intentionally leaves a broken build. The first commit that touches types is Task 2.x where `handleSyncStatus` is updated. If you prefer a green tree now, temporarily add `untracked: []` to the existing `{ files: tagged }` literal and `adopted: []` to the `SyncRunResponse` literal in `src/api/nodes.ts`, commit, then replace with the real logic in Phases 2/4. Either is fine; the plan assumes the latter (green-first) and Task 2.3 / Task 4.4 replace the stubs.

- [ ] **Step 3: Add green-first stubs so the tree builds**

In `src/api/nodes.ts`, `handleSyncStatus`, change `const payload: SyncStatusResponse = { files: tagged };` to:
```ts
    const payload: SyncStatusResponse = { files: tagged, untracked: [] };
```
In `src/api/nodes.ts`, `handleSyncRun`, change the `result` initializer to include `adopted: []`:
```ts
    const result: SyncRunResponse = {
      pushed: [],
      pulled: [],
      adopted: [],
      conflicts: [],
      errors: [],
      skipped: [],
    };
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/shared/api-types.ts src/api/nodes.ts
git commit -m "feat(api-types): add UntrackedFile/FileContentResponse, extend sync responses"
```

### Task 0.3: Export `mimeFor` from the engine

**Files:**
- Modify: `src/domain/sync/engine.ts:44`

- [ ] **Step 1: Add `export` to `mimeFor`**

Change (around line 44):
```ts
function mimeFor(n: string): string | null {
```
to:
```ts
export function mimeFor(n: string): string | null {
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/domain/sync/engine.ts
git commit -m "refactor(sync): export mimeFor for reuse by file-content + handlers"
```

---

## Phase 1 — Backend content read/write

### Task 1.1: `file-content.ts` — read + write (TDD)

**Files:**
- Create: `src/domain/sync/file-content.ts`
- Test: `test/file-content.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/file-content.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import {
  readFileContent,
  writeFileContent,
  FileContentError,
} from "../src/domain/sync/file-content.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-filecontent-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("readFileContent", () => {
  it("reads a markdown file and returns content + version", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "# hi\n");

    const r = await readFileContent(db, { userId: "U1", nodeId, relPath: "wip/x.md" });
    assert.equal(r.content, "# hi\n");
    assert.equal(r.filename, "x.md");
    assert.equal(r.mime_type, "text/markdown");
    assert.equal(r.version.length, 64);
  });

  it("throws NO_MIRROR when the node has no mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/x.md" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NO_MIRROR",
    );
  });

  it("throws NOT_FOUND for a missing file", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/nope.md" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_FOUND",
    );
  });

  it("throws NOT_EDITABLE for a binary mime", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/p.png" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_EDITABLE",
    );
  });

  it("throws INVALID_PATH on traversal", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/../../escape" }),
      (e: unknown) => e instanceof FileContentError && e.code === "INVALID_PATH",
    );
  });
});

describe("writeFileContent", () => {
  it("writes content and returns a new version (no conflict check without baseVersion)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const w = await writeFileContent(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/new.md",
      content: "hello",
    });
    assert.equal(w.version.length, 64);
    assert.equal(await readFile(join(mirrorRoot, "wip", "new.md"), "utf8"), "hello");
  });

  it("accepts a save when baseVersion matches the on-disk version", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "v1");
    const read = await readFileContent(db, { userId: "U1", nodeId, relPath: "wip/x.md" });
    const w = await writeFileContent(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/x.md",
      content: "v2",
      baseVersion: read.version,
    });
    assert.equal(await readFile(join(mirrorRoot, "wip", "x.md"), "utf8"), "v2");
    assert.notEqual(w.version, read.version);
  });

  it("throws CONFLICT when baseVersion is stale, with currentVersion attached", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "current");
    await assert.rejects(
      () =>
        writeFileContent(db, {
          userId: "U1",
          nodeId,
          relPath: "wip/x.md",
          content: "mine",
          baseVersion: "0".repeat(64),
        }),
      (e: unknown) =>
        e instanceof FileContentError &&
        e.code === "CONFLICT" &&
        typeof e.currentVersion === "string" &&
        e.currentVersion.length === 64,
    );
  });

  it("force:true overwrites despite a stale baseVersion", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "current");
    await writeFileContent(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/x.md",
      content: "mine",
      baseVersion: "0".repeat(64),
      force: true,
    });
    assert.equal(await readFile(join(mirrorRoot, "wip", "x.md"), "utf8"), "mine");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test test/file-content.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/sync/file-content.js'`.

- [ ] **Step 3: Implement `file-content.ts`**

Create `src/domain/sync/file-content.ts`:

```ts
// Path-based read/write of file content inside a node's local mirror.
// Serves both tracked and untracked files (it only resolves a mirror-relative
// path to disk; registration is a separate concern). Save is local-only: it
// writes the mirror file and never pushes -- the sync run / statusScan picks
// up the change as a push candidate. Conflict detection compares the on-disk
// sha256 against the caller's baseVersion so a concurrent terminal-agent edit
// is never silently clobbered.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./mirror-registry.js";
import { resolveNodeInfo } from "./node-info.js";
import { storeFile } from "./engine.js";
import { mimeFor } from "./engine.js";
import { sha256Buffer } from "./hash.js";
import { safeMirrorJoin, type Section } from "./remote-path.js";

export type FileContentErrorCode =
  | "NO_MIRROR"
  | "NOT_FOUND"
  | "NOT_EDITABLE"
  | "CONFLICT"
  | "EXISTS"
  | "INVALID_PATH";

export class FileContentError extends Error {
  constructor(
    message: string,
    readonly code: FileContentErrorCode,
    readonly currentVersion?: string,
  ) {
    super(message);
    this.name = "FileContentError";
  }
}

// Editable = text-ish. Unknown extension (null mime) is treated as text so
// .mdx/.yaml/.toml open; known binary types are rejected. A NUL byte in the
// bytes is a hard binary signal even if the extension lied.
function isEditableMime(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return false;
}

function resolveAbs(mirrorRoot: string, relPath: string): string {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new FileContentError("empty path", "INVALID_PATH");
  }
  try {
    return safeMirrorJoin(mirrorRoot, ...segments);
  } catch {
    throw new FileContentError(`invalid path: ${relPath}`, "INVALID_PATH");
  }
}

export async function readFileContent(
  db: Client,
  a: { userId: string; nodeId: string; relPath: string },
): Promise<{ content: string; version: string; filename: string; mime_type: string | null }> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) throw new FileContentError("node has no local mirror", "NO_MIRROR");
  const abs = resolveAbs(mirrorRoot, a.relPath);
  const filename = basename(abs);
  const mime = mimeFor(filename);

  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileContentError(`file not found: ${a.relPath}`, "NOT_FOUND");
    }
    throw e;
  }
  if (!isEditableMime(mime) || buf.includes(0)) {
    throw new FileContentError(`file is not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }
  return {
    content: buf.toString("utf8"),
    version: sha256Buffer(buf),
    filename,
    mime_type: mime,
  };
}

export async function writeFileContent(
  db: Client,
  a: {
    userId: string;
    nodeId: string;
    relPath: string;
    content: string;
    baseVersion?: string;
    force?: boolean;
  },
): Promise<{ version: string }> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) throw new FileContentError("node has no local mirror", "NO_MIRROR");
  const abs = resolveAbs(mirrorRoot, a.relPath);

  if (a.baseVersion && !a.force) {
    let current: Buffer | null = null;
    try {
      current = await readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (current) {
      const currentVersion = sha256Buffer(current);
      if (currentVersion !== a.baseVersion) {
        throw new FileContentError(
          "file changed on disk since it was opened",
          "CONFLICT",
          currentVersion,
        );
      }
    }
  }

  await mkdir(dirname(abs), { recursive: true });
  const bytes = Buffer.from(a.content, "utf8");
  await writeFile(abs, bytes);
  return { version: sha256Buffer(bytes) };
}

export async function createFile(
  db: Client,
  a: {
    userId: string;
    nodeId: string;
    filename: string;
    section?: Section;
    subpath?: string | null;
    content?: string;
  },
): Promise<{
  id: string;
  filename: string;
  status: string;
  description: string | null;
  local_path: string;
  relative_path: string;
  mime_type: string | null;
}> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) throw new FileContentError("node has no local mirror", "NO_MIRROR");
  const section: Section = a.section ?? "wip";
  const fn = a.filename;
  if (!fn || fn.includes("/") || fn.includes("\\") || fn.includes("\0") || fn === "." || fn === "..") {
    throw new FileContentError(`invalid filename: ${a.filename}`, "INVALID_PATH");
  }
  const subSegs = a.subpath ? a.subpath.split("/").filter((s) => s.length > 0) : [];
  let abs: string;
  try {
    abs = safeMirrorJoin(mirrorRoot, section, ...subSegs, fn);
  } catch {
    throw new FileContentError("invalid path", "INVALID_PATH");
  }

  // Refuse to clobber an existing file.
  try {
    await readFile(abs);
    throw new FileContentError(`file already exists: ${fn}`, "EXISTS");
  } catch (e) {
    if (e instanceof FileContentError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(a.content ?? "", "utf8"));

  // Register + push. storeFile detects the file is already inside the mirror
  // (subpathFromMirror) and skips the copy, uploads, and upserts the row.
  const stored = await storeFile(db, {
    userId: a.userId,
    nodeId: a.nodeId,
    localPath: abs,
    status: section === "outputs" ? "output" : "wip",
  });

  const relative_path = abs.startsWith(mirrorRoot + "/")
    ? abs.slice(mirrorRoot.length + 1)
    : fn;
  return {
    id: stored.file_id,
    filename: fn,
    status: section === "outputs" ? "output" : "wip",
    description: null,
    local_path: abs,
    relative_path,
    mime_type: mimeFor(fn),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/file-content.test.ts`
Expected: PASS (all read + write cases).

- [ ] **Step 5: Commit**

```bash
git add src/domain/sync/file-content.ts test/file-content.test.ts
git commit -m "feat(sync): path-based file content read/write/create with conflict guard"
```

### Task 1.2: `createFile` test

**Files:**
- Test: `test/file-content.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Add to `test/file-content.test.ts`:

```ts
describe("createFile", () => {
  it("writes the file, registers it, and returns a DetailFile shape", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { createFile } = await import("../src/domain/sync/file-content.js");
    const f = await createFile(db, {
      userId: "U1",
      nodeId,
      filename: "notes.md",
      content: "# Notes\n",
    });
    assert.equal(f.filename, "notes.md");
    assert.equal(f.relative_path, "wip/notes.md");
    assert.equal(f.mime_type, "text/markdown");
    assert.ok(f.id.length > 0);
    // file row exists
    const rows = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [f.id] });
    assert.equal(rows.rows.length, 1);
    // bytes landed on the fs remote
    void remoteRoot;
    assert.equal(await readFile(join(mirrorRoot, "wip", "notes.md"), "utf8"), "# Notes\n");
  });

  it("throws EXISTS when the file already exists", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { createFile } = await import("../src/domain/sync/file-content.js");
    await createFile(db, { userId: "U1", nodeId, filename: "a.md", content: "x" });
    await assert.rejects(
      () => createFile(db, { userId: "U1", nodeId, filename: "a.md", content: "y" }),
      (e: unknown) => e instanceof FileContentError && e.code === "EXISTS",
    );
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `node --import tsx --test test/file-content.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/file-content.test.ts
git commit -m "test(sync): createFile registers + writes mirror file"
```

### Task 1.3: REST handlers for content GET/PUT + create

**Files:**
- Create: `src/api/files.ts`
- Modify: `src/api/router.ts`

- [ ] **Step 1: Create `src/api/files.ts`**

```ts
// REST handlers for file content + lifecycle within a node mirror.
//   GET    /nodes/:nodeId/file?path=<rel>        -> read content
//   PUT    /nodes/:nodeId/file?path=<rel>        -> save (local-only, conflict-checked)
//   POST   /nodes/:nodeId/files                  -> create (registers + pushes)
//   POST   /nodes/:nodeId/files/:fileId/rename   -> rename (tracked)
//   DELETE /nodes/:nodeId/files/:fileId          -> delete (two-phase via deleteFile)

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { parseJsonBody, respondJson, respondError } from "../http/middleware.js";
import {
  readFileContent,
  writeFileContent,
  createFile,
  FileContentError,
  type FileContentErrorCode,
} from "../domain/sync/file-content.js";
import { renameFile, deleteFile } from "../domain/sync/engine-mutations.js";
import type { FileContentResponse } from "../shared/api-types.js";

const CODE_STATUS: Record<FileContentErrorCode, number> = {
  NO_MIRROR: 409,
  NOT_FOUND: 404,
  NOT_EDITABLE: 415,
  CONFLICT: 409,
  EXISTS: 409,
  INVALID_PATH: 400,
};

function handleFileContentError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof FileContentError) {
    const status = CODE_STATUS[err.code];
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.code === "CONFLICT" && err.currentVersion) {
      body.currentVersion = err.currentVersion;
    }
    respondJson(res, status, body);
    return true;
  }
  return false;
}

export async function handleGetFileContent(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
  url: URL,
): Promise<void> {
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    respondJson(res, 400, { error: "path query param required" });
    return;
  }
  try {
    const r = await readFileContent(getDb(), { userId: SOLO_USER, nodeId, relPath });
    const payload: FileContentResponse = {
      content: r.content,
      version: r.version,
      filename: r.filename,
      mime_type: r.mime_type,
    };
    respondJson(res, 200, payload);
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `GET /nodes/${nodeId}/file`, err);
  }
}

const putSchema = z.object({
  content: z.string(),
  baseVersion: z.string().optional(),
  force: z.boolean().optional(),
});

export async function handlePutFileContent(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
  url: URL,
): Promise<void> {
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    respondJson(res, 400, { error: "path query param required" });
    return;
  }
  const body = await parseJsonBody(req, res, putSchema);
  if (!body) return;
  try {
    const r = await writeFileContent(getDb(), {
      userId: SOLO_USER,
      nodeId,
      relPath,
      content: body.content,
      baseVersion: body.baseVersion,
      force: body.force,
    });
    respondJson(res, 200, { version: r.version });
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `PUT /nodes/${nodeId}/file`, err);
  }
}

const createSchema = z.object({
  filename: z.string().min(1),
  section: z.enum(["wip", "outputs", "resources"]).optional(),
  subpath: z.string().nullish(),
  content: z.string().optional(),
});

export async function handleCreateFile(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  const body = await parseJsonBody(req, res, createSchema);
  if (!body) return;
  try {
    const f = await createFile(getDb(), {
      userId: SOLO_USER,
      nodeId,
      filename: body.filename,
      section: body.section,
      subpath: body.subpath ?? null,
      content: body.content,
    });
    respondJson(res, 201, f);
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `POST /nodes/${nodeId}/files`, err);
  }
}

const renameSchema = z.object({ new_filename: z.string().min(1) });

export async function handleRenameFile(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
  fileId: string,
): Promise<void> {
  const body = await parseJsonBody(req, res, renameSchema);
  if (!body) return;
  try {
    const r = await renameFile(getDb(), {
      userId: SOLO_USER,
      fileId,
      newFilename: body.new_filename,
    });
    respondJson(res, 200, r);
  } catch (err) {
    respondError(res, `POST /nodes/${nodeId}/files/${fileId}/rename`, err);
  }
}

export async function handleDeleteFile(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
  fileId: string,
  url: URL,
): Promise<void> {
  const confirmed = url.searchParams.get("confirmed") === "true";
  try {
    const r = await deleteFile(getDb(), {
      userId: SOLO_USER,
      fileId,
      mode: "complete",
      confirmed,
    });
    respondJson(res, 200, r);
  } catch (err) {
    respondError(res, `DELETE /nodes/${nodeId}/files/${fileId}`, err);
  }
}
```

> Note: `renameFile` (engine-mutations) does not exist yet — it is added in Task 4.1. To keep this task green-first, the import will fail typecheck until then. If you implement strictly in order, temporarily comment out the `renameFile`/`handleRenameFile` lines and the rename route in Step 2, and re-enable them in Task 4.1. The recommended order is: do Task 4.1 (`renameFile`) BEFORE wiring rename, OR accept a red typecheck between this task and 4.1. The cleanest path: implement Task 4.1 now (it's self-contained), then return here. The plan below assumes `renameFile` exists.

- [ ] **Step 2: Add `routeFiles` to the router (BEFORE `routeNodes`)**

In `src/api/router.ts`, add imports near the other handler imports:

```ts
import {
  handleCreateFile,
  handleDeleteFile,
  handleGetFileContent,
  handlePutFileContent,
  handleRenameFile,
} from "./files.js";
```

Add `routeFiles` to the `SUB_ROUTERS` array, positioned **immediately before** `routeNodes`:

```ts
const SUB_ROUTERS: SubRouter[] = [
  routeSystem,
  routeActors,
  routeResponsibilities,
  routeDataSources,
  routeTools,
  routeFiles,
  routeNodes,
  routeEdges,
  routeEvents,
];
```

Add the `routeFiles` function (place it just above `routeNodes`):

```ts
// --- Files (content + lifecycle). MUST be registered before routeNodes:
// routeNodes' `pathname.startsWith("/nodes/")` would otherwise swallow
// /nodes/:id/file and treat "id/file" as a node id. ---
async function routeFiles(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;

  const contentMatch = pathname.match(/^\/nodes\/([^/]+)\/file$/);
  if (contentMatch) {
    const nodeId = decodeURIComponent(contentMatch[1]);
    if (method === "GET") {
      await handleGetFileContent(req, res, nodeId, url);
      return true;
    }
    if (method === "PUT") {
      await handlePutFileContent(req, res, nodeId, url);
      return true;
    }
  }

  const renameMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)\/rename$/);
  if (renameMatch && method === "POST") {
    await handleRenameFile(
      req,
      res,
      decodeURIComponent(renameMatch[1]),
      decodeURIComponent(renameMatch[2]),
    );
    return true;
  }

  const createMatch = pathname.match(/^\/nodes\/([^/]+)\/files$/);
  if (createMatch && method === "POST") {
    await handleCreateFile(req, res, decodeURIComponent(createMatch[1]));
    return true;
  }

  const fileMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)$/);
  if (fileMatch && method === "DELETE") {
    await handleDeleteFile(
      req,
      res,
      decodeURIComponent(fileMatch[1]),
      decodeURIComponent(fileMatch[2]),
      url,
    );
    return true;
  }

  return false;
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS (requires Task 4.1's `renameFile` to exist — implement Task 4.1 first if red).

- [ ] **Step 4: Manual smoke (backend running on 4011 via tmux)**

Rebuild + restart per project workflow:
```bash
npm run build && tmux send-keys -t portuni-mcp C-c Up Enter
```
Then (replace `<NODE_ID>` with a mirrored node id; token from env):
```bash
curl -s "http://localhost:4011/nodes/<NODE_ID>/file?path=wip/PORTUNI_SCOPE.md" \
  -H "Authorization: Bearer $PORTUNI_AUTH_TOKEN" | head -c 200
```
Expected: JSON `{ "content": "...", "version": "...", ... }` for an existing text file, or `{ "error": ..., "code": "NOT_FOUND" }`.

- [ ] **Step 5: Commit**

```bash
git add src/api/files.ts src/api/router.ts
git commit -m "feat(api): file content + lifecycle endpoints under /nodes/:id/file(s)"
```

### Task 1.4: Frontend API client for content

**Files:**
- Modify: `app/src/api.ts`
- Modify: `app/src/types.ts` (re-export new types)

- [ ] **Step 1: Re-export the new shared types**

In `app/src/types.ts`, add to the `export type { ... }` block (the list re-exported from `../../src/shared/api-types`):

```ts
  UntrackedFile,
  FileContentResponse,
```

- [ ] **Step 2: Add the API functions**

In `app/src/api.ts`, add to the type imports from `./types`:

```ts
import type {
  GraphPayload,
  NodeDetail,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
  SyncStatusResponse,
  SyncRunResponse,
  DetailFile,
  FileContentResponse,
} from "./types";
```

Append the following functions at the end of the file:

```ts
// -- File content + lifecycle ------------------------------------------

// Thrown by saveFileContent when the on-disk file changed since it was
// opened. Carries the current on-disk version so the UI can offer
// keep-mine (resend with force) / reload-theirs (re-fetch).
export class FileConflictError extends Error {
  constructor(readonly currentVersion: string) {
    super("file changed on disk since it was opened");
    this.name = "FileConflictError";
  }
}

export async function fetchFileContent(
  nodeId: string,
  relPath: string,
): Promise<FileContentResponse> {
  const res = await apiFetch(
    `/nodes/${encodeURIComponent(nodeId)}/file?path=${encodeURIComponent(relPath)}`,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`file content: ${res.status} ${text}`);
  }
  return res.json();
}

export async function saveFileContent(
  nodeId: string,
  relPath: string,
  body: { content: string; baseVersion?: string; force?: boolean },
): Promise<{ version: string }> {
  const res = await apiFetch(
    `/nodes/${encodeURIComponent(nodeId)}/file?path=${encodeURIComponent(relPath)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 409) {
    const j = (await res.json().catch(() => ({}))) as { currentVersion?: string };
    if (j.currentVersion) throw new FileConflictError(j.currentVersion);
    throw new Error("save conflict (409) without currentVersion");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`save: ${res.status} ${text}`);
  }
  return res.json();
}

export function createFile(
  nodeId: string,
  input: { filename: string; section?: string; subpath?: string | null; content?: string },
): Promise<DetailFile> {
  return jsonRequest<DetailFile>(
    "POST",
    `/nodes/${encodeURIComponent(nodeId)}/files`,
    input,
  );
}

export function renameFile(
  nodeId: string,
  fileId: string,
  newFilename: string,
): Promise<unknown> {
  return jsonRequest(
    "POST",
    `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}/rename`,
    { new_filename: newFilename },
  );
}

export function deleteFile(nodeId: string, fileId: string): Promise<unknown> {
  return jsonRequest(
    "DELETE",
    `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}?confirmed=true`,
  );
}
```

- [ ] **Step 3: Typecheck the app**

Run: `npm --prefix app run build`
Expected: PASS (tsc -b + vite build).

- [ ] **Step 4: Commit**

```bash
git add app/src/api.ts app/src/types.ts
git commit -m "feat(app/api): file content + lifecycle client functions"
```

---

## Phase 2 — Disk-truth file tree + live refresh (fixes "MCP files not visible")

### Task 2.1: `discover-local.ts` — untracked walk (TDD)

**Files:**
- Create: `src/domain/sync/discover-local.ts`
- Test: `test/discover-local.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/discover-local.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { storeFile } from "../src/domain/sync/engine.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { listUntrackedLocal } from "../src/domain/sync/discover-local.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-discover-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("listUntrackedLocal", () => {
  it("returns files on disk that are not registered", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "docs"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "loose.md"), "x");
    await writeFile(join(mirrorRoot, "wip", "docs", "deep.md"), "y");

    const out = await listUntrackedLocal(db, { userId: "U1", nodeId });
    const rels = out.map((u) => [u.section, u.subpath, u.filename]).sort();
    assert.deepEqual(rels, [
      ["wip", "docs", "deep.md"],
      ["wip", null, "loose.md"],
    ]);
  });

  it("excludes registered files", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "reg.md");
    await writeFile(src, "z");
    await storeFile(db, { userId: "U1", nodeId, localPath: src }); // -> wip/reg.md, tracked

    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "loose.md"), "x");

    const out = await listUntrackedLocal(db, { userId: "U1", nodeId });
    assert.equal(out.length, 1);
    assert.equal(out[0].filename, "loose.md");
  });

  it("returns [] when there is no mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const out = await listUntrackedLocal(db, { userId: "U1", nodeId });
    assert.deepEqual(out, []);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test test/discover-local.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `discover-local.ts`**

```ts
// Cheap, hash-free discovery of files on disk in a node mirror that are not
// registered in the `files` table. Used by the UI (sync-status `untracked`)
// and the sync run (auto-adopt). Mirrors engine.ts walkMirror but skips
// sha256 -- the hash is recomputed by storeFile at adopt time, and the UI
// only needs paths.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./mirror-registry.js";
import { resolveNodeInfo } from "./node-info.js";
import {
  buildNodeRoot,
  deriveLocalPath,
  subpathFromMirror,
  type Section,
} from "./remote-path.js";

export interface UntrackedLocalEntry {
  node_id: string;
  local_path: string;
  section: Section;
  subpath: string | null;
  filename: string;
}

export async function listUntrackedLocal(
  db: Client,
  a: { userId: string; nodeId: string },
): Promise<UntrackedLocalEntry[]> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) return [];

  let nodeRoot: string;
  try {
    nodeRoot = buildNodeRoot(await resolveNodeInfo(db, a.nodeId));
  } catch {
    return [];
  }

  // Known local paths derived from this node's registered files.
  const filesRes = await db.execute({
    sql: "SELECT remote_path FROM files WHERE node_id = ?",
    args: [a.nodeId],
  });
  const known = new Set<string>();
  for (const r of filesRes.rows) {
    const rp = r.remote_path as string | null;
    if (!rp) continue;
    try {
      known.add(deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: rp }));
    } catch {
      /* ignore */
    }
  }

  const out: UntrackedLocalEntry[] = [];
  for (const section of ["wip", "outputs", "resources"] as Section[]) {
    await walk(join(mirrorRoot, section), mirrorRoot, a.nodeId, known, out);
  }
  return out;
}

async function walk(
  dir: string,
  mirrorRoot: string,
  nodeId: string,
  known: Set<string>,
  out: UntrackedLocalEntry[],
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(p, mirrorRoot, nodeId, known, out);
    } else if (ent.isFile()) {
      if (known.has(p)) continue;
      const sub = subpathFromMirror(mirrorRoot, p);
      if (!sub) continue;
      out.push({
        node_id: nodeId,
        local_path: p,
        section: sub.section,
        subpath: sub.subpath,
        filename: sub.filename,
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --import tsx --test test/discover-local.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/sync/discover-local.ts test/discover-local.test.ts
git commit -m "feat(sync): listUntrackedLocal -- hash-free untracked discovery"
```

### Task 2.2: `handleSyncStatus` returns `untracked`

**Files:**
- Modify: `src/api/nodes.ts` (`handleSyncStatus`)

- [ ] **Step 1: Wire untracked into the response**

In `src/api/nodes.ts`, add imports:
```ts
import { listUntrackedLocal } from "../domain/sync/discover-local.js";
import { mimeFor } from "../domain/sync/engine.js";
import type { SyncStatusResponse, SyncRunResponse, UntrackedFile } from "../shared/api-types.js";
```
(Merge `UntrackedFile` into the existing `import type { SyncStatusResponse, SyncRunResponse } ...` line rather than duplicating.)

Replace the stub line `const payload: SyncStatusResponse = { files: tagged, untracked: [] };` with:

```ts
    const untrackedRaw = await listUntrackedLocal(getDb(), { userId: SOLO_USER, nodeId });
    const untracked: UntrackedFile[] = untrackedRaw.map((u) => ({
      relative_path: u.subpath
        ? `${u.section}/${u.subpath}/${u.filename}`
        : `${u.section}/${u.filename}`,
      section: u.section,
      subpath: u.subpath,
      filename: u.filename,
      local_path: u.local_path,
      mime_type: mimeFor(u.filename),
    }));
    const payload: SyncStatusResponse = { files: tagged, untracked };
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke**

```bash
npm run build && tmux send-keys -t portuni-mcp C-c Up Enter
curl -s "http://localhost:4011/nodes/<NODE_ID>/sync-status" -H "Authorization: Bearer $PORTUNI_AUTH_TOKEN" | python3 -m json.tool | head -40
```
Expected: JSON has both `files` and `untracked` arrays.

- [ ] **Step 4: Commit**

```bash
git add src/api/nodes.ts
git commit -m "feat(api): sync-status surfaces untracked local files (disk truth)"
```

### Task 2.3: FileTree shows untracked files (+ clickable rows)

**Files:**
- Modify: `app/src/components/DetailPane.files.tsx`

- [ ] **Step 1: Add a unified row model + `onOpenFile` + untracked**

In `app/src/components/DetailPane.files.tsx`:

Update the type imports at the top to include `UntrackedFile`:
```ts
import type {
  DetailFile,
  NodeDetail,
  SyncClass,
  SyncRunResponse,
  SyncStatusFile,
  UntrackedFile,
} from "../types";
```

Add an editable helper + a unified row type, and rewrite `buildFileTree` to accept both. Replace the `TreeNode` type and `buildFileTree` function (lines 35-68) with:

```ts
// Unified leaf model: registered DetailFile or an untracked disk file.
type TreeFile = {
  relative_path: string;
  filename: string;
  description: string | null;
  mime_type: string | null;
  fileId: string | null; // null = untracked (not in `files`)
};

type TreeNode = {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
  file?: TreeFile;
};

// Text-ish files are clickable to edit. Mirrors the backend editable rule.
export function isEditableFile(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return false;
}

function buildFileTree(files: TreeFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const rel = f.relative_path;
    const parts = rel.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const childPath = parts.slice(0, i + 1).join("/");
      let child = cur.children!.get(seg);
      if (!child) {
        child = { name: seg, path: childPath, children: new Map() };
        cur.children!.set(seg, child);
      }
      cur = child;
    }
    const leafName = parts[parts.length - 1];
    cur.children!.set(leafName, { name: leafName, path: rel, file: f });
  }
  return root;
}

// Merge registered + untracked into one row list. Registered wins if a path
// appears in both (a freshly-adopted file may briefly show in both).
function toTreeFiles(files: DetailFile[], untracked: UntrackedFile[]): TreeFile[] {
  const byPath = new Map<string, TreeFile>();
  for (const u of untracked) {
    byPath.set(u.relative_path, {
      relative_path: u.relative_path,
      filename: u.filename,
      description: null,
      mime_type: u.mime_type,
      fileId: null,
    });
  }
  for (const f of files) {
    const rel = f.relative_path ?? f.filename;
    byPath.set(rel, {
      relative_path: rel,
      filename: f.filename,
      description: f.description,
      mime_type: f.mime_type,
      fileId: f.id,
    });
  }
  return Array.from(byPath.values());
}
```

- [ ] **Step 2: Thread props through `FileTree` / `FileTreeNode`**

Replace the `FileTree` component (lines 149-187) signature/body to accept `untracked`, `onOpenFile`, `onRename`, `onDelete`:

```ts
export function FileTree({
  files,
  untracked,
  syncStatus,
  syncLoaded,
  onOpenFile,
  onRename,
  onDelete,
}: {
  files: DetailFile[];
  untracked: UntrackedFile[];
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, currentName: string) => void;
  onDelete: (fileId: string, filename: string) => void;
}) {
  const treeFiles = useMemo(() => toTreeFiles(files, untracked), [files, untracked]);
  const root = useMemo(() => buildFileTree(treeFiles), [treeFiles]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const topChildren = sortChildren(root, true);
  return (
    <div className="space-y-0.5">
      {topChildren.map((c) => (
        <FileTreeNode
          key={c.path}
          node={c}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
          syncStatus={syncStatus}
          syncLoaded={syncLoaded}
          onOpenFile={onOpenFile}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
```

Replace the `FileTreeNode` parameter destructure + its TS param type (lines 189-203) with:

```ts
function FileTreeNode({
  node,
  depth,
  collapsed,
  onToggle,
  syncStatus,
  syncLoaded,
  onOpenFile,
  onRename,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  syncStatus: Map<string, SyncStatusFile>;
  syncLoaded: boolean;
  onOpenFile: (relPath: string) => void;
  onRename: (fileId: string, currentName: string) => void;
  onDelete: (fileId: string, filename: string) => void;
}) {
```

Then replace the file-row branch — the `if (node.file) { ... }` block (lines 205-236) — with:

```ts
  if (node.file) {
    const f = node.file;
    const sync = f.fileId ? syncStatus.get(f.fileId) : undefined;
    const editable = isEditableFile(f.mime_type);
    return (
      <div
        className="group flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface)]"
        style={{ paddingLeft: indent + 8 }}
      >
        <FileText size={12} className="mt-0.5 shrink-0 text-[var(--color-text-dim)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!editable}
              onClick={() => editable && onOpenFile(f.relative_path)}
              title={editable ? "Otevřít v editoru" : "Tento soubor nelze editovat"}
              className={
                "truncate text-left text-[13.5px] text-[var(--color-text)] " +
                (editable ? "hover:underline" : "cursor-default opacity-70")
              }
            >
              {f.filename}
            </button>
            {sync && <SyncStatusBadge sync={sync} />}
            {!f.fileId && (
              <span
                title="Soubor je na disku, ale ještě není zaregistrovaný. Zaregistruje se při synchronizaci."
                className="rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
                style={{
                  color: "var(--color-status-archived)",
                  background:
                    "color-mix(in srgb, var(--color-status-archived) 12%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--color-status-archived) 25%, transparent)",
                }}
              >
                neregistrováno
              </span>
            )}
            {f.fileId && (
              <span className="ml-auto hidden gap-1 group-hover:flex">
                <button
                  type="button"
                  onClick={() => onRename(f.fileId!, f.filename)}
                  title="Přejmenovat"
                  className="text-[11px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                >
                  Přejmenovat
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(f.fileId!, f.filename)}
                  title="Smazat"
                  className="text-[11px] text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
                >
                  Smazat
                </button>
              </span>
            )}
          </div>
          {f.description && (
            <div className="mt-0.5 line-clamp-2 text-[13.5px] leading-relaxed text-[var(--color-text-dim)]">
              {f.description}
            </div>
          )}
        </div>
      </div>
    );
  }
```

In the folder branch's recursive render (the `sortChildren(node, false).map((c) => (<FileTreeNode .../>))` call, lines 274-284), add the three new props to the recursive element so they propagate to nested rows:

```tsx
            <FileTreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              syncStatus={syncStatus}
              syncLoaded={syncLoaded}
              onOpenFile={onOpenFile}
              onRename={onRename}
              onDelete={onDelete}
            />
```

> Note: `aggregateFolderSync(node, syncStatus)` reads `cur.file.id`. With the unified model the leaf now carries `file.fileId`. Update `aggregateFolderSync` (lines 74-123): change `const sync = map.get(cur.file.id);` to `const sync = cur.file.fileId ? map.get(cur.file.fileId) : undefined; if (!sync) continue;` (untracked leaves contribute no sync color).

- [ ] **Step 3: App-level typecheck**

Run: `npm --prefix app run build`
Expected: errors only in `DetailPane.tsx` (the `FileTree` call now needs the new props) — fixed in Task 2.4.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/DetailPane.files.tsx
git commit -m "feat(app): file tree shows untracked files + clickable editable rows"
```

### Task 2.4: DetailPane wires open/create/rename/delete + untracked + polling

**Files:**
- Modify: `app/src/components/DetailPane.tsx`

- [ ] **Step 1: Add `onOpenFile` to Props**

In the `Props` type (lines 95-115), add:
```ts
  // Open a file (mirror-relative path) in the editor. Provided by the
  // workspace; absent in contexts without an editor surface.
  onOpenFile?: (nodeId: string, relPath: string) => void;
```

- [ ] **Step 2: Track untracked files + poll sync-status**

Add `untracked` state next to the sync-status state (after line 668):
```ts
  const [untracked, setUntracked] = useState<UntrackedFile[]>([]);
```
Add the import for `UntrackedFile`, `createFile`, `renameFile`, `deleteFile`:
```ts
import type { UntrackedFile } from "../types";
import { createFile, renameFile, deleteFile } from "../api";
```
In the sync-status fetch effect (lines 301-321), capture `untracked` and convert it into a reusable loader so polling can call it. Replace that effect with:

```ts
  const loadSyncStatus = useCallback(async () => {
    try {
      const res = await fetchNodeSyncStatus(node.id);
      const m = new Map<string, SyncStatusFile>();
      for (const f of res.files) m.set(f.file_id, f);
      SYNC_STATUS_CACHE.set(node.id, m);
      setSyncStatus(m);
      setUntracked(res.untracked ?? []);
      setSyncLoaded(true);
      setSyncError(null);
    } catch (e) {
      setSyncError(String(e));
      setSyncLoaded(true);
    }
  }, [node.id]);

  useEffect(() => {
    let cancelled = false;
    void loadSyncStatus();
    // Poll while visible so agent-written (untracked) and MCP-registered
    // files appear without a manual refresh. ~5s; paused when hidden.
    const id = setInterval(() => {
      if (!document.hidden && !cancelled) void loadSyncStatus();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loadSyncStatus]);
```
(Ensure `useCallback` is imported from React in this file; if not, add it to the React import.)

- [ ] **Step 3: Add create/rename/delete handlers + the "+ Nový soubor" button**

Add handlers (near the other DetailPane callbacks):
```ts
  const handleCreateFile = async () => {
    const name = window.prompt("Název nového souboru (např. poznamky.md):");
    if (!name) return;
    try {
      const f = await createFile(node.id, { filename: name, section: "wip" });
      await Promise.all([onMutate(), loadSyncStatus()]);
      if (onOpenFile && f.relative_path) onOpenFile(node.id, f.relative_path);
    } catch (e) {
      window.alert(`Soubor se nepodařilo vytvořit: ${String(e)}`);
    }
  };

  const handleRenameFile = async (fileId: string, currentName: string) => {
    const name = window.prompt("Nový název souboru:", currentName);
    if (!name || name === currentName) return;
    try {
      await renameFile(node.id, fileId, name);
      await Promise.all([onMutate(), loadSyncStatus()]);
    } catch (e) {
      window.alert(`Přejmenování selhalo: ${String(e)}`);
    }
  };

  const handleDeleteFile = async (fileId: string, filename: string) => {
    if (!window.confirm(`Smazat soubor "${filename}"? Odstraní se i z remote úložiště.`)) {
      return;
    }
    try {
      await deleteFile(node.id, fileId);
      await Promise.all([onMutate(), loadSyncStatus()]);
    } catch (e) {
      window.alert(`Smazání selhalo: ${String(e)}`);
    }
  };
```

- [ ] **Step 4: Update the Files-tab JSX (lines 768-792)**

Replace with:
```tsx
{tab === "files" && (
  <div className="px-5 py-4">
    <div className="mb-3 flex items-center justify-between">
      {(node.files.length > 0 || untracked.length > 0) ? (
        <SyncBar
          running={syncRunning}
          result={syncRunResult}
          error={syncError}
          statusLoaded={syncLoaded}
          statusMap={syncStatus}
          onRun={handleRunSync}
        />
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={handleCreateFile}
        className="ml-2 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
      >
        + Nový soubor
      </button>
    </div>
    {node.files.length > 0 || untracked.length > 0 ? (
      <FileTree
        files={node.files}
        untracked={untracked}
        syncStatus={syncStatus}
        syncLoaded={syncLoaded}
        onOpenFile={(rel) => onOpenFile?.(node.id, rel)}
        onRename={handleRenameFile}
        onDelete={handleDeleteFile}
      />
    ) : (
      <div className="text-[14px] text-[var(--color-text-dim)]">
        Zatím žádné soubory.
      </div>
    )}
  </div>
)}
```

> Note: `SyncBar` is laid out inside a flex row now; if its existing `mb-3` double-spaces, it is cosmetic only — adjust later. Functionality is unaffected.

- [ ] **Step 5: App-level typecheck**

Run: `npm --prefix app run build`
Expected: errors only where `DetailPane` is rendered without `onOpenFile` — that's optional, so no error; the `FileTree` call now satisfies its props. Build should PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/DetailPane.tsx
git commit -m "feat(app): DetailPane untracked + polling + create/rename/delete + open-file"
```

### Task 2.5: App live-refresh (focus + visibility + ~5s node poll)

**Files:**
- Modify: `app/src/App.tsx`

- [ ] **Step 1: Extend focus to also refetch the workspace node; add visibilitychange**

Replace the Window Focus Effect (lines 170-176) with:
```tsx
  // Refetch on focus AND tab-visible. Covers BOTH the graph selection and
  // the workspace selection so files registered elsewhere (MCP / another
  // window) show up without a manual reselect.
  useEffect(() => {
    const handler = () => {
      if (document.hidden) return;
      refetchAll().catch((err) => setGraphError(String(err)));
      refetchWorkspaceDetail().catch(() => undefined);
    };
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, [refetchAll, refetchWorkspaceDetail]);
```

- [ ] **Step 2: Add the ~5s active-node poll**

Add a new effect after the focus effect:
```tsx
  // Poll the active node detail so externally-registered files appear within
  // seconds. Node-detail only (the graph poll stays on focus). Paused when
  // the tab is hidden to avoid background churn against Turso.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      if (view === "workspace" && selectedWorkspaceNodeId) {
        refetchWorkspaceDetail().catch(() => undefined);
      } else if (selectedId) {
        fetchNode(selectedId)
          .then((n) => setNodeDetail(n))
          .catch(() => undefined);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [view, selectedWorkspaceNodeId, selectedId, refetchWorkspaceDetail]);
```
(`fetchNode` is already imported in App.tsx.)

- [ ] **Step 3: Typecheck**

Run: `npm --prefix app run build`
Expected: PASS.

- [ ] **Step 4: Manual verification (the bug fix)**

Run the app (Vite): `varlock run -- npm --prefix app run dev`, open `http://portuni.test`, go to a node with a mirror in workspace view, open the Files tab. In a terminal, create a file in that node's mirror under `wip/` (e.g. `echo hi > .../wip/manual-test.md`). Within ~5s the file appears in the tree with a "neregistrováno" badge. Click Synchronizovat → badge disappears (adopted — needs Phase 4; until then it stays untracked but visible, which already proves the visibility fix).

- [ ] **Step 5: Commit**

```bash
git add app/src/App.tsx
git commit -m "fix(app): live-refresh active node (focus + visibility + 5s poll)"
```

---

## Phase 3 — Editor UI

### Task 3.1: `MarkdownEditor` (CodeMirror core)

**Files:**
- Create: `app/src/components/MarkdownEditor.tsx`

- [ ] **Step 1: Create the component (verified imports)**

```tsx
// Controlled CodeMirror 6 markdown SOURCE editor (no rendered preview).
// Cmd/Ctrl+S triggers onSave. Memoize extensions to avoid StrictMode churn.
import { useMemo } from "react";
import CodeMirror, { type BasicSetupOptions } from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSave?: (value: string) => void;
};

const basicSetup: BasicSetupOptions = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
};

export default function MarkdownEditor({ value, onChange, onSave }: Props) {
  const saveKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: (view) => {
              onSave?.(view.state.doc.toString());
              return true;
            },
          },
        ]),
      ),
    [onSave],
  );

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage }), EditorView.lineWrapping, saveKeymap],
    [saveKeymap],
  );

  return (
    <CodeMirror
      value={value}
      theme={oneDark}
      height="100%"
      style={{ height: "100%" }}
      extensions={extensions}
      basicSetup={basicSetup}
      onChange={onChange}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm --prefix app run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/MarkdownEditor.tsx
git commit -m "feat(app): MarkdownEditor CodeMirror 6 source editor"
```

### Task 3.2: `useFileEditor` hook (load/save/conflict)

**Files:**
- Create: `app/src/lib/use-file-editor.ts`

- [ ] **Step 1: Create the hook**

```ts
// Shared load/save/conflict state for the editor shells (pane + fullscreen).
// Save is local-only (PUT writes the mirror; the user pushes via Synchronizovat).
import { useCallback, useEffect, useState } from "react";
import { fetchFileContent, saveFileContent, FileConflictError } from "../api";

export type EditorStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

export type ConflictState = { theirVersion: string } | null;

export function useFileEditor(nodeId: string, relPath: string) {
  const [status, setStatus] = useState<EditorStatus>({ kind: "loading" });
  const [content, setContent] = useState("");
  const [version, setVersion] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState>(null);

  // Load on (nodeId, relPath) change.
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    setConflict(null);
    fetchFileContent(nodeId, relPath)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setVersion(r.version);
        setDirty(false);
        setStatus({ kind: "ready" });
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, relPath]);

  const onChange = useCallback((next: string) => {
    setContent(next);
    setDirty(true);
  }, []);

  const doSave = useCallback(
    async (opts?: { force?: boolean }) => {
      setSaving(true);
      try {
        const r = await saveFileContent(nodeId, relPath, {
          content,
          baseVersion: version ?? undefined,
          force: opts?.force,
        });
        setVersion(r.version);
        setDirty(false);
        setConflict(null);
      } catch (e) {
        if (e instanceof FileConflictError) {
          setConflict({ theirVersion: e.currentVersion });
        } else {
          setStatus({ kind: "error", message: String(e) });
        }
      } finally {
        setSaving(false);
      }
    },
    [nodeId, relPath, content, version],
  );

  // Conflict resolution: keep mine (force) or reload theirs (re-fetch).
  const keepMine = useCallback(() => doSave({ force: true }), [doSave]);
  const reloadTheirs = useCallback(async () => {
    const r = await fetchFileContent(nodeId, relPath);
    setContent(r.content);
    setVersion(r.version);
    setDirty(false);
    setConflict(null);
  }, [nodeId, relPath]);

  return {
    status,
    content,
    onChange,
    save: () => doSave(),
    saving,
    dirty,
    conflict,
    keepMine,
    reloadTheirs,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm --prefix app run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/use-file-editor.ts
git commit -m "feat(app): useFileEditor hook (load/save/conflict)"
```

### Task 3.3: `EditorPane` (compact) + `EditorFullscreen`

**Files:**
- Create: `app/src/components/EditorPane.tsx`
- Create: `app/src/components/EditorFullscreen.tsx`

- [ ] **Step 1: Create `EditorPane.tsx`**

```tsx
// Compact source editor for the workspace right column. Swaps in for the
// node detail (Option C). "← zpět" returns to detail; ⤢ expands to fullscreen.
import { ChevronLeft, Maximize2, Save } from "lucide-react";
import { useFileEditor } from "../lib/use-file-editor";
import MarkdownEditor from "./MarkdownEditor";

export default function EditorPane({
  nodeId,
  relPath,
  onClose,
  onExpand,
}: {
  nodeId: string;
  relPath: string;
  onClose: () => void;
  onExpand: () => void;
}) {
  const ed = useFileEditor(nodeId, relPath);
  const filename = relPath.split("/").pop() ?? relPath;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <button
          onClick={onClose}
          title="Zpět na detail"
          className="flex items-center gap-1 text-[12.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={14} /> zpět
        </button>
        <span className="ml-1 truncate text-[13px] text-[var(--color-text)]">
          {filename}
          {ed.dirty && <span className="ml-1 text-[var(--color-node-process)]">●</span>}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => ed.save()}
            disabled={ed.saving || !ed.dirty}
            title="Uložit (Cmd/Ctrl+S)"
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
          >
            <Save size={12} /> {ed.saving ? "Ukládám…" : "Uložit"}
          </button>
          <button
            onClick={onExpand}
            title="Na celé okno"
            className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <Maximize2 size={13} />
          </button>
        </span>
      </div>
      <EditorBody ed={ed} />
    </div>
  );
}

// Shared body: loading / error / conflict banner / editor. Reused by fullscreen.
export function EditorBody({ ed }: { ed: ReturnType<typeof useFileEditor> }) {
  if (ed.status.kind === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-text-dim)]">
        Načítám…
      </div>
    );
  }
  if (ed.status.kind === "error") {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-[13px] text-[var(--color-danger)]">
        {ed.status.message}
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {ed.conflict && (
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 text-[12.5px] text-[var(--color-text)]">
          <span>Soubor se mezitím změnil na disku.</span>
          <button onClick={ed.keepMine} className="underline hover:no-underline">
            Ponechat moje
          </button>
          <button onClick={ed.reloadTheirs} className="underline hover:no-underline">
            Načíst jejich
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <MarkdownEditor value={ed.content} onChange={ed.onChange} onSave={() => ed.save()} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `EditorFullscreen.tsx`**

```tsx
// Distraction-free, full-window editor overlay (Option A). Slim top bar.
import { Minimize2, Save, X } from "lucide-react";
import { useFileEditor } from "../lib/use-file-editor";
import { EditorBody } from "./EditorPane";

export default function EditorFullscreen({
  nodeId,
  relPath,
  onCollapse,
  onClose,
}: {
  nodeId: string;
  relPath: string;
  onCollapse: () => void; // back to pane
  onClose: () => void; // close editor entirely
}) {
  const ed = useFileEditor(nodeId, relPath);
  const filename = relPath.split("/").pop() ?? relPath;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <button
          onClick={onCollapse}
          title="Zmenšit do panelu"
          className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        >
          <Minimize2 size={14} />
        </button>
        <span className="truncate text-[13.5px] text-[var(--color-text)]">
          {filename}
          {ed.dirty && <span className="ml-1 text-[var(--color-node-process)]">●</span>}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => ed.save()}
            disabled={ed.saving || !ed.dirty}
            title="Uložit (Cmd/Ctrl+S)"
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2.5 py-1 text-[12.5px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
          >
            <Save size={13} /> {ed.saving ? "Ukládám…" : "Uložit"}
          </button>
          <button
            onClick={onClose}
            title="Zavřít editor"
            className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <X size={15} />
          </button>
        </span>
      </div>
      <EditorBody ed={ed} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix app run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/EditorPane.tsx app/src/components/EditorFullscreen.tsx
git commit -m "feat(app): EditorPane + EditorFullscreen shells"
```

### Task 3.4: Wire editor state into App + WorkspaceView

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/WorkspaceView.tsx`

- [ ] **Step 1: App editor state + opener**

In `App.tsx`, add state near the workspace state (after line 248):
```tsx
  const [editorFile, setEditorFile] = useState<{ nodeId: string; relPath: string } | null>(null);
  const [editorFullscreen, setEditorFullscreen] = useState(false);

  const openFileInEditor = useCallback(
    (nodeId: string, relPath: string) => {
      setEditorFile({ nodeId, relPath });
      // Workspace shows it in the side pane; elsewhere (graph) go fullscreen.
      setEditorFullscreen(view !== "workspace");
    },
    [view],
  );
  const closeEditor = useCallback(() => {
    setEditorFile(null);
    setEditorFullscreen(false);
  }, []);
```

- [ ] **Step 2: Pass `onOpenFile` to WorkspaceView and the graph DetailPane**

In the `<WorkspaceView ... />` JSX (lines 516-535), add props:
```tsx
  editorFile={editorFile}
  onOpenFile={openFileInEditor}
  onCloseEditor={closeEditor}
  onExpandEditor={() => setEditorFullscreen(true)}
```
In the graph-view `<DetailPane ... />` (lines 546-559), add:
```tsx
    onOpenFile={openFileInEditor}
```

- [ ] **Step 3: Render the fullscreen overlay**

Near the end of App's returned JSX (after the main layout container, before `StatusFooter` or at the root level so it overlays everything), add:
```tsx
      {editorFile && editorFullscreen && (
        <EditorFullscreen
          nodeId={editorFile.nodeId}
          relPath={editorFile.relPath}
          onCollapse={() => {
            // Collapse to pane only makes sense in workspace; elsewhere close.
            if (view === "workspace") setEditorFullscreen(false);
            else closeEditor();
          }}
          onClose={closeEditor}
        />
      )}
```
Add the import: `import EditorFullscreen from "./components/EditorFullscreen";`

- [ ] **Step 4: WorkspaceView renders EditorPane in place of DetailPane**

In `WorkspaceView.tsx`, extend `Props`:
```ts
  editorFile: { nodeId: string; relPath: string } | null;
  onOpenFile: (nodeId: string, relPath: string) => void;
  onCloseEditor: () => void;
  onExpandEditor: () => void;
```
Add them to the destructured params. Import the pane: `import EditorPane from "./EditorPane";`. Determine whether the editor occupies the right column:
```tsx
  const showEditor =
    editorFile != null && selectedNodeId != null && editorFile.nodeId === selectedNodeId;
```
In the `<aside>` right-column block, replace the `{selectedNodeId ? (<DetailPane ... />) : (...)}` content so that when `showEditor` is true it renders the editor, else the existing DetailPane/placeholder. Concretely, change the inner conditional to:
```tsx
          {showEditor && editorFile ? (
            <EditorPane
              nodeId={editorFile.nodeId}
              relPath={editorFile.relPath}
              onClose={onCloseEditor}
              onExpand={onExpandEditor}
            />
          ) : selectedNodeId ? (
            <DetailPane
              node={nodeDetail}
              graph={graph}
              loading={nodeDetailLoading}
              error={nodeDetailError}
              onSelect={(id) => onSelectNode(id)}
              canGoBack={false}
              onBack={() => {}}
              onMutate={onMutate}
              agentCommand={agentCommand}
              onOpenTerminal={onOpenTerminal}
              onOpenFile={onOpenFile}
              embedded
              onCollapse={toggleDetail}
            />
          ) : (
            /* existing placeholder block unchanged */
```
(Keep the existing placeholder `<div>...</div>` branch as the final `: (...)`.)

- [ ] **Step 5: Typecheck + build**

Run: `npm --prefix app run build`
Expected: PASS.

- [ ] **Step 6: Manual verification (full UX)**

`varlock run -- npm --prefix app run dev`, open `http://portuni.test`, workspace view, select a mirrored node, Files tab → click a `.md` file. Editor opens in the right pane with "← zpět" + ⤢. Edit, Cmd+S saves (badge turns to "push" after the next sync-status poll/scan). Click ⤢ → fullscreen distraction-free editor; Minimize returns to pane; X closes. Open a file from graph view → goes straight to fullscreen.

- [ ] **Step 7: Commit**

```bash
git add app/src/App.tsx app/src/components/WorkspaceView.tsx
git commit -m "feat(app): wire editor pane + fullscreen overlay into App/WorkspaceView"
```

---

## Phase 4 — CRUD backend + auto-adopt on sync

### Task 4.1: `renameFile` (TDD)

**Files:**
- Modify: `src/domain/sync/engine-mutations.ts`
- Test: `test/sync-rename.test.ts`

> If you followed the green-first ordering, do this task BEFORE Task 1.3's rename wiring compiles. It is self-contained.

- [ ] **Step 1: Write the failing test**

Create `test/sync-rename.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { storeFile } from "../src/domain/sync/engine.js";
import { renameFile } from "../src/domain/sync/engine-mutations.js";
import { getAdapter } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { stat } from "node:fs/promises";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-rename-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("renameFile", () => {
  it("renames remote + local + DB row, preserving section/subpath", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "docs"), { recursive: true });
    const src = join(mirrorRoot, "wip", "docs", "old.md");
    await writeFile(src, "body");
    const { file_id, remote_path } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    assert.ok(remote_path.endsWith("/wip/docs/old.md"));

    const r = await renameFile(db, { userId: "U1", fileId: file_id, newFilename: "new.md" });
    assert.equal(r.new_filename, "new.md");
    assert.ok(r.new_remote_path.endsWith("/wip/docs/new.md"));

    assert.equal(await exists(join(mirrorRoot, "wip", "docs", "old.md")), false);
    assert.equal(await exists(join(mirrorRoot, "wip", "docs", "new.md")), true);

    const row = await db.execute({
      sql: "SELECT filename, remote_path FROM files WHERE id = ?",
      args: [file_id],
    });
    assert.equal(row.rows[0].filename, "new.md");
    assert.ok((row.rows[0].remote_path as string).endsWith("/wip/docs/new.md"));

    // remote object moved too
    const adapter = await getAdapter(db, "test-fs");
    assert.ok(await adapter.stat(r.new_remote_path));
  });

  it("rejects an unsafe filename", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(mirrorRoot, "wip", "a.md");
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(src, "x");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    await assert.rejects(() =>
      renameFile(db, { userId: "U1", fileId: file_id, newFilename: "../evil.md" }),
    );
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test test/sync-rename.test.ts`
Expected: FAIL — `renameFile` is not exported.

- [ ] **Step 3: Implement `renameFile` in `engine-mutations.ts`**

Append (the imports it needs — `getAdapter`, `getMirrorPath`, `resolveNodeInfo`, `buildNodeRoot`, `deriveLocalPath`, `mkdir`, `dirname`, `rename as fsRename`, `ulid` — already exist in this file, used by `moveFile`):

```ts
export interface RenameFileArgs {
  userId: string;
  fileId: string;
  newFilename: string;
}

export interface RenameFileResult {
  file_id: string;
  new_filename: string;
  new_remote_path: string;
  new_local_path: string | null;
  renamed_at: string;
}

// Rename just the filename, keeping the file in its current section/subpath
// and node. Computed by swapping the basename of remote_path so the location
// is preserved exactly (unlike moveFile, which is about relocation).
export async function renameFile(
  db: Client,
  a: RenameFileArgs,
): Promise<RenameFileResult> {
  const fn = a.newFilename;
  if (
    !fn ||
    fn.includes("/") ||
    fn.includes("\\") ||
    fn.includes("\0") ||
    fn === "." ||
    fn === ".."
  ) {
    throw new Error(`Invalid filename: ${a.newFilename}`);
  }

  const r = await db.execute({
    sql: "SELECT id, node_id, filename, remote_name, remote_path FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (r.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = r.rows[0];
  const nodeId = f.node_id as string;
  const oldFilename = f.filename as string;
  const remoteName = f.remote_name as string | null;
  const oldRemotePath = f.remote_path as string | null;
  if (!remoteName || !oldRemotePath) throw new Error(`File ${a.fileId} has no remote binding`);
  if (!oldRemotePath.endsWith(oldFilename)) {
    throw new Error(`Remote path ${oldRemotePath} does not end with ${oldFilename}`);
  }
  const newRemotePath = oldRemotePath.slice(0, oldRemotePath.length - oldFilename.length) + fn;

  let oldLocalPath: string | null = null;
  let newLocalPath: string | null = null;
  const mirrorRoot = await getMirrorPath(a.userId, nodeId);
  if (mirrorRoot) {
    try {
      const nodeRoot = buildNodeRoot(await resolveNodeInfo(db, nodeId));
      oldLocalPath = deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: oldRemotePath });
      newLocalPath = deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: newRemotePath });
    } catch {
      oldLocalPath = null;
      newLocalPath = null;
    }
  }

  const adapter = await getAdapter(db, remoteName);
  await adapter.rename(oldRemotePath, newRemotePath);

  if (oldLocalPath && newLocalPath && oldLocalPath !== newLocalPath) {
    try {
      await mkdir(dirname(newLocalPath), { recursive: true });
      await fsRename(oldLocalPath, newLocalPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE files SET filename = ?, remote_path = ?, updated_at = ? WHERE id = ?`,
    args: [fn, newRemotePath, now, a.fileId],
  });
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_rename', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.fileId,
      JSON.stringify({
        old_filename: oldFilename,
        new_filename: fn,
        old_remote_path: oldRemotePath,
        new_remote_path: newRemotePath,
      }),
      now,
    ],
  });

  return {
    file_id: a.fileId,
    new_filename: fn,
    new_remote_path: newRemotePath,
    new_local_path: newLocalPath,
    renamed_at: now,
  };
}
```

> Verify the import aliases used by `moveFile` match these names. From the extracted `moveFile` body this file already imports `getAdapter`, `getMirrorPath`, `resolveNodeInfo`, `buildNodeRoot`, `deriveLocalPath`, `ulid`, `mkdir`, `dirname`, and `rename` (used as `fsRename`). If `rename` is imported under a different local alias, use that alias. Do not add duplicate imports.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --import tsx --test test/sync-rename.test.ts`
Expected: PASS.

- [ ] **Step 5: Full backend test sweep + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS (this also greenlights Task 1.3's rename import).

- [ ] **Step 6: Commit**

```bash
git add src/domain/sync/engine-mutations.ts test/sync-rename.test.ts
git commit -m "feat(sync): renameFile -- rename filename, preserve section/subpath"
```

### Task 4.2: Delete endpoint behavior test (domain)

**Files:**
- Test: reuse existing `deleteFile` coverage; add an API-shape assertion only if needed.

- [ ] **Step 1: Confirm existing deleteFile coverage suffices**

`deleteFile` is already tested (`test/sync-engine-delete.test.ts`). The DELETE handler is a thin wrapper passing `mode: "complete"` + `confirmed` from the query. No new domain test required.

Run: `node --import tsx --test test/sync-engine-delete.test.ts`
Expected: PASS.

- [ ] **Step 2: (No commit — verification only.)**

### Task 4.3: Auto-adopt untracked files on sync (TDD)

**Files:**
- Modify: `src/api/nodes.ts` (`handleSyncRun`)
- Test: `test/sync-autoadopt.test.ts`

- [ ] **Step 1: Write a domain-level test proving the mechanism**

This verifies the exact composition the handler performs (discover → storeFile). Create `test/sync-autoadopt.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { storeFile } from "../src/domain/sync/engine.js";
import { listUntrackedLocal } from "../src/domain/sync/discover-local.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-adopt-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("auto-adopt composition", () => {
  it("discovers an untracked file and storeFile registers it", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "agent.md"), "written by agent");

    const before = await listUntrackedLocal(db, { userId: "U1", nodeId });
    assert.equal(before.length, 1);

    for (const u of before) {
      await storeFile(db, { userId: "U1", nodeId: u.node_id, localPath: u.local_path });
    }

    const after = await listUntrackedLocal(db, { userId: "U1", nodeId });
    assert.equal(after.length, 0); // now tracked
    const rows = await db.execute({
      sql: "SELECT filename FROM files WHERE node_id = ?",
      args: [nodeId],
    });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].filename, "agent.md");
  });
});
```

- [ ] **Step 2: Run to verify it passes (mechanism already exists)**

Run: `node --import tsx --test test/sync-autoadopt.test.ts`
Expected: PASS.

- [ ] **Step 3: Wire auto-adopt into `handleSyncRun`**

In `src/api/nodes.ts`, import `listUntrackedLocal` (already imported in Task 2.2). In `handleSyncRun`, after the existing `for (const e of [...scan.clean, ...scan.orphan, ...scan.native])` skipped-loop and BEFORE `respondJson(res, 200, result);`, add:

```ts
    // Deterministic registration: adopt any file the agent wrote to the
    // mirror but never registered. Each storeFile registers + pushes.
    const untracked = await listUntrackedLocal(db, { userId: SOLO_USER, nodeId });
    for (const u of untracked) {
      try {
        const sr = await storeFile(db, {
          userId: SOLO_USER,
          nodeId: u.node_id,
          localPath: u.local_path,
        });
        result.adopted.push({ file_id: sr.file_id, filename: u.filename });
      } catch (err) {
        result.errors.push({ file_id: "", filename: u.filename, error: String(err) });
      }
    }
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/nodes.ts test/sync-autoadopt.test.ts
git commit -m "feat(api): sync run auto-adopts untracked local files (deterministic registration)"
```

### Task 4.4: Surface "adopted" in the SyncBar

**Files:**
- Modify: `app/src/components/DetailPane.files.tsx` (`SyncBar` result block)

- [ ] **Step 1: Show adopted count**

In `SyncBar`'s result panel (the block rendering `result.pushed` / `result.pulled` / etc.), add after the `pulled` line:
```tsx
          {result.adopted.length > 0 && (
            <div>Zaregistrováno: {result.adopted.length} souborů</div>
          )}
```
And include `result.adopted.length === 0 &&` in the "Nic k synchronizaci." guard condition alongside the existing `pushed/pulled/conflicts/errors` checks.

- [ ] **Step 2: Typecheck + build**

Run: `npm --prefix app run build`
Expected: PASS.

- [ ] **Step 3: Manual verification (end-to-end determinism)**

Run the app. In a mirrored node's terminal, write a new `.md` into `wip/` without any MCP call. It appears in the tree as "neregistrováno" within ~5s. Click Synchronizovat → SyncBar reports "Zaregistrováno: 1", the badge disappears, the file is now tracked (and pushed to the remote).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/DetailPane.files.tsx
git commit -m "feat(app): SyncBar reports auto-adopted file count"
```

---

## Final verification

- [ ] **Backend QA gate**

Run: `npm run qa`
Expected: lint:strict + typecheck + all tests + build PASS.

- [ ] **Frontend build**

Run: `npm --prefix app run build`
Expected: PASS.

- [ ] **Manual end-to-end checklist (Vite at `http://portuni.test`)**
  - Workspace → mirrored node → Files tab → click `.md` → edits in right pane; Cmd+S saves.
  - ⤢ → fullscreen distraction-free; Minimize → back to pane; X → closes.
  - Edit the same file in a terminal while open → save → conflict banner → "Načíst jejich" reloads, "Ponechat moje" overwrites.
  - "+ Nový soubor" → creates, registers, opens it.
  - Rename / Smazat on a tracked row works (delete also removes remote + local).
  - Agent writes a file in the mirror (no MCP) → appears "neregistrováno" within ~5s → Synchronizovat adopts it.
  - File registered via MCP elsewhere → appears within ~5s without reselecting the node.

- [ ] **Open a PR** (only when the user asks):
```bash
git push -u origin feat/markdown-editor
gh pr create --fill
```

---

## Notes for the executor

- **Ordering caveat:** Task 1.3 imports `renameFile`, which is implemented in Task 4.1. Either implement Task 4.1 immediately before Task 1.3's Step 1, or accept a red typecheck for those two tasks until 4.1 lands. The plan's commits are otherwise independently green.
- **Save-local-only:** `PUT .../file` never pushes. After a save, the on-disk change is classified `push` by the *non-fast* scan; the UI sync-status is `fast` (cached), so the badge may lag until the next sync run updates `file_state`. This matches existing behavior — do not add a push to the save path.
- **No frontend test harness exists** (only `node:test` for backend). Frontend tasks are verified via `npm --prefix app run build` (tsc + vite) plus the manual checklist. Do not invent a frontend test runner.
- **`window.prompt`/`window.confirm`** are used for create/rename/delete to keep scope tight. They are acceptable in Tauri's webview; a custom modal can replace them later without backend changes.
