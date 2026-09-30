/**
 * SQLite access via node:sqlite — built into Node 24, so the Docker image needs no build
 * toolchain and no architecture-specific native binding. That matters directly for the
 * self-host promise: the same image runs wherever an instance is hosted.
 *
 * Migrations run on boot, forward-only. A fleet upgrade is only safe if every migration is
 * idempotent and an older image can still boot against a newer database.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { bootstrapInstance, describeInstance, resolveInstance } from '../instance.ts';
import { log } from '../instance-log.ts';

/**
 * Where the .sql files are, from source and from the bundle alike.
 *
 * Running from source they sit right here. `astro build` bundles this module into
 * `dist/server/chunks/` and copies the migrations to `dist/server/migrations`
 * (scripts/copy-migrations.ts), so the built server finds them one level up. Walking a few
 * levels keeps both arrangements working without the bundler's chunk layout being a
 * load-bearing detail.
 */
function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 4; up += 1) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, '001_init.sql'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    'Could not find the database migrations. A build is incomplete: `npm run build` must ' +
      'run scripts/copy-migrations.ts after `astro build`.',
  );
}

export type Db = DatabaseSync;

let instance: Db | null = null;

export function openDb(path = resolveInstance().databasePath): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  // WAL lets readers run while a write is in flight. busy_timeout covers the brief moments
  // where they still collide. foreign_keys is off by default in SQLite — turn it on.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  // Give the write-ahead log a ceiling.
  //
  // An import writes the whole account in one transaction, and SQLite cannot checkpoint
  // inside one — so the log grows to the size of the entire import, which for a large
  // account is hundreds of megabytes. Without a limit it is then kept at that size for the
  // life of the process, roughly doubling the folder, and the folder is the unit of backup.
  // With a limit, the checkpoint that follows each commit truncates it back down.
  db.exec('PRAGMA journal_size_limit = 67108864'); // 64 MB

  migrate(db);
  return db;
}

/** Process-wide handle. One instance, one file, one writer. */
export function db(): Db {
  if (instance === null) {
    // Resolves the folder and loads its .env before anything reads a setting out of it.
    const resolved = bootstrapInstance();
    // Said once, at the moment the file is actually opened. Two instances on one box differ
    // only by the folder they were pointed at, so that folder is the one fact worth logging.
    log.info(describeInstance(resolved), {
      dir: resolved.dir,
      database: resolved.databasePath,
      adopted: resolved.adopted,
    });
    instance = openDb(resolved.databasePath);
    // A sync's progress lives in memory, so a run still marked `running` here belongs to a
    // process that is gone. Closing those out at boot is what stops a crashed import from
    // looking live forever. Imported lazily: this module must not depend on Harvest.
    void import('../harvest/sync.ts').then(({ reapStaleRuns }) => reapStaleRuns(instance!));
  }
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/**
 * Apply any migration files not yet recorded, in filename order.
 *
 * Deliberately tolerant of a newer database than the code expects: unknown applied
 * migrations are ignored rather than treated as an error, so an old image rolling back
 * still boots.
 */
export function migrate(database: Db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const applied = new Set(
    (database.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  const migrationsDir = findMigrationsDir();
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    database.exec('BEGIN');
    try {
      database.exec(sql);
      database
        .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, nowIso());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${String(error)}`, { cause: error });
    }
  }
}

/** Run `fn` inside a transaction, rolling back on throw. */
export function transaction<T>(database: Db, fn: () => T): T {
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * `transaction` for work that awaits between its writes. Only for callers that stop anything
 * else writing on this connection meanwhile, since those writes would join this transaction.
 */
export async function transactionAsync<T>(database: Db, fn: () => Promise<T>): Promise<T> {
  database.exec('BEGIN');
  try {
    const result = await fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * node:sqlite hands back `Record<string, SQLOutputValue>`, which never structurally overlaps
 * a domain interface. Narrowing happens here, once, so callers don't sprinkle double casts —
 * and so there is a single place to add runtime validation later if we want it.
 */
export function rows<T>(result: unknown): T[] {
  return result as T[];
}

export function row<T>(result: unknown): T | undefined {
  return (result ?? undefined) as T | undefined;
}

// ── Units ────────────────────────────────────────────────────────────────────
// Everything crossing the DB boundary converts here, so the rules live in one place.

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Harvest decimal hours → integer seconds. 2.5 → 9000. */
export function hoursToSeconds(hours: number | null | undefined): number {
  return Math.round((hours ?? 0) * 3600);
}

/** Integer seconds → decimal hours, for reports and reconciliation. */
export function secondsToHours(seconds: number): number {
  return seconds / 3600;
}

/** Money as integer minor units. 1250.5 SEK → 125050 öre. */
export function toMinorUnits(amount: number | null | undefined): number | null {
  return amount === null || amount === undefined ? null : Math.round(amount * 100);
}

export function fromMinorUnits(minor: number | null): number | null {
  return minor === null ? null : minor / 100;
}

/** SQLite has no boolean type; STRICT tables reject a JS boolean outright. */
export function bool(value: unknown): number {
  return value ? 1 : 0;
}
