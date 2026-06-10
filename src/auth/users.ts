// Identity -> users row resolution at login time. Match order:
// google_sub, then email (enriches the pre-multi-user SOLO_USER row so
// history stays attributed), then insert.

import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import type { Identity } from "./adapter.js";

export async function upsertUserFromIdentity(
  db: Client,
  identity: Identity,
  avatarUrl: string | null
): Promise<string> {
  const bySub = await db.execute({
    sql: "SELECT id FROM users WHERE google_sub = ?",
    args: [identity.sub],
  });
  if (bySub.rows.length > 0) {
    const id = String(bySub.rows[0].id);
    await db.execute({
      sql: `UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url),
                   last_login_at = datetime('now') WHERE id = ?`,
      args: [identity.email, identity.name, avatarUrl, id],
    });
    return id;
  }

  const byEmail = await db.execute({
    sql: "SELECT id FROM users WHERE email = ?",
    args: [identity.email],
  });
  if (byEmail.rows.length > 0) {
    const id = String(byEmail.rows[0].id);
    await db.execute({
      sql: `UPDATE users SET google_sub = ?, name = ?, avatar_url = COALESCE(?, avatar_url),
                   last_login_at = datetime('now') WHERE id = ?`,
      args: [identity.sub, identity.name, avatarUrl, id],
    });
    return id;
  }

  const id = ulid();
  await db.execute({
    sql: `INSERT INTO users (id, email, name, google_sub, avatar_url, last_login_at, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    args: [id, identity.email, identity.name, identity.sub, avatarUrl],
  });
  return id;
}
