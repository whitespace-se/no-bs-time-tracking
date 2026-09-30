/**
 * Shared test fixture: a throwaway SQLite database plus a small synthetic account.
 *
 * Not a test file itself (no `.test.ts` suffix), so the runner never picks it up directly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/lib/db/index.ts';
import { openDb } from '../src/lib/db/index.ts';

export interface Fixture {
  db: Db;
  dir: string;
  cleanup: () => void;
}

export function tempDir(prefix = 'no-bs-time-tracking-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function tempDb(): Fixture {
  const dir = tempDir();
  const db = openDb(join(dir, 'test.db'));
  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const STAMP = '2026-01-01T00:00:00Z';

export function count(db: Db, table: string, where = '1 = 1'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

/**
 * A minimal account: two people, two clients, two projects, two tasks.
 *
 *   users:    1 admin Ada Example · 2 member Bob Example
 *   clients:  10 Alpha Client · 11 Beta Client
 *   projects: 100 "Website" for Alpha (code WEB) · 101 "Retainer" for Beta (no code)
 *   tasks:    200 Development · 201 Meeting
 */
export function seedBasics(db: Db): void {
  db.exec(`
    INSERT INTO users (id, email, first_name, last_name, role, is_active, created_at, updated_at)
    VALUES (1, 'ada@example.test', 'Ada', 'Example', 'admin', 1, '${STAMP}', '${STAMP}'),
           (2, 'bob@example.test', 'Bob', 'Example', 'member', 1, '${STAMP}', '${STAMP}');
    INSERT INTO clients (id, name, currency, is_active, created_at, updated_at)
    VALUES (10, 'Alpha Client', 'SEK', 1, '${STAMP}', '${STAMP}'),
           (11, 'Beta Client', 'EUR', 1, '${STAMP}', '${STAMP}');
    INSERT INTO projects (id, client_id, name, code, is_active, is_billable, created_at, updated_at)
    VALUES (100, 10, 'Website', 'WEB', 1, 1, '${STAMP}', '${STAMP}'),
           (101, 11, 'Retainer', NULL, 1, 1, '${STAMP}', '${STAMP}');
    INSERT INTO tasks (id, name, billable_by_default, is_active, created_at, updated_at)
    VALUES (200, 'Development', 1, 1, '${STAMP}', '${STAMP}'),
           (201, 'Meeting', 0, 1, '${STAMP}', '${STAMP}');
    INSERT INTO task_assignments (id, project_id, task_id, is_active, billable, created_at, updated_at)
    VALUES (300, 100, 200, 1, 1, '${STAMP}', '${STAMP}'),
           (301, 100, 201, 1, 0, '${STAMP}', '${STAMP}'),
           (302, 101, 200, 1, 1, '${STAMP}', '${STAMP}');
  `);
}

export interface EntrySpec {
  id: number;
  date: string;
  user: number;
  project: number;
  task: number;
  seconds: number;
  rounded?: number;
  billable?: boolean;
  billed?: boolean;
  locked?: boolean;
  lockedReason?: string | null;
  notes?: string | null;
  billableRate?: number | null;
  updatedAt?: string;
}

export function addEntry(db: Db, spec: EntrySpec): void {
  const clientId = (db.prepare('SELECT client_id FROM projects WHERE id = ?').get(spec.project) as { client_id: number }).client_id;
  db.prepare(
    `INSERT INTO time_entries (id, spent_date, user_id, project_id, task_id, client_id,
        duration_seconds, rounded_seconds, notes, billable, is_billed, is_locked, locked_reason,
        billable_rate, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    spec.id, spec.date, spec.user, spec.project, spec.task, clientId,
    spec.seconds, spec.rounded ?? spec.seconds, spec.notes ?? null,
    spec.billable === false ? 0 : 1, spec.billed ? 1 : 0, spec.locked ? 1 : 0,
    spec.lockedReason ?? null, spec.billableRate ?? null, STAMP, spec.updatedAt ?? STAMP,
  );
}

/**
 * node:sqlite hands back null-prototype row objects, and `deepEqual` compares prototypes.
 * Normalise a row (or a list of them) before comparing it to an object literal.
 */
export function plain<T extends object>(value: T): T {
  return { ...value };
}
