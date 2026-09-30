import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';
import type { Db } from '../src/lib/db/index.ts';
import { SECRET_SETTINGS, decryptionKeys, encryptionKey, keySource } from '../src/lib/instance-key.ts';
import { NO_SECRETS_ENV, withEnv, withTempDb } from './support.ts';

function storedInstanceKey(database: Db): string | undefined {
  const found = database.prepare("SELECT value FROM settings WHERE key = 'instance_key'").get() as
    | { value: string }
    | undefined;
  return found?.value;
}

test('without SECRET_KEY, the key is generated into the database on first use and reused after', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database }) => {
      assert.equal(storedInstanceKey(database), undefined, 'a fresh database has no key');
      assert.equal(keySource(database), 'instance');

      const first = encryptionKey(database);
      assert.equal(first.source, 'instance');
      assert.equal(first.key.length, 32);

      const stored = storedInstanceKey(database);
      assert.ok(stored, 'the key now lives in settings');
      assert.equal(Buffer.from(stored, 'base64').toString('base64'), stored, 'stored as base64');
      assert.ok(first.key.equals(Buffer.from(stored, 'base64')));

      const second = encryptionKey(database);
      assert.ok(second.key.equals(first.key), 'stable across calls');
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'instance_key'").get() as { n: number }).n,
        1,
      );
    }),
  ));

test('two databases never share an instance key', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database: a }) =>
      withTempDb(({ database: b }) => {
        assert.ok(!encryptionKey(a).key.equals(encryptionKey(b).key));
      }),
    ),
  ));

test('decryptionKeys never creates a key just to read with — a database with no secrets stays keyless', () =>
  withEnv(NO_SECRETS_ENV, () =>
    withTempDb(({ database }) => {
      assert.deepEqual(decryptionKeys(database), []);
      assert.equal(storedInstanceKey(database), undefined);

      encryptionKey(database);
      const keys = decryptionKeys(database);
      assert.equal(keys.length, 1);
      assert.equal(keys[0]?.source, 'instance');
    }),
  ));

test('with SECRET_KEY set, the key is derived from it and nothing is written to the database', () =>
  withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'test-secret-one' }, () =>
    withTempDb(({ database }) => {
      assert.equal(keySource(database), 'env');
      const key = encryptionKey(database);
      assert.equal(key.source, 'env');
      assert.equal(key.key.length, 32);
      assert.ok(key.key.equals(scryptSync('test-secret-one', 'harvest-token-v1', 32)), 'derivation is the documented one');
      assert.equal(storedInstanceKey(database), undefined, 'no instance key materialised');

      const again = encryptionKey(database);
      assert.ok(again.key.equals(key.key), 'deterministic for the same secret');
    }),
  ));

test('different SECRET_KEY values derive different keys; an empty value counts as unset', () =>
  withTempDb(async ({ database }) => {
    const one = await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'alpha' }, () => encryptionKey(database));
    const two = await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'beta' }, () => encryptionKey(database));
    assert.equal(one.source, 'env');
    assert.equal(two.source, 'env');
    assert.ok(!one.key.equals(two.key));

    const empty = await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: '' }, () => encryptionKey(database));
    assert.equal(empty.source, 'instance', 'SECRET_KEY="" falls back to the database key');
  }));

test('decryptionKeys offers the env key first, then any existing instance key', () =>
  withTempDb(async ({ database }) => {
    // Written under the instance key first, as an instance without SECRET_KEY would.
    const instance = await withEnv(NO_SECRETS_ENV, () => encryptionKey(database));

    await withEnv({ ...NO_SECRETS_ENV, SECRET_KEY: 'gained-later' }, () => {
      const keys = decryptionKeys(database);
      assert.deepEqual(keys.map((k) => k.source), ['env', 'instance']);
      assert.ok(keys[1]?.key.equals(instance.key));
      assert.equal(encryptionKey(database).source, 'env', 'new values now go under the stronger key');
    });

    await withEnv(NO_SECRETS_ENV, () => {
      assert.deepEqual(decryptionKeys(database).map((k) => k.source), ['instance'], 'losing the env leaves the instance key');
    });
  }));

test('SECRET_SETTINGS names the key and the one value it protects', () => {
  assert.deepEqual([...SECRET_SETTINGS], ['instance_key', 'harvest_token_encrypted']);
});
