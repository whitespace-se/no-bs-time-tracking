import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_COOKIE,
  canAdminister,
  canViewTimesheet,
  cookieOptions,
  createSession,
  destroyAllSessions,
  destroySession,
  purgeExpired,
  resolveSession,
} from '../src/lib/auth/session.ts';
import type { SessionUser } from '../src/lib/auth/session.ts';
import { insertUser, isoFromNow, withTempDb } from './support.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function sessionRow(database: Parameters<typeof createSession>[0], id: string) {
  return database
    .prepare('SELECT id, user_id, expires_at, user_agent, ip FROM sessions WHERE id = ?')
    .get(id) as { id: string; user_id: number; expires_at: string; user_agent: string | null; ip: string | null } | undefined;
}

test('creates a session with a long random id and a 30 day expiry, then resolves it', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database, { email: 'ada@example.test', firstName: 'Ada', lastName: 'Lovelace', role: 'manager' });
    const { id, expiresAt } = createSession(database, userId, { userAgent: 'test-agent/1.0', ip: '203.0.113.7' });

    assert.match(id, /^[A-Za-z0-9_-]{43}$/, '32 random bytes as base64url');
    const lifetime = Date.parse(expiresAt) - Date.now();
    assert.ok(lifetime > 29.9 * DAY_MS && lifetime <= 30 * DAY_MS, `lifetime was ${lifetime}ms`);
    assert.match(expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'second precision, no millis');

    const stored = sessionRow(database, id);
    assert.deepEqual(
      { user_id: stored?.user_id, expires_at: stored?.expires_at, user_agent: stored?.user_agent, ip: stored?.ip },
      { user_id: userId, expires_at: expiresAt, user_agent: 'test-agent/1.0', ip: '203.0.113.7' },
    );

    assert.deepEqual(resolveSession(database, id), {
      id: userId,
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      role: 'manager',
    });
  }));

test('two sessions for the same user get different ids', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const a = createSession(database, userId);
    const b = createSession(database, userId);
    assert.notEqual(a.id, b.id);
    assert.equal(resolveSession(database, a.id)?.id, userId);
    assert.equal(resolveSession(database, b.id)?.id, userId);
  }));

test('resolves nothing for a missing, unknown, or mangled token', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { id } = createSession(database, userId);

    assert.equal(resolveSession(database, undefined), null);
    assert.equal(resolveSession(database, ''), null);
    assert.equal(resolveSession(database, 'not-a-session'), null);
    assert.equal(resolveSession(database, id.slice(0, -1)), null, 'a truncated token is not a prefix match');
    assert.equal(resolveSession(database, `${id}x`), null);
    assert.equal(resolveSession(database, id.toUpperCase()), null, 'lookups are case-sensitive');
  }));

test('an expired session resolves to nothing and is deleted on the way out', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { id } = createSession(database, userId);
    database.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(isoFromNow(-1000), id);

    assert.equal(resolveSession(database, id), null);
    assert.equal(sessionRow(database, id), undefined, 'expired row was removed');
  }));

test('a session for a deactivated user stops working immediately', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { id } = createSession(database, userId);
    assert.ok(resolveSession(database, id));

    database.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    assert.equal(resolveSession(database, id), null);

    database.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(userId);
    assert.ok(resolveSession(database, id), 'reactivating restores the still-valid session');
  }));

test('the resolved name is trimmed when a name part is empty', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database, { firstName: 'Mononym', lastName: '' });
    const { id } = createSession(database, userId);
    assert.equal(resolveSession(database, id)?.name, 'Mononym');
  }));

test('destroySession removes exactly that session; undefined is a no-op', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const keep = createSession(database, userId);
    const drop = createSession(database, userId);

    destroySession(database, undefined);
    destroySession(database, 'never-existed');
    destroySession(database, drop.id);

    assert.equal(resolveSession(database, drop.id), null);
    assert.equal(resolveSession(database, keep.id)?.id, userId);
  }));

test('destroyAllSessions signs one user out everywhere and leaves others alone', () =>
  withTempDb(({ database }) => {
    const alice = insertUser(database);
    const bob = insertUser(database);
    const a1 = createSession(database, alice);
    const a2 = createSession(database, alice);
    const b1 = createSession(database, bob);

    destroyAllSessions(database, alice);

    assert.equal(resolveSession(database, a1.id), null);
    assert.equal(resolveSession(database, a2.id), null);
    assert.equal(resolveSession(database, b1.id)?.id, bob);
  }));

test('purgeExpired deletes only sessions whose expiry has passed', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const live = createSession(database, userId);
    const stale = createSession(database, userId);
    const edge = createSession(database, userId);
    database.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(isoFromNow(-DAY_MS), stale.id);
    database.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(isoFromNow(60_000), edge.id);

    purgeExpired(database);

    const remaining = (database.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map((r) => r.id).sort();
    assert.deepEqual(remaining, [live.id, edge.id].sort());
  }));

test('cookie options are HttpOnly, Lax, site-wide, 30 days, with the secure flag as asked', () => {
  assert.equal(SESSION_COOKIE, 'tt_session');
  const secure = cookieOptions(true);
  assert.deepEqual(secure, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 30 * 24 * 60 * 60 });
  assert.equal(cookieOptions(false).secure, false);
  assert.equal(cookieOptions(false).httpOnly, true, 'HttpOnly is not negotiable');
});

test('authorization helpers: members see only their own timesheet, only admins administer', () => {
  const member: SessionUser = { id: 1, email: 'm@example.test', name: 'M', role: 'member' };
  const manager: SessionUser = { id: 2, email: 'g@example.test', name: 'G', role: 'manager' };
  const admin: SessionUser = { id: 3, email: 'a@example.test', name: 'A', role: 'admin' };

  assert.equal(canViewTimesheet(member, 1), true);
  assert.equal(canViewTimesheet(member, 2), false);
  assert.equal(canViewTimesheet(manager, 1), true);
  assert.equal(canViewTimesheet(admin, 1), true);

  assert.equal(canAdminister(member), false);
  assert.equal(canAdminister(manager), false);
  assert.equal(canAdminister(admin), true);
});
