import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeCliName, extractClientNameFromInitializeBody } from "../apps/server/mcp/client-name.js";

describe("normalizeCliName", () => {
  it("recognizes claude/codex/vibe by substring, case-insensitively", () => {
    assert.equal(normalizeCliName("claude-code"), "claude");
    assert.equal(normalizeCliName("Claude Code"), "claude");
    assert.equal(normalizeCliName("codex-cli"), "codex");
    assert.equal(normalizeCliName("mistral-vibe"), "vibe");
  });

  it("keeps an unrecognized name verbatim", () => {
    assert.equal(normalizeCliName("some-other-client"), "some-other-client");
  });
});

describe("extractClientNameFromInitializeBody", () => {
  it("extracts and normalizes clientInfo.name from a single initialize message", () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "claude-code", version: "1.0.0" } },
    };
    assert.equal(extractClientNameFromInitializeBody(body), "claude");
  });

  it("extracts from the first message of a batch", () => {
    const body = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "codex" } },
      },
    ];
    assert.equal(extractClientNameFromInitializeBody(body), "codex");
  });

  it("returns null for a non-initialize request", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    assert.equal(extractClientNameFromInitializeBody(body), null);
  });

  it("returns null when clientInfo/name is missing or malformed", () => {
    assert.equal(
      extractClientNameFromInitializeBody({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      null,
    );
    assert.equal(extractClientNameFromInitializeBody(null), null);
    assert.equal(extractClientNameFromInitializeBody(undefined), null);
    assert.equal(extractClientNameFromInitializeBody("not an object"), null);
  });
});
