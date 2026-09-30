import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bool,
  fromMinorUnits,
  hoursToSeconds,
  migrate,
  nowIso,
  openDb,
  row,
  rows,
  secondsToHours,
  toMinorUnits,
  transaction,
} from '../src/lib/db/index.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/lib/db/migrations', import.meta.url));
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-db-'));
}

function appliedMigrations(database: ReturnType<typeof openDb>): { name: string; applied_at: string }[] {
  return database
    .prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name')
    .all()
    .map((r) => ({ name: String(r.name), applied_at: String(r.applied_at) }));
}

function count(database: ReturnType<typeof openDb>, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ── Units ────────────────────────────────────────────────────────────────────

test('hoursToSeconds rounds decimal hours to whole seconds', () => {
  assert.equal(hoursToSeconds(2.5), 9000);
  assert.equal(hoursToSeconds(0), 0);
  assert.equal(hoursToSeconds(null), 0);
  assert.equal(hoursToSeconds(undefined), 0);
  assert.equal(hoursToSeconds(1 / 3), 1200);
  assert.equal(hoursToSeconds(0.0001), 0);
  assert.equal(hoursToSeconds(-1.5), -5400);
});

test('secondsToHours is the exact inverse for whole seconds', () => {
  assert.equal(secondsToHours(9000), 2.5);
  assert.equal(secondsToHours(0), 0);
  assert.equal(secondsToHours(hoursToSeconds(7.25)), 7.25);
});

test('toMinorUnits rounds to whole minor units and keeps null', () => {
  assert.equal(toMinorUnits(1250.5), 125050);
  assert.equal(toMinorUnits(19.99), 1999);
  assert.equal(toMinorUnits(0), 0);
  assert.equal(toMinorUnits(-0.5), -50);
  assert.equal(toMinorUnits(0.005), 1);
  assert.equal(toMinorUnits(null), null);
  assert.equal(toMinorUnits(undefined), null);
});

test('fromMinorUnits divides by 100 and keeps null', () => {
  assert.equal(fromMinorUnits(125050), 1250.5);
  assert.equal(fromMinorUnits(0), 0);
  assert.equal(fromMinorUnits(-1), -0.01);
  assert.equal(fromMinorUnits(null), null);
  assert.equal(fromMinorUnits(toMinorUnits(896398.5)!), 896398.5);
});

test('bool maps JS truthiness onto SQLite integers', () => {
  assert.equal(bool(true), 1);
  assert.equal(bool(false), 0);
  assert.equal(bool(1), 1);
  assert.equal(bool(0), 0);
  assert.equal(bool(null), 0);
  assert.equal(bool(undefined), 0);
  assert.equal(bool(''), 0);
  // Truthiness, not parsing: the string "false" is a non-empty string.
  assert.equal(bool('false'), 1);
});

test('nowIso is UTC to the second with no milliseconds', () => {
  const before = Date.now();
  const stamp = nowIso();
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const parsed = Date.parse(stamp);
  assert.ok(parsed <= Date.now() && parsed >= before - 1000);
});

// ── Row helpers ──────────────────────────────────────────────────────────────

test('rows and row only narrow the type, never copy or wrap', () => {
  const list = [{ id: 1 }, { id: 2 }];
  assert.equal(rows<{ id: number }>(list), list);
  assert.deepEqual(rows<{ id: number }>([]), []);

  const single = { id: 1 };
  assert.equal(row<{ id: number }>(single), single);
  assert.equal(row<{ id: number }>(undefined), undefined);
  // node:sqlite returns undefined for no row; a null from elsewhere is normalised too.
  assert.equal(row<{ id: number }>(null), undefined);
});

// ── Opening and migrating ────────────────────────────────────────────────────

test('openDb applies every migration file in order with the pragmas set', () => {
  const dir = tempDir();
  const database = openDb(join(dir, 'nested', 'folder', 'test.db'));
  try {
    assert.ok(migrationFiles.length > 0);
    assert.deepEqual(appliedMigrations(database).map((m) => m.name), migrationFiles);
    for (const m of appliedMigrations(database)) assert.match(m.applied_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    assert.equal((database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');

    // The schema from the latest migrations is actually there.
    assert.equal(count(database, 'settings'), 0);
    assert.equal(count(database, 'time_entries'), 0);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb on an in-memory path works without touching the filesystem', () => {
  const database = openDb(':memory:');
  try {
    assert.equal(appliedMigrations(database).length, migrationFiles.length);
  } finally {
    database.close();
  }
});

test('reopening the same file is idempotent and keeps the data', () => {
  const dir = tempDir();
  const path = join(dir, 'test.db');
  const first = openDb(path);
  let applied: { name: string; applied_at: string }[];
  try {
    first.prepare("INSERT INTO settings (key, value) VALUES ('currency', 'EUR')").run();
    applied = appliedMigrations(first);
  } finally {
    first.close();
  }

  const second = openDb(path);
  try {
    assert.deepEqual(appliedMigrations(second), applied);
    assert.equal(count(second, 'settings'), 1);
    // Running migrate by hand on a current database is a no-op too.
    migrate(second);
    assert.deepEqual(appliedMigrations(second), applied);
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate tolerates a database that is newer than the code', () => {
  const dir = tempDir();
  const database = openDb(join(dir, 'test.db'));
  try {
    database
      .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run('999_from_the_future.sql', nowIso());
    assert.doesNotThrow(() => migrate(database));
    assert.deepEqual(appliedMigrations(database).map((m) => m.name), [...migrationFiles, '999_from_the_future.sql']);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Transactions ─────────────────────────────────────────────────────────────

test('transaction commits and returns the callback value', () => {
  const database = openDb(':memory:');
  try {
    const result = transaction(database, () => {
      database.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
      database.prepare("INSERT INTO settings (key, value) VALUES ('b', '2')").run();
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(count(database, 'settings'), 2);
  } finally {
    database.close();
  }
});

test('transaction rolls back everything when the callback throws', () => {
  const database = openDb(':memory:');
  try {
    const boom = new Error('boom');
    assert.throws(
      () => transaction(database, () => {
        database.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(count(database, 'settings'), 0);
  } finally {
    database.close();
  }
});

test('transaction rolls back on a constraint failure and leaves the connection usable', () => {
  const database = openDb(':memory:');
  try {
    assert.throws(
      () => transaction(database, () => {
        database.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
        database.prepare("INSERT INTO settings (key, value) VALUES ('a', '2')").run();
      }),
      /UNIQUE constraint failed/,
    );
    assert.equal(count(database, 'settings'), 0);

    // Not stuck inside a transaction: a fresh one begins and commits.
    transaction(database, () => {
      database.prepare("INSERT INTO settings (key, value) VALUES ('a', '3')").run();
    });
    assert.equal(count(database, 'settings'), 1);
  } finally {
    database.close();
  }
});

test('foreign keys are enforced inside a transaction', () => {
  const database = openDb(':memory:');
  try {
    assert.throws(
      () => transaction(database, () => {
        database
          .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 999, ?, ?)")
          .run(nowIso(), nowIso());
      }),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(count(database, 'sessions'), 0);
  } finally {
    database.close();
  }
});
