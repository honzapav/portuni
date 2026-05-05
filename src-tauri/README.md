# Portuni Desktop App – Build & Configuration

This branch (`desktop-shell`) packages Portuni as a native macOS app via
Tauri 2 with the Node backend running as a Bun-compiled sidecar.
Everything still works standalone (HTTP MCP server on port 4011, REST
API, etc.); the desktop shell is an additional shipping target, not a
replacement.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Portuni.app (Tauri 2 — Rust + WebKit webview)               │
│                                                             │
│  ┌────────────────────┐    spawn       ┌──────────────────┐ │
│  │  React frontend    │ ─── ─── ───>   │  Node sidecar    │ │
│  │  (Vite-built dist) │                │  (Bun-compiled)  │ │
│  │                    │ <── HTTP ───── │                  │ │
│  │                    │  Bearer auth   │  Embeds: libSQL, │ │
│  │                    │  127.0.0.1     │  MCP SDK, schema │ │
│  └────────────────────┘                └──────────────────┘ │
│            ↑                                    ↑           │
│            └─── Tauri commands ─────────────────┤           │
│                 get_backend_port                │           │
│                 get_auth_token                  │           │
└──────────────────────────────────────────────────┼──────────┘
                                                   │
                                  ┌────────────────┴──────────┐
                                  │  $APP_DATA/portuni.db     │
                                  │  (file: libSQL)           │
                                  │  OR libsql:// remote      │
                                  │  (Turso, set via config)  │
                                  └───────────────────────────┘
```

`$APP_DATA` is `~/Library/Application Support/ooo.workflow.portuni/` on
macOS. The sidecar reads `$APP_DATA/config.json` (via the Tauri host) at
startup and uses Turso when configured, otherwise falls back to a local
file-mode libSQL DB next to the config.

## Prerequisites

```bash
# Rust toolchain (rustup-init from Homebrew)
brew install rustup
rustup-init -y --default-toolchain stable --profile minimal --no-modify-path

# Tauri CLI 2.x (compiled from source — first install ~10 min)
. "$HOME/.cargo/env"
cargo install tauri-cli --version "^2.0" --locked

# Bun (for compiling the Node sidecar to a single binary)
npm install -g bun
```

Existing Node 20 + npm are still required for the React build.

## Building the DMG

```bash
# From the repo root, on the desktop-shell branch:
. "$HOME/.cargo/env"
cargo tauri build --bundles dmg
```

This runs, in order:
1. `npm --prefix app run build` — Vite builds the React app to
   `app/dist/`.
2. `node scripts/build-sidecar.mjs` — Bun compiles `src/desktop.ts` to
   `src-tauri/binaries/portuni-sidecar-<rustc-host-triple>` (~97 MB —
   includes Bun runtime + libSQL native).
3. `cargo build --release` — Rust builds the Tauri shell.
4. The DMG is bundled to
   `src-tauri/target/release/bundle/dmg/Portuni_0.1.0_aarch64.dmg` (~41
   MB compressed).

First Rust build is slow (compiles ~520 crates). Subsequent builds with
unchanged Rust deps finish in 30–60 s.

## Configuration: Turso vs local

The desktop sidecar respects an optional `$APP_DATA/config.json`:

```json
{
  "turso_url": "libsql://your-db-name.turso.io"
}
```

- **No config or empty `turso_url`** → desktop uses
  `file:$APP_DATA/portuni.db`. Each desktop install gets its own
  isolated DB.
- **`turso_url` set + matching token in Keychain** → sidecar opens
  `libsql://...` with the token. Use this when you want the desktop to
  read/write the same Turso instance as the standalone server.

Restart the app after editing `config.json`.

### Setting the Turso token

The token is the org's shared Turso service credential — see the
Phase 1.5 multi-user note in `docs/vision/portuni-as-workspace.md`
for why this is a shared key today and `docs/specs.md` → "Security
model" for where per-user identity lands later. It lives in the OS
keychain (macOS Keychain Services on Darwin; Secret Service /
Credential Manager on Linux/Windows), never in `config.json`.

On a fresh install where `turso_url` is set but no keychain entry
exists yet, the app shows a one-shot modal asking for the token —
paste it, click "Uložit a restartovat", the sidecar reboots with
the token and the modal goes away forever (until the keychain entry
is removed).

For scripted setup or to overwrite an existing entry, the same Tauri
commands are also available from the webview dev tools:

```js
await window.__TAURI__.core.invoke('set_turso_token', { token: '<jwt>' })
await window.__TAURI__.core.invoke('clear_turso_token')
```

Installs that still carry a plaintext `turso_auth_token` in
`config.json` are migrated automatically on first launch — the value
is copied into the keychain and the field is stripped from
`config.json`. Look for `migrated turso_auth_token from config.json
to Keychain` in `~/Library/Logs/ooo.workflow.portuni/sidecar.log`.

## Auth & loopback boundary

The HTTP middleware auth gate (`src/infra/server-config.ts`) refuses to
boot in any team-shaped configuration without a bearer token. For
desktop mode this matters when `turso_url` is a remote `libsql://` —
the Tauri host generates a random 48-char token at every launch, sets
it as `PORTUNI_AUTH_TOKEN` in the sidecar env, and exposes it to the
frontend via the `get_auth_token` Tauri command. The React `apiFetch`
helper attaches it as `Authorization: Bearer <token>` on every request.

Local-only desktop installs (no `turso_url` configured) still get the
token — small extra defense against other local processes hitting the
loopback port.

## CORS & origins

The webview ships requests from `tauri://localhost` (and on some Tauri
2 builds `http://tauri.localhost`). The Rust host passes
`PORTUNI_ALLOWED_ORIGINS` containing all three variants so the
backend's existing origin allowlist admits them.

The CORS preflight allow-headers list now includes `Authorization`
(without it the browser would reject the actual request after our
preflight succeeds), and allow-methods includes `PATCH` (used by
`updateNode`, `updateEvent`, etc.).

## Running

```bash
# Mount the DMG, drag Portuni to /Applications, launch. The first
# launch triggers Gatekeeper for an unsigned binary — right-click →
# Open → confirm once.

# Or run the .app directly during dev (bypasses DMG roundtrip):
./src-tauri/target/release/bundle/macos/Portuni.app/Contents/MacOS/app
```

DevTools are enabled for the release build (`tauri = { features =
["devtools"] }`). Right-click in the window → Inspect Element opens
Web Inspector — useful when fetches behave oddly.

The sidecar's stderr is captured and prefixed with `[sidecar:err]` in
the parent process's stdout. With `PORTUNI_LOG_REQUESTS=1` (set
automatically by the Tauri host) every request gets a one-line access
log: `[req] GET /graph origin=tauri://localhost host=127.0.0.1:54321
-> 200 195ms`.

## MCP stdio mode

`src/mcp/stdio-entry.ts` wires `createMcpServer()` to a
`StdioServerTransport`. Use it in `claude_desktop_config.json` to talk
to the desktop's local Portuni DB without going through the HTTP
server:

```json
{
  "mcpServers": {
    "portuni-local": {
      "command": "/path/to/Portuni.app/Contents/MacOS/portuni-sidecar",
      "env": {
        "PORTUNI_DATA_DIR": "~/Library/Application Support/ooo.workflow.portuni"
      }
    }
  }
}
```

Note: the bundle currently ships only the HTTP sidecar. To use stdio
add the second compile target to `scripts/build-sidecar.mjs`
(`src/mcp/stdio-entry.ts` → `portuni-mcp-stdio-<triple>`) and uncomment
the second `compile()` call there.

## Troubleshooting

**"Origin not allowed" 403**  
The webview origin isn't in `PORTUNI_ALLOWED_ORIGINS`. Check the
`[req]` log to see what the actual origin header is, then add it in
`src-tauri/src/lib.rs`'s `allowed_origins` array.

**"Refusing to start: PORTUNI_AUTH_TOKEN unset"**  
The sidecar booted without the random per-launch token. This means
Tauri's `env_clear()` + explicit `PORTUNI_AUTH_TOKEN` flow didn't fire,
usually because the binary was launched outside the Tauri shell. When
running the `.app` standalone for testing, the host wires it up
correctly; running the bare `portuni-sidecar` binary directly will hit
this only if `TURSO_URL` is also remote.

**"backend sidecar did not start within 30s"**  
The frontend polled `get_backend_port` for 30 s and got `null`. Common
causes:
- Sidecar crashed at startup. Check the launch log
  (`/tmp/portuni-app.log` if launched via shell) for `[sidecar]` and
  `[sidecar:err]` lines.
- Webview opened before the Tauri app's setup hook ran (race we don't
  expect, but possible). Restart the app.

**Bun build fails on libSQL native binding**  
Fall back to `pkg` (`npm i -g pkg && pkg dist/desktop.js --output ...`)
or bundle Node as a separate binary alongside `dist/desktop.js` as a
resource. The naming convention for `externalBin` is preserved either
way.

## Rolling back

The whole desktop stack lives on the `desktop-shell` branch in the
`portuni-desktop` worktree. To remove:

```bash
cd /Users/honzapav/Dev/projekty/portuni
git worktree remove --force ../portuni-desktop
git branch -D desktop-shell
```

`main` is untouched. Local data — `~/Library/Application
Support/ooo.workflow.portuni/` — survives the worktree removal; delete
it manually if you also want the desktop's local DB and config gone.
