/**
 * Password hashing with scrypt from node:crypto.
 *
 * No dependency: argon2 and bcrypt both need native builds, which would put a compiler back
 * in the Docker image and reintroduce arch-specific bindings — the exact thing dropping
 * better-sqlite3 avoided.
 *
 * Stored format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. Parameters travel with the hash, so
 * raising the cost later doesn't invalidate existing passwords.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384; // ~16 MB, ~50–100ms. OWASP's floor for scrypt.
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  // No minimum length beyond having one: the choice is the account holder's.
  if (password.length === 0) {
    throw new Error('Enter a password.');
  }
  return hashWeak(password);
}

/**
 * Same hashing, without the length rule. Only reachable from the local CLI's --force flag,
 * for a developer who wants a throwaway login on their own machine. Nothing in the app
 * calls this — the minimum still applies to every password set through the UI.
 */
export async function hashWeak(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Users imported from Harvest have no password yet. Still burn the time, so "no such
  // account" and "wrong password" are indistinguishable from the outside.
  if (!stored) {
    await scrypt('decoy', randomBytes(16), KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return false;
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;

  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');

  // The digest length is ours, not the record's. scrypt finishes with PBKDF2, whose output is
  // prefix-truncatable: deriving `expected.length` bytes from a shortened stored hash would
  // compare only that prefix, so a three-byte hash would verify against almost anything.
  if (expected.length !== KEYLEN) return false;

  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
