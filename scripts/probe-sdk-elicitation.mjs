#!/usr/bin/env node
// #509: the live probe for "does an MCP server's elicitation reach the
// Claude adapter's onElicitation, and does the answer reach the server".
//
//   node scripts/probe-sdk-elicitation.mjs            # PROBE_TRACE=1 for every message
//   PROBE_ANSWER=decline node scripts/probe-sdk-elicitation.mjs
//   PROBE_ANSWER=interrupt node scripts/probe-sdk-elicitation.mjs   # Stop while the dialog is open
//
// The script is both halves. Run plainly it starts a real Claude Agent SDK
// query whose only MCP server is this same file in `--server` mode (stdio).
// The server sends one elicitation with Portuni's own confirmation shape
// (elicit.ts: one `confirm: boolean` field) as soon as the client has
// finished the handshake -- before any model turn, so the probe needs no
// login -- and reports the ElicitResult it got back on stderr, which the
// SDK does not show, so it also writes it to PROBE_OUT. onElicitation
// answers the way the adapter does for Povolit / Zamítnout.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--server")) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const out = process.env.PROBE_OUT;
  const server = new Server({ name: "probe", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.oninitialized = async () => {
    // Give the CLI time to install its elicitation handler after the
    // handshake; a request it gets earlier is answered `cancel` unseen.
    await new Promise((r) => setTimeout(r, Number(process.env.PROBE_DELAY_MS ?? 3000)));
    const caps = server.getClientCapabilities();
    writeFileSync(`${out}.caps`, JSON.stringify(caps ?? null));
    try {
      const result = await server.elicitInput(
        {
          message: "Allow writing to project Probe?",
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "Confirm", description: "Yes, allow it" } },
            required: ["confirm"],
          },
        },
        { timeout: 60_000 },
      );
      writeFileSync(out, JSON.stringify(result));
    } catch (err) {
      writeFileSync(out, JSON.stringify({ error: String(err) }));
    }
  };
  await server.connect(new StdioServerTransport());
} else {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const answer = process.env.PROBE_ANSWER ?? "accept";
  const out = join(mkdtempSync(join(tmpdir(), "probe-elicit-")), "result.json");
  let called = null;
  const q = query({
    prompt: (async function* () {
      yield { type: "user", message: { role: "user", content: "Odpověz jen slovem OK." }, parent_tool_use_id: null };
      // Keep the input stream open until the server reported back, the
      // way the adapter's streaming input keeps a run alive.
      const deadline = Date.now() + 60_000;
      while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    })(),
    options: {
      mcpServers: {
        probe: {
          type: "stdio",
          command: process.execPath,
          args: [fileURLToPath(import.meta.url), "--server"],
          env: { ...process.env, PROBE_OUT: out },
        },
      },
      debugFile: process.env.PROBE_DEBUG_FILE,
      onElicitation: async (request, options) => {
        called = request;
        console.log(`<- onElicitation ${JSON.stringify({ serverName: request.serverName, mode: request.mode, message: request.message, requestedSchema: request.requestedSchema, requestId: options.requestId })}`);
        if (answer === "interrupt") {
          // Stop while the dialog is open: does the SDK abort the
          // dialog's signal when the turn is interrupted?
          const aborted = new Promise((r) => options.signal.addEventListener("abort", () => r(true), { once: true }));
          await q.interrupt().catch((err) => console.log(`interrupt threw: ${err?.message ?? err}`));
          const seen = await Promise.race([aborted, new Promise((r) => setTimeout(() => r(false), 5000))]);
          console.log(`signal aborted after interrupt(): ${seen}`);
          console.log(`-> {"action":"cancel"}`);
          return { action: "cancel" };
        }
        const result = answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: answer };
        console.log(`-> ${JSON.stringify(result)}`);
        return result;
      },
    },
  });
  try {
  for await (const message of q) {
    if (process.env.PROBE_TRACE === "1") console.log(JSON.stringify(message));
    if (message.type === "system" && message.subtype === "init") {
      console.log(`init mcp_servers: ${JSON.stringify(message.mcp_servers)}`);
    }
    if (message.type === "result") {
      console.log(`result: ${message.subtype} ${JSON.stringify(message.result ?? message.errors ?? null)}`);
    }
  }
  } catch (err) {
    // Without a login the CLI ends the turn with an error result, which the
    // SDK rethrows; the elicitation round trip happened before that.
    console.log(`query ended: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  console.log(`client capabilities the server saw: ${existsSync(`${out}.caps`) ? readFileSync(`${out}.caps`, "utf8") : "(none)"}`);
  console.log(`server received: ${existsSync(out) ? readFileSync(out, "utf8") : "(nothing)"}`);
  console.log(`onElicitation called: ${called !== null}`);
}
