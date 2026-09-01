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

// Default timeout for a single elicitation hop: a direct client connection,
// or the outer hop of the agent-mode front-door chain (see
// AGENT_RELAY_ELICIT_TIMEOUT_MS below). Several minutes, not the SDK's 60s
// default -- a human reading and answering a confirmation dialog takes
// longer than a typical request round trip.
export const ELICIT_TIMEOUT_MS = 8 * 60 * 1000;

// Timeout for the agent-mode front door's own hop (its relay of a
// server-initiated elicitation request down to the real downstream client,
// agent-transport.ts). This hop is nested inside the outer hop above (the
// central/direct caller waiting on the whole round trip), so it must resolve
// with margin to spare before the outer timeout fires -- otherwise a real,
// on-time answer from the user is discarded because the outer wait already
// gave up.
export const AGENT_RELAY_ELICIT_TIMEOUT_MS = 5 * 60 * 1000;

async function confirmVia(
  server: Pick<Server, "getClientCapabilities" | "elicitInput">,
  message: string,
  timeoutMs: number = ELICIT_TIMEOUT_MS,
): Promise<ElicitOutcome> {
  if (!server.getClientCapabilities()?.elicitation) return "unsupported";
  try {
    const result = await server.elicitInput(
      {
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
      },
      { timeout: timeoutMs },
    );
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
// buildAgentServer, not an McpServer. Uses the shorter, inner timeout: this
// confirm() call is itself the front door's own hop and may be nested inside
// an outer caller's (central's) longer wait.
export function createElicitorFromServer(server: Server): Elicitor {
  return { confirm: (message) => confirmVia(server, message, AGENT_RELAY_ELICIT_TIMEOUT_MS) };
}
