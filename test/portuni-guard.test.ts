// Smoke tests for the portuni-guard.sh PreToolUse hook. The hook is shell +
// embedded Python; we run it as a subprocess to verify the contract:
//
//   write tool with valid target + server unreachable -> exit 0 (soft fallback)
//   write tool with no recoverable target              -> exit 2 (fail closed)
//   non-write tool                                     -> exit 0
//   malformed JSON payload                             -> exit 0 (fail open)
//
// We point PORTUNI_URL at a deliberately closed port so the /scope call
// fails and we can verify the parser branches without a running server.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve(process.cwd(), "scripts/portuni-guard.sh");
const UNREACHABLE = "http://127.0.0.1:65530";

function run(stdin: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(SCRIPT, [], {
      env: { ...process.env, PORTUNI_URL: UNREACHABLE },
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
