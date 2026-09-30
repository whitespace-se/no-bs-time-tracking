import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/lib/db/index.ts';
import { applyHarvestSettings, type HarvestSettings } from '../src/lib/harvest/settings.ts';
import { importTimeCsv } from '../src/lib/import/csv.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';

// Two projects, one of them fixed fee, for one client with a Swedish name, logged by two people.
const csv = `Date,Client,Project,Project Code,Task,Hours,Hours Rounded,Billable?,Invoiced?,First Name,Last Name,Billable Rate,Cost Rate
2026-05-04,Ängelholms Kommun,Webb,ÄK1,Utveckling,2,2,Yes,No,Åsa,Öberg,1000,400
2026-05-05,Ängelholms Kommun,Fastpris,ÄK2,Utveckling,3,3,Yes,No,Åsa,Öberg,1000,400
2026-05-05,Ängelholms Kommun,Fastpris,ÄK2,Utveckling,1,1,Yes,No,Paul,Brotherton,900,0
`;

const at = '2026-01-01T00:00:00Z';
const later = '2026-06-01T00:00:00Z';
const ref = (id: number, name: string) => ({ id, name });
const project = (id: number, name: string, code: string, fixed: boolean, extra: object = {}) => ({
  id, client: ref(10, 'Ängelholms kommun'), name, code, is_active: true, is_billable: true, is_fixed_fee: fixed,
  bill_by: fixed ? 'none' : 'Project', hourly_rate: fixed ? null : 1100, budget: fixed ? null : 40,
  budget_by: fixed ? 'none' : 'project', budget_is_monthly: false, notify_when_over_budget: false,
  over_budget_notification_percentage: null, show_budget_to_all: false, cost_budget: null,
  cost_budget_include_expenses: false, fee: fixed ? 50000 : null, notes: null, starts_on: null, ends_on: null,
  created_at: at, updated_at: at, ...extra,
});
const user = (id: number, first: string, last: string, email: string, extra: object = {}) => ({
  id, first_name: first, last_name: last, email, telephone: '', timezone: 'Europe/Stockholm',
  has_access_to_all_future_projects: false, is_contractor: false, is_active: true, weekly_capacity: 144000,
  default_hourly_rate: 1000, cost_rate: 400, roles: [], access_roles: ['member'], avatar_url: null,
  created_at: at, updated_at: at, ...extra,
});

const harvest = {
  users: [
    user(1, 'Åsa', 'Öberg', 'asa@example.test', { access_roles: ['manager'] }),
    // Two accounts under one name: the active one is the person's.
    user(2, 'Paul', 'Brotherton', 'paul.old@example.test', { is_active: false, updated_at: later }),
    user(3, 'Paul', 'Brotherton', 'paul@example.test'),
  ],
  clients: [{ id: 10, name: 'Ängelholms kommun', is_active: true, address: 'Storgatan 1', currency: 'SEK', created_at: at, updated_at: at }],
  tasks: [{ id: 20, name: 'Utveckling', billable_by_default: true, default_hourly_rate: 950, is_default: true, is_active: true, created_at: at, updated_at: at }],
  projects: [project(30, 'Webb', 'ÄK1', false), project(31, 'Fastpris', 'ÄK2', true), project(32, 'Only in Harvest', 'X', false)],
  user_assignments: [{ id: 40, project: ref(30, 'Webb'), user: ref(1, 'Åsa Öberg'), is_active: true, is_project_manager: true, use_default_rates: false, hourly_rate: 1200, budget: null, created_at: at, updated_at: at }],
  task_assignments: [{ id: 50, project: ref(30, 'Webb'), task: ref(20, 'Utveckling'), is_active: true, billable: true, hourly_rate: 1150, budget: null, created_at: at, updated_at: at }],
} as unknown as HarvestSettings;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-test-'));
  const database = openDb(join(dir, 'test.db'));
  importTimeCsv(database, csv, DEFAULT_SETTINGS);
  return { database, cleanup: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Harvest settings mark the fixed-fee project and fill in what the CSV lacked', () => {
  const { database, cleanup } = fixture();
  try {
    const report = applyHarvestSettings(database, harvest);
    assert.deepEqual(report.projects, { matched: 2, unmatched: 1, fixedFee: 1 });
    assert.deepEqual(report.unmatchedProjects, []);

    const projects = database.prepare('SELECT name, is_fixed_fee, bill_by, hourly_rate, fee, budget_seconds FROM projects ORDER BY name').all().map((row) => ({ ...row }));
    assert.deepEqual(projects, [
      { name: 'Fastpris', is_fixed_fee: 1, bill_by: 'none', hourly_rate: null, fee: 5000000, budget_seconds: null },
      { name: 'Webb', is_fixed_fee: 0, bill_by: 'Project', hourly_rate: 110000, fee: null, budget_seconds: 144000 },
    ]);
    // Names with Å and Ä match whatever their case: SQLite's lower() leaves them alone.
    assert.equal((database.prepare("SELECT address FROM clients").get() as { address: string }).address, 'Storgatan 1');
    assert.equal((database.prepare("SELECT default_hourly_rate AS r FROM tasks").get() as { r: number }).r, 95000);

    const people = database.prepare('SELECT first_name, email, role, weekly_capacity_seconds FROM users ORDER BY first_name').all().map((row) => ({ ...row }));
    assert.deepEqual(people, [
      { first_name: 'Åsa', email: 'asa@example.test', role: 'manager', weekly_capacity_seconds: 144000 },
      { first_name: 'Paul', email: 'paul@example.test', role: 'member', weekly_capacity_seconds: 144000 },
    ].sort((a, b) => (a.first_name < b.first_name ? -1 : 1)));

    const ua = database.prepare('SELECT ua.is_project_manager, ua.use_default_rates, ua.hourly_rate FROM user_assignments ua JOIN projects p ON p.id = ua.project_id JOIN users u ON u.id = ua.user_id WHERE p.name = ? AND u.first_name = ?').get('Webb', 'Åsa');
    assert.deepEqual({ ...ua }, { is_project_manager: 1, use_default_rates: 0, hourly_rate: 120000 });
    const ta = database.prepare('SELECT ta.billable, ta.hourly_rate FROM task_assignments ta JOIN projects p ON p.id = ta.project_id WHERE p.name = ?').get('Webb');
    assert.deepEqual({ ...ta }, { billable: 1, hourly_rate: 115000 });

    // Time entries are untouched: same count, same rates.
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM time_entries').get() as { n: number }).n, 3);
    assert.equal((database.prepare('SELECT SUM(billable_rate) AS s FROM time_entries').get() as { s: number }).s, 290000);
  } finally {
    cleanup();
  }
});

test('an administrator who can sign in keeps their role and access', () => {
  const { database, cleanup } = fixture();
  try {
    database.prepare("UPDATE users SET role = 'admin', password_hash = 'x' WHERE first_name = 'Åsa'").run();
    applyHarvestSettings(database, { ...harvest, users: [user(1, 'Åsa', 'Öberg', 'asa@example.test', { is_active: false, access_roles: ['member'] })] });
    const asa = database.prepare("SELECT role, is_active, archived_at FROM users WHERE first_name = 'Åsa'").get();
    assert.deepEqual({ ...asa }, { role: 'admin', is_active: 1, archived_at: null });
  } finally {
    cleanup();
  }
});

test('an email already held by another account is not taken', () => {
  const { database, cleanup } = fixture();
  try {
    database.prepare("UPDATE users SET email = 'paul@example.test' WHERE first_name = 'Åsa'").run();
    const report = applyHarvestSettings(database, harvest);
    const paul = database.prepare("SELECT email FROM users WHERE first_name = 'Paul'").get() as { email: string };
    assert.match(paul.email, /@invalid\.local$/);
    assert.equal(report.users.emails, 0);
  } finally {
    cleanup();
  }
});

test('a CSV import after the settings leaves Harvest billing alone', () => {
  const { database, cleanup } = fixture();
  try {
    applyHarvestSettings(database, harvest);
    importTimeCsv(database, csv, DEFAULT_SETTINGS);
    const webb = database.prepare("SELECT bill_by, hourly_rate, is_fixed_fee FROM projects WHERE name = 'Webb'").get();
    assert.deepEqual({ ...webb }, { bill_by: 'Project', hourly_rate: 110000, is_fixed_fee: 0 });
    assert.equal((database.prepare("SELECT is_fixed_fee FROM projects WHERE name = 'Fastpris'").get() as { is_fixed_fee: number }).is_fixed_fee, 1);
  } finally {
    cleanup();
  }
});

test('time on a project Harvest has archived is locked as Harvest locks it, and released when active again', () => {
  const { database, cleanup } = fixture();
  try {
    const archived = { ...harvest, projects: [project(30, 'Webb', 'ÄK1', false, { is_active: false, updated_at: later }), project(31, 'Fastpris', 'ÄK2', true)] } as HarvestSettings;
    database.prepare("UPDATE time_entries SET is_billed = 1 WHERE spent_date = '2026-05-04'").run();
    applyHarvestSettings(database, archived);
    const locks = () => database.prepare(`SELECT te.is_locked, te.locked_reason FROM time_entries te JOIN projects p ON p.id = te.project_id
      WHERE p.name = 'Webb'`).all().map((row) => ({ ...row }));
    assert.deepEqual(locks(), [{ is_locked: 1, locked_reason: 'Item Invoiced and Archived' }]);

    applyHarvestSettings(database, harvest);
    assert.deepEqual(locks(), [{ is_locked: 1, locked_reason: 'Item Invoiced' }]);
  } finally {
    cleanup();
  }
});
