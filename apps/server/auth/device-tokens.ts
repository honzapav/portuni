// Long-lived per-user per-device tokens for MCP/agent clients
// (.mcp.json). Server stores only the sha256 hash; the plaintext is
// shown exactly once at mint time. Spec §2 "Auth pro agenty".

import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";

const DEFAULT_TTL_DAYS = 180;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MintedDeviceToken {
  id: string;
  token: string; // plaintext, shown once
  expires_at: string;
}

export async function mintDeviceToken(
  db: Client,
  userId: string,
  label: string,
  opts: { ttlDays?: number } = {},
): Promise<MintedDeviceToken> {
  const id = ulid();
  const token = `ptk_${randomBytes(32).toString("base64url")}`;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  await db.execute({
    sql: `INSERT INTO device_tokens (id, user_id, label, token_hash, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, userId, label, hashToken(token), expiresAt],
  });
  return { id, token, expires_at: expiresAt };
}

export interface DeviceTokenHit {
  tokenId: string;
  userId: string;
}

export async function verifyDeviceToken(
  db: Client,
  token: string,
): Promise<DeviceTokenHit | null> {
  const r = await db.execute({
    sql: `SELECT id, user_id FROM device_tokens
          WHERE token_hash = ?
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    args: [hashToken(token)],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  await db.execute({
    sql: "UPDATE device_tokens SET last_used_at = datetime('now') WHERE id = ?",
    args: [row.id],
  });
  return { tokenId: String(row.id), userId: String(row.user_id) };
}

export async function revokeDeviceToken(
  db: Client,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE device_tokens SET revoked_at = datetime('now')
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    args: [tokenId, userId],
  });
  return r.rowsAffected > 0;
}

export interface DeviceTokenRow {
  id: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export async function listDeviceTokens(
  db: Client,
  userId: string,
): Promise<DeviceTokenRow[]> {
  const r = await db.execute({
    sql: `SELECT id, label, created_at, expires_at, revoked_at, last_used_at
          FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    args: [userId],
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    created_at: String(row.created_at),
    expires_at: row.expires_at == null ? null : String(row.expires_at),
    revoked_at: row.revoked_at == null ? null : String(row.revoked_at),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
  }));
}
