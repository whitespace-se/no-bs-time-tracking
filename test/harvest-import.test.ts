/**
 * The Harvest → SQLite import, against a small synthetic account.
 *
 * The fixtures below are hand-written objects shaped like src/lib/harvest/types.ts: two
 * people, two clients, two tasks, two projects, their assignments, four time entries, an
 * invoice with lines and a payment, an expense, a contact, a team and a rate history. Small
 * enough to reason about by hand, wide enough that every block of the importer runs.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Db } from '../src/lib/db/index.ts';
import { readSettings } from '../src/lib/settings.ts';
import type { HarvestSnapshot } from '../src/lib/harvest/import.ts';
import { importSnapshot, recordRun, reportOk } from '../src/lib/harvest/import.ts';
import type {
  HarvestClientRecord,
  HarvestCompany,
  HarvestContact,
  HarvestExpense,
  HarvestExpenseCategory,
  HarvestInvoice,
  HarvestInvoicePayment,
  HarvestProject,
  HarvestRole,
  HarvestTask,
  HarvestTaskAssignment,
  HarvestTimeEntry,
  HarvestUser,
  HarvestUserAssignment,
  HarvestUserRate,
} from '../src/lib/harvest/types.ts';
import { count, plain, tempDb } from './fixture.ts';

const T = '2026-01-01T00:00:00Z';
/** Where local rows start, per migration 006 and docs/architecture.md. */
const LOCAL_BASE = 1_000_000_000_000;

// ── the synthetic account ────────────────────────────────────────────────────

const COMPANY: HarvestCompany = {
  base_uri: 'https://example.harvestapp.com',
  full_domain: 'example.harvestapp.com',
  name: 'Synthetic Studio',
  is_active: true,
  week_start_day: 'Monday',
  wants_timestamp_timers: false,
  time_format: 'decimal',
  date_format: '%Y-%m-%d',
  plan_type: 'simple',
  currency: 'SEK',
  decimal_symbol: ',',
  thousands_separator: ' ',
  color_scheme: 'orange',
  clock: '24h',
  expense_feature: true,
  invoice_feature: true,
  estimate_feature: true,
  approval_required: false,
};

function user(over: Partial<HarvestUser> & Pick<HarvestUser, 'id' | 'email'>): HarvestUser {
  return {
    first_name: 'Ada',
    last_name: 'Example',
    telephone: null,
    timezone: 'Europe/Stockholm',
    has_access_to_all_future_projects: false,
    is_contractor: false,
    is_active: true,
    weekly_capacity: 144000,
    default_hourly_rate: 1200,
    cost_rate: 600,
    roles: [],
    access_roles: ['administrator'],
    avatar_url: null,
    created_at: T,
    updated_at: T,
    ...over,
  };
}

function clientRecord(over: Partial<HarvestClientRecord> & Pick<HarvestClientRecord, 'id' | 'name'>): HarvestClientRecord {
  return { is_active: true, address: null, currency: 'SEK', created_at: T, updated_at: T, ...over };
}

function task(over: Partial<HarvestTask> & Pick<HarvestTask, 'id' | 'name'>): HarvestTask {
  return {
    billable_by_default: true,
    default_hourly_rate: 1000,
    is_default: false,
    is_active: true,
    created_at: T,
    updated_at: T,
    ...over,
  };
}

function project(over: Partial<HarvestProject> & Pick<HarvestProject, 'id' | 'name' | 'client'>): HarvestProject {
  return {
    code: null,
    is_active: true,
    is_billable: true,
    is_fixed_fee: false,
    bill_by: 'Project',
    hourly_rate: 1200,
    budget: null,
    budget_by: 'none',
    budget_is_monthly: false,
    notify_when_over_budget: false,
    over_budget_notification_percentage: null,
    show_budget_to_all: false,
    cost_budget: null,
    cost_budget_include_expenses: false,
    fee: null,
    notes: null,
    starts_on: null,
    ends_on: null,
    created_at: T,
    updated_at: T,
    ...over,
  };
}

function entry(
  over: Partial<HarvestTimeEntry> &
    Pick<HarvestTimeEntry, 'id' | 'spent_date' | 'user' | 'client' | 'project' | 'task' | 'hours'>,
): HarvestTimeEntry {
  return {
    user_assignment: null,
    task_assignment: null,
    external_reference: null,
    invoice: null,
    hours_without_timer: null,
    rounded_hours: over.hours,
    notes: null,
    is_locked: false,
    locked_reason: null,
    is_closed: false,
    approval_status: 'unsubmitted',
    is_billed: false,
    timer_started_at: null,
    started_time: null,
    ended_time: null,
    is_running: false,
    billable: true,
    budgeted: false,
    billable_rate: 1200,
    cost_rate: 600,
    created_at: T,
    updated_at: T,
    ...over,
  };
}

const ADA = user({ id: 1, email: 'ada@example.test' });
const BOB = user({
  id: 2,
  email: 'bob@example.test',
  first_name: 'Bob',
  access_roles: ['manager', 'project_manager'],
  default_hourly_rate: 900,
  cost_rate: 450,
});
const ALPHA = clientRecord({ id: 10, name: 'Alpha Client' });
const BETA = clientRecord({ id: 11, name: 'Beta Client', currency: undefined as unknown as string });
const DEVELOPMENT = task({ id: 200, name: 'Development' });
const MEETING = task({ id: 201, name: 'Meeting', billable_by_default: false, default_hourly_rate: null });
const WEBSITE = project({
  id: 100,
  name: 'Website',
  code: 'WEB',
  client: { id: 10, name: 'Alpha Client' },
  budget: 40,
  budget_by: 'person',
  fee: null,
});
const RETAINER = project({
  id: 101,
  name: 'Retainer',
  client: { id: 11, name: 'Beta Client' },
  is_fixed_fee: true,
  budget: 50000,
  budget_by: 'project_cost',
  fee: 50000,
});

const USER_ASSIGNMENTS: HarvestUserAssignment[] = [
  {
    id: 300,
    project: { id: 100, name: 'Website' },
    user: { id: 1, name: 'Ada Example' },
    is_active: true,
    is_project_manager: true,
    use_default_rates: true,
    hourly_rate: 1200,
    budget: 20,
    created_at: T,
    updated_at: T,
  },
  {
    id: 301,
    project: { id: 101, name: 'Retainer' },
    user: { id: 2, name: 'Bob Example' },
    is_active: true,
    is_project_manager: false,
    use_default_rates: false,
    hourly_rate: 900,
    budget: 10000,
    created_at: T,
    updated_at: T,
  },
];

const TASK_ASSIGNMENTS: HarvestTaskAssignment[] = [
  {
    id: 400,
    project: { id: 100, name: 'Website' },
    task: { id: 200, name: 'Development' },
    is_active: true,
    billable: true,
    hourly_rate: 1200,
    budget: null,
    created_at: T,
    updated_at: T,
  },
  {
    id: 401,
    project: { id: 101, name: 'Retainer' },
    task: { id: 201, name: 'Meeting' },
    is_active: true,
    billable: false,
    hourly_rate: null,
    budget: null,
    created_at: T,
    updated_at: T,
  },
];

const ENTRIES: HarvestTimeEntry[] = [
  entry({
    id: 900,
    spent_date: '2025-12-30',
    user: { id: 1, name: 'Ada Example' },
    client: { id: 10, name: 'Alpha Client' },
    project: { id: 100, name: 'Website' },
    task: { id: 200, name: 'Development' },
    hours: 7.5,
    rounded_hours: 7.5,
    notes: 'Kickoff',
  }),
  entry({
    id: 901,
    spent_date: '2026-01-05',
    user: { id: 1, name: 'Ada Example' },
    client: { id: 10, name: 'Alpha Client' },
    project: { id: 100, name: 'Website' },
    task: { id: 200, name: 'Development' },
    hours: 2.25,
    rounded_hours: 2.5,
    is_locked: true,
    locked_reason: 'Item Invoiced',
    is_billed: true,
    invoice: { id: 700, number: 'A-1' },
  }),
  entry({
    id: 902,
    spent_date: '2026-01-06',
    user: { id: 2, name: 'Bob Example' },
    client: { id: 11, name: 'Beta Client' },
    project: { id: 101, name: 'Retainer' },
    task: { id: 201, name: 'Meeting' },
    hours: 1.1,
    billable: false,
    approval_status: 'approved',
  }),
  entry({
    id: 903,
    spent_date: '2026-01-07',
    user: { id: 2, name: 'Bob Example' },
    client: { id: 11, name: 'Beta Client' },
    project: { id: 101, name: 'Retainer' },
    task: { id: 201, name: 'Meeting' },
    hours: 0.4,
  }),
];

const INVOICE: HarvestInvoice = {
  id: 700,
  client: { id: 10, name: 'Alpha Client' },
  line_items: [
    {
      id: 710,
      kind: 'Service',
      description: 'Development',
      quantity: 7.5,
      unit_price: 1200,
      amount: 9000,
      taxed: true,
      taxed2: false,
      project: { id: 100, name: 'Website', code: 'WEB' },
    },
    {
      id: 711,
      kind: 'Service',
      description: 'Meeting',
      quantity: 1,
      unit_price: 1250,
      amount: 1250,
      taxed: true,
      taxed2: false,
      project: null,
    },
  ],
  estimate: null,
  retainer: null,
  creator: { id: 1, name: 'Ada Example' },
  client_key: 'abc123',
  number: 'A-1',
  purchase_order: null,
  amount: 12812.5,
  due_amount: 12812.5,
  tax: 25,
  tax_amount: 2562.5,
  tax2: null,
  tax2_amount: 0,
  discount: null,
  discount_amount: 0,
  subject: 'January',
  notes: null,
  currency: 'SEK',
  state: 'open',
  period_start: '2026-01-01',
  period_end: '2026-01-31',
  issue_date: '2026-01-31',
  due_date: '2026-02-28',
  payment_term: 'net 30',
  payment_options: [],
  sent_at: '2026-01-31T10:00:00Z',
  paid_at: null,
  paid_date: null,
  closed_at: null,
  recurring_invoice_id: null,
  created_at: T,
  updated_at: T,
};

const PAYMENT: HarvestInvoicePayment = {
  id: 720,
  invoice: { id: 700 },
  amount: 2812.5,
  paid_at: '2026-02-10T09:00:00Z',
  paid_date: '2026-02-10',
  recorded_by: 'Ada Example',
  recorded_by_email: 'ada@example.test',
  notes: null,
  transaction_reference: 'ref-1',
  payment_gateway: { id: 1, name: 'Bank' },
  created_at: T,
  updated_at: T,
};

const CONTACT: HarvestContact = {
  id: 500,
  client: { id: 10, name: 'Alpha Client' },
  title: 'Head of Ops',
  first_name: 'Cleo',
  last_name: 'Buyer',
  email: 'cleo@alpha.example.test',
  phone_office: null,
  phone_mobile: null,
  fax: null,
  invoice_recipient_status: 'primary',
  created_at: T,
  updated_at: T,
};

const TEAM: HarvestRole = { id: 600, name: 'Delivery', user_ids: [1, 2], created_at: T, updated_at: T };

const CATEGORY: HarvestExpenseCategory = {
  id: 800,
  name: 'Travel',
  unit_name: 'km',
  unit_price: 2.5,
  is_active: true,
  created_at: T,
  updated_at: T,
};

function expense(over: Partial<HarvestExpense> = {}): HarvestExpense {
  return {
    id: 850,
    spent_date: '2026-01-05',
    user: { id: 1, name: 'Ada Example' },
    user_assignment: null,
    client: { id: 10, name: 'Alpha Client', currency: 'SEK' },
    project: { id: 100, name: 'Website', code: 'WEB' },
    expense_category: { id: 800, name: 'Travel', unit_price: 2.5, unit_name: 'km' },
    invoice: null,
    receipt: null,
    notes: 'Train ticket',
    units: 120,
    total_cost: 300,
    billable: true,
    reimbursement: true,
    approval_status: 'unsubmitted',
    is_closed: false,
    is_locked: false,
    is_explicitly_locked: false,
    is_billed: false,
    locked_reason: null,
    created_at: T,
    updated_at: T,
    ...over,
  };
}

const RATES: HarvestUserRate[] = [
  { id: 870, user: { id: 1 }, amount: 1200, start_date: '2026-01-01', end_date: null, created_at: T, updated_at: T },
  { id: 871, user: { id: 1 }, amount: 1100, start_date: '2025-01-01', end_date: '2025-12-31', created_at: T, updated_at: T },
];

/** The whole account, freshly cloned so a case may edit its copy. */
function snapshot(): HarvestSnapshot {
  return structuredClone({
    company: COMPANY,
    users: [ADA, BOB],
    clients: [ALPHA, BETA],
    tasks: [DEVELOPMENT, MEETING],
    projects: [WEBSITE, RETAINER],
    user_assignments: USER_ASSIGNMENTS,
    task_assignments: TASK_ASSIGNMENTS,
    time_entries: ENTRIES,
    invoices: [INVOICE],
    invoice_payments: [PAYMENT],
    contacts: [CONTACT],
    roles: [TEAM],
    expense_categories: [CATEGORY],
    expenses: [expense()],
    user_billable_rates: RATES,
    user_cost_rates: [],
    teammates: [{ manager_id: 2, user_ids: [1] }],
  }) as HarvestSnapshot;
}

/** Hours as Harvest reported them: 7.5 + 2.25 + 1.1 + 0.4. */
const SOURCE_HOURS = 11.25;

// ── local helpers ────────────────────────────────────────────────────────────

function withDb<T>(fn: (db: Db, dir: string) => T): T {
  const fixture = tempDb();
  try {
    return fn(fixture.db, fixture.dir);
  } finally {
    fixture.cleanup();
  }
}

function one(db: Db, sql: string, ...args: (string | number)[]): Record<string, unknown> {
  const found = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
  assert.ok(found, `no row for ${sql}`);
  return plain(found);
}

// ── a first import ───────────────────────────────────────────────────────────

test('an import stores every record and reconciles the hours against Harvest', () =>
  withDb((db) => {
    const report = importSnapshot(db, snapshot());

    assert.equal(report.counts.users, 2);
    assert.equal(report.counts.clients, 2);
    assert.equal(report.counts.tasks, 2);
    assert.equal(report.counts.projects, 2);
    assert.equal(report.counts.user_assignments, 2);
    assert.equal(report.counts.task_assignments, 2);
    assert.equal(report.counts.time_entries, 4);
    assert.equal(report.counts.invoices, 1);
    assert.equal(report.counts.invoice_line_items, 2);
    assert.equal(report.counts.invoice_payments, 1);
    assert.equal(report.counts.contacts, 1);
    assert.equal(report.counts.roles, 1);
    assert.equal(report.counts.expense_categories, 1);
    assert.equal(report.counts.expenses, 1);
    assert.equal(report.counts.user_billable_rates, 2);
    assert.equal(report.counts.user_cost_rates, 0);
    assert.equal(report.counts.user_teammates, 1);

    assert.deepEqual(plain(report.reconciliation), {
      source_hours: SOURCE_HOURS,
      imported_hours: SOURCE_HOURS,
      difference: 0,
      matches: true,
      per_year: {
        2025: { source: 7.5, imported: 7.5, delta: 0 },
        2026: { source: 3.75, imported: 3.75, delta: 0 },
      },
    });
    assert.deepEqual(report.skipped, {});
    assert.equal(report.first_date, '2025-12-30');
    assert.equal(report.last_date, '2026-01-07');
    assert.equal(reportOk(report), true);
  }));

test('the invoice total reconciles in minor units, with no floating point slack', () =>
  withDb((db) => {
    const report = importSnapshot(db, snapshot());
    assert.deepEqual(plain(report.invoices!), {
      source_amount: 12812.5,
      imported_amount: 12812.5,
      difference: 0,
      matches: true,
    });
    assert.equal(one(db, 'SELECT amount FROM invoices WHERE id = 700').amount, 1281250, 'öre, as an integer');
  }));

test('a snapshot with no invoices leaves the invoice tables and the reconciliation alone', () =>
  withDb((db) => {
    const partial = snapshot();
    delete partial.invoices;
    delete partial.invoice_payments;
    const report = importSnapshot(db, partial);
    assert.equal(report.invoices, null, 'not fetched is not the same as none');
    assert.equal(report.counts.invoices, 0);
    assert.equal(reportOk(report), true);
  }));

test('a record keeps its Harvest id, so old links still resolve', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    for (const [table, id] of [
      ['users', 1], ['clients', 10], ['tasks', 200], ['projects', 100],
      ['user_assignments', 300], ['task_assignments', 400], ['time_entries', 900],
      ['invoices', 700], ['invoice_line_items', 710], ['invoice_payments', 720],
      ['contacts', 500], ['roles', 600], ['expense_categories', 800], ['expenses', 850],
    ] as const) {
      const row = one(db, `SELECT id, harvest_id FROM ${table} WHERE id = ?`, id);
      assert.equal(row.harvest_id, id, `${table}.harvest_id`);
    }
  }));

test('hours become integer seconds, and the rounded figure is kept apart', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    const billed = one(db, 'SELECT * FROM time_entries WHERE id = 901');
    assert.equal(billed.duration_seconds, 8100, '2.25 h');
    assert.equal(billed.rounded_seconds, 9000, '2.5 h after the account rounding rule');
    assert.equal(billed.source_hours, 2.25, 'the raw figure is kept for reconciliation');
    assert.equal(billed.is_billed, 1);
    assert.equal(billed.invoice_id, 700);
    assert.equal(billed.locked_reason, 'Item Invoiced');

    const unrounded = one(db, 'SELECT duration_seconds, rounded_seconds FROM time_entries WHERE id = 902');
    assert.equal(unrounded.duration_seconds, 3960, '1.1 h, rounded to the nearest second');
    assert.equal(unrounded.rounded_seconds, 3960, 'no rounded_hours means the entered duration');
  }));

test('money arrives as integer minor units everywhere it appears', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    assert.equal(one(db, 'SELECT default_billable_rate AS r FROM users WHERE id = 1').r, 120000);
    assert.equal(one(db, 'SELECT cost_rate AS r FROM users WHERE id = 2').r, 45000);
    assert.equal(one(db, 'SELECT default_hourly_rate AS r FROM tasks WHERE id = 200').r, 100000);
    assert.equal(one(db, 'SELECT default_hourly_rate AS r FROM tasks WHERE id = 201').r, null);
    assert.equal(one(db, 'SELECT hourly_rate AS r FROM projects WHERE id = 100').r, 120000);
    assert.equal(one(db, 'SELECT unit_price AS p FROM expense_categories WHERE id = 800').p, 250);
    assert.equal(one(db, 'SELECT total_cost AS c FROM expenses WHERE id = 850').c, 30000);
    assert.equal(one(db, 'SELECT amount AS a FROM invoice_payments WHERE id = 720').a, 281250);
    assert.equal(one(db, 'SELECT amount AS a FROM user_billable_rates WHERE id = 870').a, 120000);
  }));

test("a budget's unit follows budget_by, on the project and on its assignments", () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    // budget_by 'person' counts hours.
    const website = one(db, 'SELECT budget_seconds, budget_amount, budget_by FROM projects WHERE id = 100');
    assert.deepEqual(website, { budget_seconds: 144000, budget_amount: null, budget_by: 'person' });
    // budget_by 'project_cost' counts money.
    const retainer = one(db, 'SELECT budget_seconds, budget_amount, budget_by, fee FROM projects WHERE id = 101');
    assert.deepEqual(retainer, { budget_seconds: null, budget_amount: 5000000, budget_by: 'project_cost', fee: 5000000 });

    const perPerson = one(db, 'SELECT budget_seconds, budget_amount FROM user_assignments WHERE id = 300');
    assert.deepEqual(perPerson, { budget_seconds: 72000, budget_amount: null }, '20 h on a person-budgeted project');
    const perMoney = one(db, 'SELECT budget_seconds, budget_amount FROM user_assignments WHERE id = 301');
    assert.deepEqual(perMoney, { budget_seconds: null, budget_amount: 1000000 }, 'money on a cost-budgeted project');
  }));

test('the company record seeds the instance settings', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    const settings = readSettings(db);
    assert.equal(settings.companyName, 'Synthetic Studio');
    assert.equal(settings.currency, 'SEK');
    assert.equal(settings.weekStartDay, 1, 'Monday');
    assert.equal(settings.decimalSymbol, ',');
    assert.equal(settings.thousandsSeparator, ' ');
    assert.equal(settings.timeFormat, 'decimal');
  }));

test('a client with no currency of its own inherits the account currency', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    assert.equal(one(db, 'SELECT currency FROM clients WHERE id = 11').currency, 'SEK');
  }));

test("Harvest's grants decide the permission level and are kept verbatim beside it", () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    const ada = one(db, 'SELECT role, access_roles FROM users WHERE id = 1');
    assert.equal(ada.role, 'admin');
    assert.equal(ada.access_roles, '["administrator"]');
    const bob = one(db, 'SELECT role, access_roles FROM users WHERE id = 2');
    assert.equal(bob.role, 'manager', 'the highest grant wins');
    assert.deepEqual(JSON.parse(String(bob.access_roles)), ['manager', 'project_manager']);
  }));

test('an unrecognised grant is reported rather than silently demoting someone', () =>
  withDb((db) => {
    const data = snapshot();
    data.users[1]!.access_roles = ['time_lord', 'manager'];
    const report = importSnapshot(db, data);
    assert.equal(report.skipped['unknown_access_role:time_lord'], 1);
    assert.equal(one(db, 'SELECT role FROM users WHERE id = 2').role, 'manager', 'the known grant still counts');
  }));

test('an inactive record is stamped archived, an active one is not', () =>
  withDb((db) => {
    const data = snapshot();
    data.clients[1]!.is_active = false;
    data.clients[1]!.updated_at = '2026-02-01T00:00:00Z';
    importSnapshot(db, data);
    assert.equal(one(db, 'SELECT is_active, archived_at FROM clients WHERE id = 11').archived_at, '2026-02-01T00:00:00Z');
    assert.equal(one(db, 'SELECT archived_at FROM clients WHERE id = 10').archived_at, null);
  }));

test('the raw Harvest payload is kept beside every row', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    const stored = JSON.parse(String(one(db, 'SELECT source_json FROM time_entries WHERE id = 900').source_json));
    assert.equal(stored.id, 900);
    assert.equal(stored.notes, 'Kickoff');
    assert.equal(stored.hours, 7.5);
  }));

// ── running it again ─────────────────────────────────────────────────────────

test('a second identical import changes nothing', () =>
  withDb((db) => {
    const first = importSnapshot(db, snapshot());
    const second = importSnapshot(db, snapshot());

    assert.deepEqual(plain(second.counts), plain(first.counts), 'no row was duplicated');
    assert.deepEqual(plain(second.reconciliation), plain(first.reconciliation));
    assert.deepEqual(plain(second.invoices!), plain(first.invoices!));
    assert.equal(reportOk(second), true);
    // A third, for the same reason a second is worth having.
    assert.deepEqual(plain(importSnapshot(db, snapshot()).counts), plain(first.counts));
  }));

test('a changed record is updated in place rather than inserted beside itself', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    const changed = snapshot();
    changed.clients[0]!.name = 'Alpha Client AB';
    changed.clients[0]!.updated_at = '2026-03-01T00:00:00Z';
    changed.time_entries[0]!.hours = 8;
    changed.time_entries[0]!.rounded_hours = 8;

    const report = importSnapshot(db, changed);
    assert.equal(count(db, 'clients'), 2);
    assert.equal(one(db, 'SELECT name, updated_at FROM clients WHERE id = 10').name, 'Alpha Client AB');
    assert.equal(one(db, 'SELECT duration_seconds AS s FROM time_entries WHERE id = 900').s, 28800);
    assert.equal(report.reconciliation.source_hours, 11.75);
    assert.equal(report.reconciliation.matches, true);
  }));

test('an invoice line removed in Harvest is removed here, not left standing', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    assert.equal(count(db, 'invoice_line_items'), 2);

    const shorter = snapshot();
    shorter.invoices![0]!.line_items = [shorter.invoices![0]!.line_items[0]!];
    importSnapshot(db, shorter);
    assert.equal(count(db, 'invoice_line_items'), 1);
    assert.equal(one(db, 'SELECT id FROM invoice_line_items').id, 710);
  }));

test('a payment deleted in Harvest is deleted here, and one never fetched is left alone', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    assert.equal(count(db, 'invoice_payments'), 1);

    const withoutPayment = snapshot();
    withoutPayment.invoice_payments = [];
    importSnapshot(db, withoutPayment);
    assert.equal(count(db, 'invoice_payments'), 0, 'fetched-but-empty means there are none');

    importSnapshot(db, snapshot());
    const notFetched = snapshot();
    delete notFetched.invoice_payments;
    importSnapshot(db, notFetched);
    assert.equal(count(db, 'invoice_payments'), 1, 'absent means not fetched');
  }));

test('a person taken off a team is taken off it here too', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    assert.equal(count(db, 'role_members'), 2);
    const smaller = snapshot();
    smaller.roles![0]!.user_ids = [1];
    importSnapshot(db, smaller);
    assert.equal(count(db, 'role_members'), 1);
    assert.equal(one(db, 'SELECT user_id FROM role_members').user_id, 1);
  }));

// ── records this import could not place ──────────────────────────────────────

test('a record pointing at something absent is skipped and counted, never guessed at', () =>
  withDb((db) => {
    const data = snapshot();
    data.time_entries.push(
      entry({
        id: 999,
        spent_date: '2026-01-08',
        user: { id: 1, name: 'Ada Example' },
        client: { id: 10, name: 'Alpha Client' },
        project: { id: 555, name: 'Unknown' },
        task: { id: 200, name: 'Development' },
        hours: 3,
      }),
    );
    data.projects.push(project({ id: 102, name: 'Orphan', client: { id: 99, name: 'Gone' } }));
    data.contacts!.push({ ...CONTACT, id: 501, client: { id: 99, name: 'Gone' } });

    const report = importSnapshot(db, data);
    assert.equal(report.skipped.time_entries_unresolved, 1);
    assert.equal(report.skipped.projects_without_client, 1);
    assert.equal(report.skipped.contacts_without_client, 1);
    assert.equal(report.counts.time_entries, 4, 'the skipped entry was not stored');
    assert.equal(report.counts.projects, 2);

    // The skipped entry's three hours were in the source but not in the database, so the
    // reconciliation must report the gap rather than call the run healthy.
    assert.equal(report.reconciliation.source_hours, 14.25);
    assert.equal(report.reconciliation.imported_hours, SOURCE_HOURS);
    assert.equal(report.reconciliation.difference, -3);
    assert.equal(report.reconciliation.matches, false);
    assert.equal(reportOk(report), false);
  }));

test('a mismatched invoice total fails the run even when the hours agree', () =>
  withDb((db) => {
    const data = snapshot();
    data.invoices!.push({ ...INVOICE, id: 701, number: 'A-2', client: { id: 99, name: 'Gone' }, amount: 1000 });
    const report = importSnapshot(db, data);
    assert.equal(report.skipped.invoices_without_client, 1);
    assert.equal(report.reconciliation.matches, true, 'the hours are fine');
    assert.equal(report.invoices!.matches, false);
    assert.equal(report.invoices!.difference, -1000);
    assert.equal(reportOk(report), false);
  }));

// ── a partial (incremental) snapshot ─────────────────────────────────────────

test('a partial import reconciles only over the rows it carried', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());

    const delta: HarvestSnapshot = {
      ...snapshot(),
      time_entries: [
        entry({
          id: 904,
          spent_date: '2026-01-08',
          user: { id: 2, name: 'Bob Example' },
          client: { id: 11, name: 'Beta Client' },
          project: { id: 101, name: 'Retainer' },
          task: { id: 201, name: 'Meeting' },
          hours: 2,
          updated_at: '2026-01-08T12:00:00Z',
        }),
      ],
      invoices: [],
      invoice_payments: [],
    };

    const report = importSnapshot(db, delta, { partial: true });
    assert.equal(report.reconciliation.source_hours, 2);
    assert.equal(report.reconciliation.imported_hours, 2, 'thirteen years of history is not the comparison');
    assert.equal(report.reconciliation.matches, true);
    assert.equal(report.counts.time_entries, 5, 'the count is still the whole table');
    assert.deepEqual(report.invoices, {
      source_amount: 0,
      imported_amount: 0,
      difference: 0,
      matches: true,
    });
    assert.equal(reportOk(report), true);
  }));

test('the same delta imported twice is still one row', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    const delta: HarvestSnapshot = { ...snapshot(), time_entries: [{ ...ENTRIES[3]!, hours: 0.75 }] };
    importSnapshot(db, delta, { partial: true });
    const second = importSnapshot(db, delta, { partial: true });
    assert.equal(second.counts.time_entries, 4);
    assert.equal(one(db, 'SELECT duration_seconds AS s FROM time_entries WHERE id = 903').s, 2700);
    assert.equal(second.reconciliation.matches, true);
  }));

test('a full import after a partial one reconciles over everything again', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    importSnapshot(db, { ...snapshot(), time_entries: [ENTRIES[0]!] }, { partial: true });
    const full = importSnapshot(db, snapshot());
    assert.equal(full.reconciliation.source_hours, SOURCE_HOURS);
    assert.equal(full.reconciliation.imported_hours, SOURCE_HOURS);
    assert.equal(full.reconciliation.matches, true);
  }));

// ── local rows ───────────────────────────────────────────────────────────────

test('a record created here lands above every id Harvest will ever issue', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());

    const client = db
      .prepare("INSERT INTO clients (name, currency, created_at, updated_at) VALUES ('Local Client', 'SEK', ?, ?)")
      .run(T, T);
    assert.ok(Number(client.lastInsertRowid) >= LOCAL_BASE, `local client id ${client.lastInsertRowid}`);

    const project = db
      .prepare(
        `INSERT INTO projects (client_id, name, is_active, is_billable, created_at, updated_at)
         VALUES (?, 'Local Project', 1, 1, ?, ?)`,
      )
      .run(Number(client.lastInsertRowid), T, T);
    assert.ok(Number(project.lastInsertRowid) >= LOCAL_BASE);

    const entryRow = db
      .prepare(
        `INSERT INTO time_entries (spent_date, user_id, project_id, task_id, duration_seconds,
                                   rounded_seconds, created_at, updated_at)
         VALUES ('2026-02-01', 1, ?, 200, 3600, 3600, ?, ?)`,
      )
      .run(Number(project.lastInsertRowid), T, T);
    assert.ok(Number(entryRow.lastInsertRowid) >= LOCAL_BASE);
    assert.ok(Number(entryRow.lastInsertRowid) > 903, 'and above the imported range');
  }));

test('the local range is only ever raised, so a later import cannot pull ids back down', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    const first = db
      .prepare("INSERT INTO clients (name, currency, created_at, updated_at) VALUES ('One', 'SEK', ?, ?)")
      .run(T, T);
    importSnapshot(db, snapshot());
    const second = db
      .prepare("INSERT INTO clients (name, currency, created_at, updated_at) VALUES ('Two', 'SEK', ?, ?)")
      .run(T, T);
    assert.ok(Number(second.lastInsertRowid) > Number(first.lastInsertRowid), 'ids keep climbing');
  }));

// ── the administrator running the import ─────────────────────────────────────

/**
 * The person who ran the setup wizard, as they exist before the first import: no Harvest id,
 * a password, and an id in the local range (migration 006).
 */
function insertLocalAdmin(db: Db, email: string, id = LOCAL_BASE + 1): number {
  db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active, password_hash,
                        created_at, updated_at)
     VALUES (?, ?, 'Local', 'Owner', 'admin', 1, 'hash-kept', ?, ?)`,
  ).run(id, email, T, T);
  return id;
}

test('a local account is adopted by email, keeping its password and gaining its Harvest id', () =>
  withDb((db) => {
    const localId = insertLocalAdmin(db, 'ada@example.test');
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('session-1', ?, ?, ?)`,
    ).run(localId, T, '2030-01-01T00:00:00Z');

    const report = importSnapshot(db, snapshot());
    assert.equal(report.counts.users, 2, 'adopted, not duplicated');
    const ada = one(db, "SELECT id, password_hash, harvest_id FROM users WHERE email = 'ada@example.test'");
    assert.equal(ada.id, 1, 'the row now wears its Harvest id');
    assert.equal(ada.harvest_id, 1);
    assert.equal(ada.password_hash, 'hash-kept');
    assert.equal(one(db, "SELECT user_id FROM sessions WHERE id = 'session-1'").user_id, 1, 'the session followed');
  }));

test('an import never demotes or deactivates an administrator who can sign in here', () =>
  withDb((db) => {
    insertLocalAdmin(db, 'bob@example.test');

    const data = snapshot();
    data.users[1]!.is_active = false;
    data.users[1]!.access_roles = ['member'];

    importSnapshot(db, data);
    const bob = one(db, 'SELECT role, is_active, archived_at, access_roles FROM users WHERE id = 2');
    assert.equal(bob.role, 'admin', 'this instance made them an admin deliberately');
    assert.equal(bob.is_active, 1);
    assert.equal(bob.archived_at, null);
    assert.equal(bob.access_roles, '["member"]', "Harvest's grants are still recorded");
  }));

test('a person with no local account is simply inserted, and keeps no password', () =>
  withDb((db) => {
    importSnapshot(db, snapshot());
    assert.equal(one(db, 'SELECT password_hash FROM users WHERE id = 2').password_hash, null);
  }));

// ── rows created here before the first import ────────────────────────────────
//
// Before any import has parked the sequences, a row made in this app takes the next small
// autoincrement id: "Start fresh" gives the first administrator id 1. Nothing stops Harvest
// from holding a *different* record with that same number, and every upsert keys on id.

function insertToken(db: Db, userId: number): void {
  db.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at)
     VALUES (?, 'integration', ?, 'tt_test', ?)`,
  ).run(userId, `hash-${userId}-${Math.random()}`, T);
}

test("a local account on a Harvest person's id is moved aside, not overwritten by them", () =>
  withDb((db) => {
    // Exactly what "Start fresh" leaves behind: id 1, a password, a session and a token.
    insertLocalAdmin(db, 'owner@example.test', 1);
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('owner-session', 1, ?, ?)`,
    ).run(T, '2030-01-01T00:00:00Z');
    insertToken(db, 1);

    const report = importSnapshot(db, snapshot());

    // Harvest's Ada gets id 1, as a Harvest person: her own email, and no password of anyone's.
    const ada = one(db, 'SELECT email, harvest_id, password_hash FROM users WHERE id = 1');
    assert.equal(ada.email, 'ada@example.test');
    assert.equal(ada.harvest_id, 1, 'the importer can find her again');
    assert.equal(ada.password_hash, null, "she must not inherit the local owner's password");

    // The owner still exists, with their own credentials, above the Harvest range.
    const owner = one(db, "SELECT id, harvest_id, password_hash, role FROM users WHERE email = 'owner@example.test'");
    assert.ok(Number(owner.id) > LOCAL_BASE, 'moved into the local range');
    assert.equal(owner.harvest_id, null);
    assert.equal(owner.password_hash, 'hash-kept');
    assert.equal(owner.role, 'admin');
    assert.equal(one(db, "SELECT user_id FROM sessions WHERE id = 'owner-session'").user_id, owner.id);
    assert.equal(one(db, 'SELECT user_id FROM api_tokens').user_id, owner.id);

    // And none of Ada's work was dropped as belonging to nobody.
    assert.equal(report.skipped.time_entries_unresolved, undefined);
    assert.equal(count(db, 'time_entries', 'user_id = 1'), snapshot().time_entries.filter((e) => e.user.id === 1).length);
    assert.equal(reportOk(report), true, 'the run reconciles');

    // The next account made here must not be handed the id the owner was moved to.
    const next = db
      .prepare(
        `INSERT INTO users (email, first_name, last_name, role, is_active, created_at, updated_at)
         VALUES ('new@example.test', 'New', 'Person', 'member', 1, ?, ?)`,
      )
      .run(T, T);
    assert.ok(Number(next.lastInsertRowid) > Number(owner.id));

    // Running the same import again moves nobody: the owner is already clear of Harvest's ids.
    importSnapshot(db, snapshot());
    assert.equal(one(db, "SELECT id FROM users WHERE email = 'owner@example.test'").id, owner.id);
  }));

test("a local client on a Harvest client's id is moved aside, and its projects go with it", () =>
  withDb((db) => {
    const alphaId = snapshot().clients.find((c) => c.name === 'Alpha Client')!.id;
    db.prepare(
      `INSERT INTO clients (id, name, currency, is_active, created_at, updated_at)
       VALUES (?, 'Local Client', 'EUR', 1, ?, ?)`,
    ).run(alphaId, T, T);
    db.prepare(
      `INSERT INTO projects (id, client_id, name, is_active, is_billable, created_at, updated_at)
       VALUES (?, ?, 'Local Project', 1, 1, ?, ?)`,
    ).run(LOCAL_BASE + 5, alphaId, T, T);

    const report = importSnapshot(db, snapshot());

    const alpha = one(db, 'SELECT name, harvest_id FROM clients WHERE id = ?', alphaId);
    assert.equal(alpha.name, 'Alpha Client');
    assert.equal(alpha.harvest_id, alphaId);

    const local = one(db, "SELECT id, harvest_id FROM clients WHERE name = 'Local Client'");
    assert.ok(Number(local.id) > LOCAL_BASE);
    assert.equal(local.harvest_id, null);
    assert.equal(
      one(db, "SELECT client_id FROM projects WHERE name = 'Local Project'").client_id,
      local.id,
      'the local project still belongs to the local client, not to Alpha',
    );
    assert.equal(report.skipped.projects_unresolved, undefined);
    assert.equal(reportOk(report), true);
  }));

test('adopting a local account by email carries every row that points at it', () =>
  withDb((db) => {
    // Not on a Harvest id, so this is purely the adoption path: 7 becomes Ada's 1.
    insertLocalAdmin(db, 'ada@example.test', 7);
    insertToken(db, 7);

    const report = importSnapshot(db, snapshot());

    assert.equal(one(db, "SELECT id FROM users WHERE email = 'ada@example.test'").id, 1);
    assert.equal(one(db, 'SELECT user_id FROM api_tokens').user_id, 1, 'the token followed its owner');
    assert.equal(count(db, 'users', 'id = 7'), 0);
    assert.equal(reportOk(report), true);
  }));

// ── receipts ─────────────────────────────────────────────────────────────────

test('a downloaded receipt is copied into the instance folder and named by the expense', () =>
  withDb((db, dir) => {
    const downloads = join(dir, 'downloads');
    mkdirSync(downloads, { recursive: true });
    const source = join(downloads, '850.pdf');
    writeFileSync(source, '%PDF-synthetic');

    const receipts = join(dir, 'receipts');
    const data = snapshot();
    data.expenses = [
      expense({
        receipt: { url: 'https://cache.harvestapp.com/r/850.pdf', file_name: 'ticket.PDF', file_size: 14, content_type: 'application/pdf' },
        receipt_file: source,
      }),
    ];

    importSnapshot(db, data, { receiptDir: receipts });
    const stored = one(db, 'SELECT receipt_path, receipt_file_name, receipt_content_type FROM expenses WHERE id = 850');
    assert.equal(stored.receipt_path, '850.pdf', 'named by the expense, not by the upload');
    assert.equal(stored.receipt_file_name, 'ticket.PDF');
    assert.equal(stored.receipt_content_type, 'application/pdf');
    assert.ok(existsSync(join(receipts, '850.pdf')));
    assert.equal(readFileSync(join(receipts, '850.pdf'), 'utf8'), '%PDF-synthetic');
  }));

test('a receipt already kept is not forgotten because the next snapshot carried no file', () =>
  withDb((db, dir) => {
    const receipts = join(dir, 'receipts');
    mkdirSync(receipts, { recursive: true });
    const source = join(receipts, '850.pdf');
    writeFileSync(source, '%PDF-synthetic');

    const withFile = snapshot();
    withFile.expenses = [
      expense({
        receipt: { url: 'https://cache.harvestapp.com/r/850.pdf', file_name: 'ticket.pdf', file_size: 14, content_type: 'application/pdf' },
        receipt_file: source,
      }),
    ];
    importSnapshot(db, withFile, { receiptDir: receipts });

    importSnapshot(db, snapshot(), { receiptDir: receipts });
    assert.equal(one(db, 'SELECT receipt_path FROM expenses WHERE id = 850').receipt_path, '850.pdf');
  }));

test('with nowhere to keep receipts, an expense is still imported and describes its file', () =>
  withDb((db) => {
    const data = snapshot();
    data.expenses = [
      expense({
        receipt: { url: 'https://cache.harvestapp.com/r/850.pdf', file_name: 'ticket.pdf', file_size: 14, content_type: 'application/pdf' },
      }),
    ];
    importSnapshot(db, data);
    const stored = one(db, 'SELECT receipt_path, receipt_url FROM expenses WHERE id = 850');
    assert.equal(stored.receipt_path, null);
    assert.equal(stored.receipt_url, 'https://cache.harvestapp.com/r/850.pdf');
  }));

// ── the run record ───────────────────────────────────────────────────────────

test('a run is recorded with its report, its cursor and whether it reconciled', () =>
  withDb((db) => {
    const report = importSnapshot(db, snapshot());
    recordRun(db, 'harvest-dump', report, '2026-01-08T09:00:00Z', '2026-01-08T08:00:00Z');

    const run = one(db, 'SELECT * FROM import_runs ORDER BY id DESC LIMIT 1');
    assert.equal(run.source, 'harvest-dump');
    assert.equal(run.status, 'ok');
    assert.equal(run.started_at, '2026-01-08T08:00:00Z');
    assert.equal(run.cursor_updated_since, '2026-01-08T09:00:00Z');
    assert.ok(String(run.finished_at).endsWith('Z'));
    assert.equal(JSON.parse(String(run.stats_json)).reconciliation.matches, true);
  }));

test('a run that did not reconcile is recorded as failed, and a parked cursor stays null', () =>
  withDb((db) => {
    const data = snapshot();
    data.time_entries.push(
      entry({
        id: 998,
        spent_date: '2026-01-09',
        user: { id: 1, name: 'Ada Example' },
        client: { id: 10, name: 'Alpha Client' },
        project: { id: 555, name: 'Unknown' },
        task: { id: 200, name: 'Development' },
        hours: 1,
      }),
    );
    const report = importSnapshot(db, data);
    recordRun(db, 'harvest-dump', report, null);
    const run = one(db, 'SELECT status, cursor_updated_since FROM import_runs ORDER BY id DESC LIMIT 1');
    assert.equal(run.status, 'failed');
    assert.equal(run.cursor_updated_since, null);
  }));
