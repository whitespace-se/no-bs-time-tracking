/**
 * Instance directory resolution.
 *
 * An instance is a folder. These tests pin the three rules the documentation makes promises
 * about — a new folder gets `timetrack.db`, a folder holding exactly one `.db` adopts it
 * whatever it is called, and two of them stop rather than guess — plus the precedence rules
 * for a per-instance `.env`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { tempDir } from './fixture.ts';
import { withEnv } from './support.ts';
import {
  DATABASE_FILE,
  DEFAULT_INSTANCE_DIR,
  describeInstance,
  loadInstanceEnv,
  resolveInstance,
} from '../src/lib/instance.ts';

/** Every folder these tests make, removed together at the end. */
const made: string[] = [];

function folder(files: Record<string, string> = {}): string {
  const dir = tempDir('no-bs-instance-test-');
  made.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// ── Where the instance is ────────────────────────────────────────────────────

test('an unset INSTANCE_DIR falls back to the documented default folder', () => {
  const instance = resolveInstance({});
  assert.equal(instance.dir, resolve(DEFAULT_INSTANCE_DIR));
  assert.equal(instance.databasePath, join(resolve(DEFAULT_INSTANCE_DIR), DATABASE_FILE));
  assert.equal(instance.adopted, false);
});

test('a blank or whitespace INSTANCE_DIR is the same as saying nothing', () => {
  assert.equal(resolveInstance({ INSTANCE_DIR: '' }).dir, resolve(DEFAULT_INSTANCE_DIR));
  assert.equal(resolveInstance({ INSTANCE_DIR: '   ' }).dir, resolve(DEFAULT_INSTANCE_DIR));
});

test('a relative INSTANCE_DIR becomes absolute, and is trimmed first', () => {
  const instance = resolveInstance({ INSTANCE_DIR: '  ./instances/acme  ' });
  assert.equal(instance.dir, resolve('./instances/acme'));
});

test('an absolute INSTANCE_DIR is used as given', () => {
  const dir = folder();
  assert.equal(resolveInstance({ INSTANCE_DIR: dir }).dir, dir);
});

test('a folder that does not exist yet is a new instance, not an error', () => {
  const dir = join(folder(), 'not-created-yet');
  const instance = resolveInstance({ INSTANCE_DIR: dir });
  assert.equal(instance.databasePath, join(dir, DATABASE_FILE));
  assert.equal(instance.adopted, false);
});

test('an empty folder gets timetrack.db', () => {
  const dir = folder();
  const instance = resolveInstance({ INSTANCE_DIR: dir });
  assert.equal(instance.databasePath, join(dir, DATABASE_FILE));
  assert.equal(instance.adopted, false);
});

test('a folder holding exactly one .db adopts it whatever it is named', () => {
  const dir = folder({ 'acme-2026-08-27.db': '' });
  const instance = resolveInstance({ INSTANCE_DIR: dir });
  assert.equal(instance.databasePath, join(dir, 'acme-2026-08-27.db'));
  assert.equal(instance.adopted, true);
});

test('timetrack.db wins when it is one of several databases', () => {
  const dir = folder({ 'timetrack.db': '', 'old-backup.db': '' });
  const instance = resolveInstance({ INSTANCE_DIR: dir });
  assert.equal(instance.databasePath, join(dir, DATABASE_FILE));
  assert.equal(instance.adopted, false);
});

test('two databases and no timetrack.db stops loudly and names what it found', () => {
  const dir = folder({ 'alpha.db': '', 'beta.db': '' });
  assert.throws(
    () => resolveInstance({ INSTANCE_DIR: dir }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /holds 2 databases/);
      assert.match(error.message, /alpha\.db, beta\.db/);
      assert.match(error.message, /timetrack\.db/);
      return true;
    },
  );
});

test("SQLite's sidecar files are not databases", () => {
  const adopting = folder({ 'acme.db': '', 'acme.db-wal': '', 'acme.db-shm': '' });
  assert.equal(resolveInstance({ INSTANCE_DIR: adopting }).adopted, true);

  // Sidecars alone leave the folder looking empty, which is a new instance.
  const sidecarsOnly = folder({ 'acme.db-wal': '', 'acme.db-shm': '' });
  const instance = resolveInstance({ INSTANCE_DIR: sidecarsOnly });
  assert.equal(instance.databasePath, join(sidecarsOnly, DATABASE_FILE));
  assert.equal(instance.adopted, false);
});

test('a non-database file does not make a folder ambiguous', () => {
  const dir = folder({ 'acme.db': '', '.env': 'PORT=4400\n', 'notes.txt': 'hello' });
  assert.equal(resolveInstance({ INSTANCE_DIR: dir }).adopted, true);
});

test('resolution reads the environment it is handed, not the process environment', async () => {
  const dir = folder({ 'adopted.db': '' });
  await withEnv({ INSTANCE_DIR: '/nowhere/at/all' }, () => {
    const instance = resolveInstance({ INSTANCE_DIR: dir });
    assert.equal(instance.dir, dir);
  });
});

// ── The per-instance .env ────────────────────────────────────────────────────

/** Keys the .env files below set; listed so withEnv can restore every one of them. */
const ENV_KEYS: Record<string, undefined> = {
  PORT: undefined,
  SECRET_KEY: undefined,
  HARVEST_CONTACT: undefined,
  INSTANCE_DIR: undefined,
  INSTANCE_LOG: undefined,
};

test('a folder with no .env loads nothing and says so', async () => {
  const dir = folder();
  await withEnv(ENV_KEYS, () => {
    assert.equal(loadInstanceEnv(resolveInstance({ INSTANCE_DIR: dir })), null);
    assert.equal(process.env.PORT, undefined);
  });
});

test('an instance .env supplies settings the environment does not have', async () => {
  const dir = folder({ '.env': 'PORT=4400\nSECRET_KEY=from-file\nHARVEST_CONTACT=ops@example.test\n' });
  await withEnv(ENV_KEYS, () => {
    const file = loadInstanceEnv(resolveInstance({ INSTANCE_DIR: dir }));
    assert.equal(file, join(dir, '.env'));
    assert.equal(process.env.PORT, '4400');
    assert.equal(process.env.SECRET_KEY, 'from-file');
    assert.equal(process.env.HARVEST_CONTACT, 'ops@example.test');
  });
  assert.equal(process.env.PORT, undefined, 'withEnv put the environment back');
});

test('a real environment variable wins over the instance .env', async () => {
  const dir = folder({ '.env': 'PORT=4400\nSECRET_KEY=from-file\n' });
  await withEnv({ ...ENV_KEYS, PORT: '9999' }, () => {
    loadInstanceEnv(resolveInstance({ INSTANCE_DIR: dir }));
    assert.equal(process.env.PORT, '9999', 'the operator overrode one setting for one run');
    assert.equal(process.env.SECRET_KEY, 'from-file', 'the rest of the file still applies');
  });
});

test('an environment variable set to empty still wins over the file', async () => {
  const dir = folder({ '.env': 'HARVEST_CONTACT=ops@example.test\n' });
  await withEnv({ ...ENV_KEYS, HARVEST_CONTACT: '' }, () => {
    loadInstanceEnv(resolveInstance({ INSTANCE_DIR: dir }));
    assert.equal(process.env.HARVEST_CONTACT, '');
  });
});

test('INSTANCE_DIR inside an instance .env is ignored — the folder decides', async () => {
  const dir = folder({ '.env': 'INSTANCE_DIR=/srv/instances/somebody-else\nPORT=4400\n' });
  await withEnv(ENV_KEYS, () => {
    loadInstanceEnv(resolveInstance({ INSTANCE_DIR: dir }));
    assert.equal(process.env.INSTANCE_DIR, undefined);
    assert.equal(process.env.PORT, '4400', 'only INSTANCE_DIR is ignored');
  });
});

test('an INSTANCE_DIR already in the environment survives the file that tries to change it', async () => {
  const dir = folder({ '.env': 'INSTANCE_DIR=/srv/instances/somebody-else\n' });
  await withEnv({ ...ENV_KEYS, INSTANCE_DIR: dir }, () => {
    loadInstanceEnv(resolveInstance({ INSTANCE_DIR: dir }));
    assert.equal(process.env.INSTANCE_DIR, dir);
  });
});

test('an instance .env can carry INSTANCE_LOG, which bootstrap reads before logging starts', async () => {
  const dir = folder({ '.env': 'INSTANCE_LOG=off\n' });
  await withEnv(ENV_KEYS, () => {
    loadInstanceEnv(resolveInstance({ INSTANCE_DIR: dir }));
    assert.equal(process.env.INSTANCE_LOG, 'off');
  });
});

// ── The line at boot ─────────────────────────────────────────────────────────

test('describeInstance names the folder', () => {
  const dir = folder();
  assert.equal(describeInstance(resolveInstance({ INSTANCE_DIR: dir })), `Instance ${dir}`);
});

test('describeInstance says when the database was adopted under another name', () => {
  const dir = folder({ 'acme-2026-08-27.db': '' });
  assert.equal(
    describeInstance(resolveInstance({ INSTANCE_DIR: dir })),
    `Instance ${dir} (adopted acme-2026-08-27.db)`,
  );
});

test('describeInstance mentions a per-instance .env', () => {
  const dir = folder({ 'acme.db': '', '.env': 'PORT=4400\n' });
  assert.equal(
    describeInstance(resolveInstance({ INSTANCE_DIR: dir })),
    `Instance ${dir} (adopted acme.db) · .env`,
  );
});

test('describeInstance of a folder that is not there yet still names it', () => {
  const parent = folder();
  const dir = join(parent, 'fresh');
  mkdirSync(dir);
  assert.equal(describeInstance(resolveInstance({ INSTANCE_DIR: dir })), `Instance ${dir}`);
});
