/**
 * Admin CRUD.
 *
 * Clients, projects, tasks, users and the two assignment tables. All form posts.
 *
 * Two rules the imported data taught us:
 *   · Archive, never delete. Time entries reference these rows forever.
 *   · Archiving a project LOCKS its time entries, with reason "Item Archived". That is
 *     Harvest's behaviour, and the large majority of an imported account's projects are in
 *     that state.
 */

import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro:schema';
import { bool, db, nowIso, row, transaction } from '../lib/db/index.ts';
import {
  checkbox,
  optionalDate,
  optionalHours,
  optionalPercent,
  optionalRate,
  optionalText,
} from '../lib/forms.ts';
import { HOURS_BUDGETS, LOCK_REASON, MONEY_BUDGETS } from '../lib/harvest/constants.ts';
import { readSettings } from '../lib/settings.ts';
import { hashPassword } from '../lib/auth/password.ts';
import { canAdminister, destroyAllSessions } from '../lib/auth/session.ts';
import type { SessionUser } from '../lib/auth/session.ts';

/**
 * The budget form field is one box whose unit follows `budget_by`, so exactly one of the two
 * columns is filled and the other is cleared — never both, or the next reader has to guess.
 */
function budgetColumns(input: {
  budget_by: string;
  budget_hours: number | null;
  budget_money: number | null;
}): [number | null, number | null] {
  if (HOURS_BUDGETS.has(input.budget_by)) return [input.budget_hours, null];
  if (MONEY_BUDGETS.has(input.budget_by)) return [null, input.budget_money];
  return [null, null];
}

function requireAdmin(user: SessionUser | null): SessionUser {
  if (!user) throw new ActionError({ code: 'UNAUTHORIZED', message: 'Sign in first.' });
  if (!canAdminister(user)) {
    throw new ActionError({ code: 'FORBIDDEN', message: 'Only administrators can change this.' });
  }
  return user;
}

export const admin = {
  saveClient: defineAction({
    accept: 'form',
    input: z.object({
      id: z.coerce.number().int().optional(),
      name: z.string().min(1, 'A client needs a name.'),
      address: optionalText,
      // Blank falls back to the instance's currency rather than a literal.
      currency: z
        .union([z.string(), z.null(), z.undefined()])
        .transform((v) => (typeof v === 'string' && v.trim().length === 3 ? v.trim().toUpperCase() : null)),
      is_active: checkbox,
    }),
    handler: async (input, context) => {
      requireAdmin(context.locals.user);
      const now = nowIso();
      const database = db();

      if (input.id) {
        database
          .prepare(
            `UPDATE clients SET name = ?, address = ?, currency = ?, is_active = ?,
                                archived_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.name,
            input.address,
            input.currency ?? readSettings(database).currency,
            bool(input.is_active),
            input.is_active ? null : now,
            now,
            input.id,
          );
        return { id: input.id };
      }

      const result = database
        .prepare(
          `INSERT INTO clients (name, address, currency, is_active, created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(input.name, input.address, input.currency ?? readSettings(database).currency, bool(input.is_active), now, now);
      return { id: Number(result.lastInsertRowid) };
    },
  }),

  saveProject: defineAction({
    accept: 'form',
    input: z.object({
      id: z.coerce.number().int().optional(),
      client_id: z.coerce.number().int().positive(),
      name: z.string().min(1, 'A project needs a name.'),
      code: optionalText,
      notes: optionalText,
      hourly_rate: optionalRate,
      is_billable: checkbox,
      is_fixed_fee: checkbox,
      bill_by: z.enum(['none', 'Project', 'Tasks', 'People']).catch('none'),
      fee: optionalRate,
      budget_by: z.enum(['none', 'project', 'project_cost', 'task', 'task_fees', 'person']).catch('none'),
      // One field on screen; the unit follows budget_by, so it is read as both and the
      // irrelevant one is discarded below.
      budget_hours: optionalHours,
      budget_money: optionalRate,
      budget_is_monthly: checkbox,
      cost_budget: optionalRate,
      notify_when_over_budget: checkbox,
      over_budget_notification_percentage: optionalPercent,
      show_budget_to_all: checkbox,
      cost_budget_include_expenses: checkbox,
      starts_on: optionalDate,
      ends_on: optionalDate,
      is_active: checkbox,
    }),
    handler: async (input, context) => {
      requireAdmin(context.locals.user);
      const now = nowIso();
      const database = db();

      return transaction(database, () => {
        let projectId = input.id;

        if (projectId) {
          const before = row<{ is_active: number }>(
            database.prepare('SELECT is_active FROM projects WHERE id = ?').get(projectId),
          );
          if (!before) throw new ActionError({ code: 'NOT_FOUND', message: 'No such project.' });

          database
            .prepare(
              `UPDATE projects SET client_id = ?, name = ?, code = ?, notes = ?, hourly_rate = ?,
                                   is_billable = ?, is_fixed_fee = ?, bill_by = ?, fee = ?,
                                   budget_by = ?, budget_seconds = ?, budget_amount = ?,
                                   budget_is_monthly = ?, cost_budget = ?,
                                   cost_budget_include_expenses = ?, notify_when_over_budget = ?,
                                   over_budget_notification_percentage = ?, show_budget_to_all = ?,
                                   starts_on = ?, ends_on = ?,
                                   is_active = ?, archived_at = ?, updated_at = ?
                WHERE id = ?`,
            )
            .run(
              input.client_id,
              input.name,
              input.code,
              input.notes,
              input.hourly_rate,
              bool(input.is_billable),
              bool(input.is_fixed_fee),
              input.bill_by,
              input.fee,
              input.budget_by,
              ...budgetColumns(input),
              bool(input.budget_is_monthly),
              input.cost_budget,
              bool(input.cost_budget_include_expenses),
              bool(input.notify_when_over_budget),
              input.over_budget_notification_percentage,
              bool(input.show_budget_to_all),
              input.starts_on,
              input.ends_on,
              bool(input.is_active),
              input.is_active ? null : now,
              now,
              projectId,
            );

          // Harvest has four lock reasons and they compose: an entry can be archived,
          // invoiced, or both. Archiving must not clobber an invoice lock, and un-archiving
          // must not release one. Getting this wrong makes billed history editable.
          if (before.is_active && !input.is_active) {
            database
              .prepare(
                `UPDATE time_entries
                    SET is_locked = 1,
                        locked_reason = CASE
                          WHEN is_billed = 1 THEN ?
                          ELSE ? END,
                        updated_at = ?
                  WHERE project_id = ? AND locked_reason IS NOT ?`,
              )
              .run(LOCK_REASON.invoicedAndArchived, LOCK_REASON.archived, now, projectId, LOCK_REASON.period);
          } else if (!before.is_active && input.is_active) {
            // Billed entries stay locked, downgraded to the invoice reason alone.
            database
              .prepare(
                `UPDATE time_entries SET locked_reason = ?, updated_at = ?
                  WHERE project_id = ? AND locked_reason = ?`,
              )
              .run(LOCK_REASON.invoiced, now, projectId, LOCK_REASON.invoicedAndArchived);
            database
              .prepare(
                `UPDATE time_entries SET is_locked = 0, locked_reason = NULL, updated_at = ?
                  WHERE project_id = ? AND locked_reason = ? AND is_billed = 0`,
              )
              .run(now, projectId, LOCK_REASON.archived);
          }
        } else {
          const result = database
            .prepare(
              `INSERT INTO projects (client_id, name, code, notes, hourly_rate, is_billable,
                                     is_fixed_fee, bill_by, fee, budget_by, budget_seconds,
                                     budget_amount, budget_is_monthly, cost_budget,
                                     cost_budget_include_expenses, notify_when_over_budget,
                                     over_budget_notification_percentage, show_budget_to_all,
                                     starts_on, ends_on, is_active, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              input.client_id,
              input.name,
              input.code,
              input.notes,
              input.hourly_rate,
              bool(input.is_billable),
              bool(input.is_fixed_fee),
              input.bill_by,
              input.fee,
              input.budget_by,
              ...budgetColumns(input),
              bool(input.budget_is_monthly),
              input.cost_budget,
              bool(input.cost_budget_include_expenses),
              bool(input.notify_when_over_budget),
              input.over_budget_notification_percentage,
              bool(input.show_budget_to_all),
              input.starts_on,
              input.ends_on,
              bool(input.is_active),
              now,
              now,
            );
          projectId = Number(result.lastInsertRowid);
        }

        return { id: projectId };
      });
    },
  }),

  saveTask: defineAction({
    accept: 'form',
    input: z.object({
      id: z.coerce.number().int().optional(),
      name: z.string().min(1, 'A task needs a name.'),
      billable_by_default: checkbox,
      default_hourly_rate: optionalRate,
      is_active: checkbox,
    }),
    handler: async (input, context) => {
      requireAdmin(context.locals.user);
      const now = nowIso();
      const database = db();

      if (input.id) {
        database
          .prepare(
            `UPDATE tasks SET name = ?, billable_by_default = ?, default_hourly_rate = ?,
                              is_active = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.name,
            bool(input.billable_by_default),
            input.default_hourly_rate,
            bool(input.is_active),
            input.is_active ? null : now,
            now,
            input.id,
          );
        return { id: input.id };
      }

      const result = database
        .prepare(
          `INSERT INTO tasks (name, billable_by_default, default_hourly_rate, is_active,
                              created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(input.name, bool(input.billable_by_default), input.default_hourly_rate, bool(input.is_active), now, now);
      return { id: Number(result.lastInsertRowid) };
    },
  }),

  saveUser: defineAction({
    accept: 'form',
    input: z.object({
      id: z.coerce.number().int().optional(),
      email: z.string().email(),
      first_name: z.string().default(''),
      last_name: z.string().default(''),
      role: z.enum(['admin', 'manager', 'member']).default('member'),
      weekly_capacity_hours: optionalHours,
      default_billable_rate: optionalRate,
      cost_rate: optionalRate,
      is_active: checkbox,
      password: optionalText,
    }),
    handler: async (input, context) => {
      const actor = requireAdmin(context.locals.user);
      const now = nowIso();
      const database = db();

      const capacity = input.weekly_capacity_hours;
      const hash = input.password ? await hashPassword(input.password) : null;

      if (input.id) {
        // Don't let an admin lock themselves out of their own instance.
        if (input.id === actor.id && (input.role !== 'admin' || !input.is_active)) {
          throw new ActionError({
            code: 'BAD_REQUEST',
            message: 'You cannot remove your own admin access or deactivate yourself.',
          });
        }

        database
          .prepare(
            `UPDATE users SET email = ?, first_name = ?, last_name = ?, role = ?,
                              weekly_capacity_seconds = ?, default_billable_rate = ?,
                              cost_rate = ?, is_active = ?, archived_at = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            input.email,
            input.first_name,
            input.last_name,
            input.role,
            capacity,
            input.default_billable_rate,
            input.cost_rate,
            bool(input.is_active),
            input.is_active ? null : now,
            now,
            input.id,
          );

        if (hash) {
          database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, input.id);
          destroyAllSessions(database, input.id);
        }
        if (!input.is_active) destroyAllSessions(database, input.id);

        return { id: input.id };
      }

      // Email is UNIQUE, and retyping an existing address is an ordinary mistake rather than
      // an exceptional one. Without this it surfaces as a blank 500.
      const taken = row<{ id: number }>(
        database.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(input.email),
      );
      if (taken) {
        throw new ActionError({
          code: 'CONFLICT',
          message: 'Somebody already uses that email address.',
        });
      }

      const result = database
        .prepare(
          `INSERT INTO users (email, first_name, last_name, role, weekly_capacity_seconds,
                              default_billable_rate, cost_rate, is_active, password_hash,
                              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.email,
          input.first_name,
          input.last_name,
          input.role,
          capacity,
          input.default_billable_rate,
          input.cost_rate,
          bool(input.is_active),
          hash,
          now,
          now,
        );
      return { id: Number(result.lastInsertRowid) };
    },
  }),

  /** Add or remove a person from a project. */
  setUserAssignment: defineAction({
    accept: 'form',
    input: z.object({
      project_id: z.coerce.number().int().positive(),
      user_id: z.coerce.number().int().positive(),
      active: checkbox,
    }),
    handler: async (input, context) => {
      requireAdmin(context.locals.user);
      const now = nowIso();
      db()
        .prepare(
          `INSERT INTO user_assignments (project_id, user_id, is_active, created_at, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(project_id, user_id) DO UPDATE SET is_active = excluded.is_active,
                                                          updated_at = excluded.updated_at`,
        )
        .run(input.project_id, input.user_id, bool(input.active), now, now);
      return { ok: true };
    },
  }),

  /** Add or remove a task on a project, and set whether it bills. */
  setTaskAssignment: defineAction({
    accept: 'form',
    input: z.object({
      project_id: z.coerce.number().int().positive(),
      task_id: z.coerce.number().int().positive(),
      active: checkbox,
      billable: checkbox,
    }),
    handler: async (input, context) => {
      requireAdmin(context.locals.user);
      const now = nowIso();
      db()
        .prepare(
          `INSERT INTO task_assignments (project_id, task_id, is_active, billable, created_at, updated_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(project_id, task_id) DO UPDATE SET is_active = excluded.is_active,
                                                          billable = excluded.billable,
                                                          updated_at = excluded.updated_at`,
        )
        .run(input.project_id, input.task_id, bool(input.active), bool(input.billable), now, now);
      return { ok: true };
    },
  }),
};
