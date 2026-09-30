/**
 * Personal access tokens for the JSON API.
 *
 * A token is 32 random bytes, shown once at creation and never again — the database holds
 * only its SHA-256. See migration 008 for why a fast hash is correct for a secret nobody
 * chose and wrong for one somebody did.
 *
 * A token authenticates as its owner and inherits that person's role. Nothing here grants
 * more than the owner has, so a member's token cannot read what a member cannot.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { nowIso, row, rows } from '../db/index.ts';
import type { SessionUser } from './session.ts';

/** Marks the string as ours in a log or a config file, and is not part of the secret. */
const PREFIX = 'tt_';
const PREFIX_SHOWN = 8;

export interface ApiTokenRecord {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Mint a token for a person. The plaintext is returned exactly once; only the caller's
 * response can ever show it.
 */
export function createToken(
  db: Db,
  userId: number,
  name: string,
  expiresAt: string | null = null,
): { token: string; record: ApiTokenRecord } {
  const secret = randomBytes(32).toString('base64url');
  const token = `${PREFIX}${secret}`;
  const created = nowIso();

  const result = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at, expires_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(userId, name.trim() || 'Unnamed token', hashToken(token), token.slice(0, PREFIX.length + PREFIX_SHOWN), created, expiresAt);

  return {
    token,
    record: {
      id: Number(result.lastInsertRowid),
      name: name.trim() || 'Unnamed token',
      prefix: token.slice(0, PREFIX.length + PREFIX_SHOWN),
      created_at: created,
      last_used_at: null,
      expires_at: expiresAt,
      revoked_at: null,
    },
  };
}

export function listTokens(db: Db, userId: number): ApiTokenRecord[] {
  return rows<ApiTokenRecord>(
    db
      .prepare(
        `SELECT id, name, prefix, created_at, last_used_at, expires_at, revoked_at
           FROM api_tokens WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC`,
      )
      .all(userId),
  );
}

export interface OwnedToken extends ApiTokenRecord {
  user_id: number;
  owner: string;
  owner_email: string;
  owner_role: 'admin' | 'manager' | 'member';
}

/**
 * Every token in the instance, whoever made it.
 *
 * An administrator needs this for the case the owner cannot help with: someone leaves, and the
 * integration they set up keeps reading the account until somebody can see that it exists.
 * It shows names, prefixes and use — never a secret, because none is stored.
 */
export function listAllTokens(db: Db): OwnedToken[] {
  return rows<OwnedToken>(
    db
      .prepare(
        `SELECT t.id, t.name, t.prefix, t.created_at, t.last_used_at, t.expires_at, t.revoked_at,
                u.id AS user_id, TRIM(u.first_name || ' ' || u.last_name) AS owner,
                u.email AS owner_email, u.role AS owner_role
           FROM api_tokens t JOIN users u ON u.id = t.user_id
       ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`,
      )
      .all(),
  );
}

/**
 * Revoke any token in the instance. For an administrator cleaning up after someone else; the
 * owner-scoped `revokeToken` below is what a person's own buttons use.
 */
export function revokeAnyToken(db: Db, tokenId: number): boolean {
  return (
    db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowIso(), tokenId).changes > 0
  );
}

/** Revoking is a timestamp, not a delete: the record of what existed is worth keeping. */
export function revokeToken(db: Db, userId: number, tokenId: number): boolean {
  return (
    db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(nowIso(), tokenId, userId).changes > 0
  );
}

export interface TokenBearer {
  user: SessionUser;
  tokenId: number;
  tokenName: string;
}

/**
 * Resolve an `Authorization: Bearer …` header to the person it belongs to.
 *
 * The lookup is by hash, which is a unique index, so this is one indexed read rather than a
 * scan and a comparison per row. The constant-time compare that follows guards the case the
 * index cannot: two rows are only equal here if their hashes are, and comparing the hashes
 * again with timingSafeEqual costs nothing and removes any doubt about the driver's own
 * string comparison.
 */
export function resolveToken(db: Db, header: string | null): TokenBearer | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;

  const presented = hashToken(match[1]!);
  const found = row<{
    id: number;
    name: string;
    token_hash: string;
    expires_at: string | null;
    revoked_at: string | null;
    user_id: number;
    email: string;
    user_name: string;
    role: SessionUser['role'];
    is_active: number;
  }>(
    db
      .prepare(
        `SELECT t.id, t.name, t.token_hash, t.expires_at, t.revoked_at,
                u.id AS user_id, u.email, TRIM(u.first_name || ' ' || u.last_name) AS user_name,
                u.role, u.is_active
           FROM api_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?`,
      )
      .get(presented),
  );

  if (!found) return null;

  const a = Buffer.from(found.token_hash, 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (found.revoked_at) return null;
  if (found.expires_at && found.expires_at <= nowIso()) return null;
  if (!found.is_active) return null;

  return {
    user: { id: found.user_id, email: found.email, name: found.user_name, role: found.role },
    tokenId: found.id,
    tokenName: found.name,
  };
}

/**
 * Record that a token was used, at most once a minute.
 *
 * "Last used" answers one question — is this token still in service, or can it be revoked —
 * and a date is enough for that. Writing on every request would put a write in the path of a
 * read-only API and, on a busy caller, a write per request against one row.
 */
export function touchToken(db: Db, tokenId: number): void {
  db.prepare(
    `UPDATE api_tokens SET last_used_at = ?
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
  ).run(nowIso(), tokenId, new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
}
