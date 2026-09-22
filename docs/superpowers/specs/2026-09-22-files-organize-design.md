# Organizing a node's files: drag and drop, folders, one apply

The Files tab lets the user tidy a node's files by dragging them between
folders and sections, creating folders and renaming folders, all as a **plan**
that touches nothing until „Použít". Applying runs the existing per-file
move (`POST /nodes/:id/files/:fileId/move`) once per planned file, in order.
No server route, sync class or migration changes; the only code outside the
web app is one line in the desktop shell so that HTML drag and drop works
inside the Tauri webview.

Scope: files within one node, between its `wip/`, `outputs/` and
`resources/` sections and any folder under them, plus a redesign of the
folder rows the tree already has. Moving a file to another node and
uploading files from Finder are out of scope. Mockups of every state:
`docs/superpowers/mockups/2026-09-22-files-organize.html`.

## Rules

1. **A plan is not a change.** Dragging and creating folders edit the plan
   only. Disk, graph and remote stay as they are until „Použít"; agents
   working in the mirror see the old layout. „Zahodit" drops the plan with
   no effect anywhere.
2. **Apply is the existing move, N times.** Each planned file is one call
   to the move route with `confirmed: true`; the route decides what the
   move means (record only for a never-pushed file, record plus a rename on
   the remote for a pushed one, mirror relocation on the device). The plan
   never carries bytes; content pushes stay the deliberate sync they are.
3. **The plan is keyed by file id, never by path.** The tree is rebuilt from
   fresh detail on every poll and the plan is laid over it. An entry whose
   file no longer exists, or whose file already sits at its target, is
   dropped silently.
4. **A folder exists when a file is in it.** A folder created in the plan is
   virtual: a row in the tree and nothing else. It becomes real the moment
   an applied move puts a file there; emptied before apply, it disappears.
5. **Only a registered file moves.** An untracked row (no file id) is not
   draggable, with the reason in its title („Soubor ještě není
   zaregistrovaný"); the watcher registers it within seconds. A folder
   holding an untracked file cannot be dragged or renamed for the same
   reason, so a folder never ends up half moved. A file outside the three
   sections is not draggable either.
10. **A folder rename is its files' moves.** Renaming or dragging a folder
   plans one move per registered file under it; nothing else exists to
   rename (the server's own folder rename works the same way, one remote
   rename per file). The old folder leaves the tree because no file is in
   it any more (rule 4); a section root cannot be renamed.
6. **A target must be free.** Two planned files cannot share a target path,
   and a target already occupied by an existing file is refused when the
   drop happens, not at apply.
7. **Apply stops at the first failure.** Moves done stay done; the failed
   file keeps its plan entry and shows the route's error on its row
   (`repair_needed` with the hint, as delete and resolve do today); the
   remaining entries stay in the plan for the next „Použít".
8. **The plan belongs to the node on this device.** It survives leaving the
   node and restarting the app (localStorage, `portuni:<ws>:<key>`, per
   node id, like collapsed folders). It is never sent anywhere.
9. **No mirror, no plan.** In a team workspace a node without a mirror on
   this device cannot relocate anything; dragging is disabled with the
   reason in the row title („Nejdřív vytvoř mirror uzlu") and „Nová složka"
   is disabled the same way.

## The plan

```ts
type FilePlan = {
  // file id → target folder, expressed as the move route expects it
  moves: Record<string, { section: "wip" | "outputs" | "resources"; subpath: string | null }>;
  // virtual folders as node-relative paths, e.g. "wip/navrhy/v2"
  folders: string[];
};
```

Pure helpers in `apps/web/src/lib/file-plan.ts`, tested from the server's
`node:test` runner:

- `applyPlan(treeFiles, plan)` → tree files with planned paths substituted
  plus empty folder nodes for `folders`, and the cleaned plan (rule 3).
- `planMove(plan, file, targetFolder, occupied)` → new plan or a refusal
  reason (rule 6); moving a file back to where it lives removes its entry.
- `planFolderRename(plan, folderPath, newName, treeFiles, occupied)` → new
  plan or a refusal reason: a real folder becomes moves for every file
  under it (rule 10), a virtual folder is renamed in `folders` and every
  entry targeting it is retargeted; refused when the new path exists, real
  or virtual, when a target path is occupied (rule 6), or when a file under
  the folder is untracked (rule 5).
- `planFolder(plan, path, existingFolders)` → new plan or a refusal reason:
  path must start with a section, every segment safe (no `..`, `/` runs,
  leading or trailing whitespace, `\0`), and not exist already, virtual or
  real.
- `orderMoves(plan)` → the apply order: shallower targets first, then by
  path, so a folder's files land together and the tree refresh between
  moves reads sensibly.

## Files tab

### Tree

The tree keeps its file rows and changes what a folder looks like
(mockup, frame 2):

- **Section roots** (`wip`, `outputs`, `resources`) are group headings, not
  folders: sentence case in the body face, weight 500, a one-word
  description after the count („rozpracované", „výstupy", „podklady"), a
  hairline under the heading, the chevron for collapsing only. They cannot
  be dragged or renamed and have no hover actions.
- **Folder rows** use the same face and size as file rows: chevron, folder
  icon (open when expanded, closed when collapsed), name, count, sync dot,
  then the hover actions „Přejmenovat" and „Nová podsložka" at the right.
  No uppercase, no monospace, no tracking.
- **Depth** is the indent plus a 1 px guide line down the left of a folder's
  children.
- **A virtual folder** has a dashed folder icon, the name in the dim text
  colour, count 0 and the tag „nová" after the count.

### Tree with a plan

The tree renders `applyPlan`'s output. A moved file's row carries a 2 px accent
bar at its left edge, its current folder struck through after the name and
a badge in the sync-badge style, „přesun", in place of the sync badge
(mockup, frame 4).

A bar between the toolbar and the tree, when the plan is not empty:
„N změn čeká na použití", „Zahodit" (ghost) and „Použít" (accent). While
applying: „Přesouvám i/N", both buttons disabled, the file being moved
shows the row busy badge „přesouvám". After a failure the bar turns to the
danger colours and says which file stopped it and how many changes remain
(„Použít znovu"); the failed row shows the badge „chyba" and the message on
its own line under the row (mockup, frame 6). After the last move the
detail and sync status are refetched (as rename does) and the plan is what
rule 3 leaves of it, normally nothing.

### Dragging

Native HTML drag and drop, no library. A registered file row is
`draggable`; a folder row can be dragged too, which plans a move for every
file under it (rule 10; refused with the reason in its title while it holds
an untracked file). Drop targets: folder rows (real and virtual) and the three
section roots. Dropping on a file row targets its parent folder. A
collapsed folder expands after the cursor rests on it for 600 ms. The
target under the cursor is highlighted; a refused target (rule 6, or a
folder dropped into itself or its own subtree) shows the reason as the
row's title and does not highlight.

### „Nová složka"

A button next to „Nový soubor" (part of the same toolbar; the Showtime
split button is unchanged). It opens an inline form like `NewFileForm`,
with a path input prefilled `wip/` and „Vytvořit" / „Zrušit"; Enter and
Escape work the same. Validation is `planFolder`'s; its refusal shows under
the form. A folder row also gets a hover action „Nová podsložka" that opens
the same form prefilled with that folder's path and a trailing slash.

„Nový soubor" still creates in `wip/` root; creating a file inside a
virtual folder is out of scope.

### Renaming a folder

A folder row gets the hover action „Přejmenovat" that file rows have: an
inline input with the current name, Enter plans (`planFolderRename`),
Escape cancels, a refusal shows under the row. Section roots have no such
action. Renaming a real folder marks every file under it „PŘESUN" and
shows the folder under its new name; renaming a virtual folder just
renames the row. Nothing reaches the server until „Použít".

### Web API

`moveFile(nodeId, fileId, { section, subpath })` in `apps/web/src/api.ts`,
a `POST …/files/:fileId/move` with `new_section`, `new_subpath` and
`confirmed: true`. The route answers `repair_needed` as a 200 with the
status in the body, the same shape delete and resolve return; the caller
treats anything but `status: "ok"` as the row's error.

## Desktop

`open_window` in `apps/desktop/src/lib.rs` adds
`.disable_drag_drop_handler()` to the `WebviewWindowBuilder`. Tauri's own
handler intercepts drops for Finder files and, on macOS, blocks the HTML
drag and drop API in the webview; Portuni handles no Finder drops, so
nothing is lost. Ships with the next `.app`; in Vite it works immediately.

## Docs

`sites/docs/src/content/docs/guides/working-in-the-app.md`, Files: dragging
between folders and sections, „Nová složka", „Přejmenovat" on a folder,
the plan and „Použít" /
„Zahodit", what apply does for a pushed and a never-pushed file.
`CLAUDE.md`, Desktop rules: the drag drop handler stays disabled on every
window. `docs/architecture/task-surface-web.md`: the plan's localStorage
key.

## Errors

| Case | Behaviour |
|---|---|
| untracked file dragged | not draggable; reason in the row title |
| file outside `wip`/`outputs`/`resources` dragged | not draggable |
| node without a mirror on this device (team workspace) | dragging and „Nová složka" disabled, reason in titles |
| drop where a file of that name exists, real or planned | refused at drop, reason in the target's title |
| folder dropped into itself or its subtree | refused at drop |
| folder with an untracked file dragged or renamed | refused, reason in the row title; try again once the watcher registered it |
| folder renamed to a name that exists, real or virtual | refusal under the row |
| new folder path invalid or existing | refusal under the form |
| a planned file disappeared before apply | entry dropped, nothing reported |
| a planned file already at its target (moved on disk meanwhile) | entry dropped |
| move route fails or answers `repair_needed` | apply stops; the row shows the message; the rest stays planned |
| app closed mid-apply | done moves are done; the plan on next open holds only what rule 3 keeps |

## Testing

Web helpers (`node:test`): `applyPlan` substitutes paths, adds virtual
folders, drops stale and already-at-target entries; `planMove` refuses an
occupied target and a folder into its own subtree, removes an entry on a
move home; `planFolder` validation; `planFolderRename` turns a real folder into moves
and a virtual one into a renamed entry, refuses an untracked file inside
and an existing name; `orderMoves` ordering.

Web components: an untracked row is not draggable; a drop on a file row
targets its folder; a folder rename shows the new name and marks its
files; the toolbar counts entries; apply calls `moveFile` in
`orderMoves` order, stops at a failing call and leaves the remaining
entries; the plan survives an unmount and remount for the same node and is
absent for another node.

Server: no change; existing move route tests cover both workspaces.

Live on macOS (human): in Portuni.app, drag a pushed and a never-pushed
file into a new folder, apply; the pushed one is renamed on Drive without
a re-upload, the never-pushed one is still `push` at its new path; a
folder drag; a folder rename of a pushed folder (its files renamed on
Drive, no re-upload); a refused drop; quit during apply and reopen.

## Out of scope

- Moving a file to another node (the route supports `new_node_id`; the
  sidebar as a drop target is a later step).
- Creating a file inside a virtual folder.
- Dropping files from Finder into the tree.
- Undo after apply.
