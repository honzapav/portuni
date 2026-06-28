# Cluster C — Events Date Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the events list under date headers (úkol 3 — "Události se musí řadit pod termín") so events cluster under their date instead of rendering as a flat stream.

**Architecture:** Frontend-only. The backend already returns events `created_at DESC` (`node-detail.ts:109-114`); `created_at` is the editable "termín" (the EventCard DatePicker edits it). We add a pure `groupEventsByDate` helper (its own module so `node --test` can cover it without pulling in React), and render date headers in DetailPane's events tab. No schema change, no backend change (per the design spec's decision: group by the existing date, no new `term` field).

**Tech Stack:** React 19, TypeScript, `node --test` via `tsx` for the pure helper.

## Global Constraints

- **No emoji in code. Czech UI strings keep diacritics.**
- **No backend / schema change.** Grouping is purely a render concern over the existing `created_at` ordering.
- **Preserve order.** Backend sends `created_at DESC`; grouping must keep newest-first, both across groups and within a group.
- **The pure helper lives in `app/src/lib/` (not the `.tsx`)** so the node-test runner can import it without React/lucide.
- Verification: browser Vite (`http://portuni.test`). Test: `npm test`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `app/src/lib/events.ts` | Pure event helpers | Create: `groupEventsByDate` + `EventDateGroup` (Task 1) |
| `test/events-grouping.test.ts` | `node --test` coverage | Create (Task 1) |
| `app/src/components/DetailPane.tsx` | Node detail; events tab render | Render date headers (Task 2) |
| `app/src/components/DetailPane.events.tsx` | `EventCard` | Drop the now-redundant per-card date (Task 2) |

---

### Task 1: `groupEventsByDate` pure helper (TDD)

**Files:**
- Create: `app/src/lib/events.ts`
- Create: `test/events-grouping.test.ts`

**Interfaces:**
- Produces: `groupEventsByDate(events: DetailEvent[]): EventDateGroup[]` where `EventDateGroup = { date: string; events: DetailEvent[] }`.

- [ ] **Step 1: Write the failing test**

Create `test/events-grouping.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupEventsByDate } from "../app/src/lib/events.js";

// Minimal event shape; groupEventsByDate only reads created_at + id.
function evt(id: string, created_at: string) {
  return { id, created_at } as Parameters<typeof groupEventsByDate>[0][number];
}

describe("groupEventsByDate", () => {
  it("groups consecutive same-date events under one date, newest-first order preserved", () => {
    const events = [
      evt("e1", "2026-06-28T10:00:00Z"),
      evt("e2", "2026-06-28T08:00:00Z"),
      evt("e3", "2026-06-27T17:00:00Z"),
      evt("e4", "2026-06-25T09:00:00Z"),
    ];
    const groups = groupEventsByDate(events);
    assert.deepEqual(
      groups.map((g) => [g.date, g.events.map((e) => e.id)]),
      [
        ["2026-06-28", ["e1", "e2"]],
        ["2026-06-27", ["e3"]],
        ["2026-06-25", ["e4"]],
      ],
    );
  });

  it("returns an empty array for no events", () => {
    assert.deepEqual(groupEventsByDate([]), []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/events-grouping.test.ts`
Expected: FAIL — `app/src/lib/events.js` / `groupEventsByDate` does not exist.

- [ ] **Step 3: Create the helper**

Create `app/src/lib/events.ts`:

```ts
// Pure event-list helpers. No React/DOM, so the node-test runner can cover
// them headlessly (same rationale as lib/sessions.ts).
import type { DetailEvent } from "../types";

export type EventDateGroup = { date: string; events: DetailEvent[] };

// Group events under their date (created_at's YYYY-MM-DD), preserving the
// incoming order. The backend returns events created_at DESC, so all
// same-day events are already consecutive: groups and the events within
// them stay newest-first. (úkol 3: "Události se musí řadit pod termín".)
export function groupEventsByDate(events: DetailEvent[]): EventDateGroup[] {
  const groups: EventDateGroup[] = [];
  for (const evt of events) {
    const date = evt.created_at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.events.push(evt);
    } else {
      groups.push({ date, events: [evt] });
    }
  }
  return groups;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/events-grouping.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/events.ts test/events-grouping.test.ts
git commit -m "feat(events): groupEventsByDate helper" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Render date headers in the events tab

**Files:**
- Modify: `app/src/components/DetailPane.tsx` (import the helper; events render lines 869-892)
- Modify: `app/src/components/DetailPane.events.tsx` (remove the redundant per-card date, lines 143-146)

**Interfaces:**
- Consumes: `groupEventsByDate` from Task 1.

- [ ] **Step 1: Import the helper**

In `app/src/components/DetailPane.tsx`, add to the existing import from `./DetailPane.events` (the one that brings in `EventCard`, `AddEventForm`) — or add a new import:

```ts
import { groupEventsByDate } from "../lib/events";
```

- [ ] **Step 2: Render grouped events with date headers**

Replace the events-tab block (lines 869-892) with:

```tsx
        {tab === "events" && (
          <div className="px-5 py-4">
            <div className="space-y-4">
              {groupEventsByDate(node.events).map((group) => (
                <div key={group.date} className="space-y-2">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-dim)]">
                    {group.date}
                  </div>
                  {group.events.map((evt) => (
                    <EventCard
                      key={evt.id}
                      event={evt}
                      onMutate={onMutate}
                      busy={busy}
                    />
                  ))}
                </div>
              ))}
              {node.events.length === 0 && (
                <div className="text-[14px] text-[var(--color-text-dim)]">
                  Zatím žádné události.
                </div>
              )}
            </div>
            <AddEventForm
              nodeId={node.id}
              onMutate={onMutate}
              disabled={busy}
            />
          </div>
        )}
```

- [ ] **Step 3: Drop the now-redundant per-card date**

The date now lives in the group header, so remove it from `EventCard`. In `app/src/components/DetailPane.events.tsx`, delete the date span (lines 143-146):

```tsx
        <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-dim)]">
          <Clock size={9} />
          {evt.created_at.slice(0, 10)}
        </span>
```

If `Clock` becomes unused after this, remove it from the `lucide-react` import (line 7). (It is only used here; tsc/biome will flag it if it lingers.)

- [ ] **Step 4: Typecheck**

Run: `npm --prefix app run build`
Expected: tsc passes (no unused `Clock` import).

- [ ] **Step 5: Verify in the browser**

Open a node with several events across different days (use the Edit form's DatePicker to back-date a couple). Confirm the **Události** tab shows date headers with events grouped beneath each, newest date first, and same-day events clustered together. (Fixes úkol 3.)

- [ ] **Step 6: Commit**

```bash
git add app/src/components/DetailPane.tsx app/src/components/DetailPane.events.tsx
git commit -m "feat(events): group events under date headers in the detail pane" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Cluster C):** Úkol 3 (events grouped under their date) — Task 1 (pure grouping) + Task 2 (date headers, redundant card date removed). Decision "group by existing date, no new field, frontend-only" honored: no schema/backend touch. ✓

**Placeholder scan:** Every step has full code + exact commands. ✓

**Type consistency:** `groupEventsByDate(node.events)` — `node.events` is `DetailEvent[]`, matching the helper's parameter; `EventDateGroup.events` is `DetailEvent[]`, fed straight into `EventCard`'s `event` prop. Helper name identical across `events.ts` (def), the test (import), and `DetailPane.tsx` (import). ✓
