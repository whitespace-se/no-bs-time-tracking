/**
 * The key this instance encrypts its stored secrets with.
 *
 * The promise is that an instance *is* its SQLite file: the same image runs wherever it is
 * hosted, and moving an organization means moving one file. A key that has to be set in
 * the environment breaks that — a database restored next to a fresh container comes up unable
 * to read its own token, and nothing on screen explains why. So the key has a home in the
 * database, generated on first use.
 *
 * Two sources, in this order:
 *
 *   1. `SECRET_KEY` in the environment. Strongest, and unchanged from before: the key is not
 *      in the file, so a stolen database yields nothing.
 *   2. `settings.instance_key`, 32 random bytes written on first use.
 *
 * Be honest about what (2) buys. A key stored beside the ciphertext it protects does not
 * defend against someone holding the file — they have both halves. What it does defend
 * against is the ordinary way credentials actually escape: a token sitting in plaintext in a
 * settings row that ends up in a screenshot, a support paste, a CSV, or a `SELECT * FROM
 * settings` in somebody's terminal history. That is a real class of leak and this closes it.
 * It is not a substitute for `SECRET_KEY`, and the UI says so where the choice is made.
 *
 * Encryption always uses the strongest key available; decryption tries every key, so an
 * instance that gains or loses `SECRET_KEY` keeps reading what it wrote before.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import type { Db } from './db/index.ts';
import { row } from './db/index.ts';

const SETTING = 'instance_key';

/** Same derivation as the original env-only implementation, so old ciphertexts still open. */
const ENV_SALT = 'harvest-token-v1';

export type KeySource = 'env' | 'instance';

export interface InstanceKey {
  key: Buffer;
  source: KeySource;
}

function fromEnv(): InstanceKey | null {
  const secret = process.env.SECRET_KEY;
  if (!secret) return null;
  return { key: scryptSync(secret, ENV_SALT, 32), source: 'env' };
}

/**
 * The instance's own key, created on first use.
 *
 * `ON CONFLICT DO NOTHING` then read back, rather than check-then-write: two requests arriving
 * together must not each generate a key and each believe theirs is the one that stored.
 */
function fromDatabase(db: Db): InstanceKey {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  ).run(SETTING, randomBytes(32).toString('base64'));

  const stored = row<{ value: string }>(
    db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING),
  );
  if (!stored) throw new Error('Could not read or create the instance key.');

  return { key: Buffer.from(stored.value, 'base64'), source: 'instance' };
}

/** The key to encrypt *new* values with: the environment's if there is one. */
export function encryptionKey(db: Db): InstanceKey {
  return fromEnv() ?? fromDatabase(db);
}

/**
 * Every key that might open an existing value, strongest first.
 *
 * Both are tried because the set changes underneath stored data: an instance that had
 * `SECRET_KEY` set and lost it, or gained one after writing under its instance key, should
 * keep working rather than silently reporting no token.
 */
export function decryptionKeys(db: Db): InstanceKey[] {
  const env = fromEnv();
  const keys: InstanceKey[] = [];
  if (env) keys.push(env);

  // Only offer the instance key if one already exists — asking for it here would write a key
  // into a database that has no secrets in it, purely because something tried to read one.
  const stored = row<{ value: string }>(
    db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING),
  );
  if (stored) keys.push({ key: Buffer.from(stored.value, 'base64'), source: 'instance' });

  return keys;
}

/** Where the key that protects stored secrets lives, for the UI to be plain about it. */
export function keySource(db: Db): KeySource {
  void db;
  return fromEnv() ? 'env' : 'instance';
}

/**
 * Settings rows that must never leave the instance: the key, and anything it protects.
 *
 * Exported as data rather than inlined at the one call site, because the answer to "what is
 * sensitive in this table" is needed in more than one place — the database download strips
 * these, and the demo anonymiser deletes them.
 */
export const SECRET_SETTINGS = [SETTING, 'harvest_token_encrypted'] as const;
