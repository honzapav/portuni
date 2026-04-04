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
