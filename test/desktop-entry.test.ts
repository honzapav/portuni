// Verifies the desktop entry point boots the backend with PORTUNI_DATA_DIR
// as the file-mode libSQL location and announces its bound port to stdout
// in the contract the Tauri sidecar host parses.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { TEST_BEARER } from "./helpers/auth.js";

test("desktop entry boots and reports listening port to stdout", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-desktop-entry-"));
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/desktop.ts"], {
    env: {
      ...process.env,
      PORTUNI_DATA_DIR: tmp,
      PORTUNI_PORT: "0",
      TURSO_URL: "",
      TURSO_AUTH_TOKEN: "",
      PORTUNI_AUTH_TOKEN: TEST_BEARER,
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
    // #455: the device content db is opened at boot in both modes, so by
    // the time the port is announced content.db is on disk next to
    // portuni.db and runners.json.
    assert.equal(existsSync(join(tmp, "content.db")), true, "boot creates content.db");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(() => resolve(), 2000).unref();
    });
    rmSync(tmp, { recursive: true, force: true });
  }
});

// #521: an env-mode sidecar never runs without a bearer. The refusal names
// the variable and reaches the Tauri host on the PORTUNI_BACKEND_ERROR=
// marker line, before any boot work (no content.db).
test("desktop entry without PORTUNI_AUTH_TOKEN refuses to start and says why", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-desktop-entry-noauth-"));
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/desktop.ts"], {
    env: {
      ...process.env,
      PORTUNI_DATA_DIR: tmp,
      PORTUNI_PORT: "0",
      TURSO_URL: "",
      TURSO_AUTH_TOKEN: "",
      PORTUNI_AUTH_TOKEN: "",
      PORTUNI_AUTH_MODE: "env",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 1);
    const marker = stdout.split("\n").find((l) => l.startsWith("PORTUNI_BACKEND_ERROR="));
    assert.ok(marker, `expected a PORTUNI_BACKEND_ERROR= line, got: ${stdout}`);
    assert.match(marker, /PORTUNI_AUTH_TOKEN/);
    assert.doesNotMatch(stdout, /PORTUNI_LISTENING_PORT=/);
    assert.equal(existsSync(join(tmp, "content.db")), false, "no boot work before the refusal");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
