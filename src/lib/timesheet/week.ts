/**
 * The week payload.
 *
 * One query per week, serving both views. The week grid groups by (project, task); the day
 * view filters the same rows by date. Switching views or stepping between days inside the
 * week costs no round-trip, which is why Harvest feels instant.
 *
 * Covered by idx_te_user_date.
 */

import type { Db } from '../db/index.ts';
import { rows as sqlRows, row as sqlRow } from '../db/index.ts';
import { addDays, weekDates, type IsoDate } from '../format.ts';

export interface EntryRow {
  id: number;
  spent_date: IsoDate;
  duration_seconds: number;
  rounded_seconds: number;
  notes: string | null;
  billable: number;
  is_billed: number;
  is_locked: number;
  locked_reason: string | null;
  is_running: number;
  approval_status: string;
  project_id: number;
  project_name: string;
  project_code: string | null;
  client_name: string;
  task_id: number;
  task_name: string;
}

/** A grid row: one (project, task) pair, with a cell per day. */
export interface WeekRow {
  project_id: number;
  task_id: number;
  project_name: string;
  project_code: string | null;
  client_name: string;
  task_name: string;
  /** Seven cells, Monday-first. `entries` > 1 is the compound case. */
  cells: {
    date: IsoDate;
    seconds: number;
    entries: EntryRow[];
    locked: boolean;
  }[];
  total: number;
  /** True when any entry in the row is locked — the row renders read-only. */
  locked: boolean;
  locked_reason: string | null;
}

export interface WeekPayload {
  week_of: IsoDate;
  dates: IsoDate[];
  user_id: number;
  entries: EntryRow[];
  rows: WeekRow[];
  day_totals: number[];
  total: number;
  /** Whether the previous week has anything to copy forward. */
  copy_from_last_week: { available: boolean; source: IsoDate; rows: number };
}

const SELECT_ENTRIES = `
  SELECT te.id, te.spent_date, te.duration_seconds, te.rounded_seconds, te.notes,
         te.billable, te.is_billed, te.is_locked, te.locked_reason, te.is_running,
         te.approval_status,
         te.project_id, p.name AS project_name, p.code AS project_code,
         c.name AS client_name,
         te.task_id, t.name AS task_name
    FROM time_entries te
    JOIN projects p ON p.id = te.project_id
    JOIN clients  c ON c.id = p.client_id
    JOIN tasks    t ON t.id = te.task_id
   WHERE te.user_id = ? AND te.spent_date >= ? AND te.spent_date <= ?
   ORDER BY c.name, p.name, t.name, te.spent_date, te.id
`;

export function getWeek(db: Db, userId: number, weekStart: IsoDate): WeekPayload {
  const dates = weekDates(weekStart);
  const last = dates[6] ?? weekStart;

  const entries = sqlRows<EntryRow>(db.prepare(SELECT_ENTRIES).all(userId, weekStart, last));

  // Group into (project, task) rows. Insertion order follows the query's ORDER BY, so rows
  // arrive sorted by client then project then task.
  const byKey = new Map<string, WeekRow>();
  for (const entry of entries) {
    const key = `${entry.project_id}:${entry.task_id}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        project_id: entry.project_id,
        task_id: entry.task_id,
        project_name: entry.project_name,
        project_code: entry.project_code,
        client_name: entry.client_name,
        task_name: entry.task_name,
        cells: dates.map((date) => ({ date, seconds: 0, entries: [], locked: false })),
        total: 0,
        locked: false,
        locked_reason: null,
      };
      byKey.set(key, row);
    }
    const index = dates.indexOf(entry.spent_date);
    if (index < 0) continue;
    const cell = row.cells[index];
    if (!cell) continue;

    // The compound case: several entries on the same project, task and day. The cell shows
    // their sum; the individual notes live in the day view.
    cell.entries.push(entry);
    cell.seconds += entry.duration_seconds;
    if (entry.is_locked) {
      cell.locked = true;
      row.locked = true;
      row.locked_reason ??= entry.locked_reason;
    }
    row.total += entry.duration_seconds;
  }

  const rows = [...byKey.values()];
  const dayTotals = dates.map((_, i) => rows.reduce((sum, r) => sum + (r.cells[i]?.seconds ?? 0), 0));

  const previous = addDays(weekStart, -7);
  const previousRows =
    sqlRow<{ n: number }>(
      db
        .prepare(
          `SELECT COUNT(DISTINCT project_id || ':' || task_id) AS n
             FROM time_entries
            WHERE user_id = ? AND spent_date >= ? AND spent_date <= ?`,
        )
        .get(userId, previous, addDays(previous, 6)),
    )?.n ?? 0;

  return {
    week_of: weekStart,
    dates,
    user_id: userId,
    entries,
    rows,
    day_totals: dayTotals,
    total: dayTotals.reduce((a, b) => a + b, 0),
    copy_from_last_week: { available: previousRows > 0, source: previous, rows: previousRows },
  };
}

/** Entries for one day, straight out of a week payload — no extra query. */
export function dayEntries(week: WeekPayload, date: IsoDate): EntryRow[] {
  return week.entries.filter((e) => e.spent_date === date);
}

export interface UserOption {
  id: number;
  name: string;
  is_active: number;
}

export function listUsers(db: Db): UserOption[] {
  return sqlRows<UserOption>(
    db
      .prepare(
        `SELECT id, TRIM(first_name || ' ' || last_name) AS name, is_active
           FROM users WHERE is_active = 1 ORDER BY first_name, last_name`,
      )
      .all(),
  );
}

/** The user whose timesheet we show by default until auth lands. */
export function defaultUserId(db: Db): number {
  const busiest = sqlRow<{ user_id: number }>(
    db
      .prepare(
        `SELECT user_id, COUNT(*) AS n FROM time_entries
          GROUP BY user_id ORDER BY n DESC LIMIT 1`,
      )
      .get(),
  );
  return busiest?.user_id ?? 1;
}

/** Most recent date that has any time on it, so an empty landing page is unlikely. */
export function latestEntryDate(db: Db, userId: number): IsoDate | null {
  return (
    sqlRow<{ d: string | null }>(
      db.prepare('SELECT MAX(spent_date) AS d FROM time_entries WHERE user_id = ?').get(userId),
    )?.d ?? null
  );
}
