import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (url) {
      client = createClient({ url, authToken });
    } else {
      client = createClient({ url: "file:./portuni.db" });
    }
  }
  return client;
}

// Test-only seam. Lets smoke tests inject an :memory: client so they
// don't pollute the file-backed singleton. Pass null to clear and let
// the next getDb() call recreate from env.
export function setDbForTesting(c: Client | null): void {
  client = c;
}
