// Předat refused (#459): pure helpers shared by api.ts (main chunk) and the
// lazy-loaded SessionChat, kept in their own module so the main chunk does
// not pull in the chat's helpers. Tested from the server's node:test runner
// (test/handoff-refusal-helpers.test.ts).
//
// The server refuses Předat with 409 and a HANDOFF_* code saying why: the
// thread is a draft or closed, the node has no mirror on this device, the
// run is live on another device, or the transcript is on another device.
// The caller shows the code's catalog text (displayError), never the raw
// status line; `message` is the server's English log text.

import type { ErrorParams } from "../../../server/shared/error-codes";

export class HandoffRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: ErrorParams = {},
  ) {
    super(message);
    this.name = "HandoffRefusedError";
  }
}

function readParams(value: unknown): ErrorParams {
  const out: ErrorParams = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}

// The refusal carried by a 409 answer's body (`{ error, code, params? }`),
// or null when the answer is anything else.
export function parseHandoffRefusal(status: number, bodyText: string): HandoffRefusedError | null {
  if (status !== 409) return null;
  try {
    const body = JSON.parse(bodyText) as { error?: unknown; code?: unknown; params?: unknown };
    if (typeof body.error === "string" && typeof body.code === "string" && body.code.startsWith("HANDOFF_")) {
      return new HandoffRefusedError(body.code, body.error, readParams(body.params));
    }
  } catch {
    /* not JSON */
  }
  return null;
}
