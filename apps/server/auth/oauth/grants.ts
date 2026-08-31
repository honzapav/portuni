// OAuth 2.1 access/refresh token grants for chat-client connectors.
// Opaque, sha256-hashed tokens -- same pattern as device-tokens.ts, plus
// refresh rotation. Roles are never baked into the token: every request
// re-resolves access via the identity adapter, so revocation here is
// immediate. Spec:
// docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Decisions", "Data model").

import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1h
const REFRESH_TTL_DAYS = 180; // absolute, from created_at, never sliding

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export interface MintGrantInput {
  userId: string;
  clientId: string; // CIMD URL
  clientName: string;
  resource: string;
  scope: string;
}

export interface MintedGrant {
  grantId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export async function mintGrant(
  db: Client,
  input: MintGrantInput,
): Promise<MintedGrant> {
  const id = ulid();
  const accessToken = `poa_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `por_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  const accessExpiresAt = sqliteDatetime(now + ACCESS_TTL_MS);
  const refreshExpiresAt = sqliteDatetime(
    now + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await db.execute({
    sql: `INSERT INTO oauth_grants (
      id, user_id, client_id, client_name, access_token_hash, access_expires_at,
      refresh_token_hash, refresh_expires_at, resource, scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.userId,
      input.clientId,
      input.clientName,
      hashToken(accessToken),
      accessExpiresAt,
      hashToken(refreshToken),
      refreshExpiresAt,
      input.resource,
      input.scope,
    ],
  });
  return { grantId: id, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

export interface OAuthGrantHit {
  grantId: string;
  userId: string;
  resource: string;
  scope: string;
}

// Verifies an access token: hash lookup, not expired, not revoked. Audience
// (resource) matching against the canonical MCP URL is the caller's job
// (apps/server/auth/request-identity.ts, issue #173) since this module has
// no notion of "canonical". Bumps last_used_at on success.
export async function verifyAccessToken(
  db: Client,
  token: string,
): Promise<OAuthGrantHit | null> {
  const r = await db.execute({
    sql: `SELECT id, user_id, resource, scope FROM oauth_grants
          WHERE access_token_hash = ? AND revoked_at IS NULL
            AND access_expires_at > datetime('now')`,
    args: [hashToken(token)],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  await db.execute({
    sql: "UPDATE oauth_grants SET last_used_at = datetime('now') WHERE id = ?",
    args: [row.id],
  });
  return {
    grantId: String(row.id),
    userId: String(row.user_id),
    resource: String(row.resource),
    scope: String(row.scope),
  };
}

export interface RotatedGrant {
  grantId: string;
  userId: string;
  resource: string;
  scope: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
}

export type RefreshResult =
  | { ok: true; grant: RotatedGrant }
  | { ok: false; reason: "invalid_grant" };

// Rotates a refresh token: mints a fresh access + refresh token pair,
// overwrites the hashes in place, moves the old refresh hash to
// prev_refresh_token_hash. refresh_expires_at is never touched here --
// the 180-day window is absolute from the initial grant.
//
// A replay of the immediately superseded refresh token (matches
// prev_refresh_token_hash) is theft evidence: the grant is revoked and
// invalid_grant returned. Older generations match neither column and fall
// through to a plain invalid_grant without revocation.
export async function rotateRefreshToken(
  db: Client,
  refreshToken: string,
): Promise<RefreshResult> {
  const hash = hashToken(refreshToken);

  const prevMatch = await db.execute({
    sql: `SELECT id FROM oauth_grants
          WHERE prev_refresh_token_hash = ? AND revoked_at IS NULL`,
    args: [hash],
  });
  if (prevMatch.rows.length > 0) {
    await db.execute({
      sql: "UPDATE oauth_grants SET revoked_at = datetime('now') WHERE id = ?",
      args: [prevMatch.rows[0].id],
    });
    return { ok: false, reason: "invalid_grant" };
  }

  const r = await db.execute({
    sql: `SELECT id, user_id, resource, scope FROM oauth_grants
          WHERE refresh_token_hash = ? AND revoked_at IS NULL
            AND refresh_expires_at > datetime('now')`,
    args: [hash],
  });
  if (r.rows.length === 0) return { ok: false, reason: "invalid_grant" };
  const row = r.rows[0];

  const accessToken = `poa_${randomBytes(32).toString("base64url")}`;
  const newRefreshToken = `por_${randomBytes(32).toString("base64url")}`;
  const accessExpiresAt = sqliteDatetime(Date.now() + ACCESS_TTL_MS);

  await db.execute({
    sql: `UPDATE oauth_grants SET
      access_token_hash = ?, access_expires_at = ?,
      prev_refresh_token_hash = refresh_token_hash, refresh_token_hash = ?,
      rotated_at = datetime('now')
      WHERE id = ?`,
    args: [hashToken(accessToken), accessExpiresAt, hashToken(newRefreshToken), row.id],
  });

  return {
    ok: true,
    grant: {
      grantId: String(row.id),
      userId: String(row.user_id),
      resource: String(row.resource),
      scope: String(row.scope),
      accessToken,
      refreshToken: newRefreshToken,
      accessExpiresAt,
    },
  };
}

// Owner-scoped revoke, for the "Odpojit" button (issue #174) and for theft
// detection above. Invalidates access and refresh immediately.
export async function revokeGrant(
  db: Client,
  userId: string,
  grantId: string,
): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE oauth_grants SET revoked_at = datetime('now')
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    args: [grantId, userId],
  });
  return r.rowsAffected > 0;
}

export interface OAuthGrantRow {
  id: string;
  client_id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
}

export async function listGrantsForUser(
  db: Client,
  userId: string,
): Promise<OAuthGrantRow[]> {
  const r = await db.execute({
    sql: `SELECT id, client_id, client_name, created_at, last_used_at
          FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
    args: [userId],
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    client_id: String(row.client_id),
    client_name: String(row.client_name),
    created_at: String(row.created_at),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
  }));
}
