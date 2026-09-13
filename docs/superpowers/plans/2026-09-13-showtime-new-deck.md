# New Showtime Deck from a Node (Portuni side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** „Nová prezentace" on a node's Files tab hands Showtime the node's `wip/` directory and a one-time handoff code through `showtime://new`, so Showtime creates the deck there as the node's deck.

**Architecture:** The sidecar's mint endpoint (`POST /auth/handoff`) answers with the node's mirror next to the code. A new desktop command `new_in_showtime { node_id }` mints on this window's workspace sidecar, refuses without a mirror, checks `<mirror>/wip` is inside the workspace root, and opens `showtime://new?dir=…&portuni=…&code=…`. The web's „+ Nový soubor" becomes a split button when the Showtime integration is on and Showtime.app is found; its second item is disabled without a mirror. Nothing else in Portuni changes — the bundle Showtime writes is picked up by the mirror watcher like any file.

**Tech Stack:** Node + TypeScript (node:test via tsx), Rust (Tauri 2, reqwest, percent-encoding, tempfile in tests), React + Vite, Starlight docs site. Gate: `scripts/agent-gate.sh`.

**Spec:** `docs/superpowers/specs/2026-09-13-showtime-new-deck-design.md`. Ships after the Showtime side (`honzapav/showtime` plan `docs/superpowers/plans/2026-09-13-new-deck-from-portuni.md`) — an older Showtime answers the link with a failed `open::that`, which the command already reports as „aktualizujte Showtime".

## Global Constraints

- The bearer never enters a URL, argv, disk or the webview. The desktop command uses the terminal token Rust already holds (`sidecar_port_and_token`), never one from JS.
- Workspace-bound desktop commands resolve `ws_of(&window)` (#223), not `active_workspace`.
- Conventional Commits with the scopes `git log` uses (`server`, `desktop`, `web`, `docs`). Never hand-bump a version.
- UI strings in Czech with diacritics; code comments in English; no emoji in code; em dash in prose.
- The public docs site (`sites/docs/`) changes in the same branch as the behaviour.
- Gate before every commit: `scripts/agent-gate.sh` (server qa, web typecheck + build, `cargo test` + clippy, docs build).

---

## File map

| File | Responsibility |
|---|---|
| `apps/server/api/auth.ts` | `handleMintHandoff` answers `{ code, expires_in, mirror }` |
| `test/rest-handoff.test.ts` | mint answers the registered mirror, or null |
| `apps/desktop/src/lib.rs` | `mint_showtime_handoff` (shared by both commands), `showtime_new_dir`, `showtime_new_url`, `new_in_showtime` command + registration |
| `apps/web/src/lib/new-file-menu.ts` | pure: plain button or split, and whether „Nová prezentace" is enabled |
| `test/new-file-menu.test.ts` | its tests |
| `apps/web/src/lib/showtime.ts` | `newInShowtime(nodeId)` |
| `apps/web/src/components/DetailPane.files.tsx` | `NewFileSplitButton` |
| `apps/web/src/components/DetailPane.tsx` | wire it in; inline error under the toolbar |
| `sites/docs/src/content/docs/guides/working-in-the-app.md`, `CLAUDE.md` | docs |

---

### Task 1: The mint answers with the node's mirror

**Files:**
- Modify: `apps/server/api/auth.ts:298-322`
- Test: `test/rest-handoff.test.ts:126-134` (the `mint` helper) and the `POST /auth/handoff + /auth/handoff/exchange` describe block

**Interfaces:**
- Produces: `POST /auth/handoff` → `200 { code: string, expires_in: 60, mirror: string | null }`. The exchange is unchanged.

- [ ] **Step 1: Write the failing test**

In `test/rest-handoff.test.ts`, change the `mint` helper to hand back the whole body and add a test:

```ts
async function mintBody(
  nodeId: string,
  token: string,
): Promise<{ code: string; expires_in: number; mirror: string | null }> {
  const res = await post("/auth/handoff", { node_id: nodeId }, token);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as { code: string; expires_in: number; mirror: string | null };
  assert.equal(body.expires_in, 60);
  assert.ok(body.code.length >= 40, "32 random bytes, base64url");
  return body;
}

async function mint(nodeId: string, token: string): Promise<string> {
  return (await mintBody(nodeId, token)).code;
}
```

In the describe block, after the first test:

```ts
  // „Nová prezentace" needs the directory before Showtime is even asked, so
  // the mint answers with the mirror the exchange would answer with.
  it("mint answers with the node's mirror on this device, or null", async () => {
    const mirror = join(workspace, "workflow", "projects", "open-deck");
    await registerMirror(INSIDER, openNodeId, mirror);
    assert.equal((await mintBody(openNodeId, insiderToken)).mirror, mirror);
    assert.equal((await mintBody(restrictedNodeId, insiderToken)).mirror, null);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/rest-handoff.test.ts`
Expected: FAIL — `mirror` is `undefined`, not the path.

- [ ] **Step 3: Implement**

In `apps/server/api/auth.ts`, `handleMintHandoff`:

```ts
    const minted = mintHandoff({ token, nodeId: body.node_id, userId: identity.userId });
    // The mirror rides along so a caller that needs a directory before
    // Showtime is asked (a new deck) has it; the exchange answers it too.
    const mirror = await getMirrorPath(identity.userId, body.node_id);
    respondJson(res, 200, { code: minted.code, expires_in: minted.expiresIn, mirror });
```

`getMirrorPath` is already imported in this file (line 27). Update the comment block above the handlers: "POST /auth/handoff mints a one-time code bound to the caller's bearer and a node and answers it with the node's mirror on this device".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/rest-handoff.test.ts test/agent-router.test.ts`
Expected: PASS (the agent router shares the handler; its mint test reads only `code`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/auth.ts test/rest-handoff.test.ts
git commit -m "feat(server): the handoff mint answers with the node's mirror"
```

---

### Task 2: The desktop command `new_in_showtime`

**Files:**
- Modify: `apps/desktop/src/lib.rs:1739-1822` (helpers + `open_in_showtime`), `:3322-3323` (handler registration), tests in `showtime_preview_tests` (`:1876-1965`)

**Interfaces:**
- Produces:
  ```rust
  struct HandoffMinted { code: String, mirror: Option<String> }
  async fn mint_showtime_handoff(app: &AppHandle, ws_id: &str, node_id: &str) -> Result<(String, HandoffMinted), String>  // (sidecar base URL, minted)
  fn showtime_new_dir(root: &Path, mirror: &str) -> Result<PathBuf, String>
  fn showtime_new_url(dir: &Path, portuni_base: &str, code: &str) -> String
  #[tauri::command] async fn new_in_showtime(window: tauri::Window, node_id: String) -> Result<(), String>
  ```
- Consumes: Task 1's `mirror` field.

- [ ] **Step 1: Write the failing tests**

In the `showtime_preview_tests` module, extend the `use super::{…}` with `showtime_new_dir, showtime_new_url` and add:

```rust
    // The directory „Nová prezentace" hands Showtime: the mirror's wip/,
    // inside the workspace root and there on disk. A mirror registered
    // elsewhere, or one whose wip/ is gone, is refused before any link opens.
    #[test]
    fn showtime_new_dir_is_the_mirrors_wip_inside_the_root() {
        let root = tempfile::tempdir().unwrap();
        let mirror = root.path().join("org").join("projects").join("x");
        std::fs::create_dir_all(mirror.join("wip")).unwrap();

        assert_eq!(
            showtime_new_dir(root.path(), &mirror.to_string_lossy()).unwrap(),
            mirror.join("wip")
        );
        assert!(showtime_new_dir(Path::new("/elsewhere"), &mirror.to_string_lossy())
            .unwrap_err()
            .contains("workspace scope"));
        let no_wip = root.path().join("org").join("projects").join("y");
        std::fs::create_dir_all(&no_wip).unwrap();
        assert!(showtime_new_dir(root.path(), &no_wip.to_string_lossy())
            .unwrap_err()
            .contains("wip"));
    }

    #[test]
    fn showtime_new_url_percent_encodes_every_value() {
        let url = showtime_new_url(
            Path::new("/ws/Můj projekt/wip"),
            "http://127.0.0.1:47011",
            "ab-c_D=",
        );
        assert_eq!(
            url,
            "showtime://new?dir=%2Fws%2FM%C5%AFj%20projekt%2Fwip\
             &portuni=http%3A%2F%2F127%2E0%2E0%2E1%3A47011&code=ab%2Dc%5FD%3D"
        );
        assert!(!url.contains("Bearer"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `scripts/desktop-dev-placeholders.sh && (cd apps/desktop && cargo test showtime_new)`
Expected: compile error — the two functions do not exist.

- [ ] **Step 3: Implement**

In `apps/desktop/src/lib.rs`, after `showtime_open_url`:

```rust
/// The directory „Nová prezentace" hands Showtime: the node's mirror plus
/// `wip/` (a mirror is created with wip/outputs/resources), inside the
/// workspace root and there on disk. Refused before any link opens.
fn showtime_new_dir(root: &std::path::Path, mirror: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::path::PathBuf::from(mirror).join("wip");
    if !path_within_root(root, &dir) {
        return Err("mirror out of workspace scope".into());
    }
    if !dir.is_dir() {
        return Err(format!("mirror has no wip/ directory: {}", dir.display()));
    }
    Ok(dir)
}

/// `showtime://new?dir=<directory>&portuni=<sidecar base>&code=<code>`, every
/// value percent-encoded (spec: 2026-09-13-showtime-new-deck-design.md).
/// Showtime opens its New Deck screen with that directory fixed and binds
/// the node to the deck it creates there. The bearer is never part of this
/// URL -- only the one-time code is.
fn showtime_new_url(dir: &std::path::Path, portuni_base: &str, code: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let enc = |v: &str| utf8_percent_encode(v, NON_ALPHANUMERIC).to_string();
    format!(
        "showtime://new?dir={}&portuni={}&code={}",
        enc(&dir.to_string_lossy()),
        enc(portuni_base),
        enc(code)
    )
}
```

Extend the minted shape and pull the mint out of `open_in_showtime`:

```rust
#[derive(serde::Deserialize)]
struct HandoffMinted {
    code: String,
    /// The node's mirror on this device, when it has one.
    #[serde(default)]
    mirror: Option<String>,
}

/// Mint a one-time handoff code on a workspace's sidecar (POST /auth/handoff,
/// authenticated with the terminal token this host already holds for
/// pty_spawn -- never through the webview). Answers the sidecar's base URL,
/// which the link carries so Showtime knows where to exchange the code, and
/// what was minted.
async fn mint_showtime_handoff(
    app: &AppHandle,
    ws_id: &str,
    node_id: &str,
) -> Result<(String, HandoffMinted), String> {
    let (port, token) = sidecar_port_and_token(app, ws_id)?;
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let resp = http
        .post(format!("{base}/auth/handoff"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Origin", "tauri://localhost")
        .json(&serde_json::json!({ "node_id": node_id }))
        .send()
        .await
        .map_err(|e| format!("handoff request failed: {e}"))?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or(body);
        return Err(format!("handoff refused (HTTP {status}): {detail}"));
    }
    let minted: HandoffMinted = resp
        .json()
        .await
        .map_err(|e| format!("invalid handoff response: {e}"))?;
    Ok((base, minted))
}
```

`open_in_showtime` keeps its signature and body except the mint block, which becomes:

```rust
    let (base, minted) = mint_showtime_handoff(&app, &ws_id, &node_id).await?;
    let url = showtime_open_url(&deck, &base, &minted.code);
```

Add the new command after it:

```rust
/// „Nová prezentace": mints a one-time handoff code on this window's
/// workspace sidecar and opens Showtime's New Deck screen through the
/// `showtime://new` deep link, carrying the node's `wip/` directory, the
/// sidecar base URL and that code. Showtime creates the deck there and binds
/// the node to it; the mirror watcher registers the bundle. A node without a
/// mirror on this device has nowhere to put a deck and is refused here.
#[tauri::command]
async fn new_in_showtime(window: tauri::Window, node_id: String) -> Result<(), String> {
    let ws_id = ws_of(&window)?;
    let app = window.app_handle().clone();
    let cfg = workspace_config_for(&app, &ws_id)?;
    let raw_root = cfg.effective_workspace_root();
    let root = match app.path().home_dir() {
        Ok(h) => expand_tilde(&h, &raw_root),
        Err(_) => std::path::PathBuf::from(&raw_root),
    };

    let (base, minted) = mint_showtime_handoff(&app, &ws_id, &node_id).await?;
    let mirror = minted
        .mirror
        .ok_or_else(|| "Uzel nemá na tomto počítači mirror".to_string())?;
    let dir = showtime_new_dir(&root, &mirror)?;
    let url = showtime_new_url(&dir, &base, &minted.code);
    info!("new_in_showtime: {} (node {node_id})", dir.display());
    open::that(&url).map_err(|e| {
        format!("Showtime neumí přijmout deck z Portuni, aktualizujte Showtime ({e})")
    })
}
```

Register it: in the `tauri::generate_handler![…]` list add `new_in_showtime,` right after `open_in_showtime,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `(cd apps/desktop && cargo test && cargo clippy --all-targets -- -D warnings)`
Expected: PASS, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib.rs
git commit -m "feat(desktop): new_in_showtime opens Showtime's New Deck screen in the node's wip/"
```

---

### Task 3: What the „+ Nový soubor" button is, as a pure decision

**Files:**
- Create: `apps/web/src/lib/new-file-menu.ts`
- Test: `test/new-file-menu.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NewFileMenuInput { showtimeEnabled: boolean; showtimeInstalled: boolean; hasMirror: boolean }
  export type NewFileMenu =
    | { kind: "plain" }
    | { kind: "split"; presentation: { enabled: true } | { enabled: false; reason: string } };
  export function newFileMenu(input: NewFileMenuInput): NewFileMenu
  export const NO_MIRROR_REASON = "Nejdřív vytvoř mirror uzlu";
  ```

- [ ] **Step 1: Write the failing test**

`test/new-file-menu.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_MIRROR_REASON, newFileMenu } from "../apps/web/src/lib/new-file-menu.js";

// The split exists only where „Nová prezentace" could ever do something:
// integration on and Showtime.app found. Without a mirror it is there,
// disabled, and says why.
describe("newFileMenu", () => {
  it("is the plain button without the integration or without Showtime", () => {
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: false, showtimeInstalled: true, hasMirror: true }),
      { kind: "plain" },
    );
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: true, showtimeInstalled: false, hasMirror: true }),
      { kind: "plain" },
    );
  });

  it("splits with the presentation enabled when the node has a mirror", () => {
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: true, showtimeInstalled: true, hasMirror: true }),
      { kind: "split", presentation: { enabled: true } },
    );
  });

  it("splits with the presentation disabled, and the reason, without a mirror", () => {
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: true, showtimeInstalled: true, hasMirror: false }),
      { kind: "split", presentation: { enabled: false, reason: NO_MIRROR_REASON } },
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/new-file-menu.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/web/src/lib/new-file-menu.ts`:

```ts
// What the Files tab's "+ Nový soubor" button is for a node: the plain
// button, or a split whose second item starts a Showtime deck in the node's
// wip/ (spec: docs/superpowers/specs/2026-09-13-showtime-new-deck-design.md).
// The split exists only where that item could ever do something -- the
// Showtime integration on and Showtime.app found; a node without a mirror on
// this device shows it disabled with the reason, since Showtime writes to
// disk and there is nowhere to put the deck.

export interface NewFileMenuInput {
  showtimeEnabled: boolean;
  showtimeInstalled: boolean;
  hasMirror: boolean;
}

export type NewFileMenu =
  | { kind: "plain" }
  | { kind: "split"; presentation: { enabled: true } | { enabled: false; reason: string } };

export const NO_MIRROR_REASON = "Nejdřív vytvoř mirror uzlu";

export function newFileMenu(input: NewFileMenuInput): NewFileMenu {
  if (!input.showtimeEnabled || !input.showtimeInstalled) return { kind: "plain" };
  return {
    kind: "split",
    presentation: input.hasMirror ? { enabled: true } : { enabled: false, reason: NO_MIRROR_REASON },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/new-file-menu.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/new-file-menu.ts test/new-file-menu.test.ts
git commit -m "feat(web): decide the shape of the new-file button for a node"
```

---

### Task 4: The split button on the Files tab

**Files:**
- Modify: `apps/web/src/lib/showtime.ts` (append `newInShowtime`)
- Modify: `apps/web/src/components/DetailPane.files.tsx` (new `NewFileSplitButton`, after `NewFileForm` at `:220-286`)
- Modify: `apps/web/src/components/DetailPane.tsx:84-99` (import), `:351` (state), `:1099-1114` (toolbar)

**Interfaces:**
- Consumes: `newFileMenu` (Task 3), `showtimeInstalled`, `loadShowtimeEnabled` (existing), the `new_in_showtime` command (Task 2).
- Produces:
  ```ts
  export async function newInShowtime(nodeId: string): Promise<void>   // lib/showtime.ts
  export function NewFileSplitButton(props: { hasMirror: boolean; onNewFile: () => void; onNewPresentation: () => Promise<void> }): JSX.Element
  ```

- [ ] **Step 1: `newInShowtime`**

Append to `apps/web/src/lib/showtime.ts`:

```ts
// „Nová prezentace": the desktop mints a one-time handoff code on the sidecar
// and opens Showtime's New Deck screen through the showtime://new deep link
// with the node's wip/ directory, so the deck Showtime creates there is this
// node's and the agent beside it is a session on it. Rejects with a message
// to show inline: the node has no mirror here, the sidecar refused the
// handoff, or the installed Showtime has no `new` action.
export async function newInShowtime(nodeId: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("new_in_showtime", { nodeId });
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}
```

- [ ] **Step 2: `NewFileSplitButton`**

In `apps/web/src/components/DetailPane.files.tsx`, add to the imports: `import { newFileMenu } from "../lib/new-file-menu";` and `import { isShowtimePath, showtimeInstalled } from "../lib/showtime";` (replacing the existing `isShowtimePath` import), and `ChevronDown` / `Loader2` from `lucide-react` if not already in the file's lucide import (check the existing `import { … } from "lucide-react"` at the top; both are used by `TerminalSplitButton` already).

After `NewFileForm`:

```tsx
// "+ Nový soubor", and -- with the Showtime integration on and Showtime.app
// found -- a chevron with "Nový soubor" / "Nová prezentace". The second item
// starts a Showtime deck in the node's wip/ (spec: 2026-09-13-showtime-new-
// deck-design.md) and is disabled without a mirror, with the reason as its
// title. Same shape as TerminalSplitButton; its error is the caller's to
// show, inline under the toolbar (#267), never in a tab-level box.
export function NewFileSplitButton({
  hasMirror,
  onNewFile,
  onNewPresentation,
}: {
  hasMirror: boolean;
  onNewFile: () => void;
  onNewPresentation: () => Promise<void>;
}) {
  const [installed, setInstalled] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!loadShowtimeEnabled()) return;
    void showtimeInstalled().then((ok) => {
      if (!cancelled) setInstalled(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const menu = newFileMenu({
    showtimeEnabled: loadShowtimeEnabled(),
    showtimeInstalled: installed,
    hasMirror,
  });

  const primary =
    "shrink-0 border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] hover:border-[var(--color-border-strong)]";

  if (menu.kind === "plain") {
    return (
      <button type="button" onClick={onNewFile} className={`ml-2 rounded-md ${primary}`}>
        + Nový soubor
      </button>
    );
  }

  const startPresentation = async () => {
    setOpen(false);
    setBusy(true);
    try {
      await onNewPresentation();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={containerRef} className="relative ml-2 shrink-0">
      <div className="flex">
        <button type="button" onClick={onNewFile} className={`rounded-l-md border-r-0 ${primary}`}>
          + Nový soubor
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={busy}
          title="Další možnosti"
          aria-label="Další možnosti"
          className={`rounded-r-md px-2 ${primary} disabled:opacity-60`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} />}
        </button>
      </div>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewFile();
            }}
            className="flex w-full items-center px-3 py-2 text-left text-[13px] text-[var(--color-text)] hover:bg-[var(--color-surface)]"
          >
            Nový soubor
          </button>
          <button
            type="button"
            onClick={() => void startPresentation()}
            disabled={!menu.presentation.enabled}
            title={
              menu.presentation.enabled
                ? "Založí novou prezentaci v Showtime ve složce wip/ tohoto uzlu"
                : menu.presentation.reason
            }
            className="flex w-full items-center px-3 py-2 text-left text-[13px] text-[var(--color-text)] hover:bg-[var(--color-surface)] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Nová prezentace
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `DetailPane.tsx`**

Imports: add `NewFileSplitButton` to the `./DetailPane.files` import list, and `import { newInShowtime } from "../lib/showtime";`.

State, next to `creatingFile` (`:351`):

```ts
  // „Nová prezentace" failed: shown under the toolbar, where NewFileForm's
  // own error would be (#267). Cleared by the next attempt or a new file.
  const [presentationError, setPresentationError] = useState<string | null>(null);
```

Handler, next to `handleCreateFile`:

```ts
  const handleNewPresentation = async () => {
    setPresentationError(null);
    setCreatingFile(false);
    try {
      await newInShowtime(node.id);
    } catch (e) {
      setPresentationError(`Prezentaci se nepodařilo založit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
```

Toolbar (`:1099-1114`) — replace the `+ Nový soubor` button with:

```tsx
                  <NewFileSplitButton
                    hasMirror={!!node.local_mirror}
                    onNewFile={() => {
                      setPresentationError(null);
                      setCreatingFile((v) => !v);
                    }}
                    onNewPresentation={handleNewPresentation}
                  />
                </div>
                {presentationError && (
                  <div className="mb-3 text-[11px]" style={{ color: "var(--color-danger)" }}>
                    {presentationError}
                  </div>
                )}
                {creatingFile && (
```

- [ ] **Step 4: Typecheck and build**

Run: `npx --prefix apps/web tsc -b apps/web --noEmit && npm --prefix apps/web run build`
Expected: clean.

- [ ] **Step 5: Look at it**

Run `varlock run -- npm --prefix apps/web run dev` (Vite, port 4010, against the tmux backend) — in a plain browser `isTauri()` is false, so `showtimeInstalled()` resolves false and the button is the plain one; that confirms the plain path. The split needs the desktop app: `cd apps/desktop && cargo tauri dev` with Settings → Integrace → Showtime on and Showtime.app installed. Check: a node with a mirror → chevron → „Nová prezentace" enabled; a node without one → disabled with the title „Nejdřív vytvoř mirror uzlu"; with the integration off → plain button.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/showtime.ts apps/web/src/components/DetailPane.files.tsx apps/web/src/components/DetailPane.tsx
git commit -m "feat(web): \"+ Nový soubor\" splits into a new file or a new Showtime presentation"
```

---

### Task 5: Docs

**Files:**
- Modify: `sites/docs/src/content/docs/guides/working-in-the-app.md:91` (Files) and `:105` (Integrace → Showtime)
- Modify: `CLAUDE.md:390-404` (the Showtime handoff gotcha)

- [ ] **Step 1: Docs site**

In the **Files** bullet (line 91), after the sentence ending "asks you to update Showtime.", add:

"With the integration on and Showtime.app found, „+ Nový soubor" is a split button: the chevron offers „Nový soubor" and „Nová prezentace". The latter hands Showtime the node's `wip/` and a one-time code (`showtime://new`); Showtime's New Deck screen opens with that folder fixed and the node named, you pick the design system, template and name there, and the bundle it writes shows up under Files through the mirror watcher — the agent beside it is a session on this node, as for „Otevřít v Showtime". Disabled (with the reason) on a node without a mirror on this device: Showtime writes to disk, so there is nowhere to put the deck. Which agent runs beside the deck is Showtime's own setting, not Portuni's agent preset."

In the **Integrace → Showtime** bullet (line 105), after "what the button hands over: the node's Portuni connection for the agent and the node's mirror as a working directory.", add: "It also puts „Nová prezentace" behind „+ Nový soubor" on the Files tab (see Files above)."

- [ ] **Step 2: `CLAUDE.md`**

In the Showtime handoff gotcha, after "…so its session shows up under the node's Relace." and before "Spec:", add:

"**„Nová prezentace" is the same handoff before there is a deck** (spec: `docs/superpowers/specs/2026-09-13-showtime-new-deck-design.md`). `POST /auth/handoff` answers `mirror` next to the code; the desktop `new_in_showtime { node_id }` (`ws_of`, shared `mint_showtime_handoff`) refuses without a mirror, checks `<mirror>/wip` is inside the root (`showtime_new_dir`) and opens `showtime://new?dir=…&portuni=…&code=…` (`showtime_new_url`). The web's split (`NewFileSplitButton`, decided by the pure `lib/new-file-menu.ts`) exists only with the integration on and Showtime found, and is disabled without a mirror. Portuni does nothing after the link: Showtime creates the bundle, the watcher registers it."

- [ ] **Step 3: Gate and commit**

Run: `scripts/agent-gate.sh`
Expected: `== gate green`.

```bash
git add sites/docs/src/content/docs/guides/working-in-the-app.md CLAUDE.md
git commit -m "docs: a new Showtime presentation from a node"
```

---

### Task 6: Live check on macOS (human)

Needs a Showtime built from its plan's branch installed in `/Applications`, and this branch's app (`APPLE_SIGNING_IDENTITY='Developer ID Application: JAN PÁV (98H25UC996)' scripts/build-signed.sh --no-notarize`, then `cp -R … /Applications/`).

- [ ] Integration off → plain „+ Nový soubor". On, Showtime.app not installed → plain.
- [ ] On + installed, node without a mirror → chevron, „Nová prezentace" disabled, title „Nejdřív vytvoř mirror uzlu".
- [ ] Node with a mirror, Showtime not running → click → Showtime starts, New Deck sheet shows „Portuni · <node>" and `<mirror>/wip` fixed. Create → deck opens, Agent tab reads „Portuni · <node>", the agent calls `portuni_get_context` unprompted, the session appears under the node's Relace, the bundle appears under Files within seconds (watcher), its preview renders.
- [ ] Same with Showtime running and a deck open → a new Showtime window.
- [ ] Stop the sidecar (`tmux send-keys -t portuni-mcp C-c`) → click → error under the toolbar, nothing opens.
- [ ] With an older Showtime installed → „Showtime neumí přijmout deck z Portuni, aktualizujte Showtime".

## Self-review

- Spec coverage: mint `mirror` (T1), desktop command + checks + URL (T2), split button visibility/disabled (T3, T4), inline error (T4), no Portuni step after the link (by construction), docs site + CLAUDE.md (T5), live check + release order (T6, header).
- Names across tasks: `HandoffMinted.mirror`, `mint_showtime_handoff`, `showtime_new_dir`, `showtime_new_url`, `new_in_showtime`, `newFileMenu` / `NO_MIRROR_REASON`, `newInShowtime`, `NewFileSplitButton { hasMirror, onNewFile, onNewPresentation }` — consistent.
