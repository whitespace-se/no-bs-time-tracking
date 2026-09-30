/**
 * Mutations.
 *
 * Astro Actions with `accept: 'form'`, so every one of these works as a plain <form> post
 * with no JavaScript. The day view degrades to full page loads; the week grid layers a
 * batched save on top.
 */

import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro:schema';
import { db, bool, nowIso, row, rows } from '../lib/db/index.ts';
import { addDays, parseDuration, roundSeconds } from '../lib/format.ts';
import { blankableText } from '../lib/forms.ts';
import { readSettings } from '../lib/settings.ts';

/** The account's rounding rule — what reports and invoices bill on. */
function rounded(seconds: number): number {
  const { roundToHours, roundingStyle } = readSettings(db());
  return roundSeconds(seconds, roundToHours, roundingStyle);
}
import { canViewTimesheet } from '../lib/auth/session.ts';
import type { SessionUser } from '../lib/auth/session.ts';
import { auth } from './auth.ts';
import { admin } from './admin.ts';
import { tokens } from './tokens.ts';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Reject writes to anything the source system considered frozen. */
function assertEditable(entryId: number): void {
  const entry = row<{ is_locked: number; locked_reason: string | null }>(
    db().prepare('SELECT is_locked, locked_reason FROM time_entries WHERE id = ?').get(entryId),
  );
  if (!entry) {
    throw new ActionError({ code: 'NOT_FOUND', message: 'That time entry no longer exists.' });
  }
  if (entry.is_locked) {
    throw new ActionError({
      code: 'FORBIDDEN',
      message: entry.locked_reason
        ? `This entry is locked: ${entry.locked_reason.toLowerCase()}.`
        : 'This entry is locked and cannot be changed.',
    });
  }
}

/** Billability lives on the project↔task assignment, not on the task. */
function resolveBillable(projectId: number, taskId: number): boolean {
  const assignment = row<{ billable: number }>(
    db()
      .prepare('SELECT billable FROM task_assignments WHERE project_id = ? AND task_id = ?')
      .get(projectId, taskId),
  );
  if (assignment) return Boolean(assignment.billable);
  const task = row<{ billable_by_default: number }>(
    db().prepare('SELECT billable_by_default FROM tasks WHERE id = ?').get(taskId),
  );
  return Boolean(task?.billable_by_default);
}

/** Resolve the rate snapshot stored on a new or edited entry. Historical reports must not
 * change when somebody later edits a project, task, or person rate. */
function resolveRates(projectId: number, taskId: number, userId: number): {
  billableRate: number | null;
  costRate: number | null;
} {
  const found = row<{
    bill_by: string | null;
    project_rate: number | null;
    task_rate: number | null;
    task_default_rate: number | null;
    person_rate: number | null;
    person_default_rate: number | null;
    cost_rate: number | null;
  }>(
    db().prepare(
      `SELECT p.bill_by, p.hourly_rate AS project_rate,
              ta.hourly_rate AS task_rate, t.default_hourly_rate AS task_default_rate,
              ua.hourly_rate AS person_rate, u.default_billable_rate AS person_default_rate,
              u.cost_rate
         FROM projects p
         JOIN tasks t ON t.id = ?
         JOIN users u ON u.id = ?
    LEFT JOIN task_assignments ta ON ta.project_id = p.id AND ta.task_id = t.id
    LEFT JOIN user_assignments ua ON ua.project_id = p.id AND ua.user_id = u.id
        WHERE p.id = ?`,
    ).get(taskId, userId, projectId),
  );

  if (!found) return { billableRate: null, costRate: null };
  const billableRate = found.bill_by === 'Project'
    ? found.project_rate
    : found.bill_by === 'Tasks'
      ? found.task_rate ?? found.task_default_rate
      : found.bill_by === 'People'
        ? found.person_rate ?? found.person_default_rate
        : null;
  return { billableRate, costRate: found.cost_rate };
}

function clientOf(projectId: number): number | null {
  return (
    row<{ client_id: number }>(
      db().prepare('SELECT client_id FROM projects WHERE id = ?').get(projectId),
    )?.client_id ?? null
  );
}

/**
 * The URL and the form both carry a user id, so every write re-checks it against the
 * session. Members may only touch their own sheet; admins and managers may touch anyone's.
 */
function assertMaySave(user: SessionUser | null, targetUserId: number): void {
  if (!user) throw new ActionError({ code: 'UNAUTHORIZED', message: 'Sign in first.' });
  if (!canViewTimesheet(user, targetUserId)) {
    throw new ActionError({ code: 'FORBIDDEN', message: "That is not your timesheet." });
  }
}

/** An entry's owner, for authorising edits that only carry an entry id. */
function ownerOf(entryId: number): number | null {
  return (
    row<{ user_id: number }>(
      db().prepare('SELECT user_id FROM time_entries WHERE id = ?').get(entryId),
    )?.user_id ?? null
  );
}

function duration(input: string): number {
  const seconds = parseDuration(input);
  if (seconds === null) {
    throw new ActionError({
      code: 'BAD_REQUEST',
      message: `Couldn't read “${input}” as a duration. Try 1:30, 1,5 or 90m.`,
    });
  }
  return seconds;
}

const time = {
  /**
   * Create an entry, or start a timer when no hours are given.
   *
   * That dual behaviour is why Harvest's dialog has one submit button rather than two —
   * empty duration means "start the clock", a filled one means "record this".
   */
  createEntry: defineAction({
    accept: 'form',
    input: z.object({
      user_id: z.coerce.number().int().positive(),
      project_id: z.coerce.number().int().positive(),
      task_id: z.coerce.number().int().positive(),
      spent_date: IsoDate,
      hours: blankableText,
      notes: z.string().max(4000).optional(),
    }),
    handler: async (input, context) => {
      assertMaySave(context.locals.user, input.user_id);
      const database = db();
      const seconds = duration(input.hours);
      const startTimer = input.hours.trim() === '';
      const now = nowIso();
      const billable = resolveBillable(input.project_id, input.task_id);
      const rates = resolveRates(input.project_id, input.task_id, input.user_id);

      if (startTimer) {
        // The partial unique index enforces one running timer per user in the database, so
        // stop whatever is running rather than letting the insert fail.
        database
          .prepare(
            `UPDATE time_entries
                SET is_running = 0, timer_started_at = NULL, updated_at = ?
              WHERE user_id = ? AND is_running = 1`,
          )
          .run(now, input.user_id);
      }

      const result = database
        .prepare(
          `INSERT INTO time_entries (spent_date, user_id, project_id, task_id, client_id,
                                     duration_seconds, rounded_seconds, notes, billable,
                                     billable_rate, cost_rate, is_running, timer_started_at,
                                     created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.spent_date,
          input.user_id,
          input.project_id,
          input.task_id,
          clientOf(input.project_id),
          seconds,
          rounded(seconds),
          input.notes?.trim() || null,
          bool(billable),
          billable ? rates.billableRate : null,
          rates.costRate,
          bool(startTimer),
          startTimer ? now : null,
          now,
          now,
        );

      return { id: Number(result.lastInsertRowid), running: startTimer };
    },
  }),

  updateEntry: defineAction({
    accept: 'form',
    input: z.object({
      id: z.coerce.number().int().positive(),
      project_id: z.coerce.number().int().positive(),
      task_id: z.coerce.number().int().positive(),
      spent_date: IsoDate,
      hours: blankableText,
      notes: z.string().max(4000).optional(),
    }),
    handler: async (input, context) => {
      const owner = ownerOf(input.id) ?? -1;
      assertMaySave(context.locals.user, owner);
      assertEditable(input.id);
      const seconds = duration(input.hours);
      const billable = resolveBillable(input.project_id, input.task_id);

      // Keep the rate this entry was written with unless it has been moved to a different
      // project or task. Re-resolving on every save would mean that correcting a typo in a
      // January note, after a rate rise in March, quietly restates January's revenue — the
      // exact thing the snapshot exists to prevent.
      const before = row<{
        project_id: number;
        task_id: number;
        billable_rate: number | null;
        cost_rate: number | null;
      }>(
        db()
          .prepare('SELECT project_id, task_id, billable_rate, cost_rate FROM time_entries WHERE id = ?')
          .get(input.id),
      );
      const moved =
        !before || before.project_id !== input.project_id || before.task_id !== input.task_id;
      const rates = moved
        ? resolveRates(input.project_id, input.task_id, owner)
        : { billableRate: before.billable_rate, costRate: before.cost_rate };

      db()
        .prepare(
          `UPDATE time_entries
              SET project_id = ?, task_id = ?, client_id = ?, spent_date = ?,
                  duration_seconds = ?, rounded_seconds = ?, notes = ?, billable = ?,
                  billable_rate = ?, cost_rate = ?, is_running = 0,
                  timer_started_at = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.project_id,
          input.task_id,
          clientOf(input.project_id),
          input.spent_date,
          seconds,
          rounded(seconds),
          input.notes?.trim() || null,
          bool(billable),
          billable ? rates.billableRate : null,
          rates.costRate,
          nowIso(),
          input.id,
        );

      return { id: input.id };
    },
  }),

  deleteEntry: defineAction({
    accept: 'form',
    input: z.object({ id: z.coerce.number().int().positive() }),
    handler: async (input, context) => {
      assertMaySave(context.locals.user, ownerOf(input.id) ?? -1);
      assertEditable(input.id);
      db().prepare('DELETE FROM time_entries WHERE id = ?').run(input.id);
      return { id: input.id };
    },
  }),

  /**
   * Start the clock on an existing entry.
   *
   * The partial unique index enforces one running timer per user in the database, so any
   * other running entry is stopped first — banking its elapsed time rather than losing it.
   */
  startTimer: defineAction({
    accept: 'form',
    input: z.object({
      id: z.coerce.number().int().positive(),
      /** Set when the user confirmed starting a timer on a day that is not today. */
      confirmed: z.union([z.string(), z.null(), z.undefined()]).optional(),
    }),
    handler: async (input, context) => {
      const owner = ownerOf(input.id) ?? -1;
      assertMaySave(context.locals.user, owner);
      assertEditable(input.id);

      const database = db();
      const now = nowIso();

      const entry = row<{ spent_date: string }>(
        database.prepare('SELECT spent_date FROM time_entries WHERE id = ?').get(input.id),
      );
      if (!entry) throw new ActionError({ code: 'NOT_FOUND', message: 'No such entry.' });

      // Bank whatever the currently running timer has accrued before switching.
      const current = row<{ id: number; timer_started_at: string | null; duration_seconds: number }>(
        database
          .prepare(
            'SELECT id, timer_started_at, duration_seconds FROM time_entries WHERE user_id = ? AND is_running = 1',
          )
          .get(owner),
      );
      if (current) {
        const elapsed = current.timer_started_at
          ? Math.max(0, Math.round((Date.now() - Date.parse(current.timer_started_at)) / 1000))
          : 0;
        const banked = current.duration_seconds + elapsed;
        database
          .prepare(
            `UPDATE time_entries
                SET duration_seconds = ?, rounded_seconds = ?, is_running = 0,
                    timer_started_at = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(banked, rounded(banked), now, current.id);
      }

      database
        .prepare(
          'UPDATE time_entries SET is_running = 1, timer_started_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(now, now, input.id);

      return { id: input.id, stopped: current?.id ?? null, onDate: entry.spent_date };
    },
  }),

  stopTimer: defineAction({
    accept: 'form',
    input: z.object({ id: z.coerce.number().int().positive() }),
    handler: async (input, context) => {
      assertMaySave(context.locals.user, ownerOf(input.id) ?? -1);
      // Stopping a timer writes a duration, so it is a write like any other and a locked
      // entry refuses it. This was the one write path that did not ask.
      assertEditable(input.id);
      const entry = row<{ timer_started_at: string | null; duration_seconds: number }>(
        db()
          .prepare('SELECT timer_started_at, duration_seconds FROM time_entries WHERE id = ?')
          .get(input.id),
      );
      if (!entry) throw new ActionError({ code: 'NOT_FOUND', message: 'No such entry.' });

      const elapsed = entry.timer_started_at
        ? Math.max(0, Math.round((Date.now() - Date.parse(entry.timer_started_at)) / 1000))
        : 0;
      const total = entry.duration_seconds + elapsed;

      db()
        .prepare(
          `UPDATE time_entries
              SET duration_seconds = ?, rounded_seconds = ?, is_running = 0,
                  timer_started_at = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(total, rounded(total), nowIso(), input.id);

      return { id: input.id, seconds: total };
    },
  }),


  /**
   * The week grid's batched save.
   *
   * Takes raw FormData rather than a JSON blob, so the grid is a plain <form> and works
   * with JavaScript switched off. Cell fields are named `c_<date>_<projectId>_<taskId>`.
   *
   * Compound cells (several entries on the same project, task and day) are the interesting
   * case: we absorb the delta into the most recently updated entry and leave the others —
   * and their notes — alone. That is our chosen rule, not an observed Harvest behaviour;
   * and reports partial failures to the caller.
   */
  saveWeek: defineAction({
    accept: 'form',
    handler: async (form: FormData, context) => {
      const userId = Number(form.get('user_id'));
      assertMaySave(context.locals.user, userId);
      const weekStart = String(form.get('week') ?? '');
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'Missing user.' });
      }

      interface Cell {
        date: string;
        projectId: number;
        taskId: number;
        hours: string;
      }
      const cells: Cell[] = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith('c_')) continue;
        const [, date, projectId, taskId] = key.split('_');
        if (!date || !projectId || !taskId) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        cells.push({
          date,
          projectId: Number(projectId),
          taskId: Number(taskId),
          hours: String(value),
        });
      }

      const database = db();
      const now = nowIso();
      let created = 0;
      let updated = 0;
      let deleted = 0;
      let skippedLocked = 0;

      database.exec('BEGIN');
      try {
        for (const cell of cells) {
          const seconds = duration(cell.hours);
          const existing = rows<{ id: number; is_locked: number; duration_seconds: number }>(
            database
              .prepare(
                `SELECT id, is_locked, duration_seconds FROM time_entries
                  WHERE user_id = ? AND spent_date = ? AND project_id = ? AND task_id = ?
                  ORDER BY updated_at DESC, id DESC`,
              )
              .all(userId, cell.date, cell.projectId, cell.taskId),
          );

          const current = existing.reduce((sum, e) => sum + e.duration_seconds, 0);
          if (seconds === current) continue; // untouched

          // Never rewrite what the source system froze.
          if (existing.some((e) => e.is_locked)) {
            skippedLocked += 1;
            continue;
          }

          if (existing.length === 0) {
            if (seconds === 0) continue;
            // The same rate snapshot createEntry takes. Without it the grid — which is where
            // most time is actually entered — would write entries that earn nothing, because
            // reports count only rows whose billable_rate is set.
            const cellBillable = resolveBillable(cell.projectId, cell.taskId);
            const cellRates = resolveRates(cell.projectId, cell.taskId, userId);
            database
              .prepare(
                `INSERT INTO time_entries (spent_date, user_id, project_id, task_id, client_id,
                                           duration_seconds, rounded_seconds, billable,
                                           billable_rate, cost_rate, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                cell.date,
                userId,
                cell.projectId,
                cell.taskId,
                clientOf(cell.projectId),
                seconds,
                rounded(seconds),
                bool(cellBillable),
                cellBillable ? cellRates.billableRate : null,
                cellRates.costRate,
                now,
                now,
              );
            created += 1;
            continue;
          }

          if (seconds === 0) {
            for (const entry of existing) {
              database.prepare('DELETE FROM time_entries WHERE id = ?').run(entry.id);
              deleted += 1;
            }
            continue;
          }

          const target = existing[0]!;
          const others = existing.slice(1).reduce((sum, e) => sum + e.duration_seconds, 0);
          const remainder = Math.max(0, seconds - others);
          database
            .prepare(
              `UPDATE time_entries
                  SET duration_seconds = ?, rounded_seconds = ?, updated_at = ?
                WHERE id = ?`,
            )
            .run(remainder, rounded(remainder), now, target.id);
          updated += 1;
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }

      return { created, updated, deleted, skippedLocked, week: weekStart, user_id: userId };
    },
  }),

  /** Remove every entry for one (project, task) row across the displayed week. */
  deleteRow: defineAction({
    accept: 'form',
    input: z.object({
      user_id: z.coerce.number().int().positive(),
      week: IsoDate,
      // `projectId:taskId`. One field, because this arrives from a submit button's
      // name/value inside the grid's own form — a nested <form> would be invalid HTML.
      row: z.string().regex(/^\d+:\d+$/, 'Expected projectId:taskId'),
    }),
    handler: async (input, context) => {
      assertMaySave(context.locals.user, input.user_id);
      const [projectId, taskId] = input.row.split(':').map(Number);
      const result = db()
        .prepare(
          `DELETE FROM time_entries
            WHERE user_id = ? AND project_id = ? AND task_id = ?
              AND spent_date BETWEEN ? AND ? AND is_locked = 0`,
        )
        .run(input.user_id, projectId!, taskId!, input.week, addDays(input.week, 6));
      return { deleted: Number(result.changes) };
    },
  }),

  /**
   * Copy last week forward. Two modes, matching Harvest: `projects` brings the rows across
   * with no hours, `entries` brings the hours too.
   */
  copyFromLastWeek: defineAction({
    accept: 'form',
    input: z.object({
      user_id: z.coerce.number().int().positive(),
      week: IsoDate,
      mode: z.enum(['projects', 'entries']).default('projects'),
    }),
    handler: async (input, context) => {
      assertMaySave(context.locals.user, input.user_id);
      const database = db();
      const source = addDays(input.week, -7);
      const sourceEntries = rows<{
        spent_date: string;
        project_id: number;
        task_id: number;
        client_id: number | null;
        duration_seconds: number;
        billable: number;
      }>(
        database
          .prepare(
            `SELECT spent_date, project_id, task_id, client_id, duration_seconds, billable
               FROM time_entries
              WHERE user_id = ? AND spent_date BETWEEN ? AND ?`,
          )
          .all(input.user_id, source, addDays(source, 6)),
      );

      if (sourceEntries.length === 0) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'Last week has nothing to copy.' });
      }

      const now = nowIso();
      let copied = 0;

      database.exec('BEGIN');
      try {
        if (input.mode === 'projects') {
          // Rows only: one zero-hour placeholder per (project, task) on the week's first day,
          // so the grid shows the row ready to type into.
          const seen = new Set<string>();
          for (const entry of sourceEntries) {
            const key = `${entry.project_id}:${entry.task_id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const exists = row<{ n: number }>(
              database
                .prepare(
                  `SELECT COUNT(*) n FROM time_entries
                    WHERE user_id = ? AND project_id = ? AND task_id = ?
                      AND spent_date BETWEEN ? AND ?`,
                )
                .get(input.user_id, entry.project_id, entry.task_id, input.week, addDays(input.week, 6)),
            );
            if ((exists?.n ?? 0) > 0) continue;
            const rowRates = resolveRates(entry.project_id, entry.task_id, input.user_id);
            database
              .prepare(
                `INSERT INTO time_entries (spent_date, user_id, project_id, task_id, client_id,
                                           duration_seconds, rounded_seconds, billable,
                                           billable_rate, cost_rate, created_at, updated_at)
                 VALUES (?,?,?,?,?,0,0,?,?,?,?,?)`,
              )
              .run(
                input.week, input.user_id, entry.project_id, entry.task_id, entry.client_id,
                entry.billable, entry.billable ? rowRates.billableRate : null, rowRates.costRate,
                now, now,
              );
            copied += 1;
          }
        } else {
          for (const entry of sourceEntries) {
            if (entry.duration_seconds === 0) continue;
            const shifted = addDays(entry.spent_date, 7);
            // A copy is new work in a new week, so it takes today's rate rather than the rate
            // the entry it was copied from is holding.
            const copyRates = resolveRates(entry.project_id, entry.task_id, input.user_id);
            database
              .prepare(
                `INSERT INTO time_entries (spent_date, user_id, project_id, task_id, client_id,
                                           duration_seconds, rounded_seconds, billable,
                                           billable_rate, cost_rate, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                shifted,
                input.user_id,
                entry.project_id,
                entry.task_id,
                entry.client_id,
                entry.duration_seconds,
                rounded(entry.duration_seconds),
                entry.billable,
                entry.billable ? copyRates.billableRate : null,
                copyRates.costRate,
                now,
                now,
              );
            copied += 1;
          }
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }

      return { copied, mode: input.mode };
    },
  }),
};

export const server = { ...time, ...auth, ...admin, ...tokens };
