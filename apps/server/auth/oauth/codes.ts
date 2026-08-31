// Single-use OAuth 2.1 authorization codes (60s TTL). Redemption stamps
// used_at; the grant it mints is attached afterwards via attachGrantToCode
// so a second redemption of the same code (a replay -- theft evidence per
// OAuth 2.1) can revoke that grant. Spec:
// docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Data model").

import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";

const CODE_TTL_MS = 60 * 1000;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function sqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export interface MintCodeInput {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

export interface MintedCode {
  codeId: string;
  code: string;
}

export async function mintAuthorizationCode(
  db: Client,
  input: MintCodeInput,
): Promise<MintedCode> {
  const id = ulid();
  const code = randomBytes(32).toString("base64url");
  const expiresAt = sqliteDatetime(Date.now() + CODE_TTL_MS);
  await db.execute({
    sql: `INSERT INTO oauth_codes (
      id, code_hash, user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      hashCode(code),
      input.userId,
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.resource,
      input.scope,
      expiresAt,
    ],
  });
  return { codeId: id, code };
}

export interface RedeemedCode {
  codeId: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

export type RedeemResult =
  | { ok: true; code: RedeemedCode }
  | { ok: false; reason: "invalid_grant" };

// Redeems a code: unknown or expired codes are a plain invalid_grant. A
// code that was already redeemed (used_at set) is a replay -- theft
// evidence -- so the grant it minted (grant_id, set via attachGrantToCode
// after the caller mints it) is revoked. Marks used_at on first, valid
// redemption; the caller still needs to verify PKCE against codeChallenge
// before trusting the result.
export async function redeemAuthorizationCode(
  db: Client,
  code: string,
): Promise<RedeemResult> {
  const hash = hashCode(code);
  const r = await db.execute({
    sql: `SELECT id, user_id, client_id, redirect_uri, code_challenge, resource, scope,
                 grant_id, (used_at IS NOT NULL) AS is_used,
                 (expires_at <= datetime('now')) AS is_expired
          FROM oauth_codes WHERE code_hash = ?`,
    args: [hash],
  });
  if (r.rows.length === 0) return { ok: false, reason: "invalid_grant" };
  const row = r.rows[0];

  if (Number(row.is_used) === 1) {
    if (row.grant_id != null) {
      await db.execute({
        sql: "UPDATE oauth_grants SET revoked_at = datetime('now') WHERE id = ?",
        args: [row.grant_id],
      });
    }
    return { ok: false, reason: "invalid_grant" };
  }

  if (Number(row.is_expired) === 1) {
    return { ok: false, reason: "invalid_grant" };
  }

  // Conditional stamp: closes the TOCTOU window between the SELECT above
  // and this UPDATE. If a concurrent redemption of the same code already
  // stamped used_at, rowsAffected is 0 -- treat it the same as the
  // already-used branch above (replay, revoke any attached grant).
  const stamp = await db.execute({
    sql: "UPDATE oauth_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL",
    args: [row.id],
  });
  if (stamp.rowsAffected === 0) {
    const race = await db.execute({
      sql: "SELECT grant_id FROM oauth_codes WHERE id = ?",
      args: [row.id],
    });
    const grantId = race.rows[0]?.grant_id;
    if (grantId != null) {
      await db.execute({
        sql: "UPDATE oauth_grants SET revoked_at = datetime('now') WHERE id = ?",
        args: [grantId],
      });
    }
    return { ok: false, reason: "invalid_grant" };
  }

  return {
    ok: true,
    code: {
      codeId: String(row.id),
      userId: String(row.user_id),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      resource: String(row.resource),
      scope: String(row.scope),
    },
  };
}

export async function attachGrantToCode(
  db: Client,
  codeId: string,
  grantId: string,
): Promise<void> {
  await db.execute({
    sql: "UPDATE oauth_codes SET grant_id = ? WHERE id = ?",
    args: [grantId, codeId],
  });
}
