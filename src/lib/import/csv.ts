import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type { Db } from '../db/index.ts';
import { bool, nowIso, transaction, transactionAsync } from '../db/index.ts';
import { roundSeconds } from '../format.ts';
import { LOCK_REASON } from '../harvest/constants.ts';
import type { Settings } from '../settings.ts';

type CsvRow = Record<string, string>;

export interface CsvImportReport {
  rows: number;
  imported: number;
  updated: number;
  users: number;
  clients: number;
  projects: number;
  tasks: number;
  sourceSeconds: number;
  storedSeconds: number;
  /** The currency most rows were in, when the report says: what a new workspace should use. */
  currency: string | null;
  warnings: string[];
}

const aliases = {
  date: ['date', 'spent date'],
  client: ['client'],
  project: ['project'],
  projectCode: ['project code', 'code'],
  task: ['task'],
  notes: ['notes', 'note'],
  hours: ['hours', 'duration'],
  roundedHours: ['hours rounded', 'rounded hours'],
  person: ['person', 'employee', 'team member', 'user'],
  firstName: ['first name'],
  lastName: ['last name'],
  email: ['email', 'email address'],
  billable: ['billable'],
  invoiced: ['invoiced', 'billed'],
  billableRate: ['billable rate', 'rate'],
  costRate: ['cost rate'],
  currency: ['currency'],
  employee: ['employee'],
} as const;

/** Harvest writes some headers as questions — `Billable?`, `Invoiced?` — so the mark goes. */
function header(name: string): string {
  return name.trim().toLowerCase().replace(/\?$/, '').replace(/\s+/g, ' ');
}

/** Cells trimmed, except notes: those are kept as written, as Harvest's API returns them. */
function normalized(row: CsvRow): CsvRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const name = header(key);
    const text = String(value ?? '');
    return [name, (aliases.notes as readonly string[]).includes(name) ? text : text.trim()];
  }));
}

function pick(row: CsvRow, names: readonly string[]): string {
  for (const name of names) if (row[name] !== undefined && row[name] !== '') return row[name]!;
  return '';
}

function required(row: CsvRow, names: readonly string[], label: string, line: number): string {
  const value = pick(row, names);
  if (!value) throw new Error(`CSV row ${line}: missing ${label}.`);
  return value;
}

function date(value: string, line: number): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(value);
  if (!match) throw new Error(`CSV row ${line}: unsupported date "${value}". Use YYYY-MM-DD.`);
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a <= 12 && b <= 12) {
    throw new Error(`CSV row ${line}: ambiguous date "${value}". Export or convert dates to YYYY-MM-DD.`);
  }
  const day = a > 12 ? a : b;
  const month = a > 12 ? b : a;
  return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function seconds(value: string, line: number): number {
  const colon = /^(-?)(\d+):([0-5]\d)$/.exec(value);
  if (colon) return (colon[1] ? -1 : 1) * (Number(colon[2]) * 3600 + Number(colon[3]) * 60);
  const decimal = Number(value.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(decimal)) throw new Error(`CSV row ${line}: invalid hours "${value}".`);
  return Math.round(decimal * 3600);
}

function truthy(value: string): boolean {
  return /^(yes|true|1|billable|invoiced|billed)$/i.test(value.trim());
}

function person(row: CsvRow, line: number): { first: string; last: string; email: string } {
  const first = pick(row, aliases.firstName);
  const last = pick(row, aliases.lastName);
  const email = pick(row, aliases.email).toLowerCase();
  if (first || last) {
    const digest = createHash('sha256').update(`${first} ${last}`.trim().toLowerCase()).digest('hex').slice(0, 16);
    return { first, last, email: email || `imported-${digest}@invalid.local` };
  }
  const full = required(row, aliases.person, 'person', line).trim();
  const split = full.lastIndexOf(' ');
  return {
    first: split < 0 ? full : full.slice(0, split),
    last: split < 0 ? '' : full.slice(split + 1),
    email: email || `imported-${createHash('sha256').update(full.toLowerCase()).digest('hex').slice(0, 16)}@invalid.local`,
  };
}

/** Import a Harvest detailed-time or all-time CSV. Reference lists are optional: the time
 * export contains enough information to create the people, clients, projects and tasks it uses.
 */
export function importTimeCsv(database: Db, csv: string, settings: Settings): CsvImportReport {
  return transaction(database, () => drain(writeTimeCsv(database, csv, settings)));
}

/** Which part of a CSV import is under way, and how far it has got. */
export type CsvStep = 'time_report' | 'invoice_report' | 'billing';
export type CsvTick = (step: CsvStep, done: number, total: number) => void;

/** Rows written between reports. A pause per batch lets the progress be read meanwhile. */
const BATCH = 2000;

/** Run a writer to the end in one go. */
function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Run a writer to the end, handing the event loop back between batches. */
async function drainAsync<T>(steps: Generator<void, T>): Promise<T> {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function* writeTimeCsv(database: Db, csv: string, settings: Settings, tick: CsvTick = () => {}): Generator<void, CsvImportReport> {
  const records = parse(csv.replace(/^\uFEFF/, ''), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
    // Trimmed per cell in normalized(), which leaves notes alone.
    trim: false,
  }) as CsvRow[];
  if (records.length === 0) throw new Error('The CSV contains no time entries.');

  const stamp = nowIso();
  const warnings = new Set<string>();
  const identities = new Map<string, number>();
  let imported = 0;
  let updated = 0;
  let sourceSeconds = 0;
  let storedSeconds = 0;

  const findUser = database.prepare("SELECT id FROM users WHERE lower(email) = lower(?) OR (lower(first_name) = lower(?) AND lower(last_name) = lower(?)) LIMIT 1");
  const addUser = database.prepare(`INSERT INTO users (email, first_name, last_name, role, is_active, is_contractor, created_at, updated_at) VALUES (?, ?, ?, 'member', 1, ?, ?, ?) RETURNING id`);
  const currencies = new Map<string, number>();
  const findClient = database.prepare('SELECT id FROM clients WHERE lower(name) = lower(?) LIMIT 1');
  const addClient = database.prepare(`INSERT INTO clients (name, currency, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?) RETURNING id`);
  const findTask = database.prepare('SELECT id FROM tasks WHERE lower(name) = lower(?) LIMIT 1');
  const addTask = database.prepare(`INSERT INTO tasks (name, billable_by_default, is_default, is_active, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?) RETURNING id`);
  const findProject = database.prepare(`SELECT id FROM projects WHERE client_id = ? AND lower(name) = lower(?) AND COALESCE(code, '') = ? LIMIT 1`);
  const addProject = database.prepare(`INSERT INTO projects (client_id, name, code, is_active, is_billable, is_fixed_fee, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?) RETURNING id`);
  const addUserAssignment = database.prepare(`INSERT OR IGNORE INTO user_assignments (project_id, user_id, is_active, is_project_manager, use_default_rates, created_at, updated_at) VALUES (?, ?, 1, 0, 1, ?, ?)`);
  const addTaskAssignment = database.prepare(`INSERT OR IGNORE INTO task_assignments (project_id, task_id, is_active, billable, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`);
  const findEntry = database.prepare('SELECT id FROM time_entries WHERE source_key = ?');
  const putEntry = database.prepare(`
    INSERT INTO time_entries (source_key, spent_date, user_id, project_id, task_id, client_id,
      duration_seconds, rounded_seconds, source_hours, notes, billable, is_billed, billable_rate,
      cost_rate, is_locked, locked_reason, approval_status, source_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unsubmitted', ?, ?, ?)
    ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO UPDATE SET duration_seconds = excluded.duration_seconds,
      rounded_seconds = excluded.rounded_seconds, notes = excluded.notes,
      billable = excluded.billable, is_billed = excluded.is_billed,
      billable_rate = excluded.billable_rate, cost_rate = excluded.cost_rate,
      -- Invoiced time is locked, as Harvest locks it. A lock set here since, by archiving a
      -- project, is kept rather than lifted by importing the same file again.
      is_locked = MAX(time_entries.is_locked, excluded.is_locked),
      locked_reason = COALESCE(time_entries.locked_reason, excluded.locked_reason),
      source_json = excluded.source_json, updated_at = excluded.updated_at`);

  const id = (found: unknown) => Number((found as { id: number }).id);
  for (let index = 0; index < records.length; index += 1) {
    if (index % BATCH === 0) {
      tick('time_report', index, records.length);
      yield;
    }
    const line = index + 2;
    const raw = records[index]!;
    const row = normalized(raw);
    const spentDate = date(required(row, aliases.date, 'date', line), line);
    const clientName = required(row, aliases.client, 'client', line);
    const projectName = required(row, aliases.project, 'project', line);
    const projectCode = pick(row, aliases.projectCode);
    const taskName = required(row, aliases.task, 'task', line);
    const who = person(row, line);
    const rawSeconds = seconds(required(row, aliases.hours, 'hours', line), line);
    const roundedValue = pick(row, aliases.roundedHours);
    const roundedSeconds = roundedValue ? seconds(roundedValue, line) : roundSeconds(rawSeconds, settings.roundToHours, settings.roundingStyle);
    const notes = pick(row, aliases.notes) || null;
    const isBillable = truthy(pick(row, aliases.billable));
    const isBilled = truthy(pick(row, aliases.invoiced));
    // The rates as they stood when the time was tracked. Reports price billable time from
    // these, so without them every amount from a CSV import came out as nothing.
    const billableRate = isBillable ? money(pick(row, aliases.billableRate), line) : null;
    const costRate = money(pick(row, aliases.costRate), line);

    let user = findUser.get(who.email, who.first, who.last);
    // Harvest's `Employee?` is No for a contractor.
    if (!user) user = addUser.get(who.email, who.first, who.last, bool(/^no$/i.test(pick(row, aliases.employee))), stamp, stamp);
    const rowCurrency = currencyCode(pick(row, aliases.currency));
    if (rowCurrency) currencies.set(rowCurrency, (currencies.get(rowCurrency) ?? 0) + 1);
    let client = findClient.get(clientName);
    if (!client) client = addClient.get(clientName, currencyCode(pick(row, aliases.currency)) ?? settings.currency, stamp, stamp);
    let task = findTask.get(taskName);
    if (!task) task = addTask.get(taskName, bool(isBillable), stamp, stamp);
    let project = findProject.get(id(client), projectName, projectCode);
    if (!project) project = addProject.get(id(client), projectName, projectCode || null, bool(isBillable), stamp, stamp);

    addUserAssignment.run(id(project), id(user), stamp, stamp);
    addTaskAssignment.run(id(project), id(task), bool(isBillable), stamp, stamp);

    // Notes trimmed here as they were before notes were kept verbatim, so an entry imported
    // then is still recognised, and updated rather than added again.
    const identity = JSON.stringify([spentDate, who.email, who.first, who.last, clientName, projectName, projectCode, taskName, notes?.trim() || null, rawSeconds, isBillable, isBilled]);
    const digest = createHash('sha256').update(identity).digest('hex');
    const occurrence = (identities.get(digest) ?? 0) + 1;
    identities.set(digest, occurrence);
    const sourceKey = `harvest-csv:${digest}:${occurrence}`;
    const existed = Boolean(findEntry.get(sourceKey));
    putEntry.run(sourceKey, spentDate, id(user), id(project), id(task), id(client), rawSeconds,
      roundedSeconds, rawSeconds / 3600, notes, bool(isBillable), bool(isBilled), billableRate,
      costRate, bool(isBilled), isBilled ? LOCK_REASON.invoiced : null, JSON.stringify(raw), stamp, stamp);
    existed ? updated += 1 : imported += 1;
    sourceSeconds += rawSeconds;
    storedSeconds += Number((database.prepare('SELECT duration_seconds FROM time_entries WHERE source_key = ?').get(sourceKey) as { duration_seconds: number }).duration_seconds);
    if (!pick(row, aliases.email)) warnings.add('Some people had no email address; placeholder @invalid.local addresses were created.');
  }

  const count = (table: string) => Number((database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const report = {
    rows: records.length, imported, updated,
    users: count('users'), clients: count('clients'), projects: count('projects'), tasks: count('tasks'),
    sourceSeconds, storedSeconds,
    currency: [...currencies].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    warnings: [...warnings],
  };
  tick('time_report', records.length, records.length);
  tick('billing', 0, 1);
  yield;
  inferBilling(database, stamp);
  tick('billing', 1, 1);
  database.prepare(
    `INSERT INTO import_runs (source, started_at, finished_at, status, stats_json)
     VALUES ('harvest-csv', ?, ?, 'ok', ?)`,
  ).run(stamp, nowIso(), JSON.stringify(report));
  return report;
}

/**
 * How each project bills, worked out from the time it was billed at.
 *
 * The time report has the rate on every row but not the project's billing settings, and a new
 * entry takes its rate from those settings: left empty, everything logged here after the
 * import would carry no rate and count for nothing in the billable amount. So, for each
 * project that has no billing mode yet — from Harvest or from an earlier run of this — the
 * latest rate each person was billed at decides it: one rate for everyone is the project's
 * rate, different rates are each person's. Whether a task is billable on a project follows
 * most of its rows, and the project is billable if any of its time was. A person's latest cost
 * rate becomes theirs where they have none.
 */
function inferBilling(database: Db, stamp: string): void {
  // One pass over the time entries, not one query per project: on an account with two
  // thousand projects the per-project version held the server for ten seconds.
  const open = new Set((database.prepare(`SELECT id FROM projects WHERE bill_by IS NULL`).all() as { id: number }[]).map((r) => r.id));
  if (open.size === 0) return;
  const latest = database.prepare(`
    SELECT project_id, user_id, billable_rate FROM (
      SELECT project_id, user_id, billable_rate,
             row_number() OVER (PARTITION BY project_id, user_id ORDER BY spent_date DESC, id DESC) AS n
        FROM time_entries
       WHERE billable = 1 AND billable_rate IS NOT NULL)
     WHERE n = 1`).all() as { project_id: number; user_id: number; billable_rate: number }[];
  const rates = new Map<number, { user_id: number; billable_rate: number }[]>();
  for (const row of latest) {
    if (!open.has(row.project_id)) continue;
    const list = rates.get(row.project_id) ?? [];
    list.push(row);
    rates.set(row.project_id, list);
  }

  const setProject = database.prepare(`UPDATE projects SET bill_by = ?, hourly_rate = ?, is_billable = 1, updated_at = ? WHERE id = ?`);
  const setPerson = database.prepare(`
    INSERT INTO user_assignments (project_id, user_id, is_active, is_project_manager, use_default_rates,
                                  hourly_rate, created_at, updated_at)
    VALUES (?, ?, 1, 0, 0, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET use_default_rates = 0, hourly_rate = excluded.hourly_rate,
      updated_at = excluded.updated_at`);
  const setNotBillable = database.prepare(`UPDATE projects SET is_billable = 0, updated_at = ? WHERE id = ?`);
  for (const id of open) {
    const list = rates.get(id);
    if (!list) {
      setNotBillable.run(stamp, id);
      continue;
    }
    if (list.every((r) => r.billable_rate === list[0]!.billable_rate)) {
      setProject.run('Project', list[0]!.billable_rate, stamp, id);
    } else {
      setProject.run('People', null, stamp, id);
      for (const r of list) setPerson.run(id, r.user_id, r.billable_rate, stamp, stamp);
    }
  }

  // Whether a task is billable on a project follows most of its rows.
  const majority = database.prepare(`
    SELECT project_id, task_id, CASE WHEN 2 * SUM(billable) >= COUNT(*) THEN 1 ELSE 0 END AS billable
      FROM time_entries GROUP BY project_id, task_id`).all() as { project_id: number; task_id: number; billable: number }[];
  const setTaskBillable = database.prepare(`UPDATE task_assignments SET billable = ?, updated_at = ? WHERE project_id = ? AND task_id = ?`);
  for (const row of majority) {
    if (open.has(row.project_id)) setTaskBillable.run(row.billable, stamp, row.project_id, row.task_id);
  }

  database.prepare(`
    UPDATE users SET cost_rate = (
      SELECT te.cost_rate FROM time_entries te
       WHERE te.user_id = users.id AND te.cost_rate IS NOT NULL
       ORDER BY te.spent_date DESC, te.id DESC LIMIT 1)
     WHERE cost_rate IS NULL`).run();
}

export interface InvoiceCsvImportReport {
  rows: number;
  imported: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

const invoiceAliases = {
  number: ['id', 'invoice id', 'invoice number', 'invoice #', 'invoice no', 'number', 'invoice'],
  client: ['client', 'client name'],
  issueDate: ['issue date', 'issued', 'invoice date', 'date'],
  dueDate: ['due date', 'invoice due date', 'due'],
  amount: ['invoice amount', 'amount', 'amount invoiced', 'total'],
  paid: ['paid amount', 'amount paid'],
  balance: ['balance', 'due amount', 'amount due', 'outstanding'],
  tax: ['tax amount', 'tax'],
  tax2: ['tax2 amount', 'tax 2 amount', 'tax2', 'tax 2'],
  discount: ['discount amount', 'discount'],
  currency: ['currency'],
  status: ['status', 'state'],
  subject: ['subject'],
  purchaseOrder: ['po number', 'purchase order', 'po'],
  paidDate: ['last payment date', 'paid date', 'payment date', 'paid on'],
  periodStart: ['period start'],
  periodEnd: ['period end'],
  clientAddress: ['client address', 'address'],
} as const;

/**
 * Money as integer minor units, whichever separators the export used: `1,234.50`,
 * `1 234,50`, `SEK 1.234,50` and `(12.00)` all read as intended. Empty is null.
 */
function money(value: string, line: number): number | null {
  const negative = /^\(.*\)$/.test(value.trim()) || /^-|-$/.test(value.replace(/[^\d.,-]/g, ''));
  let digits = value.replace(/[^\d.,]/g, '');
  if (!digits) return null;
  const comma = digits.lastIndexOf(',');
  const point = digits.lastIndexOf('.');
  if (comma >= 0 && point >= 0) {
    const decimal = comma > point ? ',' : '.';
    digits = digits.replaceAll(decimal === ',' ? '.' : ',', '').replace(decimal, '.');
  } else if (comma >= 0) {
    digits = /,\d{1,2}$/.test(digits) && digits.indexOf(',') === comma ? digits.replace(',', '.') : digits.replaceAll(',', '');
  } else if (digits.indexOf('.') !== point) {
    digits = digits.replaceAll('.', '');
  }
  const amount = Number(digits);
  if (!Number.isFinite(amount)) throw new Error(`CSV row ${line}: invalid amount "${value}".`);
  return Math.round(amount * 100) * (negative ? -1 : 1);
}

/** `SEK`, or the code at the end of Harvest's `Swedish Krona - SEK`. */
function currencyCode(value: string): string | null {
  return /(?:^|\s)([A-Z]{3})$/.exec(value.trim())?.[1] ?? null;
}

/**
 * Harvest's invoice report has no status column, so without one the state is read from the
 * money: paid in full is paid, nothing left to pay without being paid in full is closed
 * (written off in Harvest), and anything still owed is open.
 */
function invoiceState(status: string, amount: number, paid: number | null, balance: number): 'draft' | 'open' | 'paid' | 'closed' {
  const s = status.toLowerCase();
  if (s.includes('draft')) return 'draft';
  if (/closed|written off|write-off|void/.test(s)) return 'closed';
  if (s.includes('paid') && !s.includes('partial') && !s.includes('unpaid')) return 'paid';
  if (s) return 'open';
  if (balance !== 0) return 'open';
  if (paid === null) return amount !== 0 ? 'paid' : 'closed';
  return amount > 0 && paid >= amount ? 'paid' : 'closed';
}

/** Which Harvest export a CSV is, read from its header row. */
export function csvKind(csv: string): 'time' | 'invoices' | null {
  const rows = parse(csv.replace(/^﻿/, ''), { bom: true, relax_column_count: true, skip_empty_lines: true, to_line: 20 }) as string[][];
  for (const row of rows) {
    const names = new Set(row.map(header));
    const has = (list: readonly string[]) => list.some((name) => names.has(name));
    if (has(aliases.hours) && has(aliases.task)) return 'time';
    if (has(invoiceAliases.client) && has(invoiceAliases.issueDate) && has(invoiceAliases.amount)) return 'invoices';
  }
  return null;
}

/**
 * Import a Harvest invoice report CSV. The report may open with title lines, splits accounts
 * with several currencies into sections and closes each with a totals row, so the header is
 * searched for and any row without a number, client and issue date is passed over.
 * Invoices are keyed on their number, so a re-import updates them.
 */
export function importInvoiceCsv(database: Db, csv: string, settings: Settings): InvoiceCsvImportReport {
  return transaction(database, () => drain(writeInvoiceCsv(database, csv, settings)));
}

function* writeInvoiceCsv(database: Db, csv: string, settings: Settings, tick: CsvTick = () => {}): Generator<void, InvoiceCsvImportReport> {
  const lines = parse(csv.replace(/^﻿/, ''), { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true }) as string[][];
  const headerIndex = lines.findIndex((cells) => {
    const names = new Set(cells.map(header));
    const has = (list: readonly string[]) => list.some((name) => names.has(name));
    return has(invoiceAliases.client) && has(invoiceAliases.issueDate) && has(invoiceAliases.amount);
  });
  if (headerIndex < 0) throw new Error('The CSV has no invoice header row with client, issue date and amount.');
  const names = lines[headerIndex]!.map(header);

  const stamp = nowIso();
  const warnings = new Set<string>();
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let rows = 0;
  let sectionCurrency: string | null = null;

  const findClient = database.prepare('SELECT id, currency FROM clients WHERE lower(name) = lower(?) LIMIT 1');
  const addClient = database.prepare('INSERT INTO clients (name, currency, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?) RETURNING id, currency');
  const findInvoice = database.prepare('SELECT id FROM invoices WHERE source_key = ?');
  const setAddress = database.prepare('UPDATE clients SET address = ? WHERE id = ? AND address IS NULL');
  const putInvoice = database.prepare(`
    INSERT INTO invoices (source_key, client_id, number, state, subject, purchase_order, currency,
      amount, due_amount, tax_amount, tax2_amount, discount_amount, period_start, period_end,
      issue_date, due_date, paid_date, source_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO UPDATE SET
      client_id = excluded.client_id, state = excluded.state, subject = excluded.subject,
      purchase_order = excluded.purchase_order, currency = excluded.currency,
      amount = excluded.amount, due_amount = excluded.due_amount,
      tax_amount = excluded.tax_amount, tax2_amount = excluded.tax2_amount,
      discount_amount = excluded.discount_amount, period_start = excluded.period_start,
      period_end = excluded.period_end, issue_date = excluded.issue_date,
      due_date = excluded.due_date, paid_date = excluded.paid_date,
      source_json = excluded.source_json, updated_at = excluded.updated_at`);

  const total = lines.length - headerIndex - 1;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const done = index - headerIndex - 1;
    if (done % BATCH === 0) {
      tick('invoice_report', done, total);
      yield;
    }
    const line = index + 1;
    const cells = lines[index]!;
    const filled = cells.filter(Boolean);
    // A section heading in a multi-currency report: a lone currency code.
    if (filled.length === 1 && /^[A-Z]{3}$/.test(filled[0]!.replace(/^currency:?\s*/i, ''))) {
      sectionCurrency = filled[0]!.replace(/^currency:?\s*/i, '');
      continue;
    }
    const raw = Object.fromEntries(names.map((name, column) => [name, cells[column] ?? '']));
    const number = pick(raw, invoiceAliases.number);
    const clientName = pick(raw, invoiceAliases.client);
    const issued = pick(raw, invoiceAliases.issueDate);
    if (!number || !clientName || !issued || /^total/i.test(number) || /^total/i.test(clientName)) {
      skipped += 1;
      continue;
    }
    rows += 1;

    const amount = money(required(raw, invoiceAliases.amount, 'invoice amount', line), line) ?? 0;
    const paid = money(pick(raw, invoiceAliases.paid), line);
    const balance = money(pick(raw, invoiceAliases.balance), line) ?? (paid === null ? null : amount - paid);
    const state = invoiceState(pick(raw, invoiceAliases.status), amount, paid, balance ?? amount);
    const dueAmount = balance ?? (state === 'paid' || state === 'closed' ? 0 : amount);
    const optionalDate = (list: readonly string[]) => {
      const value = pick(raw, list);
      return value ? date(value, line) : null;
    };

    let client = findClient.get(clientName) as { id: number; currency: string } | undefined;
    const currency = currencyCode(pick(raw, invoiceAliases.currency)) ?? sectionCurrency ?? client?.currency ?? settings.currency;
    if (!client) client = addClient.get(clientName, currency, stamp, stamp) as { id: number; currency: string };
    const address = pick(raw, invoiceAliases.clientAddress);
    if (address) setAddress.run(address, client.id);

    const sourceKey = `harvest-csv:invoice:${number}`;
    const existed = Boolean(findInvoice.get(sourceKey));
    putInvoice.run(sourceKey, client.id, number, state, pick(raw, invoiceAliases.subject) || null,
      pick(raw, invoiceAliases.purchaseOrder) || null, currency, amount, dueAmount,
      money(pick(raw, invoiceAliases.tax), line) ?? 0, money(pick(raw, invoiceAliases.tax2), line) ?? 0,
      money(pick(raw, invoiceAliases.discount), line) ?? 0, optionalDate(invoiceAliases.periodStart),
      optionalDate(invoiceAliases.periodEnd), date(issued, line), optionalDate(invoiceAliases.dueDate),
      optionalDate(invoiceAliases.paidDate), JSON.stringify(Object.fromEntries(lines[headerIndex]!.map((name, column) => [name, cells[column] ?? '']))),
      stamp, stamp);
    existed ? updated += 1 : imported += 1;
  }
  tick('invoice_report', total, total);
  if (rows === 0) throw new Error('The CSV contains no invoices.');
  warnings.add('Invoices from a CSV export have no line items or payments, and time entries are not linked to them.');

  const report = { rows, imported, updated, skipped, warnings: [...warnings] };
  database.prepare(
    `INSERT INTO import_runs (source, started_at, finished_at, status, stats_json)
     VALUES ('harvest-csv-invoices', ?, ?, 'ok', ?)`,
  ).run(stamp, nowIso(), JSON.stringify(report));
  return report;
}

export interface CsvFile {
  name: string;
  text: string;
}

export interface CsvFilesReport {
  time: CsvImportReport | null;
  invoices: InvoiceCsvImportReport | null;
}

/**
 * Import the files of a Harvest export together — its time report and its invoice report —
 * in one transaction, so a file that fails leaves nothing half-written. Each file's kind is
 * read from its header, so they can be chosen in any order and under any name.
 */
export function importCsvFiles(database: Db, files: CsvFile[], settings: Settings): CsvFilesReport {
  const { time, invoices } = sortFiles(files);
  return transaction(database, () => ({
    // Time first, so invoices find the clients the time report created under the same names.
    time: time ? drain(writeTimeCsv(database, time.text, settings)) : null,
    invoices: invoices ? drain(writeInvoiceCsv(database, invoices.text, settings)) : null,
  }));
}

/**
 * `importCsvFiles` for the Import page's background job: the same writes in the same single
 * transaction, pausing between batches so the page can show how far it has got. The caller
 * keeps other writes off the connection meanwhile; see isImportWriting.
 */
export async function importCsvFilesAsync(database: Db, files: CsvFile[], settings: Settings, tick: CsvTick): Promise<CsvFilesReport> {
  const { time, invoices } = sortFiles(files);
  return transactionAsync(database, async () => ({
    time: time ? await drainAsync(writeTimeCsv(database, time.text, settings, tick)) : null,
    invoices: invoices ? await drainAsync(writeInvoiceCsv(database, invoices.text, settings, tick)) : null,
  }));
}

/** The time report and the invoice report among the files, told apart by their headers. */
export function sortFiles(files: CsvFile[]): { time: CsvFile | null; invoices: CsvFile | null } {
  const time: CsvFile[] = [];
  const invoices: CsvFile[] = [];
  for (const file of files) {
    const kind = csvKind(file.text);
    if (kind === 'time') time.push(file);
    else if (kind === 'invoices') invoices.push(file);
    else throw new Error(`${file.name} is neither a Harvest time report nor an invoice report.`);
  }
  if (time.length > 1 || invoices.length > 1) throw new Error('Choose at most one time report and one invoice report.');
  return { time: time[0] ?? null, invoices: invoices[0] ?? null };
}

/** One line for the page once a CSV import is done. */
export function describeCsvImport(result: CsvFilesReport): string {
  const parts: string[] = [];
  if (result.time) {
    parts.push(`${result.time.rows} time entries (${result.time.imported} new, ${result.time.updated} updated)`);
  }
  if (result.invoices) {
    parts.push(`${result.invoices.rows} invoices (${result.invoices.imported} new, ${result.invoices.updated} updated)`);
  }
  return `Imported ${parts.join(' and ')}.`;
}

/** Progress for a CSV job: which step, and how many rows of how many. */
export function csvProgress(progress: { phase: string; counts: Record<string, number>; totals: Record<string, number> }): CsvTick {
  return (step, done, total) => {
    progress.phase = step;
    progress.counts[step] = done;
    progress.totals[step] = total;
  };
}
