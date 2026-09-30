import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createToken,
  hashToken,
  listAllTokens,
  listTokens,
  resolveToken,
  revokeAnyToken,
  revokeToken,
  touchToken,
} from '../src/lib/auth/api-token.ts';
import { RATE_LIMIT_PER_MINUTE, rateHeaders, rateLimit } from '../src/lib/api/http.ts';
import type { Db } from '../src/lib/db/index.ts';
import { insertUser, isoFromNow, withTempDb } from './support.ts';

function tokenRow(database: Db, id: number) {
  return database.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as Record<string, unknown>;
}

// ── Creation and storage ─────────────────────────────────────────────────────

test('createToken returns a tt_-prefixed secret once and stores only its SHA-256', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { token, record } = createToken(database, userId, '  CI reader  ');

    assert.match(token, /^tt_[A-Za-z0-9_-]{43}$/, '32 random bytes as base64url behind the prefix');
    assert.equal(record.name, 'CI reader', 'name is trimmed');
    assert.equal(record.prefix, token.slice(0, 11));
    assert.equal(record.revoked_at, null);
    assert.equal(record.last_used_at, null);
    assert.equal(record.expires_at, null);

    const stored = tokenRow(database, record.id);
    assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(stored.token_hash, hashToken(token));
    for (const [column, value] of Object.entries(stored)) {
      assert.ok(!String(value).includes(token), `plaintext token leaked into column ${column}`);
    }
    assert.ok(!String(stored.prefix).includes(token.slice(11)), 'the prefix is not the secret');
  }));

test('an empty or whitespace name falls back to "Unnamed token"', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    assert.equal(createToken(database, userId, '').record.name, 'Unnamed token');
    assert.equal(createToken(database, userId, '   ').record.name, 'Unnamed token');
  }));

test('each token is unique even for the same owner and name', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const a = createToken(database, userId, 'same');
    const b = createToken(database, userId, 'same');
    assert.notEqual(a.token, b.token);
    assert.notEqual(tokenRow(database, a.record.id).token_hash, tokenRow(database, b.record.id).token_hash);
  }));

// ── Resolving the Authorization header ───────────────────────────────────────

test('resolveToken maps a valid bearer header to its owner and inherits the owner role', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database, { email: 'grace@example.test', firstName: 'Grace', lastName: 'Hopper', role: 'manager' });
    const { token, record } = createToken(database, userId, 'reporting');

    const bearer = resolveToken(database, `Bearer ${token}`);
    assert.deepEqual(bearer, {
      user: { id: userId, email: 'grace@example.test', name: 'Grace Hopper', role: 'manager' },
      tokenId: record.id,
      tokenName: 'reporting',
    });
  }));

test('resolveToken is lenient about scheme case and surrounding whitespace, strict about shape', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { token } = createToken(database, userId, 't');

    assert.ok(resolveToken(database, `bearer ${token}`), 'scheme is case-insensitive');
    assert.ok(resolveToken(database, `BEARER   ${token}`), 'multiple spaces');
    assert.ok(resolveToken(database, `  Bearer ${token}  `), 'trimmed');

    assert.equal(resolveToken(database, null), null);
    assert.equal(resolveToken(database, ''), null);
    assert.equal(resolveToken(database, 'Bearer'), null, 'scheme without a token');
    assert.equal(resolveToken(database, 'Bearer '), null);
    assert.equal(resolveToken(database, token), null, 'bare token without the scheme');
    assert.equal(resolveToken(database, `Basic ${token}`), null, 'wrong scheme');
    assert.equal(resolveToken(database, `Token ${token}`), null);
    assert.equal(resolveToken(database, `Bearer ${token} extra`), null, 'trailing junk');
    assert.equal(resolveToken(database, `Bearer${token}`), null, 'no separator');
  }));

test('resolveToken rejects unknown, near-miss, and hash-instead-of-token values', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { token } = createToken(database, userId, 't');

    assert.equal(resolveToken(database, 'Bearer tt_0000000000000000000000000000000000000000000'), null);
    assert.equal(resolveToken(database, `Bearer ${token.slice(0, -1)}`), null, 'one char short');
    assert.equal(resolveToken(database, `Bearer ${token}A`), null, 'one char long');
    assert.equal(resolveToken(database, `Bearer ${token.slice(3)}`), null, 'prefix stripped');
    assert.equal(resolveToken(database, `Bearer ${hashToken(token)}`), null, 'the stored hash is not a credential');
  }));

test('a revoked token stops resolving, and revocation is owner-scoped and idempotent', () =>
  withTempDb(({ database }) => {
    const owner = insertUser(database);
    const other = insertUser(database);
    const { token, record } = createToken(database, owner, 't');

    assert.equal(revokeToken(database, other, record.id), false, 'someone else cannot revoke it');
    assert.ok(resolveToken(database, `Bearer ${token}`), 'still valid after the refused attempt');

    assert.equal(revokeToken(database, owner, record.id), true);
    assert.equal(resolveToken(database, `Bearer ${token}`), null);
    assert.equal(revokeToken(database, owner, record.id), false, 'second revoke changes nothing');

    const stored = tokenRow(database, record.id);
    assert.ok(typeof stored.revoked_at === 'string', 'revoked is a timestamp, the row survives');
  }));

test('revokeAnyToken lets an administrator revoke a token they do not own', () =>
  withTempDb(({ database }) => {
    const owner = insertUser(database);
    const { token, record } = createToken(database, owner, 't');

    assert.equal(revokeAnyToken(database, record.id), true);
    assert.equal(resolveToken(database, `Bearer ${token}`), null);
    assert.equal(revokeAnyToken(database, record.id), false);
    assert.equal(revokeAnyToken(database, 99_999), false, 'unknown id');
  }));

test('expiry is honoured: past expires_at fails, future expires_at works', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const inAnHour = isoFromNow(60 * 60 * 1000);
    const expired = createToken(database, userId, 'old', isoFromNow(-1000));
    const live = createToken(database, userId, 'new', inAnHour);

    assert.equal(resolveToken(database, `Bearer ${expired.token}`), null);
    assert.equal(resolveToken(database, `Bearer ${live.token}`)?.tokenId, live.record.id);
    assert.equal(live.record.expires_at, inAnHour);
    assert.equal(tokenRow(database, live.record.id).expires_at, inAnHour);
  }));

test('a token belonging to a deactivated user stops resolving', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { token } = createToken(database, userId, 't');
    database.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    assert.equal(resolveToken(database, `Bearer ${token}`), null);
  }));

// ── Listing ──────────────────────────────────────────────────────────────────

test('listTokens shows only the owner\'s tokens, live ones first, and never a hash', () =>
  withTempDb(({ database }) => {
    const alice = insertUser(database);
    const bob = insertUser(database);
    const first = createToken(database, alice, 'first');
    const second = createToken(database, alice, 'second');
    createToken(database, bob, 'bobs');
    // Make ordering deterministic regardless of same-second timestamps.
    database.prepare('UPDATE api_tokens SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', first.record.id);
    database.prepare('UPDATE api_tokens SET created_at = ? WHERE id = ?').run('2026-01-02T00:00:00Z', second.record.id);
    revokeToken(database, alice, second.record.id);

    const listed = listTokens(database, alice);
    assert.deepEqual(listed.map((t) => t.name), ['first', 'second'], 'revoked sorts after live despite being newer');
    for (const record of listed) {
      assert.ok(!('token_hash' in record), 'hash is not exposed');
      assert.ok(!('user_id' in record));
    }
    assert.equal(listTokens(database, bob).length, 1);
    assert.equal(listTokens(database, 12_345).length, 0);
  }));

test('listAllTokens spans owners and names them, still without secrets', () =>
  withTempDb(({ database }) => {
    const alice = insertUser(database, { email: 'alice@example.test', firstName: 'Alice', lastName: 'Adams', role: 'admin' });
    const bob = insertUser(database, { email: 'bob@example.test', firstName: 'Bob', lastName: 'Brown' });
    createToken(database, alice, 'a');
    createToken(database, bob, 'b');

    const all = listAllTokens(database);
    assert.equal(all.length, 2);
    const byName = new Map(all.map((t) => [t.name, t]));
    assert.deepEqual(
      { user_id: byName.get('a')?.user_id, owner: byName.get('a')?.owner, owner_email: byName.get('a')?.owner_email, owner_role: byName.get('a')?.owner_role },
      { user_id: alice, owner: 'Alice Adams', owner_email: 'alice@example.test', owner_role: 'admin' },
    );
    assert.equal(byName.get('b')?.owner, 'Bob Brown');
    for (const record of all) assert.ok(!('token_hash' in record));
  }));

// ── touchToken ───────────────────────────────────────────────────────────────

test('touchToken records first use, then at most once a minute', () =>
  withTempDb(({ database }) => {
    const userId = insertUser(database);
    const { record } = createToken(database, userId, 't');
    const read = () => tokenRow(database, record.id).last_used_at as string | null;

    assert.equal(read(), null);
    touchToken(database, record.id);
    const first = read();
    assert.ok(first, 'first touch sets last_used_at');

    // Pretend the last touch was 30 seconds ago: within the minute, so no write.
    const recent = isoFromNow(-30_000);
    database.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(recent, record.id);
    touchToken(database, record.id);
    assert.equal(read(), recent, 'not rewritten inside the window');

    // Two minutes ago: outside the window, so it advances.
    const stale = isoFromNow(-120_000);
    database.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(stale, record.id);
    touchToken(database, record.id);
    assert.notEqual(read(), stale);
    assert.ok(Date.parse(read()!) > Date.parse(stale));
  }));

// ── Rate limiting (lib/api/http.ts) ───────────────────────────────────────────

test('rateLimit allows 240 requests per fixed minute window, then refuses', () => {
  const key = `token-${Math.random()}`;
  const start = 1_700_000_000_000;

  const first = rateLimit(key, start);
  assert.deepEqual(first, { ok: true, remaining: RATE_LIMIT_PER_MINUTE - 1, resetAt: start + 60_000 });

  let last = first;
  for (let i = 2; i <= RATE_LIMIT_PER_MINUTE; i += 1) last = rateLimit(key, start + i);
  assert.deepEqual(last, { ok: true, remaining: 0, resetAt: start + 60_000 });

  const over = rateLimit(key, start + 59_999);
  assert.deepEqual(over, { ok: false, remaining: 0, resetAt: start + 60_000 }, 'the 241st inside the window is refused');
  assert.equal(rateLimit(key, start + 59_999).remaining, 0, 'remaining never goes negative');
});

test('rateLimit windows reset once resetAt passes and are independent per key', () => {
  const key = `token-${Math.random()}`;
  const other = `token-${Math.random()}`;
  const start = 1_700_000_000_000;

  for (let i = 0; i <= RATE_LIMIT_PER_MINUTE; i += 1) rateLimit(key, start);
  assert.equal(rateLimit(key, start + 1).ok, false);
  assert.equal(rateLimit(other, start + 1).ok, true, 'another token is unaffected');

  const renewed = rateLimit(key, start + 60_000);
  assert.deepEqual(renewed, { ok: true, remaining: RATE_LIMIT_PER_MINUTE - 1, resetAt: start + 120_000 });
});

test('rateHeaders advertise the limit, remaining count, and seconds until reset', () => {
  const now = Date.now();
  const headers = rateHeaders({ ok: true, remaining: 17, resetAt: now + 30_000 });
  assert.equal(headers['RateLimit-Limit'], '240');
  assert.equal(headers['RateLimit-Remaining'], '17');
  const reset = Number(headers['RateLimit-Reset']);
  assert.ok(reset >= 29 && reset <= 30, `reset was ${reset}`);

  assert.equal(rateHeaders({ ok: false, remaining: 0, resetAt: now - 5_000 })['RateLimit-Reset'], '0', 'never negative');
});
