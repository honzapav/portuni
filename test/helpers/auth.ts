// The bearer every in-process test server runs with (#521): an env-mode
// server never starts without PORTUNI_AUTH_TOKEN, so a test that boots one
// sets it before the start and presents it on every request.

export const TEST_BEARER = "test-bearer-token-0123456789abcdef";

// Set the server-side token. Call before startHttpServer (or before
// spawning an entry point); the server reads it live.
export function useTestBearer(): void {
  process.env.PORTUNI_AUTH_TOKEN = TEST_BEARER;
}

// Request headers carrying the test bearer, merged over `extra`.
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${TEST_BEARER}` };
}

// fetch with the test bearer added to whatever headers the caller passed
// (a caller that sets its own Authorization keeps it).
export function authFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("Authorization", `Bearer ${TEST_BEARER}`);
  return fetch(input, { ...init, headers });
}
