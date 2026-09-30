import type { APIRoute } from 'astro';
import { db, fromMinorUnits, rows, secondsToHours } from '../../lib/db/index.ts';
import { csvResponse, stamped, toCsv } from '../../lib/csv.ts';
import { formatHours } from '../../lib/format.ts';
import { canAdminister } from '../../lib/auth/session.ts';
import { buildWhere, JOINS, readFilters } from '../../lib/timesheet/report.ts';

/**
 * CSV export.
 *
 * `/export/time-entries?from=…&to=…&user=…`, plus one route per entity.
 *
 * Members export their own time; everything else is admin-only, because project rates and
 * cost rates are in there. Nobody is ever blocked from exporting their own data — that is
 * the point of the feature.
 */

type Sheet = { headers: string[]; rows: unknown[][] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GET: APIRoute = (context) => {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });

  const what = context.params.what ?? '';
  const database = db();
  const admin = canAdminister(user);
  const url = context.url;

  const from = DATE.test(url.searchParams.get('from') ?? '') ? url.searchParams.get('from')! : null;
  const to = DATE.test(url.searchParams.get('to') ?? '') ? url.searchParams.get('to')! : null;

  // A member may only ever export themselves; an admin may target anyone, or everyone.
  const requested = Number(url.searchParams.get('user'));
  const scopeUser = admin
    ? Number.isInteger(requested) && requested > 0 ? requested : null
    : user.id;

  let sheet: Sheet;

  switch (what) {
    case 'time-entries': {
      // The very same filter code the reports use, so "export these rows" exports exactly
      // the rows on screen rather than something that merely resembles them.
      const filters = readFilters(url, user, { from: from ?? '0000-01-01', to: to ?? '9999-12-31' });
      const where = buildWhere(filters);

      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT te.spent_date, TRIM(u.first_name || ' ' || u.last_name) AS person, u.email,
                    c.name AS client, p.code AS project_code, p.name AS project, t.name AS task,
                    te.duration_seconds, te.rounded_seconds, te.notes, te.billable, te.is_billed,
                    te.is_locked, te.locked_reason, te.approval_status, te.billable_rate,
                    te.harvest_id, te.created_at, te.updated_at
             ${JOINS}
              WHERE ${where.clause}
           ORDER BY te.spent_date, u.first_name, c.name, p.name`,
          )
          .all(...where.args),
      );

      sheet = {
        headers: ['Date', 'Person', 'Email', 'Client', 'Project code', 'Project', 'Task',
                  'Hours', 'Rounded hours', 'Notes', 'Billable', 'Billed', 'Locked',
                  'Locked reason', 'Approval', 'Billable rate', 'Harvest ID',
                  'Created', 'Updated'],
        rows: data.map((r) => [
          r.spent_date, r.person, r.email, r.client, r.project_code, r.project, r.task,
          formatHours(Number(r.duration_seconds)), formatHours(Number(r.rounded_seconds)),
          r.notes, r.billable ? 'yes' : 'no', r.is_billed ? 'yes' : 'no',
          r.is_locked ? 'yes' : 'no', r.locked_reason, r.approval_status,
          fromMinorUnits(r.billable_rate as number | null), r.harvest_id,
          r.created_at, r.updated_at,
        ]),
      };
      break;
    }

    case 'clients': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database.prepare('SELECT * FROM clients ORDER BY name').all(),
      );
      sheet = {
        headers: ['Name', 'Address', 'Currency', 'Active', 'Harvest ID', 'Created', 'Updated'],
        rows: data.map((r) => [r.name, r.address, r.currency, r.is_active ? 'yes' : 'no',
                              r.harvest_id, r.created_at, r.updated_at]),
      };
      break;
    }

    case 'projects': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT p.code, p.name, c.name AS client, p.is_active, p.is_billable, p.is_fixed_fee,
                    p.hourly_rate, p.bill_by, p.fee, p.budget_by, p.budget_seconds,
                    p.budget_amount, p.budget_is_monthly, p.cost_budget,
                    p.notes, p.starts_on, p.ends_on,
                    p.harvest_id, p.created_at, p.updated_at
               FROM projects p JOIN clients c ON c.id = p.client_id
           ORDER BY c.name, p.name`,
          )
          .all(),
      );
      sheet = {
        // Budget hours and budget money are separate columns here for the same reason they
        // are separate in the database: one "Budget" column would export two units.
        headers: ['Code', 'Project', 'Client', 'Active', 'Billable', 'Fixed fee', 'Hourly rate',
                  'Bill by', 'Fee', 'Budget by', 'Budget hours', 'Budget amount',
                  'Budget resets monthly', 'Cost budget',
                  'Notes', 'Starts', 'Ends', 'Harvest ID', 'Created', 'Updated'],
        rows: data.map((r) => [r.code, r.name, r.client, r.is_active ? 'yes' : 'no',
                               r.is_billable ? 'yes' : 'no', r.is_fixed_fee ? 'yes' : 'no',
                               fromMinorUnits(r.hourly_rate as number | null),
                               r.bill_by,
                               fromMinorUnits(r.fee as number | null),
                               r.budget_by,
                               r.budget_seconds === null ? null : secondsToHours(r.budget_seconds as number),
                               fromMinorUnits(r.budget_amount as number | null),
                               r.budget_is_monthly ? 'yes' : 'no',
                               fromMinorUnits(r.cost_budget as number | null),
                               r.notes, r.starts_on, r.ends_on, r.harvest_id,
                               r.created_at, r.updated_at]),
      };
      break;
    }

    case 'tasks': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database.prepare('SELECT * FROM tasks ORDER BY name').all(),
      );
      sheet = {
        headers: ['Task', 'Billable by default', 'Default rate', 'Active', 'Harvest ID'],
        rows: data.map((r) => [r.name, r.billable_by_default ? 'yes' : 'no',
                               fromMinorUnits(r.default_hourly_rate as number | null),
                               r.is_active ? 'yes' : 'no', r.harvest_id]),
      };
      break;
    }

    case 'people': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database.prepare('SELECT * FROM users ORDER BY first_name, last_name').all(),
      );
      sheet = {
        headers: ['First name', 'Last name', 'Email', 'Role', 'Harvest grants', 'Active',
                  'Contractor', 'Weekly capacity (h)', 'Billable rate', 'Cost rate', 'Harvest ID'],
        rows: data.map((r) => [r.first_name, r.last_name, r.email, r.role, r.access_roles,
                               r.is_active ? 'yes' : 'no', r.is_contractor ? 'yes' : 'no',
                               r.weekly_capacity_seconds ? Number(r.weekly_capacity_seconds) / 3600 : '',
                               fromMinorUnits(r.default_billable_rate as number | null),
                               fromMinorUnits(r.cost_rate as number | null), r.harvest_id]),
      };
      break;
    }

    case 'assignments': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const people = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT 'user' AS kind, p.name AS project, c.name AS client,
                    TRIM(u.first_name || ' ' || u.last_name) AS subject,
                    ua.is_active, ua.is_project_manager AS extra, ua.hourly_rate
               FROM user_assignments ua
               JOIN projects p ON p.id = ua.project_id
               JOIN clients c ON c.id = p.client_id
               JOIN users u ON u.id = ua.user_id`,
          )
          .all(),
      );
      const tasks = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT 'task' AS kind, p.name AS project, c.name AS client, t.name AS subject,
                    ta.is_active, ta.billable AS extra, ta.hourly_rate
               FROM task_assignments ta
               JOIN projects p ON p.id = ta.project_id
               JOIN clients c ON c.id = p.client_id
               JOIN tasks t ON t.id = ta.task_id`,
          )
          .all(),
      );
      sheet = {
        headers: ['Kind', 'Client', 'Project', 'Person or task', 'Active', 'PM / billable', 'Rate'],
        rows: [...people, ...tasks].map((r) => [r.kind, r.client, r.project, r.subject,
                                                r.is_active ? 'yes' : 'no', r.extra ? 'yes' : 'no',
                                                fromMinorUnits(r.hourly_rate as number | null)]),
      };
      break;
    }

    case 'invoices': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT i.number, c.name AS client, i.state, i.subject, i.purchase_order,
                    i.issue_date, i.due_date, i.payment_term, i.period_start, i.period_end,
                    i.currency, i.amount, i.due_amount, i.tax_rate, i.tax_amount,
                    i.discount_rate, i.discount_amount, i.sent_at, i.paid_date, i.closed_at,
                    i.creator_name, i.notes, i.harvest_id, i.created_at, i.updated_at
               FROM invoices i JOIN clients c ON c.id = i.client_id
           ORDER BY i.issue_date, CAST(i.number AS INTEGER), i.number`,
          )
          .all(),
      );
      sheet = {
        headers: ['Number', 'Client', 'State', 'Subject', 'PO number', 'Issued', 'Due',
                  'Payment term', 'Period start', 'Period end', 'Currency', 'Amount',
                  'Unpaid', 'Tax %', 'Tax', 'Discount %', 'Discount', 'Sent', 'Paid',
                  'Closed', 'Created by', 'Notes', 'Harvest ID', 'Created', 'Updated'],
        rows: data.map((r) => [r.number, r.client, r.state, r.subject, r.purchase_order,
                               r.issue_date, r.due_date, r.payment_term, r.period_start,
                               r.period_end, r.currency,
                               fromMinorUnits(r.amount as number),
                               fromMinorUnits(r.due_amount as number),
                               r.tax_rate, fromMinorUnits(r.tax_amount as number),
                               r.discount_rate, fromMinorUnits(r.discount_amount as number),
                               r.sent_at, r.paid_date, r.closed_at, r.creator_name, r.notes,
                               r.harvest_id, r.created_at, r.updated_at]),
      };
      break;
    }

    case 'invoice-lines': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT i.number, c.name AS client, i.issue_date, i.currency, l.position, l.kind,
                    l.description, p.code AS project_code, p.name AS project, l.quantity,
                    l.unit_price, l.amount, l.taxed, l.harvest_id
               FROM invoice_line_items l
               JOIN invoices i ON i.id = l.invoice_id
               JOIN clients c ON c.id = i.client_id
          LEFT JOIN projects p ON p.id = l.project_id
           ORDER BY i.issue_date, CAST(i.number AS INTEGER), i.number, l.position`,
          )
          .all(),
      );
      sheet = {
        headers: ['Invoice', 'Client', 'Issued', 'Currency', 'Line', 'Item', 'Description',
                  'Project code', 'Project', 'Quantity', 'Unit price', 'Amount', 'Taxed',
                  'Harvest ID'],
        rows: data.map((r) => [r.number, r.client, r.issue_date, r.currency,
                               Number(r.position) + 1, r.kind, r.description,
                               r.project_code, r.project, r.quantity,
                               fromMinorUnits(r.unit_price as number),
                               fromMinorUnits(r.amount as number),
                               r.taxed ? 'yes' : 'no', r.harvest_id]),
      };
      break;
    }

    case 'invoice-payments': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT i.number, c.name AS client, i.currency, ip.paid_date, ip.paid_at, ip.amount,
                    ip.recorded_by, ip.transaction_reference, ip.payment_gateway, ip.notes,
                    ip.harvest_id
               FROM invoice_payments ip
               JOIN invoices i ON i.id = ip.invoice_id
               JOIN clients c ON c.id = i.client_id
           ORDER BY COALESCE(ip.paid_date, ip.paid_at), i.number`,
          )
          .all(),
      );
      sheet = {
        headers: ['Invoice', 'Client', 'Currency', 'Paid', 'Paid at', 'Amount', 'Recorded by',
                  'Reference', 'Gateway', 'Notes', 'Harvest ID'],
        rows: data.map((r) => [r.number, r.client, r.currency, r.paid_date, r.paid_at,
                               fromMinorUnits(r.amount as number), r.recorded_by,
                               r.transaction_reference, r.payment_gateway, r.notes,
                               r.harvest_id]),
      };
      break;
    }

    case 'expenses': {
      // Like time entries: a member gets their own, an administrator everyone's.
      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT e.spent_date, TRIM(u.first_name || ' ' || u.last_name) AS person, u.email,
                    c.name AS client, p.code AS project_code, p.name AS project, ec.name AS category,
                    e.notes, e.units, ec.unit_name, e.total_cost, e.billable, e.reimbursement,
                    e.is_billed, i.number AS invoice, e.is_locked, e.locked_reason,
                    e.receipt_file_name, e.harvest_id, e.created_at, e.updated_at
               FROM expenses e
               JOIN users u ON u.id = e.user_id
               JOIN projects p ON p.id = e.project_id
          LEFT JOIN clients c ON c.id = p.client_id
          LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id
          LEFT JOIN invoices i ON i.id = e.invoice_id
              WHERE (? IS NULL OR e.user_id = ?)
                AND (? IS NULL OR e.spent_date >= ?) AND (? IS NULL OR e.spent_date <= ?)
           ORDER BY e.spent_date, u.first_name`,
          )
          .all(scopeUser, scopeUser, from, from, to, to),
      );
      sheet = {
        headers: ['Date', 'Person', 'Email', 'Client', 'Project code', 'Project', 'Category',
                  'Notes', 'Units', 'Unit', 'Amount', 'Billable', 'Reimbursable', 'Billed',
                  'Invoice', 'Locked', 'Locked reason', 'Receipt', 'Harvest ID', 'Created', 'Updated'],
        rows: data.map((r) => [r.spent_date, r.person, r.email, r.client, r.project_code, r.project,
                               r.category, r.notes, r.units, r.unit_name,
                               fromMinorUnits(r.total_cost as number), r.billable ? 'yes' : 'no',
                               r.reimbursement ? 'yes' : 'no', r.is_billed ? 'yes' : 'no', r.invoice,
                               r.is_locked ? 'yes' : 'no', r.locked_reason, r.receipt_file_name,
                               r.harvest_id, r.created_at, r.updated_at]),
      };
      break;
    }

    case 'contacts': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT c.name AS client, k.first_name, k.last_name, k.title, k.email, k.phone_office,
                    k.phone_mobile, k.fax, k.invoice_recipient_status, k.harvest_id, k.created_at,
                    k.updated_at
               FROM contacts k JOIN clients c ON c.id = k.client_id
           ORDER BY c.name, k.last_name, k.first_name`,
          )
          .all(),
      );
      sheet = {
        headers: ['Client', 'First name', 'Last name', 'Title', 'Email', 'Phone (office)',
                  'Phone (mobile)', 'Fax', 'Invoice recipient', 'Harvest ID', 'Created', 'Updated'],
        rows: data.map((r) => [r.client, r.first_name, r.last_name, r.title, r.email, r.phone_office,
                               r.phone_mobile, r.fax, r.invoice_recipient_status, r.harvest_id,
                               r.created_at, r.updated_at]),
      };
      break;
    }

    case 'estimates': {
      if (!admin) return new Response('Administrators only.', { status: 403 });
      const data = rows<Record<string, unknown>>(
        database
          .prepare(
            `SELECT e.number, c.name AS client, e.state, e.subject, e.purchase_order, e.issue_date,
                    e.currency, e.amount, e.tax_rate, e.tax_amount, e.discount_rate,
                    e.discount_amount, e.sent_at, e.accepted_at, e.declined_at, e.creator_name,
                    e.notes, e.harvest_id, e.created_at, e.updated_at
               FROM estimates e JOIN clients c ON c.id = e.client_id
           ORDER BY e.issue_date, CAST(e.number AS INTEGER), e.number`,
          )
          .all(),
      );
      sheet = {
        headers: ['Number', 'Client', 'State', 'Subject', 'PO number', 'Issued', 'Currency', 'Amount',
                  'Tax %', 'Tax', 'Discount %', 'Discount', 'Sent', 'Accepted', 'Declined',
                  'Created by', 'Notes', 'Harvest ID', 'Created', 'Updated'],
        rows: data.map((r) => [r.number, r.client, r.state, r.subject, r.purchase_order, r.issue_date,
                               r.currency, fromMinorUnits(r.amount as number), r.tax_rate,
                               fromMinorUnits(r.tax_amount as number), r.discount_rate,
                               fromMinorUnits(r.discount_amount as number), r.sent_at, r.accepted_at,
                               r.declined_at, r.creator_name, r.notes, r.harvest_id, r.created_at,
                               r.updated_at]),
      };
      break;
    }

    default:
      return new Response('Unknown export', { status: 404 });
  }

  return csvResponse(stamped(what), toCsv(sheet.headers, sheet.rows));
};
