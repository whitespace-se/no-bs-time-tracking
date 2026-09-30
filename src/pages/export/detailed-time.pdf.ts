import type { APIRoute } from 'astro';
import { db, rows } from '../../lib/db/index.ts';
import { readSettings } from '../../lib/settings.ts';
import { buildWhere, JOINS, readFilters, totals } from '../../lib/timesheet/report.ts';
import { detailedTimeReportPdf, type DetailedTimeReportRow } from '../../lib/pdf/detailed-time-report.ts';

const today = () => new Date().toISOString().slice(0, 10);

export const GET: APIRoute = async (context) => {
  const viewer = context.locals.user;
  if (!viewer) return new Response('Unauthorized', { status: 401 });

  const database = db();
  const settings = readSettings(database);
  const filters = readFilters(context.url, viewer, { from: today(), to: today() });
  if (filters.from > filters.to) return new Response('The start date must not be after the end date.', { status: 400 });
  const where = buildWhere(filters);
  const sums = totals(database, where);
  const uninvoicedRounded = database.prepare(
    `SELECT COALESCE(SUM(CASE WHEN te.billable = 1 AND te.is_billed = 0
                              THEN te.rounded_seconds ELSE 0 END), 0) AS seconds
       ${JOINS}
      WHERE ${where.clause}`,
  ).get(...where.args) as { seconds: number };

  const reportRows = rows<DetailedTimeReportRow>(database.prepare(
    `SELECT te.spent_date, c.name AS client, p.name AS project, p.code AS project_code,
            t.name AS task, te.notes, TRIM(u.first_name || ' ' || u.last_name) AS person,
            (SELECT GROUP_CONCAT(r.name, ', ')
               FROM role_members rm JOIN roles r ON r.id = rm.role_id
              WHERE rm.user_id = u.id) AS roles,
            te.rounded_seconds AS duration_seconds
       ${JOINS}
      WHERE ${where.clause}
   ORDER BY te.spent_date, c.name COLLATE NOCASE, p.name COLLATE NOCASE,
            t.name COLLATE NOCASE, u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE`,
  ).all(...where.args));

  const lookup = (table: 'clients' | 'projects' | 'tasks' | 'users', id: number | null, fallback: string) => {
    if (id === null) return fallback;
    const expression = table === 'users' ? "TRIM(first_name || ' ' || last_name)" : 'name';
    const found = database.prepare(`SELECT ${expression} AS name FROM ${table} WHERE id = ?`).get(id) as { name?: string } | undefined;
    return found?.name ?? fallback;
  };

  const clientName = lookup('clients', filters.clientId, 'All clients');
  const projectName = lookup('projects', filters.projectId, 'All projects');
  const taskName = lookup('tasks', filters.taskId, 'All tasks');
  const teamName = lookup('users', filters.userId, 'Everyone');

  const pdf = await detailedTimeReportPdf({
    companyName: settings.companyName,
    from: filters.from,
    to: filters.to,
    client: clientName,
    project: projectName,
    task: taskName,
    team: teamName,
    billable: filters.billable === null ? 'All entries' : filters.billable ? 'Billable' : 'Non-billable',
    rows: reportRows,
    totalSeconds: sums.rounded,
    uninvoicedSeconds: uninvoicedRounded.seconds,
    settings,
  });

  const scopes = [
    filters.clientId === null ? null : clientName,
    filters.projectId === null ? null : projectName,
    filters.taskId === null ? null : taskName,
    filters.userId === null ? null : teamName,
  ].filter((value): value is string => Boolean(value));
  const subject = scopes.length > 0 ? scopes.join(' - ') : settings.companyName || 'All time';
  const filename = `Detailed time report - ${subject} - ${filters.from} to ${filters.to}.pdf`;
  const asciiFilename = filename
    .replace(/\.pdf$/, '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\/:*?<>|]/g, '-')
    .slice(0, 176) + '.pdf';
  return new Response(Uint8Array.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
    },
  });
};
