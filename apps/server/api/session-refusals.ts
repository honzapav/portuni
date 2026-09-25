// The one mapping of a session runtime refusal to what a client receives,
// shared by the local router (api/sessions.ts), the sync agent's router
// (api/agent-router.ts) and the live channel (api/sessions-ws.ts), so the
// three paths cannot drift apart:
//
// - SessionHandoffError (Předat, Navázat na handoff, a resume with nothing
//   to continue from on this device): 409 with the error's code.
// - NoLiveRunError (a message into a thread whose run is not live): 409
//   NO_LIVE_RUN.
//
// #530: the code always comes from the error's type, never from its
// message text -- rewording a message never changes the code a client gets.

import type { ServerResponse } from "node:http";
import { respondJson } from "../http/middleware.js";
import { NoLiveRunError, SessionHandoffError } from "../domain/runner/session-runtime.js";

export interface SessionRefusal {
  status: 409;
  code: SessionHandoffError["code"] | NoLiveRunError["code"];
  message: string;
}

export function sessionRefusal(err: unknown): SessionRefusal | null {
  if (err instanceof SessionHandoffError || err instanceof NoLiveRunError) {
    return { status: 409, code: err.code, message: err.message };
  }
  return null;
}

// Writes the refusal and answers true when `err` is one; false leaves the
// response to the caller.
export function respondSessionRefusal(res: ServerResponse, err: unknown): boolean {
  const refusal = sessionRefusal(err);
  if (!refusal) return false;
  respondJson(res, refusal.status, { error: refusal.message, code: refusal.code });
  return true;
}
