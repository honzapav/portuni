// Tests for the elicit.ts wrapper around MCP protocol elicitation
// (elicitInput, SDK >= 1.29). Covers the two paths issue #188 calls for:
// a capability-present client gets a real dialog; a capability-absent
// client (or one that errors mid-request) degrades to "unsupported" so
// callers fall back to the honor-system convention.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  createElicitor,
  createElicitorFromServer,
  agentRelayElicitTimeoutMs,
  elicitTimeoutMs,
  ELICIT_TIMEOUT_MS,
  ELICIT_RELAY_MARGIN_MS,
  AGENT_RELAY_ELICIT_TIMEOUT_MS,
  type ElicitCapableServer,
} from "../apps/server/mcp/elicit.js";
import { writeGuardError } from "../apps/server/domain/write-gate.js";

async function connect(
  clientCapabilities: Record<string, unknown>,
): Promise<{ server: McpServer; client: Client }> {
  const server = new McpServer({ name: "elicit-test-server", version: "0.0.1" }, {});
  const client = new Client(
    { name: "elicit-test-client", version: "0.0.1" },
    { capabilities: clientCapabilities },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe("createElicitor: capability-absent fallback", () => {
  it("resolves 'unsupported' without ever sending a request, when the client declared no elicitation capability", async () => {
    const { server, client } = await connect({});
    const elicitor = createElicitor(server);
    const outcome = await elicitor.confirm("Allow this?");
    assert.equal(outcome, "unsupported");
    await client.close();
  });
});

describe("createElicitor: capability-present dialog path", () => {
  it("resolves 'accept' when the client's dialog handler accepts", async () => {
    const { server, client } = await connect({ elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { confirm: true },
    }));
    const elicitor = createElicitor(server);
    const outcome = await elicitor.confirm("Allow this?");
    assert.equal(outcome, "accept");
    await client.close();
  });

  it("resolves 'decline' when the client's dialog handler declines", async () => {
    const { server, client } = await connect({ elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    const elicitor = createElicitor(server);
    const outcome = await elicitor.confirm("Allow this?");
    assert.equal(outcome, "decline");
    await client.close();
  });

  it("resolves 'decline' when the client cancels the dialog", async () => {
    const { server, client } = await connect({ elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "cancel" }));
    const elicitor = createElicitor(server);
    const outcome = await elicitor.confirm("Allow this?");
    assert.equal(outcome, "decline");
    await client.close();
  });

  it("resolves 'unsupported' when the request throws despite the declared capability", async () => {
    const { server, client } = await connect({ elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, async () => {
      throw new Error("client-side dialog crashed");
    });
    const elicitor = createElicitor(server);
    const outcome = await elicitor.confirm("Allow this?");
    assert.equal(outcome, "unsupported");
    await client.close();
  });
});

// A server stub standing in for a client that never answers: the SDK's own
// deadline fires and rejects with ErrorCode.RequestTimeout. Driving the
// classification from the rejection (rather than waiting out a real timer)
// keeps the test instant and deterministic -- no sleeps anywhere.
function timingOutServer(recorded: { timeoutMs?: number }): ElicitCapableServer {
  return {
    getClientCapabilities: () => ({ elicitation: {} }),
    elicitInput: (async (_params: unknown, options?: { timeout?: number }) => {
      recorded.timeoutMs = options?.timeout;
      throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
    }) as ElicitCapableServer["elicitInput"],
  } as ElicitCapableServer;
}

describe("elicitation timeouts (#206, #409)", () => {
  it("uses generous, explicit timeouts (SDK default is 60s) with the outer hop longer than the inner one", () => {
    // The agent-mode front door nests two hops: central's own wait (using
    // ELICIT_TIMEOUT_MS, the general default) wraps the front door's relay
    // down to the real client (AGENT_RELAY_ELICIT_TIMEOUT_MS). If the inner
    // timeout were not comfortably shorter, an eventual real answer could
    // arrive after the outer caller already gave up and discarded it.
    assert.ok(ELICIT_TIMEOUT_MS > 60_000);
    assert.ok(AGENT_RELAY_ELICIT_TIMEOUT_MS > 60_000);
    assert.ok(AGENT_RELAY_ELICIT_TIMEOUT_MS < ELICIT_TIMEOUT_MS);
  });
});

describe("elicitation deadline (#409)", () => {
  it("stays below the 300s tool-call deadline claude.ai enforces, relay one margin shorter", () => {
    assert.ok(ELICIT_TIMEOUT_MS < 300_000);
    assert.equal(AGENT_RELAY_ELICIT_TIMEOUT_MS, ELICIT_TIMEOUT_MS - ELICIT_RELAY_MARGIN_MS);
  });

  it("resolves 'timeout' (not 'unsupported') when the dialog goes unanswered, and the write gate answers write_expansion_required", async () => {
    const recorded: { timeoutMs?: number } = {};
    const elicitor = createElicitorFromServer(timingOutServer(recorded));
    const outcome = await elicitor.confirm("Allow this?");
    assert.equal(outcome, "timeout");
    assert.equal(recorded.timeoutMs, AGENT_RELAY_ELICIT_TIMEOUT_MS);
    // What the caller (mcp/write-gate.ts, agent-transport.ts) turns that
    // into: a structured refusal the agent can act on, flagged as a timed-out
    // dialog rather than a client without dialogs.
    const payload = writeGuardError("N1", "elicit", "ignored", {
      elicitationSupported: true,
      dialogTimedOut: true,
    });
    assert.equal(payload.error, "write_expansion_required");
    assert.equal(payload.dialog_timed_out, true);
    assert.equal(payload.elicitation_supported, undefined);
    assert.match(payload.hint, /not answered in time/);
  });

  it("PORTUNI_ELICIT_TIMEOUT_MS overrides the outer hop, and the relay stays strictly shorter", () => {
    assert.equal(elicitTimeoutMs({ PORTUNI_ELICIT_TIMEOUT_MS: "120000" }), 120_000);
    assert.equal(agentRelayElicitTimeoutMs({ PORTUNI_ELICIT_TIMEOUT_MS: "120000" }), 60_000);
    // Too small for a whole margin: half of the outer value, still shorter.
    assert.equal(agentRelayElicitTimeoutMs({ PORTUNI_ELICIT_TIMEOUT_MS: "30000" }), 15_000);
    // Any sane override keeps the relay strictly shorter (a 1 ms outer
    // value is degenerate and floors at 1 ms for both).
    for (const raw of ["120000", "30000", "2", ""]) {
      const outer = elicitTimeoutMs({ PORTUNI_ELICIT_TIMEOUT_MS: raw });
      assert.ok(agentRelayElicitTimeoutMs({ PORTUNI_ELICIT_TIMEOUT_MS: raw }) < outer);
    }
  });

  it("ignores a non-positive-integer override instead of disabling the deadline", () => {
    for (const raw of ["0", "-5", "abc", "1.5"]) {
      assert.equal(elicitTimeoutMs({ PORTUNI_ELICIT_TIMEOUT_MS: raw }), ELICIT_TIMEOUT_MS);
    }
  });

  it("the direct-client hop uses the outer deadline", async () => {
    const recorded: { timeoutMs?: number } = {};
    const fake = timingOutServer(recorded);
    const server = new McpServer({ name: "elicit-timeout-test", version: "0.0.1" }, {});
    // createElicitor reads server.server; swap in the stub so no real
    // transport (and no real clock) is involved.
    (server as unknown as { server: ElicitCapableServer }).server = fake;
    const outcome = await createElicitor(server).confirm("Allow this?");
    assert.equal(outcome, "timeout");
    assert.equal(recorded.timeoutMs, ELICIT_TIMEOUT_MS);
  });
});
