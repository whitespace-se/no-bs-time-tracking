/**
 * Harvest's settings for an instance built from CSV exports.
 *
 * A time report carries the hours and the rates on them, but nothing about the projects,
 * clients, tasks and people beyond their names: not which projects are fixed fee, not their
 * budgets, fees or rates, not who is archived, not anybody's email. The importer has to make
 * all of that up, and a fixed-fee project taken for an hourly one moves the billable amount by
 * as much as it is worth. The full API import brings it, but on top of a CSV import it would
 * add every time entry a second time.
 *
 * This reads only Harvest's four lists — projects, clients, tasks and people, a few requests
 * — and writes their settings onto the rows the CSV import made, matched by name the way the
 * CSV import names them. Time entries are not touched, and neither are harvest_id or any id.
 */

import type { Db } from '../db/index.ts';
import { bool, hoursToSeconds, nowIso, toMinorUnits, transaction } from '../db/index.ts';
import { settingsFromCompany, writeSettings } from '../settings.ts';
import { HarvestClient } from './client.ts';
import { HOURS_BUDGETS, LOCK_REASON, MONEY_BUDGETS } from './constants.ts';
import { mapAccessRoles } from './roles.ts';
import type { Phase, SyncCredentials, SyncProgress } from './sync.ts';
import type {
  HarvestClientRecord,
  HarvestCompany,
  HarvestProject,
  HarvestTask,
  HarvestTaskAssignment,
  HarvestUser,
  HarvestUserAssignment,
} from './types.ts';

export interface HarvestSettings {
  company?: HarvestCompany;
  users: HarvestUser[];
  clients: HarvestClientRecord[];
  tasks: HarvestTask[];
  projects: HarvestProject[];
  user_assignments?: HarvestUserAssignment[];
  task_assignments?: HarvestTaskAssignment[];
}

export interface SettingsReport {
  projects: { matched: number; unmatched: number; fixedFee: number };
  clients: { matched: number; unmatched: number };
  tasks: { matched: number; unmatched: number };
  users: { matched: number; unmatched: number; emails: number };
  /** Local projects no Harvest project matched, so still on the CSV import's defaults. */
  unmatchedProjects: string[];
}

export async function fetchHarvestSettings(credentials: SyncCredentials, progress?: SyncProgress): Promise<HarvestSettings> {
  const client = new HarvestClient({ ...credentials, onRequest: () => { if (progress) progress.requests += 1; } });
  const collect = async <T>(path: string, resource: Phase & string): Promise<T[]> => {
    const out: T[] = [];
    if (progress) {
      progress.phase = resource;
      progress.counts[resource] = 0;
    }
    for await (const record of client.paginate<T>(path, resource)) {
      out.push(record);
      if (progress) progress.counts[resource] = out.length;
    }
    return out;
  };
  const company = await client.get<HarvestCompany>('/company');
  if (progress) progress.company = (company as { name?: string }).name ?? null;
  return {
    company,
    users: await collect<HarvestUser>('/users', 'users'),
    clients: await collect<HarvestClientRecord>('/clients', 'clients'),
    tasks: await collect<HarvestTask>('/tasks', 'tasks'),
    projects: await collect<HarvestProject>('/projects', 'projects'),
    user_assignments: await collect<HarvestUserAssignment>('/user_assignments', 'user_assignments'),
    task_assignments: await collect<HarvestTaskAssignment>('/task_assignments', 'task_assignments'),
  };
}

export function applyHarvestSettings(db: Db, settings: HarvestSettings): SettingsReport {
  return transaction(db, () => {
    const stamp = nowIso();
    const report: SettingsReport = {
      projects: { matched: 0, unmatched: 0, fixedFee: 0 },
      clients: { matched: 0, unmatched: 0 },
      tasks: { matched: 0, unmatched: 0 },
      users: { matched: 0, unmatched: 0, emails: 0 },
      unmatchedProjects: [],
    };

    // Rounding, week start, currency and the rest, as the API import takes them.
    if (settings.company) writeSettings(db, settingsFromCompany(settings.company as unknown as Record<string, unknown>));

    // Harvest id → local id, for the assignments at the end.
    const localProject = new Map<number, number>();
    const localTask = new Map<number, number>();
    const localUser = new Map<number, number>();
    const budgetBy = new Map<number, string | null>();

    // ── clients, by name ───────────────────────────────────────────────────────
    // SQLite's lower() folds A–Z only, so Å and Ä stay as they are. Names are therefore
    // compared with lower() on both sides in SQL, never against a JavaScript-lowered string.
    const clientNames = new Map<number, string>();
    const setClient = db.prepare(`
      UPDATE clients SET is_active = ?, currency = COALESCE(?, currency), address = COALESCE(?, address),
                         updated_at = ?
       WHERE lower(name) = lower(?)`);
    for (const c of settings.clients) {
      clientNames.set(c.id, c.name.trim());
      const changed = setClient.run(bool(c.is_active), c.currency ?? null, c.address ?? null, stamp, c.name.trim()).changes;
      changed ? (report.clients.matched += 1) : (report.clients.unmatched += 1);
    }

    // ── tasks, by name ─────────────────────────────────────────────────────────
    const setTask = db.prepare(`
      UPDATE tasks SET billable_by_default = ?, default_hourly_rate = ?, is_active = ?, updated_at = ?
       WHERE lower(name) = lower(?) RETURNING id`);
    for (const t of settings.tasks) {
      const row = setTask.get(bool(t.billable_by_default), toMinorUnits(t.default_hourly_rate),
        bool(t.is_active), stamp, t.name.trim()) as { id: number } | undefined;
      if (row) {
        localTask.set(t.id, row.id);
        report.tasks.matched += 1;
      } else {
        report.tasks.unmatched += 1;
      }
    }

    // ── projects, by client, name and code ─────────────────────────────────────
    // The CSV import keys a project on exactly these three, so they find the same row.
    const setProject = db.prepare(`
      UPDATE projects SET is_active = ?, is_billable = ?, is_fixed_fee = ?, bill_by = ?,
                          hourly_rate = ?, budget_seconds = ?, budget_amount = ?, budget_by = ?,
                          budget_is_monthly = ?, fee = ?, cost_budget = ?, notes = COALESCE(?, notes),
                          starts_on = ?, ends_on = ?, archived_at = ?, updated_at = ?
       WHERE id = (SELECT p.id FROM projects p JOIN clients c ON c.id = p.client_id
                    WHERE lower(c.name) = lower(?) AND lower(p.name) = lower(?) AND COALESCE(p.code, '') = ?
                    LIMIT 1)
      RETURNING id`);
    const seen = new Set<string>(); // local project ids a Harvest project matched
    for (const p of settings.projects) {
      const clientName = clientNames.get(p.client?.id ?? -1) ?? (p.client?.name ?? '').trim();
      const key = [clientName, p.name.trim(), p.code ?? ''];
      const row = setProject.get(
        bool(p.is_active), bool(p.is_billable), bool(p.is_fixed_fee), p.bill_by ?? null,
        toMinorUnits(p.hourly_rate),
        HOURS_BUDGETS.has(p.budget_by ?? '') && p.budget != null ? hoursToSeconds(p.budget) : null,
        MONEY_BUDGETS.has(p.budget_by ?? '') ? toMinorUnits(p.budget) : null,
        p.budget_by ?? null, bool(p.budget_is_monthly), toMinorUnits(p.fee), toMinorUnits(p.cost_budget),
        p.notes ?? null, p.starts_on ?? null, p.ends_on ?? null, p.is_active ? null : p.updated_at, stamp,
        ...key,
      ) as { id: number } | undefined;
      if (row) {
        localProject.set(p.id, row.id);
        budgetBy.set(row.id, p.budget_by ?? null);
        report.projects.matched += 1;
        if (p.is_fixed_fee) report.projects.fixedFee += 1;
        seen.add(row.id.toString());
      } else {
        report.projects.unmatched += 1;
      }
    }
    // Harvest locks the time on an archived project, as archiving here does (actions/admin.ts):
    // "Item Archived", or "Item Invoiced and Archived" where it was billed too. A CSV cannot
    // say which projects are archived, so the locks arrive with the settings. The same rules
    // release them on a project Harvest has active again.
    const archivedLock = db.prepare(`
      UPDATE time_entries SET is_locked = 1,
             locked_reason = CASE WHEN is_billed = 1 THEN ? ELSE ? END
       WHERE project_id = ? AND locked_reason IS NOT ?`);
    const downgradeLock = db.prepare(`UPDATE time_entries SET locked_reason = ? WHERE project_id = ? AND locked_reason = ?`);
    const releaseLock = db.prepare(`UPDATE time_entries SET is_locked = 0, locked_reason = NULL
                                     WHERE project_id = ? AND locked_reason = ? AND is_billed = 0`);
    for (const p of settings.projects) {
      const id = localProject.get(p.id);
      if (!id) continue;
      if (!p.is_active) {
        archivedLock.run(LOCK_REASON.invoicedAndArchived, LOCK_REASON.archived, id, LOCK_REASON.period);
      } else {
        downgradeLock.run(LOCK_REASON.invoiced, id, LOCK_REASON.invoicedAndArchived);
        releaseLock.run(id, LOCK_REASON.archived);
      }
    }

    for (const row of db.prepare(`SELECT p.id, c.name AS client, p.name, COALESCE(p.code, '') AS code
                                    FROM projects p JOIN clients c ON c.id = p.client_id`).all() as { id: number; client: string; name: string; code: string }[]) {
      if (!seen.has(row.id.toString())) {
        report.unmatchedProjects.push(`${row.client} / ${row.name}${row.code ? ` (${row.code})` : ''}`);
      }
    }

    // ── people, by first and last name ─────────────────────────────────────────
    // The time report names people but has no email, so the CSV import made placeholder
    // addresses. The real one replaces a placeholder only, and only while no other account
    // holds it. As in the API import, an administrator who can sign in here is never
    // demoted or deactivated by Harvest's view of them.
    const findUser = db.prepare(`SELECT id, email FROM users WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)`);
    const emailTaken = db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) AND id <> ?');
    const setUser = db.prepare(`
      UPDATE users SET
        role = CASE WHEN role = 'admin' THEN 'admin' ELSE ? END,
        access_roles = ?,
        is_active = CASE WHEN role = 'admin' AND password_hash IS NOT NULL THEN 1 ELSE ? END,
        archived_at = CASE WHEN role = 'admin' AND password_hash IS NOT NULL THEN NULL ELSE ? END,
        is_contractor = ?, weekly_capacity_seconds = ?, default_billable_rate = ?, cost_rate = ?,
        timezone = COALESCE(?, timezone), updated_at = ?
       WHERE id = ?`);
    const setEmail = db.prepare('UPDATE users SET email = ? WHERE id = ?');
    // One person can have two Harvest accounts under one name, typically after leaving and
    // coming back. The CSV import made them one local person, so that person takes the
    // account in use: the active one, else the one changed last.
    const byName = new Map<string, HarvestUser>();
    for (const u of settings.users) {
      const name = `${u.first_name ?? ''}\u0001${u.last_name ?? ''}`.toLowerCase();
      const held = byName.get(name);
      const better = !held || (u.is_active && !held.is_active)
        || (u.is_active === held.is_active && u.updated_at > held.updated_at);
      if (better) byName.set(name, u);
    }
    for (const u of byName.values()) {
      const matches = findUser.all((u.first_name ?? '').trim(), (u.last_name ?? '').trim()) as { id: number; email: string }[];
      // Two local people with one name cannot be told apart by name; leave them as they are.
      if (matches.length !== 1) {
        report.users.unmatched += 1;
        continue;
      }
      const local = matches[0]!;
      localUser.set(u.id, local.id);
      setUser.run(mapAccessRoles(u.access_roles).level, JSON.stringify(u.access_roles ?? u.roles ?? []),
        bool(u.is_active), u.is_active ? null : u.updated_at, bool(u.is_contractor),
        u.weekly_capacity ?? null, toMinorUnits(u.default_hourly_rate), toMinorUnits(u.cost_rate),
        u.timezone ?? null, stamp, local.id);
      report.users.matched += 1;
      if (u.email && local.email.endsWith('@invalid.local') && !emailTaken.get(u.email, local.id)) {
        setEmail.run(u.email, local.id);
        report.users.emails += 1;
      }
    }

    // ── assignments: who and what is on each project, at which rate ────────────
    // Where a project bills by task or by person, these are its rates; without them a new
    // entry on it gets no rate and counts for nothing in the billable amount.
    const putUA = db.prepare(`
      INSERT INTO user_assignments (project_id, user_id, is_active, is_project_manager, use_default_rates,
                                    hourly_rate, budget_seconds, budget_amount, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET is_active = excluded.is_active,
        is_project_manager = excluded.is_project_manager, use_default_rates = excluded.use_default_rates,
        hourly_rate = excluded.hourly_rate, budget_seconds = excluded.budget_seconds,
        budget_amount = excluded.budget_amount, updated_at = excluded.updated_at`);
    for (const a of settings.user_assignments ?? []) {
      const projectId = localProject.get(a.project?.id ?? -1);
      const userId = localUser.get(a.user?.id ?? -1);
      if (!projectId || !userId) continue;
      const budget = a.budget == null ? [null, null]
        : budgetBy.get(projectId) === 'person' ? [hoursToSeconds(a.budget), null] : [null, toMinorUnits(a.budget)];
      putUA.run(projectId, userId, bool(a.is_active), bool(a.is_project_manager), bool(a.use_default_rates),
        toMinorUnits(a.hourly_rate), ...budget, stamp, stamp);
    }
    const putTA = db.prepare(`
      INSERT INTO task_assignments (project_id, task_id, is_active, billable, hourly_rate,
                                    budget_seconds, budget_amount, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, task_id) DO UPDATE SET is_active = excluded.is_active,
        billable = excluded.billable, hourly_rate = excluded.hourly_rate,
        budget_seconds = excluded.budget_seconds, budget_amount = excluded.budget_amount,
        updated_at = excluded.updated_at`);
    for (const a of settings.task_assignments ?? []) {
      const projectId = localProject.get(a.project?.id ?? -1);
      const taskId = localTask.get(a.task?.id ?? -1);
      if (!projectId || !taskId) continue;
      const budget = a.budget == null ? [null, null]
        : budgetBy.get(projectId) === 'task' ? [hoursToSeconds(a.budget), null] : [null, toMinorUnits(a.budget)];
      putTA.run(projectId, taskId, bool(a.is_active), bool(a.billable), toMinorUnits(a.hourly_rate),
        ...budget, stamp, stamp);
    }

    db.prepare(
      `INSERT INTO import_runs (source, started_at, finished_at, status, stats_json)
       VALUES ('harvest-settings', ?, ?, 'ok', ?)`,
    ).run(stamp, nowIso(), JSON.stringify({ ...report, unmatchedProjects: report.unmatchedProjects.slice(0, 50) }));
    return report;
  });
}
