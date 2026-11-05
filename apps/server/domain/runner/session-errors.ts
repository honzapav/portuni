// The record store has no such session (see session-runtime.ts). Its own
// module so http/middleware.ts can map it without importing the runtime.
export class SessionNotFoundError extends Error {
  constructor(op: string, readonly sessionId: string) {
    super(`${op}: session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}
