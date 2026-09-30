/**
 * Report filtering.
 *
 * One place that turns query parameters into a WHERE clause, shared by the summary report,
 * the detailed report and the CSV export. Three implementations of "the same filters" is how
 * an export quietly stops matching the screen it was exported from.
 */

import type { Db } from '../db/index.ts';
import { rows } from '../db/index.ts';
import type { SessionUser } from '../auth/session.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportFilters {
  from: string;
  to: string;
  userId: number | null;
  clientId: number | null;
  projectId: number | null;
  taskId: number | null;
  /** null = both */
  billable: boolean | null;
}

function positive(value: string | null): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Read filters from a URL, clamped to what this viewer may see.
 *
 * A member's `user` filter is forced to themselves — the URL is user input, and a report is
 * shareable, so someone will eventually paste one with another person's id in it.
 */
export function readFilters(url: URL, viewer: SessionUser, defaults: { from: string; to: string }): ReportFilters {
  const privileged = viewer.role === 'admin' || viewer.role === 'manager';
  const raw = (key: string) => url.searchParams.get(key);
  const billableParam = raw('billable');

  return {
    from: DATE.test(raw('from') ?? '') ? raw('from')! : defaults.from,
    to: DATE.test(raw('to') ?? '') ? raw('to')! : defaults.to,
    userId: privileged ? positive(raw('user')) : viewer.id,
    clientId: positive(raw('client')),
    projectId: positive(raw('project')),
    taskId: positive(raw('task')),
    billable: billableParam === 'yes' ? true : billableParam === 'no' ? false : null,
  };
}

export interface Where {
  clause: string;
  args: (string | number)[];
}

export function buildWhere(filters: ReportFilters): Where {
  const parts = ['te.spent_date >= ?', 'te.spent_date <= ?'];
  const args: (string | number)[] = [filters.from, filters.to];

  if (filters.userId !== null) { parts.push('te.user_id = ?'); args.push(filters.userId); }
  if (filters.clientId !== null) { parts.push('p.client_id = ?'); args.push(filters.clientId); }
  if (filters.projectId !== null) { parts.push('te.project_id = ?'); args.push(filters.projectId); }
  if (filters.taskId !== null) { parts.push('te.task_id = ?'); args.push(filters.taskId); }
  if (filters.billable !== null) { parts.push('te.billable = ?'); args.push(filters.billable ? 1 : 0); }

  return { clause: parts.join(' AND '), args };
}

/** Serialise filters back into a query string, so a report is a shareable URL. */
export function filtersToQuery(filters: ReportFilters, extra: Record<string, string | number | null> = {}): string {
  const params = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.userId !== null) params.set('user', String(filters.userId));
  if (filters.clientId !== null) params.set('client', String(filters.clientId));
  if (filters.projectId !== null) params.set('project', String(filters.projectId));
  if (filters.taskId !== null) params.set('task', String(filters.taskId));
  if (filters.billable !== null) params.set('billable', filters.billable ? 'yes' : 'no');
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  return params.toString();
}

export const JOINS = `
    FROM time_entries te
    JOIN users u ON u.id = te.user_id
    JOIN projects p ON p.id = te.project_id
    JOIN clients c ON c.id = p.client_id
    JOIN tasks t ON t.id = te.task_id`;

export interface DetailRow {
  id: number;
  spent_date: string;
  person: string;
  user_id: number;
  client: string;
  project: string;
  project_code: string | null;
  project_id: number;
  task: string;
  notes: string | null;
  duration_seconds: number;
  rounded_seconds: number;
  billable: number;
  is_billed: number;
  is_locked: number;
  locked_reason: string | null;
}

export type SortKey = 'date' | 'hours' | 'person' | 'project' | 'client' | 'task';

const SORTS: Record<SortKey, string> = {
  date: 'te.spent_date DESC, u.first_name, c.name',
  hours: 'te.duration_seconds DESC, te.spent_date DESC',
  person: "u.first_name, u.last_name, te.spent_date DESC",
  project: 'c.name, p.name, te.spent_date DESC',
  client: 'c.name, te.spent_date DESC',
  task: 't.name, te.spent_date DESC',
};

/**
 * Group headings and their subtotals.
 *
 * The subtotal has to come from SQL rather than from the rows on screen: a group can straddle
 * a page boundary, and a subtotal that silently counts only the visible half is worse than no
 * subtotal at all.
 */
export const GROUPS = {
  date: { label: 'Date', sql: 'te.spent_date', sort: 'date' },
  client: { label: 'Client', sql: 'c.name', sort: 'client' },
  project: {
    label: 'Project',
    sql: "CASE WHEN p.code IS NULL THEN p.name ELSE '[' || p.code || '] ' || p.name END",
    sort: 'project',
  },
  task: { label: 'Task', sql: 't.name', sort: 'task' },
  person: { label: 'Person', sql: "TRIM(u.first_name || ' ' || u.last_name)", sort: 'person' },
} as const satisfies Record<string, { label: string; sql: string; sort: SortKey }>;

export type GroupKey = keyof typeof GROUPS;

export function groupTotals(db: Db, where: Where, group: GroupKey): Map<string, number> {
  const found = rows<{ k: string; seconds: number }>(
    db
      .prepare(
        `SELECT ${GROUPS[group].sql} AS k, SUM(te.duration_seconds) AS seconds
         ${JOINS} WHERE ${where.clause} GROUP BY k`,
      )
      .all(...where.args),
  );
  return new Map(found.map((r) => [r.k, r.seconds]));
}

export function countEntries(db: Db, where: Where): number {
  const result = db.prepare(`SELECT COUNT(*) AS n ${JOINS} WHERE ${where.clause}`).get(...where.args);
  return (result as { n: number }).n;
}

export function detailRows(
  db: Db,
  where: Where,
  sort: SortKey,
  limit: number,
  offset: number,
): DetailRow[] {
  return rows<DetailRow>(
    db
      .prepare(
        `SELECT te.id, te.spent_date,
                TRIM(u.first_name || ' ' || u.last_name) AS person, te.user_id,
                c.name AS client, p.name AS project, p.code AS project_code, te.project_id,
                t.name AS task, te.notes, te.duration_seconds, te.rounded_seconds,
                te.billable, te.is_billed, te.is_locked, te.locked_reason
         ${JOINS}
          WHERE ${where.clause}
       ORDER BY ${SORTS[sort]}
          LIMIT ? OFFSET ?`,
      )
      .all(...where.args, limit, offset),
  );
}

export interface Totals {
  entries: number;
  seconds: number;
  rounded: number;
  billable: number;
  /** Billable time not yet marked billed — Harvest's "uninvoiced billable hours". */
  uninvoiced: number;
}

export function totals(db: Db, where: Where): Totals {
  const result = db
    .prepare(
      `SELECT COUNT(*) AS entries,
              COALESCE(SUM(te.duration_seconds), 0) AS seconds,
              COALESCE(SUM(te.rounded_seconds), 0) AS rounded,
              COALESCE(SUM(CASE WHEN te.billable = 1 THEN te.rounded_seconds ELSE 0 END), 0) AS billable,
              COALESCE(SUM(CASE WHEN te.billable = 1 AND te.is_billed = 0
                                 THEN te.duration_seconds ELSE 0 END), 0) AS uninvoiced
       ${JOINS}
        WHERE ${where.clause}`,
    )
    .get(...where.args);
  return result as unknown as Totals;
}
