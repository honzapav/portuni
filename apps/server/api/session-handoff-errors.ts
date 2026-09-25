// The one mapping of a SessionHandoffError (Předat, Navázat na handoff, a
// resume with nothing to continue from on this device) to
// what a client receives, shared by the local router (api/sessions.ts), the
// sync agent's router (api/agent-router.ts) and the live channel
// (api/sessions-ws.ts): 409 with the error's code and its Czech message,
// which the web shows as-is.

import type { ServerResponse } from "node:http";
import { respondJson } from "../http/middleware.js";
import { SessionHandoffError } from "../domain/runner/session-runtime.js";

export interface HandoffRefusal {
  status: 409;
  code: SessionHandoffError["code"];
  message: string;
}

export function handoffRefusal(err: unknown): HandoffRefusal | null {
  if (!(err instanceof SessionHandoffError)) return null;
  return { status: 409, code: err.code, message: err.message };
}

// Writes the refusal and answers true when `err` is one; false leaves the
// response to the caller.
export function respondHandoffRefusal(res: ServerResponse, err: unknown): boolean {
  const refusal = handoffRefusal(err);
  if (!refusal) return false;
  respondJson(res, refusal.status, { error: refusal.message, code: refusal.code });
  return true;
}
