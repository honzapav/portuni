// Smoke test for the stdio MCP entry point. Spawns it as a subprocess,
// sends an `initialize` JSON-RPC frame on stdin, and asserts a parseable
// response on stdout.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

test("stdio MCP entry responds to initialize over JSON-RPC", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-mcp-stdio-"));
  const child = spawn("npx", ["tsx", "src/mcp/stdio-entry.ts"], {
    env: {
      ...process.env,
      PORTUNI_DATA_DIR: tmp,
      TURSO_URL: "",
      TURSO_AUTH_TOKEN: "",
      PORTUNI_AUTH_TOKEN: "",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  try {
    const initMsg =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }) + "\n";

    // Wait until child is ready to receive on stdin.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    child.stdin.write(initMsg);

    const response = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const newline = buf.indexOf("\n");
        if (newline >= 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, newline));
        }
      });
      child.on("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`mcp-stdio exited with code ${code}`));
        }
      });
    });

    const parsed = JSON.parse(response) as {
      id: number;
      result?: { serverInfo?: { name?: string } };
    };
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result?.serverInfo?.name, "portuni");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(() => resolve(), 2000).unref();
    });
    rmSync(tmp, { recursive: true, force: true });
  }
});
