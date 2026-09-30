/**
 * Storing the Harvest token so a re-sync doesn't need it typed again.
 *
 * A Harvest personal access token is full-account access, so this is the one secret in the
 * database that could cause real harm if the file leaked. It is always encrypted at rest with
 * AES-256-GCM; where the key lives is decided in `../instance-key.ts` and is the whole of the
 * security story — read that file before changing anything here.
 *
 * Storing used to be refused outright when `SECRET_KEY` was unset, on the grounds that
 * silently downgrading a security property is worse than the feature not working. The
 * downgrade is no longer silent: an instance without `SECRET_KEY` keeps its key in its own
 * database, the checkbox says so in the words that matter ("anyone with a copy of this
 * database can read it"), and the stronger option is one environment variable away.
 *
 * The token is optional throughout: the default migration path is one import and then
 * you are off Harvest, so keeping the token is a convenience for people running the two side
 * by side, not a requirement.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { rows } from '../db/index.ts';
import { decryptionKeys, encryptionKey, keySource, type KeySource } from '../instance-key.ts';
import { writeSettings } from '../settings.ts';
import type { SyncCredentials } from './sync.ts';

const KEY_ACCOUNT = 'harvest_account_id';
const KEY_CONTACT = 'harvest_contact';
const KEY_TOKEN = 'harvest_token_encrypted';

/**
 * Where the key protecting a stored token lives — 'env' when `SECRET_KEY` is set, 'instance'
 * when it is the database's own key. The UI needs this to describe what storing costs.
 */
export function tokenKeySource(db: Db): KeySource {
  return keySource(db);
}

function encrypt(plaintext: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

function decrypt(packed: string, k: Buffer): string | null {
  const [iv, tag, body] = packed.split('.');
  if (!iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or a tampered value. Both mean "there is no usable token here".
    return null;
  }
}

function settingsMap(db: Db): Map<string, string> {
  return new Map(
    rows<{ key: string; value: string }>(db.prepare('SELECT key, value FROM settings').all()).map(
      (r) => [r.key, r.value],
    ),
  );
}

/** Account id and contact are stored either way; the token only when asked for. */
export function saveCredentials(db: Db, credentials: SyncCredentials, keepToken: boolean): void {
  writeSettings(db, {
    [KEY_ACCOUNT]: credentials.accountId,
    [KEY_CONTACT]: credentials.contact,
  });

  if (!keepToken) {
    forgetToken(db);
    return;
  }
  writeSettings(db, { [KEY_TOKEN]: encrypt(credentials.accessToken, encryptionKey(db).key) });
}

export function forgetToken(db: Db): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(KEY_TOKEN);
}

export interface StoredCredentials {
  accountId: string | null;
  contact: string | null;
  /** Null when no token is stored, or when no key on this instance opens the one that is. */
  accessToken: string | null;
}

/**
 * Open a stored token with whichever key fits.
 *
 * GCM's auth tag makes a wrong key an unambiguous failure rather than a plausible-looking
 * wrong answer, so trying each candidate in turn is safe — and it is what lets an instance
 * that gained or lost `SECRET_KEY` still read what it wrote.
 */
function openToken(db: Db, packed: string): string | null {
  for (const candidate of decryptionKeys(db)) {
    const plaintext = decrypt(packed, candidate.key);
    if (plaintext !== null) return plaintext;
  }
  return null;
}

export function readCredentials(db: Db): StoredCredentials {
  const stored = settingsMap(db);
  const packed = stored.get(KEY_TOKEN);

  return {
    accountId: stored.get(KEY_ACCOUNT) ?? process.env.HARVEST_ACCOUNT_ID ?? null,
    contact: stored.get(KEY_CONTACT) ?? process.env.HARVEST_CONTACT ?? null,
    accessToken: (packed ? openToken(db, packed) : null) ?? process.env.HARVEST_ACCESS_TOKEN ?? null,
  };
}

/** Complete credentials, or null when something is missing — the caller must ask for it. */
export function usableCredentials(db: Db): SyncCredentials | null {
  const stored = readCredentials(db);
  if (!stored.accountId || !stored.accessToken || !stored.contact) return null;
  return {
    accountId: stored.accountId,
    accessToken: stored.accessToken,
    contact: stored.contact,
  };
}
