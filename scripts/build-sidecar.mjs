// Compiles the desktop entry into a single-file binary named with the
// Tauri target triple, placed under src-tauri/binaries/. The naming
// pattern <name>-<rustc-host-triple><ext> is required by Tauri's
// externalBin bundler.
//
// Uses execFileSync (not exec) to avoid shell injection and Windows
// quoting issues.
//
// Native binding copy
// -------------------
// libsql/index.js does `require(`@libsql/${target}`)` at runtime — a
// dynamic require that Bun's static analyzer cannot follow, so the
// native .node file does NOT get bundled into the --compile output.
// Bun's runtime falls back to walking up from cwd looking for
// node_modules/, which only happened to work when the sidecar was
// launched from inside the dev project. Production .app launches from
// Finder gave cwd=/, the fallback failed, and the sidecar crashed with
// `Cannot find module '@libsql/darwin-arm64'`.
//
// Fix: copy the native binding directory into src-tauri/sidecar-deps/
// next to the binaries/. Tauri's `bundle.resources` ships it inside the
// .app at Resources/sidecar-deps/. The Tauri host (lib.rs) sets the
// sidecar's cwd to that directory so Bun's ancestor walk finds the
// node_modules/@libsql/<target>/ tree.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, renameSync, existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function detectTargetTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = output.match(/host: (\S+)/);
  if (!match) throw new Error("could not detect rustc host triple - install rustc");
  return match[1];
}

const triple = detectTargetTriple();
const outDir = "src-tauri/binaries";
mkdirSync(outDir, { recursive: true });

const ext = process.platform === "win32" ? ".exe" : "";

function compile(entry, name) {
  const finalPath = join(outDir, `${name}-${triple}${ext}`);
  const tmpPath = join(outDir, `${name}-tmp-${process.pid}${ext}`);
  if (existsSync(tmpPath)) unlinkSync(tmpPath);
  execFileSync(
    "bun",
    ["build", "--compile", "--target=bun", entry, "--outfile", tmpPath],
    { stdio: "inherit" },
  );
  if (existsSync(finalPath)) unlinkSync(finalPath);
  renameSync(tmpPath, finalPath);
  console.log(`built: ${finalPath}`);
}

// Copy every @libsql/<platform> native binding directory present in
// node_modules into src-tauri/sidecar-deps/node_modules/@libsql/. We
// copy ALL platforms (not just the host) so a future cross-build can
// pick the right one without re-running this script per target. npm
// only installs the platforms listed in optionalDependencies for the
// host architecture, so in practice this is just one or two dirs.
function stageNativeBindings() {
  const srcRoot = "node_modules/@libsql";
  const dstRoot = "src-tauri/sidecar-deps/node_modules/@libsql";
  if (!existsSync(srcRoot)) {
    throw new Error(
      `expected ${srcRoot} to exist after npm install; cannot stage native bindings`,
    );
  }
  // Wipe and recreate so deletions in node_modules propagate.
  rmSync("src-tauri/sidecar-deps", { recursive: true, force: true });
  mkdirSync(dstRoot, { recursive: true });
  let staged = 0;
  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Only copy platform-native binding directories (darwin-*, linux-*,
    // win32-*). Pure-JS packages (@libsql/client, @libsql/core,
    // @libsql/hrana-client, @libsql/isomorphic-ws) are statically
    // imported and Bun bundles them into the compiled output already.
    if (!/^(darwin|linux|win32)-/.test(entry.name)) continue;
    cpSync(join(srcRoot, entry.name), join(dstRoot, entry.name), {
      recursive: true,
    });
    staged++;
    console.log(`staged: ${dstRoot}/${entry.name}`);
  }
  if (staged === 0) {
    throw new Error(
      `no @libsql/<platform> native binding found in ${srcRoot}; run npm install`,
    );
  }
}

compile("src/desktop.ts", "portuni-sidecar");
stageNativeBindings();
// MCP stdio binary is added by the Task 7 commit.
