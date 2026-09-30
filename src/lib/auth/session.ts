/**
 * Sessions — a random token in an HttpOnly cookie, backed by the `sessions` table.
 *
 * A database table rather than a signed stateless cookie, for two reasons: sign-out-everywhere
 * has to actually work, and sessions then live in the same SQLite file as everything else, so
 * one `VACUUM INTO` backs up the whole instance.
 */

import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { db, nowIso, row } from '../db/index.ts';

export const SESSION_COOKIE = 'tt_session';
const LIFETIME_DAYS = 30;

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'member';
}

function expiry(days = LIFETIME_DAYS): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createSession(
  database: Db,
  userId: number,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): { id: string; expiresAt: string } {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = expiry();
  database
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at, user_agent, ip)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(id, userId, expiresAt, nowIso(), meta.userAgent ?? null, meta.ip ?? null);
  return { id, expiresAt };
}

export function resolveSession(database: Db, token: string | undefined): SessionUser | null {
  if (!token) return null;

  const found = row<{
    id: number;
    email: string;
    name: string;
    role: SessionUser['role'];
    expires_at: string;
  }>(
    database
      .prepare(
        `SELECT u.id, u.email, TRIM(u.first_name || ' ' || u.last_name) AS name, u.role,
                s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ? AND u.is_active = 1`,
      )
      .get(token),
  );

  if (!found) return null;

  if (Date.parse(found.expires_at) < Date.now()) {
    database.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return null;
  }

  return { id: found.id, email: found.email, name: found.name, role: found.role };
}

export function destroySession(database: Db, token: string | undefined): void {
  if (token) database.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

/** Sign out everywhere — the reason sessions are a table and not a stateless cookie. */
export function destroyAllSessions(database: Db, userId: number): void {
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpired(database: Db = db()): void {
  database.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

// ── Authorization ────────────────────────────────────────────────────────────

/** Admins and managers may open someone else's timesheet; members only their own. */
export function canViewTimesheet(user: SessionUser, targetUserId: number): boolean {
  return user.id === targetUserId || user.role === 'admin' || user.role === 'manager';
}

/** Only admins may change who exists or what they are paid. */
export function canAdminister(user: SessionUser): boolean {
  return user.role === 'admin';
}

/**
 * `secure` comes from the deployment, not from the socket — see src/lib/public-origin.ts.
 */
export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: LIFETIME_DAYS * 24 * 60 * 60,
  };
}
