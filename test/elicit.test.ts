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
import {
  createElicitor,
  ELICIT_TIMEOUT_MS,
  AGENT_RELAY_ELICIT_TIMEOUT_MS,
} from "../apps/server/mcp/elicit.js";

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

describe("elicitation timeouts (#206)", () => {
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
