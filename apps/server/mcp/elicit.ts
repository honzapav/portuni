// MCP protocol elicitation (SDK >= 1.29's `elicitInput`), wrapped as a
// single confirm() call so scope/write-gate call sites don't each deal with
// capability checks or the requestedSchema shape. Clients that declared
// `elicitation` at initialize get a real dialog; everything else (capability
// absent, or the request throws/races) degrades to "unsupported" so the
// caller can fall back to the honor-system structured-refusal convention
// that predates this module. See
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Elicitation").

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type ElicitOutcome = "accept" | "decline" | "unsupported";

export interface Elicitor {
  // Shows a yes/no confirmation dialog with `message`. Resolves "accept"
  // only when the user explicitly confirmed; "decline" covers an explicit
  // no AND a cancelled dialog; "unsupported" means the client never
  // declared the elicitation capability (or the request errored) -- the
  // caller should fall back to the pre-elicitation convention, not treat it
  // as a decline.
  confirm(message: string): Promise<ElicitOutcome>;
}

async function confirmVia(
  server: Pick<Server, "getClientCapabilities" | "elicitInput">,
  message: string,
): Promise<ElicitOutcome> {
  if (!server.getClientCapabilities()?.elicitation) return "unsupported";
  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "Confirm",
            description: message,
          },
        },
        required: ["confirm"],
      },
    });
    return result.action === "accept" && result.content?.confirm === true ? "accept" : "decline";
  } catch {
    // A client that declared the capability but errors/races on the actual
    // request should degrade gracefully, not fail the underlying tool call.
    return "unsupported";
  }
}

export function createElicitor(server: McpServer): Elicitor {
  return { confirm: (message) => confirmVia(server.server, message) };
}

// For the agent-mode front door (agent-transport.ts), where the "server" the
// downstream real client is attached to is the low-level Server built by
// buildAgentServer, not an McpServer.
export function createElicitorFromServer(server: Server): Elicitor {
  return { confirm: (message) => confirmVia(server, message) };
}
