// Smoke tests for the portuni-guard.sh PreToolUse hook. The hook is shell +
// embedded Python; we run it as a subprocess to verify the contract:
//
//   write tool with valid target + server unreachable -> exit 0 (soft fallback)
//   write tool with no recoverable target              -> exit 2 (fail closed)
//   non-write tool                                     -> exit 0
//   malformed JSON payload                             -> exit 0 (fail open)
//   /scope answers 401/403 (token missing or wrong)    -> exit 2 (#521)
//
// We point PORTUNI_URL at a deliberately closed port so the /scope call
// fails and we can verify the parser branches without a running server.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

const SCRIPT = resolve(process.cwd(), "scripts/portuni-guard.sh");
const UNREACHABLE = "http://127.0.0.1:65530";

function run(
  stdin: string,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stderr: string }> {
  const childEnv: Record<string, string | undefined> = { ...process.env, PORTUNI_URL: UNREACHABLE };
  delete childEnv.PORTUNI_GUARD_TOKEN;
  delete childEnv.PORTUNI_GUARD_TOKEN_VAR;
  delete childEnv.PORTUNI_AUTH_TOKEN;
  Object.assign(childEnv, env);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(SCRIPT, [], {
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: code ?? -1, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("portuni-guard.sh", () => {
  it("write tool with no recoverable target -> exit 2 (fail closed)", async () => {
    const r = await run(JSON.stringify({ tool_name: "Edit", tool_input: {} }));
    assert.equal(r.code, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /cannot determine target path/);
  });

  it("write tool with valid target + server unreachable -> exit 0 (soft fallback)", async () => {
    const r = await run(
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/tmp/x.txt" } }),
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  });

  it("non-write tool -> exit 0", async () => {
    const r = await run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } }));
    assert.equal(r.code, 0);
  });

  it("malformed JSON -> exit 0 (fail open)", async () => {
    const r = await run("not json at all");
    assert.equal(r.code, 0);
  });

  it("no tool_name + no target -> exit 0", async () => {
    const r = await run("{}");
    assert.equal(r.code, 0);
  });

  it("MultiEdit treated as write tool, no target -> exit 2", async () => {
    const r = await run(JSON.stringify({ tool_name: "MultiEdit", tool_input: {} }));
    assert.equal(r.code, 2);
  });
});

// A stand-in /scope that answers like the env-mode front door: 401 unless
// the bearer is "right", then "allow".
async function withScopeServer<T>(fn: (url: string, seen: string[]) => Promise<T>): Promise<T> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    seen.push(auth);
    if (auth !== "Bearer right") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ decision: "allow" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const EDIT = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/tmp/x.txt" } });

describe("portuni-guard.sh against a front door that refuses the token (#521)", () => {
  it("an empty token -> exit 2 naming the variable to export", async () => {
    await withScopeServer(async (url) => {
      const r = await run(EDIT, { PORTUNI_URL: url, PORTUNI_GUARD_TOKEN_VAR: "PORTUNI_MCP_TOKEN_WS" });
      assert.equal(r.code, 2, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /token is missing/);
      assert.match(r.stderr, /PORTUNI_MCP_TOKEN_WS/);
    });
  });

  it("a wrong token -> exit 2 saying it does not match", async () => {
    await withScopeServer(async (url) => {
      const r = await run(EDIT, { PORTUNI_URL: url, PORTUNI_GUARD_TOKEN: "wrong" });
      assert.equal(r.code, 2, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /does not match/);
      assert.match(r.stderr, /PORTUNI_MCP_TOKEN\b/);
    });
  });

  it("the right token in PORTUNI_GUARD_TOKEN -> allowed", async () => {
    await withScopeServer(async (url, seen) => {
      const r = await run(EDIT, { PORTUNI_URL: url, PORTUNI_GUARD_TOKEN: "right" });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.deepEqual(seen, ["Bearer right"]);
    });
  });

  it("the legacy PORTUNI_AUTH_TOKEN input is still accepted", async () => {
    await withScopeServer(async (url, seen) => {
      const r = await run(EDIT, { PORTUNI_URL: url, PORTUNI_AUTH_TOKEN: "right" });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.deepEqual(seen, ["Bearer right"]);
    });
  });
});
