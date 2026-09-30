/**
 * Harvest → SQLite import.
 *
 * Every statement is `ON CONFLICT(id) DO UPDATE` with the Harvest id as the id (migration 006),
 * so running this twice is a no-op
 * and running it against a partially-imported database repairs it. That idempotence is also
 * what makes incremental sync possible later: same code path, narrower input.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Db } from '../db/index.ts';
import {
  bool,
  hoursToSeconds,
  nowIso,
  secondsToHours,
  toMinorUnits,
  transaction,
} from '../db/index.ts';
import { HOURS_BUDGETS, MONEY_BUDGETS } from './constants.ts';
import { log } from '../instance-log.ts';
import { mapAccessRoles } from './roles.ts';
import { DEFAULT_SETTINGS, settingsFromCompany, writeSettings } from '../settings.ts';
import { receiptFileName } from './extras.ts';
import type {
  HarvestClientRecord,
  HarvestCompany,
  HarvestContact,
  HarvestEstimate,
  HarvestEstimateItemCategory,
  HarvestEstimateMessage,
  HarvestExpense,
  HarvestExpenseCategory,
  HarvestInvoice,
  HarvestInvoiceItemCategory,
  HarvestInvoiceMessage,
  HarvestInvoicePayment,
  HarvestProject,
  HarvestRole,
  HarvestTeammates,
  HarvestUserRate,
  HarvestTask,
  HarvestTaskAssignment,
  HarvestTimeEntry,
  HarvestUser,
  HarvestUserAssignment,
} from './types.ts';

export interface HarvestSnapshot {
  /** Optional: when present, seeds instance settings (currency, week start, rounding). */
  company?: HarvestCompany;
  users: HarvestUser[];
  clients: HarvestClientRecord[];
  tasks: HarvestTask[];
  projects: HarvestProject[];
  user_assignments: HarvestUserAssignment[];
  task_assignments: HarvestTaskAssignment[];
  time_entries: HarvestTimeEntry[];
  /**
   * Optional, because a dump pulled before invoices were imported has neither. Absent means
   * "not fetched" and leaves the invoice tables alone; present-but-empty means "there are
   * none" and is acted on.
   */
  invoices?: HarvestInvoice[];
  invoice_payments?: HarvestInvoicePayment[];
  // The rest of the account (migration 007). Same rule: absent means not fetched.
  contacts?: HarvestContact[];
  roles?: HarvestRole[];
  expense_categories?: HarvestExpenseCategory[];
  expenses?: HarvestExpense[];
  estimates?: HarvestEstimate[];
  estimate_messages?: HarvestEstimateMessage[];
  invoice_messages?: HarvestInvoiceMessage[];
  invoice_item_categories?: HarvestInvoiceItemCategory[];
  estimate_item_categories?: HarvestEstimateItemCategory[];
  user_billable_rates?: HarvestUserRate[];
  user_cost_rates?: HarvestUserRate[];
  teammates?: HarvestTeammates[];
}

export interface ImportReport {
  counts: Record<string, number>;
  skipped: Record<string, number>;
  reconciliation: {
    source_hours: number;
    imported_hours: number;
    difference: number;
    matches: boolean;
    per_year: Record<string, { source: number; imported: number; delta: number }>;
  };
  /**
   * The same check for money: what Harvest said the invoices total against what is stored.
   * Null when the snapshot carried no invoices. Amounts are major units, for reading.
   */
  invoices: {
    source_amount: number;
    imported_amount: number;
    difference: number;
    matches: boolean;
  } | null;
  first_date: string | null;
  last_date: string | null;
}

/** A run is good when everything it reconciled agreed — hours, and invoices when present. */
export function reportOk(report: ImportReport): boolean {
  return report.reconciliation.matches && (report.invoices?.matches ?? true);
}

type IdMap = Map<number, number>;

/**
 * `[budget_seconds, budget_amount]` for a task or user assignment.
 *
 * Harvest gives one `budget` whose unit follows the project's `budget_by`: hours for the
 * mode named here, money for the fees variant. Exactly one column is ever filled.
 */
function assignmentBudget(
  budgetBy: string | null | undefined,
  hoursMode: 'task' | 'person',
  budget: number | null | undefined,
): [number | null, number | null] {
  if (budget == null) return [null, null];
  if (budgetBy === hoursMode) return [hoursToSeconds(budget), null];
  return [null, toMinorUnits(budget)];
}

/**
 * A temp table holding the snapshot's time-entry ids, for partial reconciliation.
 *
 * A literal `IN (...)` would work at delta size but not at snapshot size, and the difference
 * between the two is exactly the sort of thing that goes unnoticed until someone runs a full
 * import with the partial flag set by mistake. A table has no such cliff.
 */
function scopeToSnapshot(db: Db, records: readonly { id: number }[], name: string): string {
  db.exec(`DROP TABLE IF EXISTS temp.${name}`);
  db.exec(`CREATE TEMP TABLE ${name} (harvest_id INTEGER PRIMARY KEY)`);
  const insert = db.prepare(`INSERT OR IGNORE INTO temp.${name} (harvest_id) VALUES (?)`);
  for (const record of records) insert.run(record.id);
  return `temp.${name}`;
}

/**
 * Where rows made in this app live once Harvest rows share a table. See parkSequences.
 */
const LOCAL_BASE = 1_000_000_000_000;

/**
 * The tables this application writes rows into itself, and so the only ones where a local row
 * can be standing on an id Harvest is about to use.
 *
 * Kept to these on purpose. Moving a row means moving every row that points at it, and that
 * list is read from the schema's declared foreign keys — which is complete for these tables
 * and not for every table: time_entries.invoice_id and expenses.invoice_id are undeclared.
 * Invoices are import-only, so it does not matter today. A table that gains a local "create"
 * belongs here, after checking nothing refers to it without a foreign key.
 */
const LOCALLY_WRITTEN = [
  'users', 'clients', 'tasks', 'projects', 'user_assignments', 'task_assignments', 'time_entries',
] as const satisfies readonly (keyof HarvestSnapshot)[];

interface Reference {
  table: string;
  column: string;
}

/** Every column that holds a foreign key into `target`, read from the schema itself. */
function referencesTo(db: Db, target: string): Reference[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const found: Reference[] = [];
  for (const { name } of tables) {
    const keys = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as {
      table: string;
      from: string;
    }[];
    for (const key of keys) if (key.table === target) found.push({ table: name, column: key.from });
  }
  return found;
}

/**
 * Give a row a new id, and repoint everything that refers to it.
 *
 * Driven by the schema rather than by a list in this file. The list it replaces named four
 * columns while twelve refer to users, so adopting an administrator who had made an API token
 * left the token pointing at an id that no longer existed, and the deferred foreign-key check
 * rolled back the entire import at its final statement.
 */
function moveRow(db: Db, table: string, from: number, to: number, references: Reference[]): void {
  if (from === to) return;
  db.prepare(`UPDATE "${table}" SET id = ? WHERE id = ?`).run(to, from);
  for (const ref of references) {
    db.prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.column}" = ?`).run(to, from);
  }
}

/**
 * The next id in the local range.
 *
 * The sequence is read as well as the table's highest id, so an id that once existed and was
 * deleted is not handed out again — the same promise AUTOINCREMENT makes. Nothing is written to
 * the sequence: AUTOINCREMENT already takes the larger of the sequence and the highest id, so a
 * row moved up by UPDATE is never reissued to the next row this application creates.
 */
function nextLocalId(db: Db, table: string): number {
  const { next } = db
    .prepare(
      `SELECT MAX(
         COALESCE((SELECT MAX(id) FROM "${table}"), 0),
         COALESCE((SELECT seq FROM sqlite_sequence WHERE name = ?), 0),
         CAST(? AS INTEGER)
       ) + 1 AS next`,
    )
    .get(table, LOCAL_BASE) as { next: number };
  return next;
}

/**
 * Move local rows off the ids an incoming snapshot is about to use.
 *
 * A row made here before the first import takes a small autoincrement id — "Start fresh"
 * gives the first administrator id 1 — and nothing stops Harvest holding a different record
 * with that number. Every upsert keys on id, so without this the Harvest record is written
 * over the local one: a different person's email on the owner's password, with harvest_id
 * left empty so nothing that belongs to the Harvest person can be matched to them.
 *
 * Returns how many rows were moved. Local rows are few, so they are checked against the
 * incoming ids in memory rather than by building a table of every incoming id.
 */
function makeRoom(
  db: Db,
  table: string,
  incoming: readonly { id: number }[],
  references: Reference[],
): number {
  const local = db
    .prepare(`SELECT id FROM "${table}" WHERE harvest_id IS NULL AND id < CAST(? AS INTEGER)`)
    .all(LOCAL_BASE) as { id: number }[];
  if (local.length === 0 || incoming.length === 0) return 0;
  const wanted = new Set(incoming.map((record) => record.id));
  let moved = 0;
  for (const { id } of local) {
    if (!wanted.has(id)) continue;
    moveRow(db, table, id, nextLocalId(db, table), references);
    moved += 1;
  }
  return moved;
}

/** Read back harvest_id → local id after upserting a table. */
function idMap(db: Db, table: string): IdMap {
  const rows = db
    .prepare(`SELECT id, harvest_id FROM ${table} WHERE harvest_id IS NOT NULL`)
    .all() as { id: number; harvest_id: number }[];
  return new Map(rows.map((r) => [r.harvest_id, r.id]));
}

export interface ImportOptions {
  /** The snapshot is a delta from an incremental sync, not the whole account. */
  partial?: boolean;
  /**
   * Where receipt files live for this instance. A snapshot's expenses name the file they
   * were downloaded to; each is copied here unless it is here already, and the row records
   * its name under this folder. Without it, receipts are described but not kept.
   */
  receiptDir?: string;
}

export function importSnapshot(
  db: Db,
  snapshot: HarvestSnapshot,
  options: ImportOptions = {},
): ImportReport {
  const skipped: Record<string, number> = {};
  const bump = (key: string) => {
    skipped[key] = (skipped[key] ?? 0) + 1;
  };

  return transaction(db, () => {
    // Adopting a local account moves its id (below), and its sessions and entries follow it
    // within the same transaction. Checked at the commit, on the whole result.
    db.exec('PRAGMA defer_foreign_keys = ON');

    // Before anything is written, so no upsert below can land on a row it does not own.
    const references = new Map(LOCALLY_WRITTEN.map((table) => [table, referencesTo(db, table)]));
    let movedAside = 0;
    for (const table of LOCALLY_WRITTEN) {
      movedAside += makeRoom(db, table, snapshot[table], references.get(table)!);
    }
    if (movedAside) {
      log.info(`[import] moved ${movedAside} local row(s) off ids Harvest is using`, { movedAside });
    }

    // ── settings ─────────────────────────────────────────────────────────────
    // Currency, week start and the rounding rule are per-account. Hardcoding them would be
    // wrong for every other account, and unfixable on a self-hosted instance.
    if (snapshot.company) {
      writeSettings(db, settingsFromCompany(snapshot.company as unknown as Record<string, unknown>));
    }

    // ── users ────────────────────────────────────────────────────────────────
    // A person can already exist here without a Harvest id — created by "Start fresh" or by
    // scripts/admin.ts, and usually the administrator running this very import. The upsert
    // below keys on id, and such a row sits at an id of its own, so it is invisible to the
    // upsert and the insert collides with the UNIQUE email instead. That failure arrives on the last statement of
    // a six-minute pull, rolls the whole thing back, and reads "UNIQUE constraint failed:
    // users.email" — which names neither the person nor the cause.
    //
    // So the local row is claimed for the Harvest id first, and the upsert then updates it
    // in place. The account keeps its password and its sessions; it gains its Harvest
    // identity and everything Harvest knows about it — including the id itself, since an
    // imported row's id is its Harvest id (migration 006). The rows that pointed at the old
    // id are moved with it, inside this transaction.
    const findLocal = db.prepare(
      'SELECT id FROM users WHERE harvest_id IS NULL AND lower(email) = lower(?)',
    );
    const markImported = db.prepare('UPDATE users SET harvest_id = ? WHERE id = ?');
    const claimLocal = (harvestId: number, email: string): boolean => {
      const local = findLocal.get(email) as { id: number } | undefined;
      if (!local) return false;
      moveRow(db, 'users', local.id, harvestId, references.get('users')!);
      markImported.run(harvestId, harvestId);
      return true;
    };

    const insUser = db.prepare(`
      INSERT INTO users (id, harvest_id, email, first_name, last_name, role, access_roles,
                         is_active, is_contractor, timezone, weekly_capacity_seconds,
                         default_billable_rate, cost_rate, avatar_url, source_json,
                         created_at, updated_at, archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email, first_name = excluded.first_name,
        last_name = excluded.last_name,
        -- Never demote an administrator, and never deactivate one who can sign in here.
        -- Harvest's grants decide the role for everyone else, but an admin of *this* instance
        -- was made one deliberately — by the setup wizard, the Team page or the CLI — and an
        -- import that quietly reverses that locks the owner out of their own instance. The
        -- grants are still recorded verbatim below, so nothing is lost.
        role = CASE WHEN users.role = 'admin' THEN 'admin' ELSE excluded.role END,
        access_roles = excluded.access_roles,
        is_active = CASE
          WHEN users.role = 'admin' AND users.password_hash IS NOT NULL THEN 1
          ELSE excluded.is_active END,
        is_contractor = excluded.is_contractor,
        timezone = excluded.timezone,
        weekly_capacity_seconds = excluded.weekly_capacity_seconds,
        default_billable_rate = excluded.default_billable_rate,
        cost_rate = excluded.cost_rate, avatar_url = excluded.avatar_url,
        source_json = excluded.source_json, updated_at = excluded.updated_at,
        -- Same reasoning as is_active: an archived admin cannot sign in, and an import is not
        -- the place to take an instance's own administrator away from it.
        archived_at = CASE
          WHEN users.role = 'admin' AND users.password_hash IS NOT NULL THEN NULL
          ELSE excluded.archived_at END
    `);
    let adopted = 0;
    for (const u of snapshot.users) {
      const mapped = mapAccessRoles(u.access_roles);
      for (const grant of mapped.unknown) bump(`unknown_access_role:${grant}`);
      if (u.email) adopted += claimLocal(u.id, u.email) ? 1 : 0;
      insUser.run(
        u.id,
        u.id,
        u.email,
        u.first_name ?? '',
        u.last_name ?? '',
        mapped.level,
        // Harvest's grants, verbatim. `role` above is only our derived permission level.
        JSON.stringify(u.access_roles ?? u.roles ?? []),
        bool(u.is_active),
        bool(u.is_contractor),
        u.timezone ?? null,
        // Harvest reports weekly_capacity in seconds already.
        u.weekly_capacity ?? null,
        toMinorUnits(u.default_hourly_rate),
        toMinorUnits(u.cost_rate),
        u.avatar_url ?? null,
        JSON.stringify(u),
        u.created_at,
        u.updated_at,
        u.is_active ? null : u.updated_at,
      );
    }
    if (adopted) log.info(`[import] adopted ${adopted} local account(s) by email`, { adopted });
    const users = idMap(db, 'users');

    // Clients without their own currency inherit the account's.
    const accountCurrency = snapshot.company?.currency ?? DEFAULT_SETTINGS.currency;

    // ── clients ──────────────────────────────────────────────────────────────
    const insClient = db.prepare(`
      INSERT INTO clients (id, harvest_id, name, address, currency, is_active, source_json,
                           created_at, updated_at, archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, address = excluded.address, currency = excluded.currency,
        is_active = excluded.is_active, source_json = excluded.source_json,
        updated_at = excluded.updated_at, archived_at = excluded.archived_at
    `);
    for (const c of snapshot.clients) {
      insClient.run(
        c.id,
        c.id,
        c.name,
        c.address ?? null,
        c.currency ?? accountCurrency,
        bool(c.is_active),
        JSON.stringify(c),
        c.created_at,
        c.updated_at,
        c.is_active ? null : c.updated_at,
      );
    }
    const clients = idMap(db, 'clients');

    // ── tasks ────────────────────────────────────────────────────────────────
    const insTask = db.prepare(`
      INSERT INTO tasks (id, harvest_id, name, billable_by_default, default_hourly_rate,
                         is_default, is_active, source_json, created_at, updated_at,
                         archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, billable_by_default = excluded.billable_by_default,
        default_hourly_rate = excluded.default_hourly_rate,
        is_default = excluded.is_default, is_active = excluded.is_active,
        source_json = excluded.source_json, updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `);
    for (const t of snapshot.tasks) {
      insTask.run(
        t.id,
        t.id,
        t.name,
        bool(t.billable_by_default),
        toMinorUnits(t.default_hourly_rate),
        bool(t.is_default),
        bool(t.is_active),
        JSON.stringify(t),
        t.created_at,
        t.updated_at,
        t.is_active ? null : t.updated_at,
      );
    }
    const tasks = idMap(db, 'tasks');

    // ── projects ─────────────────────────────────────────────────────────────
    const insProject = db.prepare(`
      INSERT INTO projects (id, harvest_id, client_id, name, code, is_active, is_billable,
                            is_fixed_fee, bill_by, hourly_rate, budget_seconds, budget_amount,
                            budget_by, budget_is_monthly, fee, cost_budget,
                            cost_budget_include_expenses, notify_when_over_budget,
                            over_budget_notification_percentage, over_budget_notification_date,
                            show_budget_to_all, currency, notes,
                            starts_on, ends_on, source_json, created_at, updated_at,
                            archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        client_id = excluded.client_id, name = excluded.name, code = excluded.code,
        is_active = excluded.is_active, is_billable = excluded.is_billable,
        is_fixed_fee = excluded.is_fixed_fee, bill_by = excluded.bill_by,
        hourly_rate = excluded.hourly_rate, budget_seconds = excluded.budget_seconds,
        budget_amount = excluded.budget_amount,
        budget_by = excluded.budget_by, budget_is_monthly = excluded.budget_is_monthly,
        fee = excluded.fee, cost_budget = excluded.cost_budget,
        cost_budget_include_expenses = excluded.cost_budget_include_expenses,
        notify_when_over_budget = excluded.notify_when_over_budget,
        over_budget_notification_percentage = excluded.over_budget_notification_percentage,
        over_budget_notification_date = excluded.over_budget_notification_date,
        show_budget_to_all = excluded.show_budget_to_all,
        currency = excluded.currency, notes = excluded.notes,
        starts_on = excluded.starts_on, ends_on = excluded.ends_on,
        source_json = excluded.source_json, updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `);
    for (const p of snapshot.projects) {
      const clientId = clients.get(p.client?.id ?? -1);
      if (!clientId) {
        bump('projects_without_client');
        continue;
      }
      insProject.run(
        p.id,
        p.id,
        clientId,
        p.name,
        p.code || null,
        bool(p.is_active),
        bool(p.is_billable),
        bool(p.is_fixed_fee),
        p.bill_by ?? null,
        toMinorUnits(p.hourly_rate),
        // `budget` is hours or money depending on `budget_by`; see migration 003.
        HOURS_BUDGETS.has(p.budget_by ?? '') && p.budget != null ? hoursToSeconds(p.budget) : null,
        MONEY_BUDGETS.has(p.budget_by ?? '') ? toMinorUnits(p.budget) : null,
        p.budget_by ?? null,
        bool(p.budget_is_monthly),
        toMinorUnits(p.fee),
        toMinorUnits(p.cost_budget),
        bool((p as { cost_budget_include_expenses?: boolean }).cost_budget_include_expenses),
        bool((p as { notify_when_over_budget?: boolean }).notify_when_over_budget),
        (p as { over_budget_notification_percentage?: number }).over_budget_notification_percentage ?? null,
        (p as { over_budget_notification_date?: string }).over_budget_notification_date ?? null,
        bool((p as { show_budget_to_all?: boolean }).show_budget_to_all),
        (p as { currency?: string }).currency ?? null,
        p.notes ?? null,
        p.starts_on ?? null,
        p.ends_on ?? null,
        JSON.stringify(p),
        p.created_at,
        p.updated_at,
        p.is_active ? null : p.updated_at,
      );
    }
    const projects = idMap(db, 'projects');

    // An assignment's budget unit is decided by its *project's* budget_by, so the modes have
    // to be to hand before the assignments are written. See migration 004.
    const budgetByFor = new Map(
      (db.prepare('SELECT id, budget_by FROM projects').all() as { id: number; budget_by: string | null }[])
        .map((p) => [p.id, p.budget_by]),
    );

    // ── assignments ──────────────────────────────────────────────────────────
    const insUA = db.prepare(`
      INSERT INTO user_assignments (id, harvest_id, project_id, user_id, is_active,
                                    is_project_manager, use_default_rates, hourly_rate,
                                    budget_seconds, budget_amount, source_json,
                                    created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        is_active = excluded.is_active,
        is_project_manager = excluded.is_project_manager,
        use_default_rates = excluded.use_default_rates,
        hourly_rate = excluded.hourly_rate, budget_seconds = excluded.budget_seconds,
        budget_amount = excluded.budget_amount,
        source_json = excluded.source_json, updated_at = excluded.updated_at
    `);
    /**
     * The pair is the real identity; Harvest's assignment id is not stable across a
     * remove-and-re-add. Both tables carry UNIQUE (project_id, user_id) / (project_id,
     * task_id), and the upserts above target ON CONFLICT(id) — so a person taken off a
     * project and put back gets a new assignment id, violates the *pair* constraint, and
     * rolls back a multi-minute import. Clearing the stale row first makes an ordinary
     * Harvest operation an ordinary import.
     */
    const dropStaleUA = db.prepare(
      'DELETE FROM user_assignments WHERE project_id = ? AND user_id = ? AND id <> ?',
    );

    for (const a of snapshot.user_assignments) {
      const projectId = projects.get(a.project?.id ?? -1);
      const userId = users.get(a.user?.id ?? -1);
      if (!projectId || !userId) {
        bump('user_assignments_unresolved');
        continue;
      }
      dropStaleUA.run(projectId, userId, a.id);
      insUA.run(
        a.id,
        a.id,
        projectId,
        userId,
        bool(a.is_active),
        bool(a.is_project_manager),
        bool(a.use_default_rates),
        toMinorUnits(a.hourly_rate),
        // Unit follows the project's budget_by, exactly as on the project itself. See 004.
        ...assignmentBudget(budgetByFor.get(projectId), 'person', a.budget),
        JSON.stringify(a),
        a.created_at,
        a.updated_at,
      );
    }

    const insTA = db.prepare(`
      INSERT INTO task_assignments (id, harvest_id, project_id, task_id, is_active, billable,
                                    hourly_rate, budget_seconds, budget_amount,
                                    source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        is_active = excluded.is_active, billable = excluded.billable,
        hourly_rate = excluded.hourly_rate, budget_seconds = excluded.budget_seconds,
        budget_amount = excluded.budget_amount,
        source_json = excluded.source_json, updated_at = excluded.updated_at
    `);
    // Same reasoning as user_assignments above.
    const dropStaleTA = db.prepare(
      'DELETE FROM task_assignments WHERE project_id = ? AND task_id = ? AND id <> ?',
    );

    for (const a of snapshot.task_assignments) {
      const projectId = projects.get(a.project?.id ?? -1);
      const taskId = tasks.get(a.task?.id ?? -1);
      if (!projectId || !taskId) {
        bump('task_assignments_unresolved');
        continue;
      }
      dropStaleTA.run(projectId, taskId, a.id);
      insTA.run(
        a.id,
        a.id,
        projectId,
        taskId,
        bool(a.is_active),
        bool(a.billable),
        toMinorUnits(a.hourly_rate),
        ...assignmentBudget(budgetByFor.get(projectId), 'task', a.budget),
        JSON.stringify(a),
        a.created_at,
        a.updated_at,
      );
    }

    // ── time entries ─────────────────────────────────────────────────────────
    const insEntry = db.prepare(`
      INSERT INTO time_entries (id, harvest_id, spent_date, user_id, project_id, task_id,
                                client_id, duration_seconds, rounded_seconds, source_hours,
                                notes, billable, budgeted, billable_rate, cost_rate,
                                is_billed, invoice_id, is_locked, locked_reason,
                                is_explicitly_locked, approval_status, is_running,
                                timer_started_at, started_time, ended_time,
                                external_ref_json, source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        spent_date = excluded.spent_date, user_id = excluded.user_id,
        project_id = excluded.project_id, task_id = excluded.task_id,
        client_id = excluded.client_id, duration_seconds = excluded.duration_seconds,
        rounded_seconds = excluded.rounded_seconds, source_hours = excluded.source_hours,
        notes = excluded.notes, billable = excluded.billable, budgeted = excluded.budgeted,
        billable_rate = excluded.billable_rate, cost_rate = excluded.cost_rate,
        is_billed = excluded.is_billed, invoice_id = excluded.invoice_id,
        is_locked = excluded.is_locked, locked_reason = excluded.locked_reason,
        is_explicitly_locked = excluded.is_explicitly_locked,
        approval_status = excluded.approval_status, is_running = excluded.is_running,
        timer_started_at = excluded.timer_started_at, started_time = excluded.started_time,
        ended_time = excluded.ended_time, external_ref_json = excluded.external_ref_json,
        source_json = excluded.source_json, updated_at = excluded.updated_at
    `);

    for (const e of snapshot.time_entries) {
      const userId = users.get(e.user?.id ?? -1);
      const projectId = projects.get(e.project?.id ?? -1);
      const taskId = tasks.get(e.task?.id ?? -1);
      if (!userId || !projectId || !taskId) {
        bump('time_entries_unresolved');
        continue;
      }
      insEntry.run(
        e.id,
        e.id,
        e.spent_date,
        userId,
        projectId,
        taskId,
        clients.get(e.client?.id ?? -1) ?? null,
        hoursToSeconds(e.hours),
        hoursToSeconds(e.rounded_hours ?? e.hours),
        e.hours ?? 0,
        e.notes ?? null,
        bool(e.billable),
        bool(e.budgeted),
        toMinorUnits(e.billable_rate),
        toMinorUnits(e.cost_rate),
        bool(e.is_billed),
        e.invoice?.id ?? null,
        bool(e.is_locked),
        e.locked_reason ?? null,
        bool((e as { is_explicitly_locked?: boolean }).is_explicitly_locked),
        e.approval_status ?? 'unsubmitted',
        bool(e.is_running),
        e.timer_started_at ?? null,
        e.started_time ?? null,
        e.ended_time ?? null,
        e.external_reference ? JSON.stringify(e.external_reference) : null,
        JSON.stringify(e),
        e.created_at,
        e.updated_at,
      );
    }

    // ── invoices ─────────────────────────────────────────────────────────────
    // History only: read from Harvest, shown here, never issued here. Absent from the snapshot means not fetched, and the tables are left as
    // they are — an old dump must not look like an account with no invoices.
    if (snapshot.invoices) importInvoices(db, snapshot, users, clients, projects, bump);

    importRest(db, snapshot, { users, clients, projects }, bump, options.receiptDir);

    parkSequences(db);

    return reconcile(db, snapshot, skipped, options.partial === true);
  });
}

/**
 * Where rows made in this app get their ids from, once Harvest rows share the table.
 *
 * Imported rows carry Harvest's ids, which are global across every Harvest account and still
 * climbing; a local row at max+1 would sit in the range Harvest is handing out right now,
 * and a sync could bring back a record wearing the same id. Local rows therefore start at
 * 10^12, which no Harvest id will reach for centuries — see migration 006. The sequence is
 * only ever raised, never lowered, so a table already counting above it is left alone.
 */
function parkSequences(db: Db): void {
  const tables = [
    'users', 'clients', 'tasks', 'projects', 'user_assignments', 'task_assignments',
    'time_entries', 'invoices', 'invoice_line_items', 'invoice_payments',
    'contacts', 'roles', 'expense_categories', 'expenses', 'estimates', 'estimate_line_items',
    'invoice_messages', 'estimate_messages', 'invoice_item_categories',
    'estimate_item_categories', 'user_billable_rates', 'user_cost_rates',
  ];
  // CAST, because a JavaScript number this size binds as a REAL, and AUTOINCREMENT reads the
  // sequence as an integer — a REAL there is ignored, and the next local row lands at 1. The
  // second condition repairs a row an earlier build left as a REAL: it is not below the base,
  // so raising alone would step over it.
  const raise = db.prepare(
    `UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER)
      WHERE name = ? AND (seq < ? OR typeof(seq) <> 'integer')`,
  );
  const create = db.prepare(
    `INSERT INTO sqlite_sequence (name, seq) SELECT ?, CAST(? AS INTEGER)
      WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)`,
  );
  for (const table of tables) {
    raise.run(LOCAL_BASE, table, LOCAL_BASE);
    create.run(table, LOCAL_BASE, table);
  }
}

/** Oldest first: issue date, then the number as a number where it is one, then Harvest's id. */
function byIssueOrder(a: HarvestInvoice, b: HarvestInvoice): number {
  if (a.issue_date !== b.issue_date) return a.issue_date < b.issue_date ? -1 : 1;
  const na = Number(a.number);
  const nb = Number(b.number);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (a.number !== b.number) return a.number < b.number ? -1 : 1;
  return a.id - b.id;
}

function importInvoices(
  db: Db,
  snapshot: HarvestSnapshot,
  users: IdMap,
  clients: IdMap,
  projects: IdMap,
  bump: (key: string) => void,
): void {
  const insInvoice = db.prepare(`
    INSERT INTO invoices (id, harvest_id, client_id, number, state, subject, purchase_order, notes,
                          currency, amount, due_amount, tax_rate, tax_amount, tax2_rate,
                          tax2_amount, discount_rate, discount_amount, period_start, period_end,
                          issue_date, due_date, payment_term, sent_at, paid_at, paid_date,
                          closed_at, creator_user_id, creator_name, estimate_harvest_id,
                          retainer_harvest_id, recurring_invoice_harvest_id, client_key,
                          source_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      client_id = excluded.client_id, number = excluded.number, state = excluded.state,
      subject = excluded.subject, purchase_order = excluded.purchase_order,
      notes = excluded.notes, currency = excluded.currency, amount = excluded.amount,
      due_amount = excluded.due_amount, tax_rate = excluded.tax_rate,
      tax_amount = excluded.tax_amount, tax2_rate = excluded.tax2_rate,
      tax2_amount = excluded.tax2_amount, discount_rate = excluded.discount_rate,
      discount_amount = excluded.discount_amount, period_start = excluded.period_start,
      period_end = excluded.period_end, issue_date = excluded.issue_date,
      due_date = excluded.due_date, payment_term = excluded.payment_term,
      sent_at = excluded.sent_at, paid_at = excluded.paid_at, paid_date = excluded.paid_date,
      closed_at = excluded.closed_at, creator_user_id = excluded.creator_user_id,
      creator_name = excluded.creator_name, estimate_harvest_id = excluded.estimate_harvest_id,
      retainer_harvest_id = excluded.retainer_harvest_id,
      recurring_invoice_harvest_id = excluded.recurring_invoice_harvest_id,
      client_key = excluded.client_key, source_json = excluded.source_json,
      updated_at = excluded.updated_at
  `);

  // Lines are replaced with their invoice rather than upserted one by one: a line deleted in
  // Harvest has no record to conflict with, so an upsert would leave it standing. Nothing
  // references a line by its local id, so the churn costs nothing.
  const clearLines = db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?');
  const insLine = db.prepare(`
    INSERT INTO invoice_line_items (id, harvest_id, invoice_id, project_id, position, kind,
                                    description, quantity, unit_price, amount, taxed, taxed2)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // Harvest lists newest first. Written oldest first instead, so that on a fresh instance the
  // row ids climb with the invoice numbers rather than against them — the order anyone
  // reading the table, or a backup of it, expects. A re-import keeps existing ids either way.
  const invoices = [...(snapshot.invoices ?? [])].sort(byIssueOrder);

  for (const inv of invoices) {
    const clientId = clients.get(inv.client?.id ?? -1);
    if (!clientId) {
      bump('invoices_without_client');
      continue;
    }
    insInvoice.run(
      inv.id,
      inv.id,
      clientId,
      inv.number,
      inv.state,
      inv.subject || null,
      inv.purchase_order || null,
      inv.notes || null,
      inv.currency,
      toMinorUnits(inv.amount) ?? 0,
      toMinorUnits(inv.due_amount) ?? 0,
      inv.tax ?? null,
      toMinorUnits(inv.tax_amount) ?? 0,
      inv.tax2 ?? null,
      toMinorUnits(inv.tax2_amount) ?? 0,
      inv.discount ?? null,
      toMinorUnits(inv.discount_amount) ?? 0,
      inv.period_start ?? null,
      inv.period_end ?? null,
      inv.issue_date,
      inv.due_date ?? null,
      inv.payment_term ?? null,
      inv.sent_at ?? null,
      inv.paid_at ?? null,
      inv.paid_date ?? null,
      inv.closed_at ?? null,
      users.get(inv.creator?.id ?? -1) ?? null,
      inv.creator?.name ?? null,
      inv.estimate?.id ?? null,
      inv.retainer?.id ?? null,
      inv.recurring_invoice_id ?? null,
      inv.client_key ?? null,
      JSON.stringify(inv),
      inv.created_at,
      inv.updated_at,
    );
  }
  const invoiceIds = idMap(db, 'invoices');

  for (const inv of invoices) {
    const invoiceId = invoiceIds.get(inv.id);
    if (!invoiceId) continue; // skipped above
    clearLines.run(invoiceId);
    (inv.line_items ?? []).forEach((line, position) => {
      const projectId = line.project ? projects.get(line.project.id) ?? null : null;
      if (line.project && !projectId) bump('invoice_lines_without_project');
      insLine.run(
        line.id,
        line.id,
        invoiceId,
        projectId,
        position,
        line.kind,
        line.description || null,
        line.quantity ?? 0,
        toMinorUnits(line.unit_price) ?? 0,
        toMinorUnits(line.amount) ?? 0,
        bool(line.taxed),
        bool(line.taxed2),
      );
    });
  }

  // ── payments ─────────────────────────────────────────────────────────────
  // Only for invoices in this snapshot, and only when payments were fetched at all. For
  // each such invoice the fetched set is the truth: a payment stored here that Harvest no
  // longer has was deleted there, and the fetcher asked for every invoice that has any
  // (see invoices.ts), so an invoice with none in the snapshot has none.
  if (!snapshot.invoice_payments) return;

  const byInvoice = new Map<number, HarvestInvoicePayment[]>();
  for (const payment of snapshot.invoice_payments) {
    const list = byInvoice.get(payment.invoice.id) ?? [];
    list.push(payment);
    byInvoice.set(payment.invoice.id, list);
  }

  // The scope table has to exist before the statement below is compiled against it.
  scopeToSnapshot(db, snapshot.invoice_payments, 'payment_scope');

  const clearPayments = db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?');
  const insPayment = db.prepare(`
    INSERT INTO invoice_payments (id, harvest_id, invoice_id, amount, paid_at, paid_date,
                                  recorded_by, recorded_by_email, notes, transaction_reference,
                                  payment_gateway, source_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      invoice_id = excluded.invoice_id, amount = excluded.amount, paid_at = excluded.paid_at,
      paid_date = excluded.paid_date, recorded_by = excluded.recorded_by,
      recorded_by_email = excluded.recorded_by_email, notes = excluded.notes,
      transaction_reference = excluded.transaction_reference,
      payment_gateway = excluded.payment_gateway, source_json = excluded.source_json,
      updated_at = excluded.updated_at
  `);
  const stalePayments = db.prepare(
    `DELETE FROM invoice_payments WHERE invoice_id = ?
        AND harvest_id NOT IN (SELECT harvest_id FROM temp.payment_scope)`,
  );

  for (const inv of invoices) {
    const invoiceId = invoiceIds.get(inv.id);
    if (!invoiceId) continue;
    const payments = byInvoice.get(inv.id);
    if (!payments) {
      clearPayments.run(invoiceId);
      continue;
    }
    stalePayments.run(invoiceId);
    for (const payment of payments) {
      insPayment.run(
        payment.id,
        payment.id,
        invoiceId,
        toMinorUnits(payment.amount) ?? 0,
        payment.paid_at ?? null,
        payment.paid_date ?? null,
        payment.recorded_by || null,
        payment.recorded_by_email || null,
        payment.notes || null,
        payment.transaction_reference || null,
        payment.payment_gateway?.name ?? null,
        JSON.stringify(payment),
        payment.created_at,
        payment.updated_at,
      );
    }
  }
}

/**
 * The rest of the account — contacts, roles, expenses, estimates, messages, categories,
 * rates, teammates (migration 007). Each block runs only when its key is in the snapshot.
 */
function importRest(
  db: Db,
  snapshot: HarvestSnapshot,
  ids: { users: IdMap; clients: IdMap; projects: IdMap },
  bump: (key: string) => void,
  receiptDir: string | undefined,
): void {
  const { users, clients, projects } = ids;

  // ── contacts ─────────────────────────────────────────────────────────────
  if (snapshot.contacts) {
    const ins = db.prepare(`
      INSERT INTO contacts (id, harvest_id, client_id, title, first_name, last_name, email,
                            phone_office, phone_mobile, fax, invoice_recipient_status,
                            source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        client_id = excluded.client_id, title = excluded.title,
        first_name = excluded.first_name, last_name = excluded.last_name,
        email = excluded.email, phone_office = excluded.phone_office,
        phone_mobile = excluded.phone_mobile, fax = excluded.fax,
        invoice_recipient_status = excluded.invoice_recipient_status,
        source_json = excluded.source_json, updated_at = excluded.updated_at
    `);
    for (const c of snapshot.contacts) {
      const clientId = clients.get(c.client?.id ?? -1);
      if (!clientId) {
        bump('contacts_without_client');
        continue;
      }
      ins.run(
        c.id, c.id, clientId, c.title || null, c.first_name ?? '', c.last_name ?? '',
        c.email || null, c.phone_office || null, c.phone_mobile || null, c.fax || null,
        c.invoice_recipient_status ?? 'none', JSON.stringify(c), c.created_at, c.updated_at,
      );
    }
  }

  // ── roles (Harvest's teams) ──────────────────────────────────────────────
  // Membership is replaced with the role: a person taken off a team has no record to
  // conflict with, so an upsert would leave them on it.
  if (snapshot.roles) {
    const ins = db.prepare(`
      INSERT INTO roles (id, harvest_id, name, source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, source_json = excluded.source_json, updated_at = excluded.updated_at
    `);
    const clear = db.prepare('DELETE FROM role_members WHERE role_id = ?');
    const member = db.prepare('INSERT OR IGNORE INTO role_members (role_id, user_id) VALUES (?, ?)');
    for (const r of snapshot.roles) {
      ins.run(r.id, r.id, r.name, JSON.stringify(r), r.created_at, r.updated_at);
      clear.run(r.id);
      for (const userId of r.user_ids ?? []) {
        const localId = users.get(userId);
        if (!localId) {
          bump('role_members_without_user');
          continue;
        }
        member.run(r.id, localId);
      }
    }
  }

  // ── expense categories, then expenses ────────────────────────────────────
  if (snapshot.expense_categories) {
    const ins = db.prepare(`
      INSERT INTO expense_categories (id, harvest_id, name, unit_name, unit_price, is_active,
                                      source_json, created_at, updated_at, archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, unit_name = excluded.unit_name, unit_price = excluded.unit_price,
        is_active = excluded.is_active, source_json = excluded.source_json,
        updated_at = excluded.updated_at, archived_at = excluded.archived_at
    `);
    for (const c of snapshot.expense_categories) {
      ins.run(
        c.id, c.id, c.name, c.unit_name || null, toMinorUnits(c.unit_price), bool(c.is_active),
        JSON.stringify(c), c.created_at, c.updated_at, c.is_active ? null : c.updated_at,
      );
    }
  }

  if (snapshot.expenses) {
    const categories = idMap(db, 'expense_categories');
    const ins = db.prepare(`
      INSERT INTO expenses (id, harvest_id, spent_date, user_id, project_id, client_id,
                            expense_category_id, notes, units, total_cost, billable,
                            reimbursement, approval_status, is_closed, is_locked,
                            is_explicitly_locked, locked_reason, is_billed, invoice_id,
                            receipt_file_name, receipt_file_size, receipt_content_type,
                            receipt_url, receipt_path, source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        spent_date = excluded.spent_date, user_id = excluded.user_id,
        project_id = excluded.project_id, client_id = excluded.client_id,
        expense_category_id = excluded.expense_category_id, notes = excluded.notes,
        units = excluded.units, total_cost = excluded.total_cost, billable = excluded.billable,
        reimbursement = excluded.reimbursement, approval_status = excluded.approval_status,
        is_closed = excluded.is_closed, is_locked = excluded.is_locked,
        is_explicitly_locked = excluded.is_explicitly_locked,
        locked_reason = excluded.locked_reason, is_billed = excluded.is_billed,
        invoice_id = excluded.invoice_id, receipt_file_name = excluded.receipt_file_name,
        receipt_file_size = excluded.receipt_file_size,
        receipt_content_type = excluded.receipt_content_type,
        receipt_url = excluded.receipt_url,
        -- A file already kept is not forgotten because this snapshot did not carry one.
        receipt_path = COALESCE(excluded.receipt_path, expenses.receipt_path),
        source_json = excluded.source_json, updated_at = excluded.updated_at
    `);
    for (const e of snapshot.expenses) {
      const userId = users.get(e.user?.id ?? -1);
      const projectId = projects.get(e.project?.id ?? -1);
      if (!userId || !projectId) {
        bump('expenses_unresolved');
        continue;
      }
      ins.run(
        e.id, e.id, e.spent_date, userId, projectId,
        clients.get(e.client?.id ?? -1) ?? null,
        categories.get(e.expense_category?.id ?? -1) ?? null,
        e.notes || null, e.units ?? 1, toMinorUnits(e.total_cost) ?? 0, bool(e.billable),
        bool(e.reimbursement), e.approval_status ?? 'unsubmitted', bool(e.is_closed),
        bool(e.is_locked), bool(e.is_explicitly_locked), e.locked_reason ?? null,
        bool(e.is_billed), e.invoice?.id ?? null,
        e.receipt?.file_name ?? null, e.receipt?.file_size ?? null,
        e.receipt?.content_type ?? null, e.receipt?.url ?? null,
        keepReceipt(e, receiptDir),
        JSON.stringify(e), e.created_at, e.updated_at,
      );
    }
  }

  // ── estimates, lines, messages ───────────────────────────────────────────
  const estimateIds = new Map<number, number>();
  if (snapshot.estimates) {
    const ins = db.prepare(`
      INSERT INTO estimates (id, harvest_id, client_id, number, state, subject, purchase_order,
                             notes, currency, amount, tax_rate, tax_amount, tax2_rate,
                             tax2_amount, discount_rate, discount_amount, issue_date, sent_at,
                             accepted_at, declined_at, creator_user_id, creator_name,
                             client_key, source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        client_id = excluded.client_id, number = excluded.number, state = excluded.state,
        subject = excluded.subject, purchase_order = excluded.purchase_order,
        notes = excluded.notes, currency = excluded.currency, amount = excluded.amount,
        tax_rate = excluded.tax_rate, tax_amount = excluded.tax_amount,
        tax2_rate = excluded.tax2_rate, tax2_amount = excluded.tax2_amount,
        discount_rate = excluded.discount_rate, discount_amount = excluded.discount_amount,
        issue_date = excluded.issue_date, sent_at = excluded.sent_at,
        accepted_at = excluded.accepted_at, declined_at = excluded.declined_at,
        creator_user_id = excluded.creator_user_id, creator_name = excluded.creator_name,
        client_key = excluded.client_key, source_json = excluded.source_json,
        updated_at = excluded.updated_at
    `);
    const clearLines = db.prepare('DELETE FROM estimate_line_items WHERE estimate_id = ?');
    const insLine = db.prepare(`
      INSERT INTO estimate_line_items (id, harvest_id, estimate_id, position, kind, description,
                                       quantity, unit_price, amount, taxed, taxed2)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const est of [...snapshot.estimates].sort((a, b) => (a.issue_date < b.issue_date ? -1 : a.issue_date > b.issue_date ? 1 : a.id - b.id))) {
      const clientId = clients.get(est.client?.id ?? -1);
      if (!clientId) {
        bump('estimates_without_client');
        continue;
      }
      ins.run(
        est.id, est.id, clientId, est.number, est.state, est.subject || null,
        est.purchase_order || null, est.notes || null, est.currency,
        toMinorUnits(est.amount) ?? 0, est.tax ?? null, toMinorUnits(est.tax_amount) ?? 0,
        est.tax2 ?? null, toMinorUnits(est.tax2_amount) ?? 0, est.discount ?? null,
        toMinorUnits(est.discount_amount) ?? 0, est.issue_date, est.sent_at ?? null,
        est.accepted_at ?? null, est.declined_at ?? null,
        users.get(est.creator?.id ?? -1) ?? null, est.creator?.name ?? null,
        est.client_key ?? null, JSON.stringify(est), est.created_at, est.updated_at,
      );
      estimateIds.set(est.id, est.id);
      clearLines.run(est.id);
      (est.line_items ?? []).forEach((line, position) => {
        insLine.run(
          line.id, line.id, est.id, position, line.kind, line.description || null,
          line.quantity ?? 0, toMinorUnits(line.unit_price) ?? 0, toMinorUnits(line.amount) ?? 0,
          bool(line.taxed), bool(line.taxed2),
        );
      });
    }
  }

  if (snapshot.estimate_messages) {
    const ins = db.prepare(`
      INSERT INTO estimate_messages (id, harvest_id, estimate_id, event_type, sent_by,
                                     sent_by_email, sent_from, sent_from_email, recipients_json,
                                     subject, body, send_me_a_copy, source_json, created_at,
                                     updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        event_type = excluded.event_type, sent_by = excluded.sent_by,
        sent_by_email = excluded.sent_by_email, sent_from = excluded.sent_from,
        sent_from_email = excluded.sent_from_email, recipients_json = excluded.recipients_json,
        subject = excluded.subject, body = excluded.body,
        send_me_a_copy = excluded.send_me_a_copy, source_json = excluded.source_json,
        updated_at = excluded.updated_at
    `);
    const known = idMap(db, 'estimates');
    for (const m of snapshot.estimate_messages) {
      if (!known.has(m.estimate.id)) {
        bump('estimate_messages_without_estimate');
        continue;
      }
      ins.run(
        m.id, m.id, m.estimate.id, m.event_type ?? null, m.sent_by || null,
        m.sent_by_email || null, m.sent_from || null, m.sent_from_email || null,
        JSON.stringify(m.recipients ?? []), m.subject || null, m.body || null,
        bool(m.send_me_a_copy), JSON.stringify(m), m.created_at, m.updated_at,
      );
    }
  }

  if (snapshot.invoice_messages) {
    const ins = db.prepare(`
      INSERT INTO invoice_messages (id, harvest_id, invoice_id, event_type, sent_by, sent_by_email,
                                    sent_from, sent_from_email, recipients_json, subject, body,
                                    include_link_to_client_invoice, attach_pdf, send_me_a_copy,
                                    thank_you, reminder, send_reminder_on, source_json,
                                    created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        event_type = excluded.event_type, sent_by = excluded.sent_by,
        sent_by_email = excluded.sent_by_email, sent_from = excluded.sent_from,
        sent_from_email = excluded.sent_from_email, recipients_json = excluded.recipients_json,
        subject = excluded.subject, body = excluded.body,
        include_link_to_client_invoice = excluded.include_link_to_client_invoice,
        attach_pdf = excluded.attach_pdf, send_me_a_copy = excluded.send_me_a_copy,
        thank_you = excluded.thank_you, reminder = excluded.reminder,
        send_reminder_on = excluded.send_reminder_on, source_json = excluded.source_json,
        updated_at = excluded.updated_at
    `);
    const known = idMap(db, 'invoices');
    for (const m of snapshot.invoice_messages) {
      if (!known.has(m.invoice.id)) {
        bump('invoice_messages_without_invoice');
        continue;
      }
      ins.run(
        m.id, m.id, m.invoice.id, m.event_type ?? null, m.sent_by || null,
        m.sent_by_email || null, m.sent_from || null, m.sent_from_email || null,
        JSON.stringify(m.recipients ?? []), m.subject || null, m.body || null,
        bool(m.include_link_to_client_invoice), bool(m.attach_pdf), bool(m.send_me_a_copy),
        bool(m.thank_you), bool(m.reminder), m.send_reminder_on ?? null,
        JSON.stringify(m), m.created_at, m.updated_at,
      );
    }
  }

  // ── the two item-category lists ──────────────────────────────────────────
  if (snapshot.invoice_item_categories) {
    const ins = db.prepare(`
      INSERT INTO invoice_item_categories (id, harvest_id, name, use_as_service, use_as_expense,
                                           source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, use_as_service = excluded.use_as_service,
        use_as_expense = excluded.use_as_expense, source_json = excluded.source_json,
        updated_at = excluded.updated_at
    `);
    for (const c of snapshot.invoice_item_categories) {
      ins.run(c.id, c.id, c.name, bool(c.use_as_service), bool(c.use_as_expense),
        JSON.stringify(c), c.created_at, c.updated_at);
    }
  }
  if (snapshot.estimate_item_categories) {
    const ins = db.prepare(`
      INSERT INTO estimate_item_categories (id, harvest_id, name, source_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, source_json = excluded.source_json, updated_at = excluded.updated_at
    `);
    for (const c of snapshot.estimate_item_categories) {
      ins.run(c.id, c.id, c.name, JSON.stringify(c), c.created_at, c.updated_at);
    }
  }

  // ── rate history ─────────────────────────────────────────────────────────
  // Replaced per person: the fetcher asked for the whole history of everyone it hands in,
  // so for those people the fetched set is the truth, deletions included.
  for (const [key, table] of [
    ['user_billable_rates', 'user_billable_rates'],
    ['user_cost_rates', 'user_cost_rates'],
  ] as const) {
    const rates = snapshot[key];
    if (!rates) continue;
    const ins = db.prepare(`
      INSERT INTO ${table} (id, harvest_id, user_id, amount, start_date, end_date, source_json,
                            created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id, amount = excluded.amount, start_date = excluded.start_date,
        end_date = excluded.end_date, source_json = excluded.source_json,
        updated_at = excluded.updated_at
    `);
    const clear = db.prepare(`DELETE FROM ${table} WHERE user_id = ?`);
    const byUser = new Map<number, HarvestUserRate[]>();
    for (const r of rates) byUser.set(r.user.id, [...(byUser.get(r.user.id) ?? []), r]);
    // Every person the fetcher visited, including those with no rates left.
    for (const userId of new Set([...byUser.keys(), ...snapshot.users.map((u) => u.id)])) {
      const localId = users.get(userId);
      if (!localId) continue;
      clear.run(localId);
      for (const r of byUser.get(userId) ?? []) {
        ins.run(r.id, r.id, localId, toMinorUnits(r.amount) ?? 0, r.start_date ?? null,
          r.end_date ?? null, JSON.stringify(r), r.created_at, r.updated_at);
      }
    }
  }

  // ── teammates ────────────────────────────────────────────────────────────
  if (snapshot.teammates) {
    const clear = db.prepare('DELETE FROM user_teammates WHERE manager_user_id = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO user_teammates (manager_user_id, user_id) VALUES (?, ?)');
    for (const t of snapshot.teammates) {
      const managerId = users.get(t.manager_id);
      if (!managerId) continue;
      clear.run(managerId);
      for (const userId of t.user_ids) {
        const localId = users.get(userId);
        if (localId) ins.run(managerId, localId);
      }
    }
  }
}

/**
 * Put an expense's downloaded receipt in the instance's receipt folder, and say what it is
 * called there. Null when there is no file to keep, or nowhere to keep it.
 */
function keepReceipt(expense: HarvestExpense, receiptDir: string | undefined): string | null {
  const name = receiptFileName(expense);
  if (!name || !receiptDir || !expense.receipt_file || !existsSync(expense.receipt_file)) {
    return null;
  }
  mkdirSync(receiptDir, { recursive: true });
  const target = join(receiptDir, name);
  if (resolve(expense.receipt_file) !== resolve(target)) copyFileSync(expense.receipt_file, target);
  return basename(target);
}

/**
 * Compare what we stored against what Harvest sent.
 *
 * This is the number an operator can check against Harvest's own report — it turns
 * "we think it worked" into evidence.
 */
function reconcile(
  db: Db,
  snapshot: HarvestSnapshot,
  skipped: Record<string, number>,
  partial: boolean,
): ImportReport {
  const sourceHours = snapshot.time_entries.reduce((total, e) => total + (e.hours || 0), 0);

  // A full snapshot is the whole account, so the whole table is the right comparison. A
  // partial one is a delta, and comparing a day's entries against years of history would
  // report an enormous difference and call a healthy sync broken. So a partial run
  // reconciles only over the rows it actually carried.
  const scope = partial ? scopeToSnapshot(db, snapshot.time_entries, 'sync_scope') : null;
  const where = scope === null ? '' : ` WHERE harvest_id IN (SELECT harvest_id FROM ${scope})`;

  const storedSeconds = (
    db.prepare(`SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM time_entries${where}`).get() as {
      s: number;
    }
  ).s;
  const importedHours = secondsToHours(storedSeconds);

  const perYearSource = new Map<string, number>();
  for (const e of snapshot.time_entries) {
    const year = e.spent_date.slice(0, 4);
    perYearSource.set(year, (perYearSource.get(year) ?? 0) + (e.hours || 0));
  }

  const perYearStored = new Map(
    (
      db
        .prepare(
          `SELECT substr(spent_date, 1, 4) AS year, SUM(duration_seconds) AS s
             FROM time_entries${where} GROUP BY year`,
        )
        .all() as { year: string; s: number }[]
    ).map((r) => [r.year, secondsToHours(r.s)]),
  );

  const perYear: ImportReport['reconciliation']['per_year'] = {};
  for (const year of [...new Set([...perYearSource.keys(), ...perYearStored.keys()])].sort()) {
    const source = Number((perYearSource.get(year) ?? 0).toFixed(2));
    const imported = Number((perYearStored.get(year) ?? 0).toFixed(2));
    perYear[year] = { source, imported, delta: Number((imported - source).toFixed(2)) };
  }

  const dates = db.prepare('SELECT MIN(spent_date) a, MAX(spent_date) b FROM time_entries').get() as {
    a: string | null;
    b: string | null;
  };

  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  const difference = Number((importedHours - sourceHours).toFixed(2));

  // Invoices get the same treatment as hours: Harvest's total against ours, over the whole
  // table for a full run and over the snapshot's own invoices for a partial one. Money is
  // integer minor units on both sides of the comparison, so the tolerance is zero.
  let invoices: ImportReport['invoices'] = null;
  if (snapshot.invoices) {
    const sourceMinor = snapshot.invoices.reduce(
      (total, inv) => total + (toMinorUnits(inv.amount) ?? 0),
      0,
    );
    const invoiceScope = partial ? scopeToSnapshot(db, snapshot.invoices, 'invoice_scope') : null;
    const invoiceWhere =
      invoiceScope === null ? '' : ` WHERE harvest_id IN (SELECT harvest_id FROM ${invoiceScope})`;
    const storedMinor = (
      db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM invoices${invoiceWhere}`).get() as {
        s: number;
      }
    ).s;
    invoices = {
      source_amount: sourceMinor / 100,
      imported_amount: storedMinor / 100,
      difference: (storedMinor - sourceMinor) / 100,
      matches: storedMinor === sourceMinor,
    };
  }

  return {
    counts: {
      users: count('users'),
      clients: count('clients'),
      tasks: count('tasks'),
      projects: count('projects'),
      user_assignments: count('user_assignments'),
      task_assignments: count('task_assignments'),
      time_entries: count('time_entries'),
      invoices: count('invoices'),
      invoice_line_items: count('invoice_line_items'),
      invoice_payments: count('invoice_payments'),
      invoice_messages: count('invoice_messages'),
      contacts: count('contacts'),
      roles: count('roles'),
      expense_categories: count('expense_categories'),
      expenses: count('expenses'),
      estimates: count('estimates'),
      estimate_line_items: count('estimate_line_items'),
      estimate_messages: count('estimate_messages'),
      user_billable_rates: count('user_billable_rates'),
      user_cost_rates: count('user_cost_rates'),
      user_teammates: count('user_teammates'),
    },
    invoices,
    skipped,
    reconciliation: {
      source_hours: Number(sourceHours.toFixed(2)),
      imported_hours: Number(importedHours.toFixed(2)),
      difference,
      // Sub-0.01h tolerance: seconds are integers, so a 139k-row sum can land a hair off.
      matches: Math.abs(difference) < 0.01,
      per_year: perYear,
    },
    first_date: dates.a,
    last_date: dates.b,
  };
}

/**
 * Record the run so incremental sync knows where to resume.
 *
 * `cursor` is a promise about the data, not about the clock: "everything Harvest had changed
 * up to this moment is now in the database". Only the code that fetched the data knows when
 * that moment was, so it must pass it — and a caller importing a file pulled yesterday must
 * pass yesterday, or the next incremental sync starts its window after changes nobody ever
 * fetched and they are lost in the gap. That is not hypothetical: it happened here, and it
 * cost a day of everyone's time entries.
 *
 * Pass `null` when the moment is unknowable, which parks the cursor rather than advancing it.
 */
export function recordRun(
  db: Db,
  source: string,
  report: ImportReport,
  cursor: string | null,
  startedAt: string = nowIso(),
): void {
  db.prepare(
    `INSERT INTO import_runs (source, started_at, finished_at, status, stats_json,
                              cursor_updated_since)
     VALUES (?,?,?,?,?,?)`,
  ).run(source, startedAt, nowIso(), reportOk(report) ? 'ok' : 'failed',
    JSON.stringify(report), cursor);
}
