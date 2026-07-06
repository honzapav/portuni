# HTML viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `.html`/`.htm` files in the workspace editor pane via a sandboxed iframe — full scripts + external resources, isolated from the Portuni token.

**Architecture:** Preview mode dispatches by file extension: `.html`/`.htm` → new `HtmlPreview`, else `MarkdownPreview`. On web (Vite) the iframe uses `srcDoc` (no app CSP there). On desktop the strict app CSP would be inherited by `srcdoc`/`blob:` frames, so the iframe `src` points at a new Tauri custom URI-scheme protocol (`portuni-html://`) whose Rust handler reads the mirror file from disk and returns it with its own permissive CSP — a separate origin, framed with `sandbox="allow-scripts"` and no `allow-same-origin`, so it cannot reach our DOM, token, or API.

**Tech Stack:** Node + libSQL (Turso), TypeScript, `node:test` (backend tests in `test/*.test.ts`, run via `node --import tsx --test`); React 19 + Vite + Tailwind 4 (no FE unit-test runner — React work is verified manually, per the markdown-editor plan precedent); Tauri 2 / Rust (`cargo` `#[cfg(test)]` unit tests for pure helpers). Source spec: `docs/superpowers/specs/2026-06-30-html-viewer-design.md`.

## Global Constraints

- **Security tier:** iframe is always `sandbox="allow-scripts"` with **no `allow-same-origin`** (and no `allow-forms`/`allow-popups` unless a step says so). Scripts + external resources allowed; exfiltration is the accepted tradeoff; the token must stay unreachable.
- **Do not weaken the main app CSP.** The only permitted `tauri.conf.json` CSP change is adding a `frame-src` directive for the preview origin. `script-src` of the main app stays `'self'`.
- **No new backend content endpoint.** HTML is already served/editable via `GET/PUT /nodes/:id/file`; only an additive `local_path` field is added to that response.
- **Czech UI strings, with diacritics. Never emoji in code.** Match surrounding code style.
- **Lint/types:** backend changes must pass `npm run lint:strict` and `npm run typecheck`. FE must pass `tsc -b` (via `npm --prefix apps/web run build`).
- **v1 scope:** single-file HTML. No relative-asset multi-file apps inside the preview.

---

### Task 1: Backend — expose `local_path` on the file-content response

The desktop protocol URL needs the file's absolute on-disk path. The backend already resolves it (`abs`) when reading; expose it additively. The remote (central/no-mirror) read path returns `null`.

**Files:**
- Modify: `apps/server/domain/sync/file-content.ts:62-90` (`readFileContent` return)
- Modify: `apps/server/domain/sync/file-content-remote.ts:133-170` (`readFileContentRemote` return)
- Modify: `apps/server/shared/api-types.ts:95-100` (`FileContentResponse`)
- Modify: `apps/server/api/files.ts:80-86` (payload)
- Test: `test/file-content.test.ts` (append)

**Interfaces:**
- Produces: `FileContentResponse.local_path: string | null` — absolute filesystem path of the file when read from a local mirror, `null` when read remotely.

- [ ] **Step 1: Append the failing test**

Add to `test/file-content.test.ts` inside the `describe("readFileContent", ...)` block:

```typescript
it("returns the absolute local_path of the file on disk", async () => {
  const { db, nodeId } = await makeSharedDb();
  const mirrorRoot = join(workspace, "mirror");
  await registerMirror("U1", nodeId, mirrorRoot);
  await mkdir(join(mirrorRoot, "wip"), { recursive: true });
  await writeFile(join(mirrorRoot, "wip", "page.html"), "<h1>hi</h1>");

  const r = await readFileContent(db, {
    userId: "U1",
    nodeId,
    relPath: "wip/page.html",
  });

  assert.equal(r.local_path, join(mirrorRoot, "wip", "page.html"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/file-content.test.ts`
Expected: FAIL — the returned object has no `local_path` property (assertion `undefined === <path>`).

- [ ] **Step 3: Add `local_path` to `readFileContent`**

In `apps/server/domain/sync/file-content.ts`, update the return type and the returned object of `readFileContent`:

```typescript
export async function readFileContent(
  _db: Client,
  a: { userId: string; nodeId: string; relPath: string },
): Promise<{
  content: string;
  version: string;
  filename: string;
  mime_type: string | null;
  local_path: string;
}> {
```

and the return statement (after the `isEditableMime`/NUL check):

```typescript
  return {
    content: buf.toString("utf8"),
    version: sha256Buffer(buf),
    filename,
    mime_type: mime,
    local_path: abs,
  };
```

- [ ] **Step 4: Add `local_path: null` to `readFileContentRemote`**

In `apps/server/domain/sync/file-content-remote.ts`, update the return type and final return of `readFileContentRemote`:

```typescript
): Promise<{
  content: string;
  version: string;
  filename: string;
  mime_type: string | null;
  local_path: string | null;
}> {
```

```typescript
  return {
    content: buf.toString("utf8"),
    version: sha256Buffer(buf),
    filename,
    mime_type: mime,
    local_path: null,
  };
```

- [ ] **Step 5: Add the field to `FileContentResponse` and the handler payload**

In `apps/server/shared/api-types.ts`, extend the type:

```typescript
export type FileContentResponse = {
  content: string; // UTF-8 file content
  version: string; // sha256 hash of on-disk bytes
  filename: string; // basename of file
  mime_type: string | null;
  // Absolute filesystem path when read from a local mirror; null when read
  // remotely (central / no mirror). Used by the desktop HTML preview to
  // build its protocol URL.
  local_path: string | null;
};
```

In `apps/server/api/files.ts`, add to the `payload`:

```typescript
    const payload: FileContentResponse = {
      content: r.content,
      version: r.version,
      filename: r.filename,
      mime_type: r.mime_type,
      local_path: r.local_path,
    };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --import tsx --test test/file-content.test.ts`
Expected: PASS (all cases, including the new one).

- [ ] **Step 7: Typecheck + lint**

Run: `npm run typecheck && npm run lint:strict`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/server/domain/sync/file-content.ts apps/server/domain/sync/file-content-remote.ts apps/server/shared/api-types.ts apps/server/api/files.ts test/file-content.test.ts
git commit -m "feat(files): expose absolute local_path on file-content response"
```

---

### Task 2: Frontend — default `.html` to preview mode on open

`App.tsx` already chooses the initial editor mode by extension (`isMarkdownPath`). Add an `isHtmlPath` helper and include it in that choice.

**Files:**
- Modify: `apps/web/src/App.tsx:46` (add helper) and `apps/web/src/App.tsx:467` (mode choice)

**Interfaces:**
- Produces: `isHtmlPath(relPath: string): boolean` — true for `.html`/`.htm` (case-insensitive). Reused by Task 4.

- [ ] **Step 1: Add the `isHtmlPath` helper**

In `apps/web/src/App.tsx`, directly below the existing `isMarkdownPath` function (line 46):

```typescript
function isHtmlPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}
```

- [ ] **Step 2: Include HTML in the default-preview choice**

In `apps/web/src/App.tsx`, change the mode line (currently line 467):

```typescript
    setEditorMode(isMarkdownPath(relPath) || isHtmlPath(relPath) ? "preview" : "edit");
```

- [ ] **Step 3: Typecheck the web build**

Run: `npm --prefix apps/web run build`
Expected: builds with no TS errors. (`isHtmlPath` is referenced now and again in Task 4; if your linter flags it as unused before Task 4, that resolves in Task 4 — but it IS used here on line 467, so there should be no unused warning.)

- [ ] **Step 4: Manual verification (Vite)**

Start the frontend: `varlock run -- npm --prefix apps/web run dev`. Open `http://localhost:4010`, go to a node with a mirror, Files tab. Create a file `wip/test.html` in that node's mirror on disk (`echo '<h1>hello</h1>' > <mirror>/wip/test.html`), wait for it to appear, click it.
Expected: the editor opens in **Náhled** mode (not Editace). (Rendering still shows raw markdown-of-HTML until Task 4 — this step only verifies the default mode.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(editor): default .html files to preview mode on open"
```

---

### Task 3: Frontend — expose `localPath` from the file editor hook

`HtmlPreview` (Task 4) needs the file's absolute path on desktop. The hook already fetches `FileContentResponse`; capture and expose its `local_path`.

**Files:**
- Modify: `apps/web/src/lib/use-file-editor.ts`

**Interfaces:**
- Produces: `FileEditor.localPath: string | null` — the absolute path from the last successful load, or `null`.

- [ ] **Step 1: Add `localPath` state and set it on load**

In `apps/web/src/lib/use-file-editor.ts`, add state alongside the existing `useState` calls:

```typescript
  const [localPath, setLocalPath] = useState<string | null>(null);
```

In the load `.then((r) => { ... })` block, after `setContent(r.content);`, add:

```typescript
        setLocalPath(r.local_path);
```

- [ ] **Step 2: Return `localPath` from the hook**

Find the object the hook returns (the `return { ... }` exposing `content`, `status`, `save`, etc.) and add `localPath` to it:

```typescript
    localPath,
```

- [ ] **Step 3: Typecheck the web build**

Run: `npm --prefix apps/web run build`
Expected: no TS errors. `r.local_path` resolves because Task 1 added it to `FileContentResponse`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/use-file-editor.ts
git commit -m "feat(editor): expose localPath from useFileEditor"
```

---

### Task 4: Frontend — `HtmlPreview` component + preview dispatch

The component renders HTML in a sandboxed iframe (desktop: protocol `src`; web: `srcDoc`) and offers a "Kopírovat cestu" button. `EditorBody` dispatches to it for HTML files in preview mode.

**Files:**
- Create: `apps/web/src/components/HtmlPreview.tsx`
- Modify: `apps/web/src/components/EditorPane.tsx` (thread extension into `EditorBody`, dispatch in preview)
- Modify: `apps/web/src/App.tsx` (export/share `isHtmlPath`, pass `relPath` to fullscreen mount if not already)

**Interfaces:**
- Consumes: `FileEditor.localPath` (Task 3), `isHtmlPath` (Task 2), `isTauri()` from `../lib/backend-url`.
- Produces: `HtmlPreview` default export with props `{ content: string; localPath: string | null }`.

- [ ] **Step 1: Export `isHtmlPath` from App.tsx so EditorPane can reuse it**

In `apps/web/src/App.tsx`, change the helper added in Task 2 to be exported:

```typescript
export function isHtmlPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}
```

- [ ] **Step 2: Create `HtmlPreview.tsx`**

Create `apps/web/src/components/HtmlPreview.tsx`:

```tsx
// Rendered HTML preview (read-only) in a sandboxed iframe. Scripts + external
// resources are allowed, but the frame runs with NO allow-same-origin, so it
// sits in an opaque origin and cannot reach our DOM, cookies, token or API.
//
// Web (Vite): there is no app CSP, so srcDoc executes scripts directly.
// Desktop (Tauri): the strict app CSP is inherited by srcdoc/blob frames and
// would block scripts, so we load the file over the portuni-html:// custom
// protocol (its own origin + permissive CSP, served by Rust from disk).
import { useState } from "react";
import { isTauri } from "../lib/backend-url";

// Build the protocol URL for the desktop webview. The absolute path is
// percent-encoded as the URL path; the Rust handler decodes + scope-checks it.
function protocolUrl(absPath: string): string {
  return `portuni-html://localhost/${encodeURIComponent(absPath)}`;
}

export default function HtmlPreview({
  content,
  localPath,
}: {
  content: string;
  localPath: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const useProtocol = isTauri() && localPath !== null;

  async function copyPath() {
    if (!localPath) return;
    try {
      await navigator.clipboard.writeText(localPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject without a user gesture / permission; ignore.
    }
  }

  return (
    <div className="flex h-full flex-col">
      {localPath && (
        <div className="flex justify-end border-b border-[var(--color-border)] px-2 py-1">
          <button
            onClick={copyPath}
            title="Kopírovat cestu k souboru"
            className="rounded px-2 py-0.5 text-[11.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            {copied ? "Zkopírováno" : "Kopírovat cestu"}
          </button>
        </div>
      )}
      <iframe
        title="HTML náhled"
        sandbox="allow-scripts"
        {...(useProtocol
          ? { src: protocolUrl(localPath as string) }
          : { srcDoc: content })}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
```

- [ ] **Step 3: Dispatch to `HtmlPreview` in `EditorBody`**

In `apps/web/src/components/EditorPane.tsx`:

Add imports at the top:

```tsx
import { isHtmlPath } from "../App";
import HtmlPreview from "./HtmlPreview";
```

Add a `relPath` prop to `EditorBody`. Change its signature:

```tsx
export function EditorBody({
  ed,
  relPath,
  mode,
  onModeChange,
  capWidth = false,
}: {
  ed: FileEditor;
  relPath: string;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  capWidth?: boolean;
}) {
```

Replace the preview branch (currently `<MarkdownPreview value={ed.content} />` at lines 122-126):

```tsx
          {mode === "edit" ? (
            <MarkdownEditor value={ed.content} onChange={ed.onChange} onSave={(v) => ed.save(v)} />
          ) : isHtmlPath(relPath) ? (
            <HtmlPreview content={ed.content} localPath={ed.localPath} />
          ) : (
            <MarkdownPreview value={ed.content} />
          )}
```

- [ ] **Step 4: Pass `relPath` into both `EditorBody` mounts**

In `apps/web/src/components/EditorPane.tsx`, the `EditorPane` component renders `EditorBody` (line 60). Pass `relPath`:

```tsx
      <EditorBody ed={ed} relPath={relPath} mode={mode} onModeChange={onModeChange} />
```

Find the fullscreen shell that also mounts `EditorBody` (the component used at `apps/web/src/App.tsx:1040-1046`, which receives `relPath`). Open that component file, and add `relPath={relPath}` to its `<EditorBody ... />`. Search to confirm every `<EditorBody` usage now passes `relPath`:

```bash
grep -rn "<EditorBody" apps/web/src
```
Expected: every match passes a `relPath` prop.

- [ ] **Step 5: Typecheck the web build**

Run: `npm --prefix apps/web run build`
Expected: no TS errors. (`ed.localPath` resolves via Task 3.)

- [ ] **Step 6: Manual verification (Vite — full scripts in sandbox)**

Start the frontend (`varlock run -- npm --prefix apps/web run dev`), open `http://localhost:4010`. In a node mirror create `wip/chart.html`:

```html
<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
<body class="p-6 bg-slate-100"><h1 class="text-2xl font-bold">Sandbox OK</h1>
<canvas id="c" width="200" height="60"></canvas>
<script>const x=document.getElementById('c').getContext('2d');x.fillStyle='teal';x.fillRect(0,0,200,60);</script>
</body></html>
```

Click the file.
Expected: opens in Náhled; the heading is Tailwind-styled and the teal rectangle is drawn (external CSS + inline JS both run). Switch to Editace → raw HTML source in CodeMirror. Switch back to Náhled → renders again. In browser devtools, the iframe has no `allow-same-origin` and `frame.contentWindow` access from the parent throws (opaque origin). "Kopírovat cestu" shows nothing in web (localPath is null in Vite proxy mode unless the mirror read returns it — if null, the button is hidden; that is expected, the path button is primarily a desktop affordance).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/HtmlPreview.tsx apps/web/src/components/EditorPane.tsx apps/web/src/App.tsx
git commit -m "feat(editor): render .html files in a sandboxed iframe preview"
```

---

### Task 5: Desktop — `portuni-html` custom protocol + scope guard + CSP frame-src

The desktop iframe loads `portuni-html://localhost/<encoded-abs-path>`. Register the protocol in Rust; the handler scope-checks the path against the workspace root and serves the file with its own permissive CSP. Add the one allowed CSP change (`frame-src`).

**Files:**
- Modify: `apps/desktop/tauri.conf.json:26` (add `frame-src`)
- Modify: `apps/desktop/src/lib.rs` (scope-guard helper + `#[cfg(test)]` tests + `.register_uri_scheme_protocol(...)` on the builder)

**Interfaces:**
- Consumes: `load_config(data_dir).portuni_workspace_root`, the URL produced by `protocolUrl()` in Task 4 (`portuni-html://localhost/<percent-encoded absolute path>`).
- Produces: a `portuni-html` URI-scheme handler serving `text/html` with a permissive CSP; pure helper `path_within_root(root: &Path, candidate: &Path) -> bool`.

- [ ] **Step 1: Add the scope-guard helper with failing tests**

In `apps/desktop/src/lib.rs`, add near the other free functions:

```rust
/// True when `candidate`, after lexical normalization (resolving `.`/`..`),
/// stays inside `root`. Scopes the portuni-html protocol to the workspace
/// mirror so a crafted URL cannot read arbitrary files (e.g. ../../etc/passwd).
/// Lexical only — does not resolve symlinks; the mirror is trusted not to
/// contain symlinks escaping the workspace.
fn path_within_root(root: &std::path::Path, candidate: &std::path::Path) -> bool {
    use std::path::Component;
    let mut normalized = std::path::PathBuf::new();
    for comp in candidate.components() {
        match comp {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.starts_with(root)
}
```

Add tests to the existing test module (`#[cfg(test)] mod local_only_path_tests` block, or a new `#[cfg(test)] mod protocol_scope_tests`):

```rust
#[cfg(test)]
mod protocol_scope_tests {
    use super::path_within_root;
    use std::path::Path;

    #[test]
    fn allows_file_inside_root() {
        assert!(path_within_root(
            Path::new("/ws"),
            Path::new("/ws/nodes/abc/wip/page.html")
        ));
    }

    #[test]
    fn rejects_traversal_escape() {
        assert!(!path_within_root(
            Path::new("/ws"),
            Path::new("/ws/../etc/passwd")
        ));
    }

    #[test]
    fn rejects_unrelated_root() {
        assert!(!path_within_root(Path::new("/ws"), Path::new("/etc/passwd")));
    }
}
```

- [ ] **Step 2: Run the Rust tests to verify the scope tests pass and compile**

Run: `cd apps/desktop && cargo test path_within_root protocol_scope_tests 2>&1 | tail -20`
Expected: the three `protocol_scope_tests` pass. (If `allows_file_inside_root` fails, fix the normalization until all three pass before continuing.)

- [ ] **Step 3: Register the protocol on the Tauri builder**

In `apps/desktop/src/lib.rs`, in the `tauri::Builder::default()` chain (before `.invoke_handler(...)` at line 1103), add:

```rust
        .register_uri_scheme_protocol("portuni-html", |ctx, request| {
            use tauri::http::Response;
            let app = ctx.app_handle();
            // URL: portuni-html://localhost/<percent-encoded absolute path>
            let raw = request.uri().path().trim_start_matches('/');
            let decoded = percent_encoding::percent_decode_str(raw)
                .decode_utf8_lossy()
                .to_string();
            let candidate = std::path::PathBuf::from(&decoded);

            let data_dir = app.path().app_data_dir().unwrap_or_default();
            let root = load_config(&data_dir).portuni_workspace_root.map(std::path::PathBuf::from);

            let forbidden = || {
                Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body(b"forbidden".to_vec())
                    .unwrap()
            };

            let Some(root) = root else { return forbidden() };
            if !path_within_root(&root, &candidate) {
                error!("portuni-html refused out-of-scope path: {decoded}");
                return forbidden();
            }
            match std::fs::read(&candidate) {
                Ok(bytes) => Response::builder()
                    .status(200)
                    .header("Content-Type", "text/html; charset=utf-8")
                    // Own permissive CSP: this origin is sandboxed (no
                    // allow-same-origin) and isolated from the app, so the
                    // app CSP is intentionally NOT applied here.
                    .header("Content-Security-Policy", "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'")
                    .body(bytes)
                    .unwrap(),
                Err(e) => {
                    error!("portuni-html read failed for {decoded}: {e}");
                    Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain")
                        .body(b"not found".to_vec())
                        .unwrap()
                }
            }
        })
```

Ensure `percent-encoding` is available. Check `apps/desktop/Cargo.toml`; if it is not a dependency, add it:

```bash
cd apps/desktop && cargo add percent-encoding
```

(`url` is already a dependency — used by `open_external` — and re-exports nothing usable here, so add `percent-encoding` explicitly.)

- [ ] **Step 4: Add the `frame-src` directive to the app CSP**

In `apps/desktop/tauri.conf.json`, change the `csp` string (line 26) to append a `frame-src` directive (this is the ONLY permitted CSP change — it allows *framing* the isolated origin, not script execution in the main app):

```json
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: asset: http://asset.localhost; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' portuni-html: http://portuni-html.localhost"
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd apps/desktop && cargo build 2>&1 | tail -20`
Expected: compiles. (If `register_uri_scheme_protocol`'s closure signature differs in the installed Tauri 2 version, adjust the closure params to match — the body logic stays the same. Verify the exact signature with `cargo doc --open` or the `@tauri-apps` version in `Cargo.toml`.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib.rs apps/desktop/tauri.conf.json apps/desktop/Cargo.toml apps/desktop/Cargo.lock
git commit -m "feat(desktop): portuni-html custom protocol for sandboxed HTML preview"
```

---

### Task 6: Desktop — end-to-end verification

Verify the full desktop path renders scripted HTML in-pane while remaining isolated. No code change; this gates the feature as actually working on the daily driver.

**Files:** none (verification only).

- [ ] **Step 1: Build the sidecar and run the desktop app in dev**

Run:
```bash
npm run build:sidecar
cd apps/desktop && cargo tauri dev
```
Expected: app launches, sidecar boots (check `~/Library/Logs/<bundle_id>/sidecar.log`).

- [ ] **Step 2: Render a scripted HTML file in the pane**

In a node mirror, create `wip/chart.html` (same content as Task 4 Step 6). In the app, open that node's Files tab and click the file.
Expected: opens in Náhled; Tailwind-styled heading + teal canvas rectangle render — i.e. external CDN script and inline JS BOTH execute inside the desktop pane (proving the custom protocol escaped the strict app CSP).

- [ ] **Step 3: Confirm isolation**

In the app's devtools console, run:
```js
document.querySelector('iframe[title="HTML náhled"]').contentWindow.document
```
Expected: throws a cross-origin/SecurityError (opaque sandboxed origin — the frame cannot be reached from the app, so it cannot read the token or call the API).

- [ ] **Step 4: Confirm scope guard + path button + regressions**

- "Kopírovat cestu" copies the absolute path (paste to check).
- Manually hit `portuni-html://localhost/%2Fetc%2Fpasswd` by editing the iframe `src` in devtools (or load it in a temp tab) → 403 (out of scope).
- Open a `.md` file → MarkdownPreview renders and edit/save still work (no regression).
- Open `chart.html` in Editace → raw HTML editable; save writes to disk.

- [ ] **Step 5: Record the result**

Note in the PR/commit description that desktop e2e passed (scripted render + isolation + scope guard + md regression). If shipping a new `.app`, follow CLAUDE.md: `cargo tauri build` + copy to `/Applications/`.

---

### Task 7 (OPTIONAL — nice-to-have, not a blocker): "Otevřít v prohlížeči"

Only do this if cheap. The shell allowlist blocks `file:`, so opening the on-disk HTML in the external browser needs a small native command. "Kopírovat cestu" (Task 4) already covers the must-have.

**Files:**
- Modify: `apps/desktop/src/lib.rs` (new command + register), `apps/web/src/lib/backend-url.ts` (wrapper), `apps/web/src/components/HtmlPreview.tsx` (button)

**Interfaces:**
- Produces: Tauri command `open_path_external(path: String)`; FE wrapper `openPathExternal(path: string): Promise<void>`.

- [ ] **Step 1: Add the native command (scope-guarded)**

In `apps/desktop/src/lib.rs`:

```rust
#[tauri::command]
fn open_path_external(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().unwrap_or_default();
    let root = load_config(&data_dir)
        .portuni_workspace_root
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "no workspace root".to_string())?;
    let candidate = std::path::PathBuf::from(&path);
    if !path_within_root(&root, &candidate) {
        return Err("path out of workspace scope".into());
    }
    info!("open_path_external: {path}");
    open::that(&candidate).map_err(|e| e.to_string())
}
```

Register it in the `invoke_handler` list (line 1103-1130), e.g. after `open_in_finder,`:

```rust
            open_path_external,
```

Note: `tauri::AppHandle` and `tauri::Manager` (for `app.path()`) must be in scope — they already are (used elsewhere in the file).

- [ ] **Step 2: Add the FE wrapper**

In `apps/web/src/lib/backend-url.ts`, next to `openInFinder`:

```typescript
// Open a local file in the OS default app (for .html: the default browser).
// Scope-guarded in Rust to the workspace root. No-op in browser mode.
export async function openPathExternal(path: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_path_external", { path });
}
```

- [ ] **Step 3: Add the button in `HtmlPreview`**

In `apps/web/src/components/HtmlPreview.tsx`, import and add a button next to "Kopírovat cestu" (only when `isTauri() && localPath`):

```tsx
import { isTauri, openPathExternal } from "../lib/backend-url";
```

```tsx
          {isTauri() && (
            <button
              onClick={() => localPath && void openPathExternal(localPath)}
              title="Otevřít v prohlížeči"
              className="rounded px-2 py-0.5 text-[11.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            >
              Otevřít v prohlížeči
            </button>
          )}
```

- [ ] **Step 4: Build + manual check**

Run: `npm --prefix apps/web run build` then `cd apps/desktop && cargo build`.
Expected: compiles. In `cargo tauri dev`, the button opens the `.html` in the default external browser; an out-of-scope path is rejected.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib.rs apps/web/src/lib/backend-url.ts apps/web/src/components/HtmlPreview.tsx
git commit -m "feat(desktop): open HTML file in external browser (scope-guarded)"
```

---

## Notes for the executor

- **Where the fullscreen `EditorBody` lives:** Task 4 Step 4 — `apps/web/src/App.tsx:1040-1046` mounts a fullscreen editor shell that renders `EditorBody`. Grep `<EditorBody` to find every mount and ensure all pass `relPath`. Missing one means HTML files render as markdown in that surface.
- **Tauri version drift:** the `register_uri_scheme_protocol` closure signature and `tauri::http` response builder API can vary across Tauri 2 minor versions. If Step 3/5 of Task 5 fails to compile, check the `@tauri-apps`/`tauri` version in `apps/desktop/Cargo.toml` and match the current signature; the handler *logic* (decode → scope-check → read → serve with own CSP) is the contract, not the exact types.
- **central/no-mirror mode:** `local_path` is `null` there, so desktop falls back to `srcDoc` (static-only under CSP). That matches the "central file content = phase B" reality and is out of scope to improve here.
