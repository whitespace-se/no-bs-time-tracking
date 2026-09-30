/**
 * Shared fixtures for the unit tests. Not a test file itself (the runner only picks up
 * `*.test.ts`), just the three things every DB-backed test needs: a throwaway database, a
 * synthetic user in it, and a way to set environment variables without leaking them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/lib/db/index.ts';
import { nowIso, openDb } from '../src/lib/db/index.ts';

export interface TempDb {
  dir: string;
  path: string;
  database: Db;
}

export function openTempDb(prefix = 'no-bs-time-tracking-test-'): TempDb {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'test.db');
  return { dir, path, database: openDb(path) };
}

/** Open a fresh database, run `fn`, and always close and delete it afterwards. */
export async function withTempDb<T>(fn: (temp: TempDb) => T | Promise<T>): Promise<T> {
  const temp = openTempDb();
  try {
    return await fn(temp);
  } finally {
    // A test may close the handle itself to inspect the file on disk; closing twice throws.
    try {
      temp.database.close();
    } catch {
      /* already closed */
    }
    rmSync(temp.dir, { recursive: true, force: true });
  }
}

export interface UserFixture {
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: 'admin' | 'manager' | 'member';
  isActive?: boolean;
  passwordHash?: string | null;
}

let userCounter = 0;

/** Insert a synthetic user and return its id. Every field has a harmless default. */
export function insertUser(database: Db, fixture: UserFixture = {}): number {
  userCounter += 1;
  const stamp = nowIso();
  const result = database
    .prepare(
      `INSERT INTO users (email, first_name, last_name, role, is_active, password_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      fixture.email ?? `user${userCounter}@example.test`,
      fixture.firstName ?? 'Test',
      fixture.lastName ?? `Person${userCounter}`,
      fixture.role ?? 'member',
      fixture.isActive === false ? 0 : 1,
      fixture.passwordHash ?? null,
      stamp,
      stamp,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Run `fn` with the given environment variables set (`undefined` unsets one), and restore the
 * previous values whatever happens. Tests that touch `process.env` must go through this so
 * they neither depend on nor leak into the developer's shell.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Environment the Harvest and key code reads, all unset — the baseline for those tests. */
export const NO_SECRETS_ENV: Record<string, undefined> = {
  SECRET_KEY: undefined,
  HARVEST_ACCOUNT_ID: undefined,
  HARVEST_CONTACT: undefined,
  HARVEST_ACCESS_TOKEN: undefined,
};

/** ISO timestamp `ms` milliseconds from now, in the same second-precision form the app stores. */
export function isoFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
