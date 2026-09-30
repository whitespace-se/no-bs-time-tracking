import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';
import { hashPassword, hashWeak, verifyPassword } from '../src/lib/auth/password.ts';

const PASSWORD = 'correct horse battery staple';

test('hashes in the documented scrypt$N$r$p$salt$hash format', async () => {
  const stored = await hashPassword(PASSWORD);
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.deepEqual(parts.slice(1, 4).map(Number), [16384, 8, 1]);
  assert.equal(Buffer.from(parts[4]!, 'base64').length, 16, 'salt is 16 bytes');
  assert.equal(Buffer.from(parts[5]!, 'base64').length, 32, 'derived key is 32 bytes');
  assert.ok(!stored.includes(PASSWORD), 'plaintext never appears in the stored value');
});

test('round-trips a password and rejects a wrong one', async () => {
  const stored = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(await verifyPassword(`${PASSWORD} `, stored), false);
  assert.equal(await verifyPassword('', stored), false);
  assert.equal(await verifyPassword('Correct horse battery staple', stored), false, 'case matters');
});

test('every hash gets its own salt, so equal passwords do not produce equal hashes', async () => {
  const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
  assert.notEqual(a, b);
  assert.notEqual(a.split('$')[4], b.split('$')[4], 'salts differ');
  assert.notEqual(a.split('$')[5], b.split('$')[5], 'derived keys differ');
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test('a tampered hash or salt no longer verifies', async () => {
  const stored = await hashPassword(PASSWORD);
  const parts = stored.split('$');

  const flip = (value: string) => (value[0] === 'A' ? 'B' : 'A') + value.slice(1);

  const tamperedHash = [...parts.slice(0, 5), flip(parts[5]!)].join('$');
  assert.equal(await verifyPassword(PASSWORD, tamperedHash), false);

  const tamperedSalt = [...parts.slice(0, 4), flip(parts[4]!), parts[5]].join('$');
  assert.equal(await verifyPassword(PASSWORD, tamperedSalt), false);

  const truncatedHash = [...parts.slice(0, 5), parts[5]!.slice(0, 20)].join('$');
  assert.equal(await verifyPassword(PASSWORD, truncatedHash), false);
});

test('parameters travel with the hash: a hash made with a lower cost still verifies', async () => {
  // Simulate a hash written by an older, cheaper configuration. Only N differs.
  const stored = await hashWeak(PASSWORD);
  const parts = stored.split('$');
  const salt = Buffer.from(parts[4]!, 'base64');
  const cheaper = scryptSync(PASSWORD.normalize('NFKC'), salt, 32, { N: 1024, r: 8, p: 1 });
  const legacy = ['scrypt', '1024', '8', '1', parts[4], cheaper.toString('base64')].join('$');

  assert.equal(await verifyPassword(PASSWORD, legacy), true);
  assert.equal(await verifyPassword('not the password', legacy), false);
});

test('refuses to verify against a missing or foreign-format hash without throwing', async () => {
  assert.equal(await verifyPassword(PASSWORD, null), false, 'imported user without a password');
  assert.equal(await verifyPassword(PASSWORD, ''), false);
  assert.equal(await verifyPassword(PASSWORD, PASSWORD), false, 'a plaintext "hash" never matches');
  assert.equal(await verifyPassword(PASSWORD, '$2b$10$abcdefghijklmnopqrstuv'), false, 'bcrypt-style');
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$16384$8$1$onlyfiveparts'), false);
  assert.equal(await verifyPassword(PASSWORD, 'argon2$16384$8$1$c2FsdA==$aGFzaA=='), false, 'wrong algorithm tag');
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$16384$8$1$c2FsdA==$aGFzaA==$extra'), false, 'too many parts');
});

test('the missing-hash path still spends time, so absent accounts are not instantly distinguishable', async () => {
  // Not a strict timing test — just that the decoy scrypt runs, which shows up as
  // something well above a bare early return (a few ms at minimum, typically tens).
  const started = process.hrtime.bigint();
  await verifyPassword(PASSWORD, null);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs > 1, `expected the decoy derivation to take time, got ${elapsedMs}ms`);
});

test('any non-empty password is accepted; only an empty one is refused', async () => {
  assert.ok(await verifyPassword('abc', await hashPassword('abc')));
  await assert.rejects(() => hashPassword(''), /Enter a password/);
  assert.match(await hashPassword('exactly 10'), /^scrypt\$/);

  const weak = await hashWeak('abc');
  assert.match(weak, /^scrypt\$/);
  assert.equal(await verifyPassword('abc', weak), true);
});

test('normalises Unicode (NFKC) so composed and decomposed forms are the same password', async () => {
  const composed = 'pässword-längd-ok'; // precomposed ä (U+00E4)
  const decomposed = composed.normalize('NFD');
  assert.notEqual(composed, decomposed, 'sanity: the two strings differ byte-wise');

  const stored = await hashPassword(composed);
  assert.equal(await verifyPassword(decomposed, stored), true);

  // Compatibility forms too: the ligature ﬁ becomes "fi" under NFKC.
  const ligature = await hashPassword('ﬁrst-password!');
  assert.equal(await verifyPassword('first-password!', ligature), true);
});
