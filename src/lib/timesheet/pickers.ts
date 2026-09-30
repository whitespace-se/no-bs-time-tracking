/**
 * Project and task options for the entry pickers.
 *
 * Filtering strictly on `is_active` is wrong. Imported accounts routinely have projects marked
 * inactive that still carry time logged in the last 90 days — archived work people are still
 * finishing. Offering only active projects makes those unreachable, which reads as "options
 * are missing".
 *
 * So: every active project, plus any project this person has touched recently, with archived
 * ones marked. Ordered by how much they actually use it, which is how Harvest ranks its
 * pickers (`usage_count` / `last_used_at`).
 */

import type { Db } from '../db/index.ts';
import { rows } from '../db/index.ts';
import { addDays, todayIso } from '../format.ts';
import { readSettings } from '../settings.ts';

export interface ProjectOption {
  id: number;
  label: string;
  client_name: string;
  is_active: number;
  uses: number;
}

export interface TaskOption {
  id: number;
  name: string;
  uses: number;
}

export function projectOptions(db: Db, userId: number): ProjectOption[] {
  const since = addDays(todayIso(), -readSettings(db).recentProjectDays);
  return rows<ProjectOption>(
    db
      .prepare(
        `SELECT p.id,
                CASE WHEN p.code IS NULL THEN p.name
                     ELSE '[' || p.code || '] ' || p.name END AS label,
                c.name AS client_name,
                p.is_active,
                COUNT(te.id) AS uses
           FROM projects p
           JOIN clients c ON c.id = p.client_id
      LEFT JOIN time_entries te ON te.project_id = p.id AND te.user_id = ?
          WHERE p.is_active = 1
             OR EXISTS (
                  SELECT 1 FROM time_entries r
                   WHERE r.project_id = p.id AND r.user_id = ? AND r.spent_date >= ?
                )
       GROUP BY p.id
       ORDER BY p.is_active DESC, uses DESC, c.name, p.name`,
      )
      .all(userId, userId, since),
  );
}

export function taskOptions(db: Db, userId: number): TaskOption[] {
  return rows<TaskOption>(
    db
      .prepare(
        `SELECT t.id, t.name, COUNT(te.id) AS uses
           FROM tasks t
      LEFT JOIN time_entries te ON te.task_id = t.id AND te.user_id = ?
          WHERE t.is_active = 1
       GROUP BY t.id
       ORDER BY uses DESC, t.name`,
      )
      .all(userId),
  );
}

/**
 * Which tasks each project offers. Availability and billability both live on the
 * project↔task assignment, so a task list that ignores the project offers pairs that
 * do not exist.
 */
export function tasksByProject(db: Db): Record<number, number[]> {
  const links = rows<{ project_id: number; task_id: number }>(
    db
      .prepare(
        `SELECT ta.project_id, ta.task_id
           FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
          WHERE ta.is_active = 1 AND t.is_active = 1`,
      )
      .all(),
  );
  const map: Record<number, number[]> = {};
  for (const link of links) (map[link.project_id] ??= []).push(link.task_id);
  return map;
}
