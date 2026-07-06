# Unified sharing: one access model, one endpoint, one tab

**Date:** 2026-07-05
**Status:** approved design, pre-implementation

## Problem

A node's access ("who can see this") is one conceptual dimension but is
exposed through two UI surfaces and two write paths:

- The header **VisibilityDropdown** sets `nodes.visibility` to `team` or
  `private` via `updateNode({ visibility })`.
- The Přehled-tab **Sdílení section** (`AccessSection`) manages the ACL
  (`node_access` rows) via `PUT /nodes/:id/access`, which derives
  `visibility=group` from having rows.

The server already treats these as one guarded knob (`domain/nodes.ts`
refuses `updateNode` visibility changes on an ACL'd node, and refuses setting
`group` directly), but the split across two endpoints and two widgets makes
it read as two features. This unifies it: **one access model, written through
one endpoint, edited in one tab.**

## Model (unchanged conceptually, made explicit)

One dimension, three modes, stored in `nodes.visibility`:

- **tým** (`team`) — everyone in the workspace. No `node_access` rows.
- **soukromé** (`private`) — only the creator/admins. No rows.
- **skupina** (`group`) — only the granted users/groups. ≥1 `node_access`
  row. Carries `access_mode` (`private` | `request`) as a sub-option: whether
  non-grantees may request access.

The grant list is the *detail* of the `group` mode; `access_mode` is a
sub-option of `group`. Enforcement (`auth/node-access.ts`) already reads
`visibility` + `node_access` together as one walk.

## Server: `PUT /nodes/:id/access` becomes the single access endpoint

Extend the request body with an optional authoritative `visibility`:

```
PUT /nodes/:id/access
{ visibility?: "team" | "private" | "group",
  entries: NodeAccessEntryInput[],
  mode?: "private" | "request" }
```

Handler behaviour when `visibility` is present (authoritative):

- `team` → entries forced to `[]`; `UPDATE nodes SET visibility='team',
  access_mode='private'`; `DELETE node_access`.
- `private` → entries forced to `[]`; `visibility='private',
  access_mode='private'`; `DELETE node_access`.
- `group` → **require `entries.length >= 1`** (else 400
  `"group visibility requires at least one access entry"`);
  `visibility='group'`, `access_mode = mode ?? 'private'`, replace
  `node_access` with entries.

When `visibility` is **absent**, keep today's derive-from-entries behaviour
(backward-compatible; no other caller exists, but this keeps the endpoint
safe if one appears). All existing validation stays: duplicate `(kind,
principal)` → 400, unknown user ids → 400, single atomic `db.batch`, audit
log. `updateNode`'s visibility guards remain (defence in depth); the webview
simply stops calling `updateNode` for visibility.

`GET /nodes/:id/access` response gains `visibility` (the node's current mode)
so the tab can render the selector without cross-referencing; alternatively
the tab reads `node.visibility` it already holds — implement whichever is
cleaner, but the tab MUST NOT need a second fetch.

## Web: one control in one tab

- **New node-detail tab "Sdílení"**, rightmost (after Propojení), rendering
  `AccessSection`. Remove `AccessSection` from the Přehled tab. Remove the
  header `VisibilityDropdown` and its now-dead `SELECTABLE_VISIBILITIES` /
  component code.
- **`putNodeAccess`** gains an optional `visibility` argument, forwarded in
  the body.
- **`AccessSection`** gains a 3-mode selector at the top (segmented control /
  radio: Tým / Soukromé / Skupina), driven by the node's current visibility:
  - **Tým** / **Soukromé**: hide the grant editor. Selecting either persists
    via `putNodeAccess([], undefined, "team"|"private")` (one call, clears any
    grants server-side).
  - **Skupina**: show the existing grant editor (add/remove users & groups,
    the inherited-ACL "Upravit kopii" override flow, the `request`
    sub-toggle) unchanged. Grants persist via `putNodeAccess(entries, mode,
    "group")`. Selecting Skupina with zero grants shows an inline hint
    ("přidej aspoň jednoho příjemce, jinak node uvidí jen správci") and does
    not persist an empty group (the server would 400).
  - Switching **away** from Skupina when grants exist prompts a confirm
    ("Tímto odebereš N sdílení — pokračovat?") before the clearing call.
- Read-only users: the selector and editor are disabled (existing `canManage`
  gate); they still see the current mode and grants.

## Testing

- Server (`test/api-access.test.ts` or a sibling): PUT with
  `visibility:'team'` clears rows + sets team; `'private'` clears rows + sets
  private; `'group'` with entries sets group + mode; `'group'` with `[]` →
  400; absent `visibility` keeps the derive path; duplicate/unknown-user
  validation still fires; enforcement (`nodeVisibleTo`) reflects each mode.
- Web: no test harness — verify via `npm run typecheck` + web build, and a
  manual pass in the app (switch each mode, add/remove grants, confirm the
  header dropdown is gone and the tab is rightmost).

## Out of scope

- Collapsing the three modes into a binary open/restricted model (private =
  empty restricted list). Considered and declined: `private` is a distinct
  stored `visibility` enforcement reads, three named modes are clearer UX
  (matches the Google-Docs "anyone / restricted / specific people" mental
  model), and collapsing would need a data-model migration for no user gain.
- Any change to group membership management (Directory-owned) or the
  enforcement walk.
