// Identity -> users row resolution at login time. Match order:
// google_sub, then email (enriches the pre-multi-user SOLO_USER row so
// history stays attributed), then insert.

import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import type { Identity } from "./adapter.js";

// Thrown by inviteUser() when the email is already registered (paired or
// invited). Handlers map this to 409.
export class UserExistsError extends Error {
  constructor(public readonly email: string) {
    super(`User with email ${email} already exists`);
    this.name = "UserExistsError";
  }
}

export interface UserPickerRow {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
}

export interface UserAdminRow {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  last_login_at: string | null;
  invited: boolean;
}

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
    // Guard against UNIQUE(email) collision: if a different row already owns
    // identity.email (e.g. a stale row from before this sub claimed that
    // address), skip the email update to avoid a constraint crash. The old
    // email on this row remains valid; the collision row is stale.
    const emailOwner = await db.execute({
      sql: "SELECT id FROM users WHERE email = ? AND id != ?",
      args: [identity.email, id],
    });
    if (emailOwner.rows.length > 0) {
      // Another row owns the email — update everything except email.
      await db.execute({
        sql: `UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url),
                     last_login_at = datetime('now') WHERE id = ?`,
        args: [identity.name, avatarUrl, id],
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url),
                     last_login_at = datetime('now') WHERE id = ?`,
        args: [identity.email, identity.name, avatarUrl, id],
      });
    }
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

// GET /auth/users (manage scope): ACL picker shape -- just enough to render
// a user in a share dialog, no admin-only fields (invited, global_scope).
export async function listUsers(db: Client): Promise<UserPickerRow[]> {
  const rows = await db.execute(
    "SELECT id, name, email, avatar_url FROM users ORDER BY name",
  );
  return rows.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    avatar_url: (row.avatar_url as string | null) ?? null,
  }));
}

// GET /auth/users/admin (admin scope): full account list. `invited` is
// derived here (google_sub IS NULL); `global_scope` is resolved by the
// handler via adapter.resolveAccess, since that requires the identity
// adapter which lives at the API layer, not this domain module.
export async function listUsersAdmin(db: Client): Promise<UserAdminRow[]> {
  const rows = await db.execute(
    "SELECT id, name, email, avatar_url, last_login_at, google_sub FROM users ORDER BY name",
  );
  return rows.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    avatar_url: (row.avatar_url as string | null) ?? null,
    last_login_at: (row.last_login_at as string | null) ?? null,
    invited: row.google_sub === null,
  }));
}

// POST /auth/users/invite (admin scope): creates a placeholder row (no
// google_sub) so it can be shared/assigned before the invitee ever logs in.
// upsertUserFromIdentity's byEmail branch pairs this row on first login.
export async function inviteUser(
  db: Client,
  email: string,
): Promise<{ id: string; email: string; name: string }> {
  const normalized = email.trim().toLowerCase();
  const existing = await db.execute({
    sql: "SELECT id FROM users WHERE email = ?",
    args: [normalized],
  });
  if (existing.rows.length > 0) throw new UserExistsError(normalized);
  const id = ulid();
  const name = normalized.split("@")[0];
  await db.execute({
    sql: "INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime('now'))",
    args: [id, normalized, name],
  });
  return { id, email: normalized, name };
}
