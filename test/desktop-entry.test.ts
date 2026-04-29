// Verifies the desktop entry point boots the backend with PORTUNI_DATA_DIR
// as the file-mode libSQL location and announces its bound port to stdout
// in the contract the Tauri sidecar host parses.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

test("desktop entry boots and reports listening port to stdout", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-desktop-entry-"));
  const child = spawn("npx", ["tsx", "src/desktop.ts"], {
    env: {
      ...process.env,
      PORTUNI_DATA_DIR: tmp,
      PORTUNI_PORT: "0",
      TURSO_URL: "",
      TURSO_AUTH_TOKEN: "",
      PORTUNI_AUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("desktop entry did not announce port within 10s"));
      }, 10_000);
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const match = buf.match(/PORTUNI_LISTENING_PORT=(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`desktop entry exited early with code ${code}`));
        }
      });
    });

    assert.ok(port > 0, "expected a positive bound port");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(() => resolve(), 2000).unref();
    });
    rmSync(tmp, { recursive: true, force: true });
  }
});
