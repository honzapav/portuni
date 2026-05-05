// Compiles the desktop entry into a single-file binary named with the
// Tauri target triple, placed under src-tauri/binaries/. The naming
// pattern <name>-<rustc-host-triple><ext> is required by Tauri's
// externalBin bundler.
//
// Uses execFileSync (not exec) to avoid shell injection and Windows
// quoting issues.

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
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

compile("src/desktop.ts", "portuni-sidecar");
// MCP stdio binary is added by the Task 7 commit.
