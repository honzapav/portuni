# Cluster B — Editor / File-Viewer Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three file/editor fixes — closing a file keeps you on the Soubory tab instead of bouncing to Přehled (úkol 9); an open file whose bytes change on disk surfaces a "changed on disk" banner with a one-click reload (úkol 2); and each file row can copy its link — local path always, Google Drive URL when synced (úkol 10).

**Architecture:** Mostly frontend (React) over the existing Node REST API, plus one new backend endpoint for the per-file Drive URL. úkol 9 reuses the file's existing module-cache pattern (`SYNC_STATUS_CACHE`) so the tab survives the DetailPane unmount that happens when the editor opens. úkol 2 adds a 5 s version poll to `useFileEditor` (consistent with the spec's "no watcher, poll" stance). úkol 10 copies `DetailFile.local_path` (already on the wire) and wires the already-implemented-but-uncalled `driveAdapter.url()` behind a new `GET /nodes/:id/file-url`.

**Tech Stack:** React 19, TypeScript, the Node REST backend (`src/api`), libSQL, `apiFetch` (Tauri command in desktop, Vite proxy in browser).

## Global Constraints

- **No emoji in code. Czech UI strings keep diacritics.**
- **No filesystem watcher** (markdown-editor spec non-goal). úkol 2 is a poll over the existing `GET /nodes/:id/file` `version` (sha256), never a watcher.
- **Save stays local-only**; úkol 2 only *notifies*, it never silently overwrites.
- **Drive URLs resolve server-side** (opaque ids) — the frontend never builds a Drive URL; it calls the endpoint.
- **Verification is browser Vite** (`varlock run -- npm --prefix app run dev`, open `http://portuni.test`): the editor/detail/files talk to the backend over REST and render fully in the browser (no desktop shell needed). Backend changes: `npm run build` + restart the `portuni-mcp` tmux server.
- Backend test: `npm test`. Frontend typecheck: `npm --prefix app run build`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `app/src/components/DetailPane.tsx` | Node detail + tab state | úkol 9: `TAB_CACHE` module map; init tab from it; persist on change (Task 1) |
| `app/src/lib/use-file-editor.ts` | Editor load/save/conflict state | úkol 2: `externalChange` flag + 5 s version poll (Task 2) |
| `app/src/components/EditorPane.tsx` | Editor shell + `EditorBody` banner | úkol 2: external-change banner + reload (Task 2) |
| `app/src/components/DetailPane.files.tsx` | File tree + `FileRow` + `TreeFile` | úkol 10: `local_path` on `TreeFile`; copy-path + copy-Drive-link buttons (Tasks 3, 4) |
| `src/api/nodes.ts` | Node REST handlers | úkol 10: `handleFileUrl` (Task 4) |
| `src/api/router.ts` | REST routing | úkol 10: register `/nodes/:id/file-url` (Task 4) |
| `src/auth/min-scopes.ts` | Per-route min scope | úkol 10: `read` for `file-url` (Task 4) |
| `app/src/api.ts` | Frontend REST client | úkol 10: `fetchNodeFileUrl` (Task 4) |

---

### Task 1: Keep the active tab across the editor open/close (úkol 9)

**Root cause:** opening a file swaps `DetailPane` → `EditorPane` in the same slot (`App.tsx:813-843` graph, `WorkspaceView.tsx:96-134` workspace), so `DetailPane` unmounts and its local `tab` state (`DetailPane.tsx:246-248`) is destroyed; on close it remounts and re-initializes to `"overview"`. Fix: persist the tab in a module-level cache keyed by node id — the exact pattern the file already uses for `SYNC_STATUS_CACHE` (`DetailPane.tsx:92`), which exists for this same "survive remount" reason.

**Files:**
- Modify: `app/src/components/DetailPane.tsx` (cache near line 92; tab init line 246-248; reset line 283; tab buttons lines 680/685/691/699)

- [ ] **Step 1: Add a `DetailTab` type + `TAB_CACHE` next to `SYNC_STATUS_CACHE`**

In `app/src/components/DetailPane.tsx`, right after `const SYNC_STATUS_CACHE = new Map<string, Map<string, SyncStatusFile>>();` (line 92), add:

```ts
type DetailTab = "overview" | "events" | "files" | "connections";
// Survives the DetailPane unmount that happens when the editor takes over
// the right slot (Option C). Without this, closing a file remounts the
// pane and resets the tab to "overview" -- the bug in úkol 9.
const TAB_CACHE = new Map<string, DetailTab>();
```

- [ ] **Step 2: Initialize the tab from the cache**

Replace the tab state (lines 246-248):

```ts
  const [tab, setTab] = useState<
    "overview" | "events" | "files" | "connections"
  >("overview");
```

with:

```ts
  const [tab, setTabState] = useState<DetailTab>(
    () => TAB_CACHE.get(node.id) ?? "overview",
  );
  // Wrap setTab so the choice is remembered across an editor open/close
  // (which unmounts this pane). Keyed by node id.
  const setTab = useCallback(
    (t: DetailTab) => {
      TAB_CACHE.set(node.id, t);
      setTabState(t);
    },
    [node.id],
  );
```

(`useCallback` is already imported in this file — it is used elsewhere in DetailPane. If a lint run reports it missing, add it to the existing `react` import.)

- [ ] **Step 3: Make the node-switch reset write through the cache**

In the reset effect, replace `setTab("overview");` (line 283) with:

```ts
      TAB_CACHE.set(node.id, "overview");
      setTabState("overview");
```

(Using `setTabState` here, not `setTab`, is equivalent — both now write the cache — but spelling it out keeps the reset self-contained. A real node switch resets to Přehled; the editor open/close does NOT change `node.id`, so it never hits this branch.)

- [ ] **Step 4: Typecheck**

Run: `npm --prefix app run build`
Expected: tsc passes. The four tab buttons (lines 680-699) already call `setTab(...)`, which now persists; no change needed there.

- [ ] **Step 5: Verify in the browser**

Start `varlock run -- npm --prefix app run dev`, open `http://portuni.test`. Select a node, open the **Soubory** tab, open a markdown file, then click **← zpět** to close it. Confirm you land back on **Soubory**, not **Přehled**. Switch to a different node and confirm it still opens on **Přehled** (reset on real node switch). (Fixes úkol 9.)

- [ ] **Step 6: Commit**

```bash
git add app/src/components/DetailPane.tsx
git commit -m "fix(detail): keep active tab across editor open/close (TAB_CACHE)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: "Changed on disk" notification for the open file (úkol 2)

**Files:**
- Modify: `app/src/lib/use-file-editor.ts` (add `externalChange` state + poll effect; clear it on load/save/reload; expose it)
- Modify: `app/src/components/EditorPane.tsx` (banner in `EditorBody`, lines 92-104)

**Interfaces:**
- Produces: `FileEditor.externalChange: boolean` (true when the on-disk `version` moved past the loaded one).

- [ ] **Step 1: Add `externalChange` state + clear it on load**

In `app/src/lib/use-file-editor.ts`, add the state after `conflict` (line 19):

```ts
  const [externalChange, setExternalChange] = useState(false);
```

In the load effect's `.then` (after `setStatus({ kind: "ready" })`, line 35), add:

```ts
        setExternalChange(false);
```

- [ ] **Step 2: Clear it on save success and on reloadTheirs**

In `doSave`, in the success path (after `setConflict(null);`, line 64), add:

```ts
        setExternalChange(false);
```

In `reloadTheirs` (after `setConflict(null);`, line 86), add:

```ts
        setExternalChange(false);
```

- [ ] **Step 3: Add the poll effect**

After the `reloadTheirs` callback (after line 87), add:

```ts
  // Poll the on-disk version while a file is open. The backend's GET
  // returns the sha256 `version`; if it moved past what we loaded, the
  // file changed underneath us (an agent edit, a sync pull). We only
  // FLAG it -- never silently swap content -- mirroring the save-time
  // conflict UX. Paused when the tab is hidden. 5 s matches App's
  // node-detail poll (App.tsx:492-509).
  useEffect(() => {
    if (nodeId == null || relPath == null || version == null) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      fetchFileContent(nodeId, relPath)
        .then((r) => {
          if (r.version !== version) setExternalChange(true);
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [nodeId, relPath, version]);
```

- [ ] **Step 4: Expose `externalChange`**

In the hook's return object (lines 89-99), add `externalChange,` (e.g. after `conflict,`):

```ts
    conflict,
    externalChange,
    keepMine,
    reloadTheirs,
```

- [ ] **Step 5: Surface it in the editor banner**

In `app/src/components/EditorPane.tsx`, inside `EditorBody`, immediately after the `{ed.conflict && (...)}` block (after line 104), add:

```tsx
      {!ed.conflict && ed.externalChange && (
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-3 py-2 text-[12.5px] text-[var(--color-text)]">
          <span>Soubor se na disku změnil.</span>
          <button onClick={ed.reloadTheirs} className="underline hover:no-underline">
            Načíst aktuální verzi
          </button>
        </div>
      )}
```

- [ ] **Step 6: Typecheck**

Run: `npm --prefix app run build`
Expected: tsc passes (`FileEditor` now carries `externalChange`).

- [ ] **Step 7: Verify in the browser**

With the backend running and Vite open: open a markdown file in the editor (Náhled mode). In a terminal, append a line to that file in the mirror on disk (or have an agent edit it). Within ~5 s the "Soubor se na disku změnil." banner appears; click **Načíst aktuální verzi** and confirm the new content loads and the banner clears. (Fixes úkol 2.)

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/use-file-editor.ts app/src/components/EditorPane.tsx
git commit -m "feat(editor): notify when the open file changes on disk (poll)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Copy the file's local path (úkol 10, local half)

**Files:**
- Modify: `app/src/components/DetailPane.files.tsx` (`TreeFile` type line 38-44; `toTreeFiles` lines 86-108; a `CopyPathButton` + its placement in `FileRow` line 455-548)

**Interfaces:**
- Consumes: `DetailFile.local_path` and `UntrackedFile.local_path` (both already on the wire).

- [ ] **Step 1: Add `local_path` to the unified `TreeFile` model**

In `app/src/components/DetailPane.files.tsx`, add to `TreeFile` (after line 43):

```ts
type TreeFile = {
  relative_path: string;
  filename: string;
  description: string | null;
  mime_type: string | null;
  fileId: string | null; // null = untracked (not in `files`)
  local_path: string | null;
};
```

In `toTreeFiles`, carry `local_path` for both branches:

```ts
  for (const u of untracked) {
    byPath.set(u.relative_path, {
      relative_path: u.relative_path,
      filename: u.filename,
      description: null,
      mime_type: u.mime_type,
      fileId: null,
      local_path: u.local_path,
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
      local_path: f.local_path,
    });
  }
```

- [ ] **Step 2: Add a `CopyPathButton` component**

In `app/src/components/DetailPane.files.tsx`, just above `function FileRow(` (line 393), add:

```tsx
// Click-to-copy with a brief check confirmation. stopPropagation so the
// click doesn't also open/select the file row.
function CopyPathButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}
```

(`Check` and `Copy` are already imported at the top of this file, lines 9 and 12.)

- [ ] **Step 3: Render it in `FileRow`**

In `FileRow`'s action area, add the copy-path button so it shows on hover for every file (registered or untracked). Insert it right before the `{sync && <SyncStatusBadge .../>}` line (line 493) is fine, but to group it with the row actions, place it at the start of the hover cluster. Add this just after the filename `</button>`/rename input block closes (after line 492):

```tsx
          {f.local_path && (
            <span className="opacity-0 group-hover:opacity-100">
              <CopyPathButton value={f.local_path} title="Kopírovat cestu k souboru" />
            </span>
          )}
```

- [ ] **Step 4: Typecheck**

Run: `npm --prefix app run build`
Expected: tsc passes (`UntrackedFile` and `DetailFile` both have `local_path`; if tsc reports `local_path` missing on either, that field is in `src/shared/api-types.ts` — confirm it's exported on both types).

- [ ] **Step 5: Verify in the browser**

Open the Soubory tab, hover a file, click the copy icon, paste somewhere — confirm the absolute on-disk path is copied. (Fixes úkol 10, local half.)

- [ ] **Step 6: Commit**

```bash
git add app/src/components/DetailPane.files.tsx
git commit -m "feat(files): copy a file's local path from the file row" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Copy the file's Google Drive link (úkol 10, Drive half)

**Root cause / opportunity:** `driveAdapter.url(path)` already returns `https://drive.google.com/file/d/<id>/view` (`src/domain/sync/drive-adapter.ts:257-261`) but has **no caller** — there is no per-file URL endpoint. We add one by cloning `handleFolderUrl` (`src/api/nodes.ts:331-399`).

**Files:**
- Modify: `src/api/nodes.ts` (add `handleFileUrl`)
- Modify: `src/api/router.ts` (register the route inside `routeNodes`, next to the folder-url match at line 400)
- Modify: `src/auth/min-scopes.ts` (line 115 sibling)
- Modify: `app/src/api.ts` (add `fetchNodeFileUrl`)
- Modify: `app/src/components/DetailPane.files.tsx` (thread `nodeId` to `FileRow`; add a Drive-link copy button)

**Interfaces:**
- Produces: `GET /nodes/:id/file-url?file_id=<id>` → `{ url: string | null, remote_name?: string, reason?: string }` (same shape as folder-url).
- Produces: `fetchNodeFileUrl(id: string, fileId: string): Promise<FolderUrlResponse>`.

- [ ] **Step 1: Add the backend handler**

In `src/api/nodes.ts`, immediately after `handleFolderUrl` (after line 399), add. It reuses the same imports `handleFolderUrl` already uses (`getDb`, `nodeVisibleTo`, `respondJson`, `respondError`, `resolveRemote`, `getAdapter`):

```ts
// Browser-openable URL of a single file on its routed remote. Mirrors
// handleFolderUrl but resolves the FILE's remote_path and calls
// adapter.url() (which handleFolderUrl's folderUrl() sibling does not).
// Returns { url: null, reason } when the file has no remote_path (not
// synced), no remote is routed, or the adapter can't produce a web URL.
export async function handleFileUrl(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const url = new URL(req.url ?? "", "http://internal");
    const fileId = url.searchParams.get("file_id");
    if (!fileId) {
      respondJson(res, 400, { error: "file_id query param required" });
      return;
    }
    const fileRow = await db.execute({
      sql: "SELECT remote_path FROM files WHERE id = ? AND node_id = ?",
      args: [fileId, nodeId],
    });
    if (fileRow.rows.length === 0) {
      respondJson(res, 404, { error: "file not found" });
      return;
    }
    const remotePath = fileRow.rows[0].remote_path as string | null;
    if (!remotePath) {
      respondJson(res, 200, { url: null, reason: "file not synced yet" });
      return;
    }
    // Resolve the node's routed remote (same resolution as folder-url).
    const nodeRow = await db.execute({
      sql: "SELECT type, sync_key FROM nodes WHERE id = ?",
      args: [nodeId],
    });
    if (nodeRow.rows.length === 0) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const nodeType = nodeRow.rows[0].type as string;
    const nodeSyncKey = nodeRow.rows[0].sync_key as string;
    let orgSyncKey: string | null = nodeSyncKey;
    if (nodeType !== "organization") {
      const orgRow = await db.execute({
        sql: `SELECT o.sync_key FROM edges e
              JOIN nodes o ON o.id = e.target_id
              WHERE e.source_id = ? AND e.relation = 'belongs_to'
              LIMIT 1`,
        args: [nodeId],
      });
      if (orgRow.rows.length === 0) {
        respondJson(res, 200, { url: null, reason: "no organization" });
        return;
      }
      orgSyncKey = orgRow.rows[0].sync_key as string;
    }
    const remoteName = await resolveRemote(db, nodeType, orgSyncKey);
    if (!remoteName) {
      respondJson(res, 200, { url: null, reason: "no remote routed" });
      return;
    }
    const adapter = await getAdapter(db, remoteName);
    let fileUrl: string | null = null;
    try {
      fileUrl = await adapter.url(remotePath);
    } catch {
      // Adapter can't resolve a web URL (e.g. fs/sftp, or not synced).
      fileUrl = null;
    }
    respondJson(res, 200, {
      url: fileUrl,
      remote_name: remoteName,
      ...(fileUrl === null ? { reason: "no web URL for this file" } : {}),
    });
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/file-url`, err);
  }
}
```

- [ ] **Step 2: Register the route**

In `src/api/router.ts`, inside `routeNodes`, right after the folder-url block (line 400 `const folderUrlMatch = pathname.match(/^\/nodes\/([^/]+)\/folder-url$/);` and its handler call), add a sibling. Mirror exactly how `folderUrlMatch` dispatches (find the 2-3 lines that call `handleFolderUrl(req, res, identity, folderUrlMatch[1])` and copy their shape):

```ts
  const fileUrlMatch = pathname.match(/^\/nodes\/([^/]+)\/file-url$/);
  if (fileUrlMatch && req.method === "GET") {
    await handleFileUrl(req, res, identity, fileUrlMatch[1]);
    return true;
  }
```

Add `handleFileUrl` to the existing `import { ... } from "./nodes.js"` group at the top of `router.ts` (next to `handleFolderUrl`).

- [ ] **Step 3: Add the min-scope**

In `src/auth/min-scopes.ts`, after line 115, add the sibling:

```ts
  if (/^\/nodes\/[^/]+\/file-url$/.test(pathname) && m === "GET") return "read";
```

- [ ] **Step 4: Add the frontend client**

In `app/src/api.ts`, after `fetchNodeFolderUrl` (after line 78), add:

```ts
export async function fetchNodeFileUrl(
  id: string,
  fileId: string,
): Promise<FolderUrlResponse> {
  const res = await apiFetch(
    `/nodes/${encodeURIComponent(id)}/file-url?file_id=${encodeURIComponent(fileId)}`,
  );
  await throwForStatus(res, "file-url");
  return res.json();
}
```

- [ ] **Step 5: Build + restart the backend**

Run:
```bash
npm run build
tmux send-keys -t portuni-mcp C-c Up Enter
```
Expected: clean restart. Smoke the route (unknown file → 404, proves wiring):
```bash
curl -s -H "Authorization: Bearer $PORTUNI_MCP_TOKEN" "http://127.0.0.1:4011/nodes/SOME_NODE_ID/file-url?file_id=does-not-exist" | head
```
Expected: `{"error":"file not found"}` (or `{"error":"node not found"}` if the node id is wrong). (`handleFolderUrl` itself has no unit test; this endpoint mirrors it, so its real-Drive path is verified manually in Step 7.)

- [ ] **Step 6: Add the Drive-link button in `FileRow`**

In `app/src/components/DetailPane.files.tsx`:

(a) Import the client + an icon. Add to the lucide import (line 8-18) `Link2` and to the `../api` import (line 29) `fetchNodeFileUrl`:

```ts
import { createNodeMirror, fetchNodeFileUrl } from "../api";
```
(and add `Link2,` to the `lucide-react` import block.)

(b) Thread `nodeId` to `FileRow` exactly where `syncStatus` is already threaded. `syncStatus` flows `DetailPaneBody → FileTree → FileTreeNode → FileRow`; add a `nodeId: string` prop beside it in each of those three components' prop types and pass-throughs, and pass `node.id` from `DetailPaneBody` where it already passes `syncStatus`.

(c) Add the button component above `FileRow` (next to `CopyPathButton`):

```tsx
// Fetches the file's Drive URL on demand (server resolves the opaque id)
// and copies it. Only meaningful for registered, synced files.
function CopyDriveLinkButton({ nodeId, fileId }: { nodeId: string; fileId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "none">("idle");
  return (
    <button
      type="button"
      title={state === "none" ? "Soubor zatím není na Disku" : "Kopírovat odkaz na Disk"}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          const r = await fetchNodeFileUrl(nodeId, fileId);
          if (r.url) {
            await navigator.clipboard.writeText(r.url);
            setState("copied");
          } else {
            setState("none");
          }
        } catch {
          setState("none");
        }
        setTimeout(() => setState("idle"), 1500);
      }}
      className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
    >
      {state === "copied" ? <Check size={11} /> : <Link2 size={11} />}
    </button>
  );
}
```

(d) Render it next to `CopyPathButton` in `FileRow`, but only for registered files (`f.fileId`):

```tsx
          {f.fileId && (
            <span className="opacity-0 group-hover:opacity-100">
              <CopyDriveLinkButton nodeId={nodeId} fileId={f.fileId} />
            </span>
          )}
```

- [ ] **Step 7: Typecheck + verify in the browser**

Run: `npm --prefix app run build` (tsc passes).
Then, for a node routed to a Google Drive remote with a synced file: hover the file row, click the Drive-link icon, and confirm a `https://drive.google.com/file/d/.../view` URL is copied (opens the file in Drive). For an unsynced/fs-routed file the icon's title shows "Soubor zatím není na Disku" and nothing is copied. (Fixes úkol 10, Drive half.)

- [ ] **Step 8: Commit**

```bash
git add src/api/nodes.ts src/api/router.ts src/auth/min-scopes.ts app/src/api.ts app/src/components/DetailPane.files.tsx
git commit -m "feat(files): per-file Drive link endpoint + copy-link button" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Cluster B of the design spec):**
- Úkol 9 (close file → wrong tab): Task 1 (`TAB_CACHE` survives the unmount). ✓
- Úkol 2 (external change not notified): Task 2 (version poll + banner + reload). ✓
- Úkol 10 (copy link, local + Drive): Task 3 (local path) + Task 4 (Drive endpoint + button). ✓
- "No watcher, poll-based": Task 2 uses a 5 s poll over `version`. ✓
- "Drive URL resolves server-side; `adapter.url()` was dead code": Task 4 wires it behind a new endpoint. ✓

**Placeholder scan:** Every code step shows full code. The one "follow the existing pattern" instruction (Task 4 Step 6b, threading `nodeId` like `syncStatus`) names the exact existing prop to mirror and the exact component chain — it is a precise instruction, not a TODO. ✓

**Type consistency:** `TreeFile.local_path: string | null` set in both `toTreeFiles` branches and read in `FileRow`. `fetchNodeFileUrl` returns `FolderUrlResponse` (reused), matching `handleFileUrl`'s `{ url, remote_name?, reason? }`. `FileEditor.externalChange` added in the hook return and consumed in `EditorBody`. `handleFileUrl` signature matches `handleFolderUrl`'s `(req, res, identity, nodeId)`. ✓

**Known scope notes (no silent gaps):** Task 4's endpoint mirrors the untested `handleFolderUrl`; its real-Drive path is verified manually (Step 7), its wiring by the 404 smoke (Step 5). Threading `nodeId` (Step 6b) touches `FileTree`/`FileTreeNode` whose bodies aren't reproduced here — the instruction is "mirror `syncStatus`", an existing identical prop.
