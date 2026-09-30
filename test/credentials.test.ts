import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Db } from '../src/lib/db/index.ts';
import {
  forgetToken,
  readCredentials,
  saveCredentials,
  tokenKeySource,
  usableCredentials,
} from '../src/lib/harvest/credentials.ts';
import { NO_SECRETS_ENV, withEnv, withTempDb } from './support.ts';

const TOKEN = 'synthetic-harvest-pat-0123456789abcdefABCDEF.rest-of-token';
const CREDENTIALS = { accountId: '1234567', accessToken: TOKEN, contact: 'ops@example.test' };

function settingsRows(database: Db): Map<string, string> {
  return new Map(
    (database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );
}

function storedToken(database: Db): string | undefined {
  return settingsRows(database).get('harvest_token_encrypted');
}

/** Every byte the instance folder holds: the database plus any WAL/SHM that is still around. */
function folderBytes(dir: string): Buffer {
  return Buffer.concat(readdirSync(dir).map((name) => readFileSync(join(dir, name))));
}

test('saves account and contact in the clear, and the token only when asked', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database }) => {
      saveCredentials(database, CREDENTIALS, false);
      const rows = settingsRows(database);
      assert.equal(rows.get('harvest_account_id'), '1234567');
      assert.equal(rows.get('harvest_contact'), 'ops@example.test');
      assert.equal(rows.has('harvest_token_encrypted'), false);
      assert.deepEqual(readCredentials(database), { accountId: '1234567', contact: 'ops@example.test', accessToken: null });
      assert.equal(usableCredentials(database), null, 'no token means not usable');

      saveCredentials(database, CREDENTIALS, true);
      assert.deepEqual(readCredentials(database), CREDENTIALS);
      assert.deepEqual(usableCredentials(database), CREDENTIALS);
    }),
  ));

test('the token is encrypted at rest: neither the settings rows nor the file on disk contain it', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database, dir }) => {
      saveCredentials(database, CREDENTIALS, true);

      for (const [key, value] of settingsRows(database)) {
        assert.ok(!value.includes(TOKEN), `plaintext token found in settings.${key}`);
      }
      const packed = storedToken(database)!;
      assert.match(packed, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/, 'iv.tag.body, base64');
      const [iv, tag] = packed.split('.');
      assert.equal(Buffer.from(iv!, 'base64').length, 12, 'GCM nonce');
      assert.equal(Buffer.from(tag!, 'base64').length, 16, 'GCM auth tag');

      // Checkpoint and close so everything is in the main file, then grep the bytes.
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      database.close();
      const bytes = folderBytes(dir);
      assert.ok(bytes.includes('harvest_account_id'), 'sanity: the settings table is in the file');
      assert.ok(bytes.includes('1234567'), 'sanity: cleartext settings are findable');
      assert.ok(!bytes.includes(TOKEN), 'the plaintext token is nowhere in the instance folder');
    }),
  ));

test('saving the same token twice produces different ciphertext (fresh IV each time)', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database }) => {
      saveCredentials(database, CREDENTIALS, true);
      const first = storedToken(database);
      saveCredentials(database, CREDENTIALS, true);
      const second = storedToken(database);
      assert.ok(first && second);
      assert.notEqual(first, second);
      assert.equal(readCredentials(database).accessToken, TOKEN);
    }),
  ));

test('saving again without keepToken forgets a previously stored token', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database }) => {
      saveCredentials(database, CREDENTIALS, true);
      assert.ok(storedToken(database));
      saveCredentials(database, { ...CREDENTIALS, accessToken: 'another-synthetic-token' }, false);
      assert.equal(storedToken(database), undefined);
      assert.equal(readCredentials(database).accessToken, null);

      saveCredentials(database, CREDENTIALS, true);
      forgetToken(database);
      assert.equal(storedToken(database), undefined);
      forgetToken(database); // idempotent
      assert.equal(readCredentials(database).accountId, '1234567', 'account and contact survive');
    }),
  ));

test('a tampered ciphertext, tag, or IV reads back as no token rather than garbage', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database }) => {
      saveCredentials(database, CREDENTIALS, true);
      const original = storedToken(database)!;
      const [iv, tag, body] = original.split('.') as [string, string, string];
      const put = database.prepare("UPDATE settings SET value = ? WHERE key = 'harvest_token_encrypted'");
      const flip = (b64: string) => {
        const bytes = Buffer.from(b64, 'base64');
        bytes[0] = bytes[0]! ^ 0x01;
        return bytes.toString('base64');
      };

      put.run([iv, tag, flip(body)].join('.'));
      assert.equal(readCredentials(database).accessToken, null, 'flipped ciphertext bit');

      put.run([iv, flip(tag), body].join('.'));
      assert.equal(readCredentials(database).accessToken, null, 'flipped tag bit');

      put.run([flip(iv), tag, body].join('.'));
      assert.equal(readCredentials(database).accessToken, null, 'flipped IV bit');

      put.run('not.even.close');
      assert.equal(readCredentials(database).accessToken, null, 'undecodable base64');
      put.run('two.parts');
      assert.equal(readCredentials(database).accessToken, null, 'missing segment');
      put.run('');
      assert.equal(readCredentials(database).accessToken, null, 'empty value');

      put.run(original);
      assert.equal(readCredentials(database).accessToken, TOKEN, 'the untouched value still opens');
    }),
  ));

test('a token written under SECRET_KEY stays readable after the instance gains a database key, and vice versa', () =>
  withTempDb(async ({ database }) => {
    // Written under the env key.
    await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'first-secret' }, () => {
      assert.equal(tokenKeySource(database), 'env');
      saveCredentials(database, CREDENTIALS, true);
      assert.equal(readCredentials(database).accessToken, TOKEN);
    });

    // Same env, plus an instance key that appears later: still opens with the env key.
    await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'first-secret' }, () => {
      assert.equal(readCredentials(database).accessToken, TOKEN);
    });

    // A different SECRET_KEY cannot open it, and there is no instance key to fall back on.
    await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'second-secret' }, () => {
      assert.equal(readCredentials(database).accessToken, null);
    });

    // Losing SECRET_KEY entirely: the ciphertext is opaque to the instance key path too.
    await withEnv(NO_SECRETS_ENV, () => {
      assert.equal(tokenKeySource(database), 'instance');
      assert.equal(readCredentials(database).accessToken, null);
    });

    // Now the reverse: written under the instance key, then SECRET_KEY arrives.
    await withEnv(NO_SECRETS_ENV, () => {
      saveCredentials(database, CREDENTIALS, true);
      assert.equal(readCredentials(database).accessToken, TOKEN);
    });
    await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'arrived-later' }, () => {
      assert.equal(readCredentials(database).accessToken, TOKEN, 'falls through env key to the instance key');
      // Re-saving under the new env key drops the dependency on the instance key.
      saveCredentials(database, CREDENTIALS, true);
    });
    await withEnv(NO_SECRETS_ENV, () => {
      assert.equal(readCredentials(database).accessToken, null, 'now only SECRET_KEY opens it');
    });
  }));

test('environment variables fill in whatever the database lacks, and never override a stored value', () =>
  withTempDb(async ({ database }) => {
    await withEnv(
      { ...NO_SECRETS_ENV, HARVEST_ACCOUNT_ID: '999', HARVEST_CONTACT: 'env@example.test', HARVEST_ACCESS_TOKEN: 'env-token' },
      () => {
        assert.deepEqual(readCredentials(database), { accountId: '999', contact: 'env@example.test', accessToken: 'env-token' });
        assert.deepEqual(usableCredentials(database), { accountId: '999', contact: 'env@example.test', accessToken: 'env-token' });

        saveCredentials(database, CREDENTIALS, true);
        assert.deepEqual(readCredentials(database), CREDENTIALS, 'stored values win');
      },
    );

    await withEnv({ ...NO_SECRETS_ENV, HARVEST_ACCESS_TOKEN: 'env-token' }, () => {
      forgetToken(database);
      assert.equal(readCredentials(database).accessToken, 'env-token', 'env token fills the gap once stored one is gone');
    });

    await withEnv(NO_SECRETS_ENV, () => {
      assert.equal(readCredentials(database).accessToken, null);
    });
  }));

test('usableCredentials demands all three parts', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database }) => {
      saveCredentials(database, { ...CREDENTIALS, contact: '' }, true);
      assert.equal(usableCredentials(database), null, 'empty contact');
      saveCredentials(database, { ...CREDENTIALS, accountId: '' }, true);
      assert.equal(usableCredentials(database), null, 'empty account');
      saveCredentials(database, CREDENTIALS, true);
      assert.deepEqual(usableCredentials(database), CREDENTIALS);
    }),
  ));
