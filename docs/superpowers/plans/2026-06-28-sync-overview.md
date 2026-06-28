# Unsynced Overview + Quit Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Portuni a single place that shows everything not yet synced to a remote, with one-click sync from there, and warn on app quit if local work is unsynced (Asana task 1215907170556844).

**Architecture (approved design — PASSIVE):** Today sync status is computed only for the open node (`handleSyncStatus` → `statusScan` for one node). Add one new primitive — a cross-mirror aggregate (`listUserMirrors` → `statusScan` per mirror, `fast:true` + `includeDiscovery:true`) exposed as `GET /sync/pending`. Three passive surfaces consume it: (1) a persistent badge in `StatusFooter` ("↑ N nesynced"), (2) a `SyncOverview` modal listing pending nodes with per-node "Synchronizovat" (reuses `handleSyncRun`) + "Synchronizovat vše", (3) an extension of the existing app-close guard so Cmd+Q warns when there's unsynced work. NO modal/toast on node switch — the badge is the always-on indicator; the hard stop is only at quit, where data actually leaves scope.

**Tech Stack:** Node/TS backend (`src/api`, `src/domain/sync`), libSQL, React 19/TS frontend, Tauri window close API.

## Global Constraints

- **"Unsynced" = local work not on the remote:** `push_candidates` + `conflicts` + `new_local` (untracked) + `orphan` + `deleted_local`. Pull candidates / `new_remote` are INCOMING — excluded from the pending count and the quit warning (different action, no data-loss risk).
- **Scan is best-effort + cheap:** `fast:true` (DB-cache for tracked classification) + `includeDiscovery:true` (name-only fs walk for untracked). A mirror that fails to scan is skipped, never breaks the overview. On-demand + a light interval/focus refresh, paused when `document.hidden` — never continuous, never blocking.
- **Reuse, don't reinvent:** per-node sync uses the existing `POST /nodes/:id/sync` (`handleSyncRun` / `runNodeSync`); "Synchronizovat vše" loops it client-side (per-node progress, no new server endpoint).
- **Passive only:** no interrupt on node switch. The only hard interrupt is the quit guard.
- **No emoji in code; Czech UI strings keep diacritics.**
- Backend test: `npm test`. Builds: `npm run build` (backend), `npm --prefix app run build` (frontend). Verification of the UI surfaces needs the desktop app (`cargo tauri dev`) — deferred to the user.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/domain/sync/pending.ts` | Cross-mirror aggregate (testable) | Create: `computeSyncPending(db, userId)` (Task 1) |
| `src/api/nodes.ts` | Node/sync REST handlers | Add thin `handleSyncPending` wrapper (Task 1) |
| `src/api/router.ts` | Routing | Register `GET /sync/pending` in `routeSystem` (Task 1) |
| `src/auth/min-scopes.ts` | Per-route scope | `read` for `/sync/pending` (Task 1) |
| `src/shared/api-types.ts` | Shared types | `SyncPendingNode` + `SyncPendingResponse` (Task 1) |
| `app/src/api.ts` | REST client | `fetchSyncPending` (Task 1) |
| `test/sync-pending.test.ts` | Coverage | Create (Task 1) |
| `app/src/lib/use-sync-pending.ts` | Polling hook | Create (Task 2) |
| `app/src/components/StatusFooter.tsx` | Footer badge | "↑ N nesynced" button (Task 2) |
| `app/src/components/SyncOverview.tsx` | Overview modal | Create (Task 3) |
| `app/src/App.tsx` | Owns state + close guard | Wire hook/footer/overview (Tasks 2-3); extend quit guard (Task 4) |

---

### Task 1: `GET /sync/pending` aggregate endpoint (TDD)

**Files:** Create `src/domain/sync/pending.ts`, `test/sync-pending.test.ts`; modify `src/shared/api-types.ts`, `src/api/nodes.ts`, `src/api/router.ts`, `src/auth/min-scopes.ts`, `app/src/api.ts`.

**Interfaces:**
- Produces: `computeSyncPending(db: Client, userId: string): Promise<SyncPendingResponse>` and `GET /sync/pending → SyncPendingResponse`.
- `SyncPendingNode = { node_id, node_name, node_type, push, conflict, untracked, orphan, deleted_local, total }`; `SyncPendingResponse = { nodes: SyncPendingNode[]; total: number }`.

- [ ] **Step 1: Add the shared types**

In `src/shared/api-types.ts`, after `SyncRunResponse` (~line 154), add:

```ts
// Cross-mirror "what is not yet on a remote" aggregate, per node. Only the
// local-not-on-remote classes count (push/conflict/untracked/orphan/deleted);
// incoming pull candidates are excluded.
export type SyncPendingNode = {
  node_id: string;
  node_name: string;
  node_type: string;
  push: number;
  conflict: number;
  untracked: number;
  orphan: number;
  deleted_local: number;
  total: number;
};
export type SyncPendingResponse = {
  nodes: SyncPendingNode[]; // only nodes with total > 0, sorted by total desc
  total: number;            // sum of every node's total
};
```

- [ ] **Step 2: Write the failing test**

Create `test/sync-pending.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { setDbForTesting } from "../src/infra/db.js";
import { SOLO_USER } from "../src/infra/schema.js";
import { computeSyncPending } from "../src/domain/sync/pending.js";
import { makeSharedDb } from "./helpers/shared-db.js";

let workspace: string;
let originalRoot: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-pending-"));
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});
afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
  await rm(workspace, { recursive: true, force: true });
});

describe("computeSyncPending", () => {
  it("reports a node with an untracked local file as pending", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirror = join(workspace, "mirror-p");
    await mkdir(join(mirror, "wip"), { recursive: true });
    await writeFile(join(mirror, "wip", "draft.md"), "# unsynced\n");
    await registerMirror(SOLO_USER, shared.nodeId, mirror);

    const r = await computeSyncPending(shared.db, SOLO_USER);

    const node = r.nodes.find((n) => n.node_id === shared.nodeId);
    assert.ok(node, "node with the untracked file must appear");
    assert.ok(node.untracked >= 1, "the untracked draft must be counted");
    assert.ok(node.total >= 1);
    assert.ok(r.total >= 1);
  });

  it("returns an empty aggregate when nothing is pending", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirror = join(workspace, "mirror-clean");
    await mkdir(join(mirror, "wip"), { recursive: true });
    await registerMirror(SOLO_USER, shared.nodeId, mirror);

    const r = await computeSyncPending(shared.db, SOLO_USER);
    assert.deepEqual(r, { nodes: [], total: 0 });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test test/sync-pending.test.ts`
Expected: FAIL — `src/domain/sync/pending.js` / `computeSyncPending` does not exist.

- [ ] **Step 4: Implement `computeSyncPending`**

Create `src/domain/sync/pending.ts`:

```ts
// Cross-mirror aggregate of local work that is not yet on a remote. Powers
// the global "unsynced overview" and the quit guard. Best-effort: a mirror
// that fails to scan is skipped, never aborts the whole aggregate.
import type { Client } from "@libsql/client";
import { listUserMirrors } from "./mirror-registry.js";
import { statusScan } from "./engine.js";
import type { SyncPendingNode, SyncPendingResponse } from "../../shared/api-types.js";

export async function computeSyncPending(
  db: Client,
  userId: string,
): Promise<SyncPendingResponse> {
  const mirrors = await listUserMirrors(userId);
  const nodes: SyncPendingNode[] = [];
  for (const m of mirrors) {
    let scan;
    try {
      scan = await statusScan(db, {
        userId,
        nodeId: m.node_id,
        includeDiscovery: true,
        fast: true,
      });
    } catch {
      continue; // unscannable mirror — skip, don't break the overview
    }
    const push = scan.push_candidates.length;
    const conflict = scan.conflicts.length;
    const untracked = scan.new_local.length;
    const orphan = scan.orphan.length;
    const deleted_local = scan.deleted_local.length;
    const total = push + conflict + untracked + orphan + deleted_local;
    if (total === 0) continue;
    const row = await db.execute({
      sql: "SELECT name, type FROM nodes WHERE id = ?",
      args: [m.node_id],
    });
    if (row.rows.length === 0) continue; // mirror for a deleted node — skip
    nodes.push({
      node_id: m.node_id,
      node_name: row.rows[0].name as string,
      node_type: row.rows[0].type as string,
      push,
      conflict,
      untracked,
      orphan,
      deleted_local,
      total,
    });
  }
  nodes.sort((a, b) => b.total - a.total);
  const total = nodes.reduce((s, n) => s + n.total, 0);
  return { nodes, total };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/sync-pending.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the HTTP handler + route + scope + client**

In `src/api/nodes.ts`, add (near `handleSyncStatus`; reuse its existing imports `getDb`, `respondJson`, `respondError`, and add `computeSyncPending` import from `../domain/sync/pending.js`):

```ts
export async function handleSyncPending(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const result = await computeSyncPending(getDb(), identity.userId);
    respondJson(res, 200, result);
  } catch (err) {
    respondError(res, `${req.method} /sync/pending`, err);
  }
}
```

In `src/api/router.ts`: add `handleSyncPending` to the import from `./nodes.js`, and in `routeSystem` (next to the other top-level GETs) add:

```ts
  if (pathname === "/sync/pending" && method === "GET") {
    await handleSyncPending(req, res, identity);
    return true;
  }
```

In `src/auth/min-scopes.ts`, with the other route scopes:

```ts
  if (pathname === "/sync/pending" && m === "GET") return "read";
```

In `app/src/api.ts`, add (next to `fetchNodeSyncStatus`), importing `SyncPendingResponse` from the shared types alongside the existing imports:

```ts
export async function fetchSyncPending(): Promise<SyncPendingResponse> {
  const res = await apiFetch(`/sync/pending`);
  await throwForStatus(res, "sync-pending");
  return res.json();
}
```

- [ ] **Step 7: Verify backend build + full suite**

Run: `npm run build` (tsc clean) and `node --import tsx --test test/sync-pending.test.ts` (PASS). Then `npm test` to confirm no regression.

- [ ] **Step 8: Commit**

```bash
git add src/domain/sync/pending.ts test/sync-pending.test.ts src/shared/api-types.ts src/api/nodes.ts src/api/router.ts src/auth/min-scopes.ts app/src/api.ts
git commit -m "feat(sync): GET /sync/pending cross-mirror unsynced aggregate" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `useSyncPending` hook + footer badge

**Files:** Create `app/src/lib/use-sync-pending.ts`; modify `app/src/components/StatusFooter.tsx`, `app/src/App.tsx`.

**Interfaces:**
- Produces: `useSyncPending(): { pending: SyncPendingResponse; refresh: () => void }` (pending defaults to `{ nodes: [], total: 0 }`).
- `StatusFooter` gains props `pendingCount: number` and `onOpenSyncOverview: () => void`.

- [ ] **Step 1: Create the hook**

Create `app/src/lib/use-sync-pending.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { fetchSyncPending } from "../api";
import type { SyncPendingResponse } from "../types";

const EMPTY: SyncPendingResponse = { nodes: [], total: 0 };

// Polls the cross-mirror unsynced aggregate. On mount, every 30s (paused
// when the tab is hidden), and on window focus. Cheap (fast + name-only
// discovery server-side); failures keep the last good value.
export function useSyncPending() {
  const [pending, setPending] = useState<SyncPendingResponse>(EMPTY);

  const refresh = useCallback(() => {
    fetchSyncPending()
      .then(setPending)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 30000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { pending, refresh };
}
```

(If `SyncPendingResponse` is not re-exported from `app/src/types.ts`, import it from the shared types path used elsewhere in `app/src/api.ts`; check how `SyncStatusResponse` is imported and mirror it.)

- [ ] **Step 2: Add the footer badge**

In `app/src/components/StatusFooter.tsx`, extend `Props`:

```ts
type Props = {
  onOpenSettings: () => void;
  sessionCount: number;
  onOpenWorkspace: () => void;
  pendingCount: number;
  onOpenSyncOverview: () => void;
};
```

Destructure `pendingCount` and `onOpenSyncOverview`, and after the `sessionCount` button (after line 66) add:

```tsx
      {pendingCount > 0 && (
        <button
          type="button"
          title={`Nesynchronizováno: ${pendingCount} souborů`}
          onClick={onOpenSyncOverview}
          className="ml-3 flex items-center gap-2 rounded px-2 py-0.5 transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
        >
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-amber-500" />
          <span className="font-mono">↑ {pendingCount} nesynced</span>
        </button>
      )}
```

- [ ] **Step 3: Wire it in App**

In `app/src/App.tsx`: call `const { pending: syncPending, refresh: refreshSyncPending } = useSyncPending();` (import the hook). Add state `const [syncOverviewOpen, setSyncOverviewOpen] = useState(false);`. Pass to `StatusFooter` (line 859-863): `pendingCount={syncPending.total}` and `onOpenSyncOverview={() => setSyncOverviewOpen(true)}`.

- [ ] **Step 4: Verify + commit**

Run: `npm --prefix app run build` (tsc passes). Commit:

```bash
git add app/src/lib/use-sync-pending.ts app/src/components/StatusFooter.tsx app/src/App.tsx
git commit -m "feat(sync): unsynced count badge in the status footer" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `SyncOverview` panel

**Files:** Create `app/src/components/SyncOverview.tsx`; modify `app/src/App.tsx`.

**Interfaces:** `SyncOverview({ pending, onClose, onMutated, onSelectNode })` — `pending: SyncPendingResponse`, `onMutated: () => void` (re-fetch the aggregate + graph after a sync), `onSelectNode: (id: string) => void` (jump to a node).

- [ ] **Step 1: Create the component**

Create `app/src/components/SyncOverview.tsx`:

```tsx
// Global "unsynced" overview. Lists every node with local work not yet on a
// remote, with one-click per-node sync and a sync-all. Reuses the per-node
// POST /nodes/:id/sync (runNodeSync). Opened from the StatusFooter badge.
import { useState } from "react";
import { X, RefreshCw, Loader2 } from "lucide-react";
import type { SyncPendingResponse } from "../types";
import { runNodeSync } from "../api";

export default function SyncOverview({
  pending,
  onClose,
  onMutated,
  onSelectNode,
}: {
  pending: SyncPendingResponse;
  onClose: () => void;
  onMutated: () => void;
  onSelectNode: (id: string) => void;
}) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [allBusy, setAllBusy] = useState(false);

  const syncOne = async (nodeId: string) => {
    setBusy((b) => new Set(b).add(nodeId));
    try {
      await runNodeSync(nodeId);
      onMutated();
    } catch {
      /* per-node failure is surfaced by the refreshed aggregate */
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(nodeId);
        return n;
      });
    }
  };

  const syncAll = async () => {
    setAllBusy(true);
    try {
      for (const n of pending.nodes) {
        try {
          await runNodeSync(n.node_id);
        } catch {
          /* keep going; refreshed aggregate shows what remains */
        }
      }
      onMutated();
    } finally {
      setAllBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[560px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <div className="text-[14.5px] font-semibold text-[var(--color-text)]">
            Nesynchronizováno
          </div>
          <span className="font-mono text-[12px] text-[var(--color-text-dim)]">
            {pending.total} souborů
          </span>
          <span className="flex-1" />
          {pending.nodes.length > 0 && (
            <button
              type="button"
              onClick={syncAll}
              disabled={allBusy}
              className="flex items-center gap-1 rounded-md border border-[var(--color-accent-dim)] px-3 py-1 text-[12.5px] text-[var(--color-accent)] hover:bg-[var(--color-surface)] disabled:opacity-50"
            >
              {allBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Synchronizovat vše
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Zavřít"
            className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {pending.nodes.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-[var(--color-text-dim)]">
              Všechno je synchronizované.
            </div>
          ) : (
            pending.nodes.map((n) => {
              const isBusy = busy.has(n.node_id) || allBusy;
              return (
                <div
                  key={n.node_id}
                  className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-[var(--color-surface)]"
                >
                  <button
                    type="button"
                    onClick={() => onSelectNode(n.node_id)}
                    className="min-w-0 flex-1 truncate text-left text-[13.5px] text-[var(--color-text)] hover:underline"
                    title="Přejít na uzel"
                  >
                    {n.node_name}
                  </button>
                  <span className="font-mono text-[11.5px] text-[var(--color-text-dim)]">
                    {n.push > 0 && <span title="Ke pushnutí">↑{n.push} </span>}
                    {n.untracked > 0 && <span title="Neregistrováno">◯{n.untracked} </span>}
                    {n.conflict > 0 && (
                      <span className="text-[var(--color-danger)]" title="Konflikt">⚠{n.conflict} </span>
                    )}
                    {n.orphan > 0 && <span title="Orphan">⊘{n.orphan} </span>}
                    {n.deleted_local > 0 && <span title="Smazáno lokálně">␡{n.deleted_local} </span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => syncOne(n.node_id)}
                    disabled={isBusy}
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    Synchronizovat
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render it from App**

In `app/src/App.tsx`, render the overlay (next to the `editorGuard` overlay, ~line 914) when `syncOverviewOpen`:

```tsx
      {syncOverviewOpen && (
        <SyncOverview
          pending={syncPending}
          onClose={() => setSyncOverviewOpen(false)}
          onMutated={() => {
            refreshSyncPending();
            refetchAll().catch(() => undefined);
          }}
          onSelectNode={(id) => {
            setSyncOverviewOpen(false);
            setSelectedId(id);
          }}
        />
      )}
```

Import `SyncOverview`. (`refetchAll` and `setSelectedId` already exist in App.)

- [ ] **Step 3: Verify + commit**

Run: `npm --prefix app run build`. Commit:

```bash
git add app/src/components/SyncOverview.tsx app/src/App.tsx
git commit -m "feat(sync): unsynced overview panel with per-node + sync-all" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Quit guard for unsynced work

**Files:** modify `app/src/App.tsx`.

**Interfaces:** a new guard state `syncQuitGuard: { count: number } | null` and its dialog, plus a ref so the close listener sees the latest pending count.

- [ ] **Step 1: Track the latest pending count in a ref**

In `app/src/App.tsx`, near `editorDirtyRef`, add:

```ts
  const syncPendingRef = useRef(syncPending.total);
  useEffect(() => {
    syncPendingRef.current = syncPending.total;
  }, [syncPending.total]);
  const [syncQuitGuard, setSyncQuitGuard] = useState<{ count: number } | null>(null);
```

- [ ] **Step 2: Extend the close handler**

In the `onCloseRequested` callback (App.tsx:446-451), after the existing editor-dirty branch, add a sync branch so quitting with unsynced work prompts. The editor-dirty guard takes precedence (unsaved edits are the more urgent loss):

```ts
          unlisten = await getCurrentWindow().onCloseRequested((event) => {
            if (editorDirtyRef.current) {
              event.preventDefault();
              setEditorGuard({ kind: "quit" });
            } else if (syncPendingRef.current > 0) {
              event.preventDefault();
              setSyncQuitGuard({ count: syncPendingRef.current });
            }
          });
```

- [ ] **Step 3: Add the sync-quit dialog**

In `app/src/App.tsx`, next to the `editorGuard` dialog (~line 914), add:

```tsx
      {syncQuitGuard && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="w-[440px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl">
            <div className="mb-2 text-[14.5px] font-semibold text-[var(--color-text)]">
              Nesynchronizovaná práce
            </div>
            <p className="mb-4 text-[13px] leading-relaxed text-[var(--color-text-dim)]">
              Máš {syncQuitGuard.count} nesynchronizovaných souborů, které nejsou
              na remote. Pokud aplikaci zavřeš, zůstanou jen lokálně.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSyncQuitGuard(null)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)]"
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={async () => {
                  setSyncQuitGuard(null);
                  setSyncOverviewOpen(true);
                }}
                className="rounded-md border border-[var(--color-accent-dim)] px-3 py-1.5 text-[12.5px] text-[var(--color-accent)] hover:bg-[var(--color-surface)]"
              >
                Zobrazit a synchronizovat
              </button>
              <button
                type="button"
                onClick={async () => {
                  setSyncQuitGuard(null);
                  const { getCurrentWindow } = await import("@tauri-apps/api/window");
                  await getCurrentWindow().destroy();
                }}
                className="rounded-md border border-[var(--color-danger-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-danger)] hover:bg-[var(--color-surface)]"
              >
                Zavřít bez synchronizace
              </button>
            </div>
          </div>
        </div>
      )}
```

(The "Zobrazit a synchronizovat" button cancels the quit and opens the overview — the user syncs from there, then quits again cleanly. This avoids a fragile sync-then-quit race.)

- [ ] **Step 4: Verify + commit**

Run: `npm --prefix app run build`. Commit:

```bash
git add app/src/App.tsx
git commit -m "feat(sync): warn on app quit when local work is unsynced" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Asana 1215907170556844):**
- "Místo v appce s přehledem všeho nesynchronizovaného" → Task 1 (aggregate) + Task 3 (overview panel) + Task 2 (footer badge entry point). ✓
- "Odtud je možné synchronizaci spustit" → Task 3 (per-node "Synchronizovat" + "Synchronizovat vše", reusing `runNodeSync`). ✓
- "Při uzavření nebo změně node varovat" → Task 4 (quit guard); node-switch is intentionally passive (the always-on footer badge), per the approved design. ✓
- "Unsynced = local-not-on-remote, cheap best-effort scan, passive" → Global Constraints + Task 1 (`fast`+discovery, skip-on-error) + Task 2 (paused-when-hidden poll). ✓

**Placeholder scan:** Backend (Task 1) is complete runnable code + a real test. Frontend tasks give complete components/handlers + exact wiring points; the one conditional ("if `SyncPendingResponse` isn't re-exported from types.ts, mirror the `SyncStatusResponse` import") names the exact existing pattern to copy. ✓

**Type consistency:** `computeSyncPending` → `SyncPendingResponse` → `fetchSyncPending` → `useSyncPending` → `StatusFooter.pendingCount` / `SyncOverview.pending`, all the same shape. `runNodeSync` (existing) reused in Task 3. `syncPendingRef` (Task 4) reads `syncPending.total` from Task 2. ✓

**Known limitation:** the aggregate scans all mirrors on each poll; for very large mirror counts the 30s cadence may want a lighter "counts-only" fast path later. `fast:true` + name-only discovery keeps it acceptable for the current ~35-mirror scale.
