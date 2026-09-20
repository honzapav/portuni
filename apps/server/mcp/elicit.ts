// MCP protocol elicitation (SDK >= 1.29's `elicitInput`), wrapped as a
// single confirm() call so scope/write-gate call sites don't each deal with
// capability checks or the requestedSchema shape. Clients that declared
// `elicitation` at initialize get a real dialog; everything else (capability
// absent, or the request throws/races) degrades to "unsupported" so the
// caller can fall back to the honor-system structured-refusal convention
// that predates this module. A dialog that is shown but never answered
// within the hop's deadline resolves "timeout" -- the caller answers with
// its structured refusal, so a tool call can never outlive the client's own
// tool-call deadline (#409). See
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Elicitation").

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export type ElicitOutcome = "accept" | "decline" | "unsupported" | "timeout";

export interface Elicitor {
  // Shows a yes/no confirmation dialog with `message`. Resolves "accept"
  // only when the user explicitly confirmed; "decline" covers an explicit
  // no AND a cancelled dialog; "timeout" means the dialog was really shown
  // but nobody answered before the hop's own deadline (the caller answers
  // with its structured refusal instead of hanging -- see #409);
  // "unsupported" means the client never declared the elicitation
  // capability (or the request errored) -- the caller should fall back to
  // the pre-elicitation convention, not treat it as a decline.
  confirm(message: string): Promise<ElicitOutcome>;
}

// Default timeout for a single elicitation hop: a direct client connection,
// or the outer hop of the agent-mode front-door chain (see
// AGENT_RELAY_ELICIT_TIMEOUT_MS below). Minutes, not the SDK's 60s default
// -- a human reading and answering a confirmation dialog takes longer than
// a typical request round trip -- but deliberately BELOW the tool-call
// deadlines common clients enforce (claude.ai aborts a tool call after
// 300s): a dialog nobody answers must come back as a structured refusal the
// agent can act on, never as a hang the client kills (#409).
export const ELICIT_TIMEOUT_MS = 4 * 60 * 1000;

// Timeout for the agent-mode front door's own hop (its relay of a
// server-initiated elicitation request down to the real downstream client,
// agent-transport.ts). This hop is nested inside the outer hop above (the
// central/direct caller waiting on the whole round trip), so it must resolve
// with margin to spare before the outer timeout fires -- otherwise a real,
// on-time answer from the user is discarded because the outer wait already
// gave up. Invariant: relay < outer, by ELICIT_RELAY_MARGIN_MS.
export const AGENT_RELAY_ELICIT_TIMEOUT_MS = 3 * 60 * 1000;

// How much earlier the nested relay hop gives up than the hop wrapping it.
export const ELICIT_RELAY_MARGIN_MS = 60 * 1000;

// Optional operator override of the outer hop (the relay is derived from
// it, never configured separately, so the invariant above cannot be broken
// from the environment). Anything that is not a positive integer is
// ignored, with one warning, rather than silently disabling the timeout.
export const ELICIT_TIMEOUT_ENV_VAR = "PORTUNI_ELICIT_TIMEOUT_MS";

let warnedAboutEnv = false;

export function elicitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ELICIT_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === "") return ELICIT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warnedAboutEnv) {
      warnedAboutEnv = true;
      console.warn(
        `[elicit] ignoring ${ELICIT_TIMEOUT_ENV_VAR}=${raw}: expected a positive integer (ms)`,
      );
    }
    return ELICIT_TIMEOUT_MS;
  }
  return parsed;
}

// The nested hop's deadline: one margin below the outer one, or half of it
// when the outer value is too small for a whole margin to fit. Strictly
// shorter than the outer deadline for any outer value of 2 ms or more (a
// 1 ms outer value is degenerate and floors at 1 ms for both).
export function agentRelayElicitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const outer = elicitTimeoutMs(env);
  if (outer > 2 * ELICIT_RELAY_MARGIN_MS) return outer - ELICIT_RELAY_MARGIN_MS;
  return Math.max(1, Math.floor(outer / 2));
}

// The server half an elicitation hop needs: everything else on McpServer /
// Server is irrelevant here, and narrowing it this far is what lets a test
// drive the classification below from a fake.
export type ElicitCapableServer = Pick<Server, "getClientCapabilities" | "elicitInput">;

// A request that ran out of time is not the same as a client that cannot
// show dialogs at all: the SDK rejects it with ErrorCode.RequestTimeout,
// and the caller turns that into its own structured refusal (with a hint
// that says the dialog went unanswered) instead of the capability-absent
// wording.
function isTimeoutError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ErrorCode.RequestTimeout;
}

async function confirmVia(
  server: ElicitCapableServer,
  message: string,
  timeoutMs: number,
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
              // Deliberately NOT `message`: clients render the request
              // message and the field description separately, so repeating
              // the message here prints the whole prompt twice in the
              // dialog. The field is a bare yes/no next to the message.
              description: "Yes, allow it",
            },
          },
          required: ["confirm"],
        },
      },
      { timeout: timeoutMs },
    );
    return result.action === "accept" && result.content?.confirm === true ? "accept" : "decline";
  } catch (err) {
    // Nobody answered in time: the dialog itself worked, so the caller must
    // not tell the agent this client has no dialogs -- it answers with the
    // structured refusal and a hint saying the confirmation went
    // unanswered (#409).
    if (isTimeoutError(err)) return "timeout";
    // A client that declared the capability but errors/races on the actual
    // request should degrade gracefully, not fail the underlying tool call.
    return "unsupported";
  }
}

export function createElicitor(server: McpServer): Elicitor {
  // The deadline is resolved per call, so an operator override applies to
  // the next dialog rather than to whatever the process read at boot.
  return { confirm: (message) => confirmVia(server.server, message, elicitTimeoutMs()) };
}

// For the agent-mode front door (agent-transport.ts), where the "server" the
// downstream real client is attached to is the low-level Server built by
// buildAgentServer, not an McpServer. Uses the shorter, inner timeout: this
// confirm() call is itself the front door's own hop and may be nested inside
// an outer caller's (central's) longer wait.
export function createElicitorFromServer(server: ElicitCapableServer): Elicitor {
  return { confirm: (message) => confirmVia(server, message, agentRelayElicitTimeoutMs()) };
}
