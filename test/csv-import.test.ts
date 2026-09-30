import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/lib/db/index.ts';
import { csvKind, importCsvFiles, importInvoiceCsv, importTimeCsv } from '../src/lib/import/csv.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';

const sample = `Date,Client,Project,Project Code,Task,Notes,Hours,Rounded Hours,First Name,Last Name,Email,Billable,Invoiced
2026-07-02,Example Client,Migration,EX-1,Consulting,Planning,"0,20","0,25",Ada,Lovelace,ada@example.test,Yes,No
2026-07-03,Example Client,Migration,EX-1,Consulting,Delivery,1:30,1:30,Ada,Lovelace,ada@example.test,Yes,Yes
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-test-'));
  const database = openDb(join(dir, 'test.db'));
  return { database, cleanup: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('imports a Harvest time CSV with exact rounded values and relationships', () => {
  const { database, cleanup } = fixture();
  try {
    const report = importTimeCsv(database, sample, { ...DEFAULT_SETTINGS, roundToHours: 0.25, roundingStyle: 'round' });
    assert.equal(report.rows, 2);
    assert.equal(report.imported, 2);
    assert.equal(report.updated, 0);
    assert.equal(report.sourceSeconds, 6120);

    const entries = database.prepare('SELECT duration_seconds, rounded_seconds, billable, is_billed FROM time_entries ORDER BY spent_date').all().map((row) => ({ ...row }));
    assert.deepEqual(entries, [
      { duration_seconds: 720, rounded_seconds: 900, billable: 1, is_billed: 0 },
      { duration_seconds: 5400, rounded_seconds: 5400, billable: 1, is_billed: 1 },
    ]);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
  } finally {
    cleanup();
  }
});

test('an exact CSV re-import updates instead of duplicating entries', () => {
  const { database, cleanup } = fixture();
  try {
    importTimeCsv(database, sample, DEFAULT_SETTINGS);
    const second = importTimeCsv(database, sample, DEFAULT_SETTINGS);
    assert.equal(second.imported, 0);
    assert.equal(second.updated, 2);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM time_entries').get() as { n: number }).n, 2);
  } finally {
    cleanup();
  }
});

test('rejects ambiguous localized dates instead of guessing', () => {
  const { database, cleanup } = fixture();
  try {
    const ambiguous = sample.replace('2026-07-02', '07/08/2026');
    assert.throws(() => importTimeCsv(database, ambiguous, DEFAULT_SETTINGS), /ambiguous date/);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM time_entries').get() as { n: number }).n, 0);
  } finally {
    cleanup();
  }
});

// The headers Harvest's own time report export uses: questions for the flags, Hours Rounded.
const harvestTime = `Date,Client,Project,Project Code,Task,Notes,Hours,Hours Rounded,Billable?,Invoiced?,Approved?,First Name,Last Name,Roles,Employee?,Billable Rate,Billable Amount,Cost Rate,Cost Amount,Currency,External Reference URL
2026-07-02,Example Client,Migration,EX-1,Consulting,Planning,0.20,0.25,Yes,No,No,Ada,Lovelace,,Yes,1000,250,0,0,Swedish Krona - SEK,
2026-07-03,Example Client,Migration,EX-1,Consulting,Delivery,1.50,1.50,No,Yes,No,Ada,Lovelace,,Yes,1000,1500,0,0,Swedish Krona - SEK,
`;

// Title lines, a currency section, a totals row: the shape of Harvest's invoice report.
const harvestInvoices = `Invoice Report,,,,,,,
,,,,,,,
Status,Issue Date,Paid,ID,Client,Invoice Amount,Paid Amount,Balance
SEK,,,,,,,
Paid,2026-07-31,12 days,2026-001,Example Client,"12 500,00","12 500,00","0,00"
Open,2026-08-31,,2026-002,Example Client,"1,234.50",0.00,"1,234.50"
Draft,2026-09-10,,2026-003,New Client,500,,
,,,Total,,"14 234,50","12 500,00","1 734,50"
`;

test('reads the flags, rounding and rates from the headers Harvest actually exports', () => {
  const { database, cleanup } = fixture();
  try {
    importTimeCsv(database, harvestTime, DEFAULT_SETTINGS);
    const entries = database.prepare('SELECT rounded_seconds, billable, is_billed, billable_rate, cost_rate FROM time_entries ORDER BY spent_date').all().map((row) => ({ ...row }));
    assert.deepEqual(entries, [
      { rounded_seconds: 900, billable: 1, is_billed: 0, billable_rate: 100000, cost_rate: 0 },
      { rounded_seconds: 5400, billable: 0, is_billed: 1, billable_rate: null, cost_rate: 0 },
    ]);
    // What Reports sums as the billable amount: 0.25 h at 1 000 an hour.
    const billable = database.prepare('SELECT SUM(billable_rate * rounded_seconds / 3600.0) AS amount FROM time_entries WHERE billable = 1').get() as { amount: number };
    assert.equal(billable.amount, 25000);
  } finally {
    cleanup();
  }
});

test('tells a time report from an invoice report by its header', () => {
  assert.equal(csvKind(harvestTime), 'time');
  assert.equal(csvKind(sample), 'time');
  assert.equal(csvKind(harvestInvoices), 'invoices');
  assert.equal(csvKind('Name,Colour\nAda,blue\n'), null);
});

test('imports an invoice report, skipping its headings and totals', () => {
  const { database, cleanup } = fixture();
  try {
    const report = importInvoiceCsv(database, harvestInvoices, { ...DEFAULT_SETTINGS, currency: 'EUR' });
    assert.equal(report.imported, 3);
    assert.equal(report.rows, 3);
    const invoices = database.prepare('SELECT number, state, currency, amount, due_amount, issue_date FROM invoices ORDER BY number').all().map((row) => ({ ...row }));
    assert.deepEqual(invoices, [
      { number: '2026-001', state: 'paid', currency: 'SEK', amount: 1250000, due_amount: 0, issue_date: '2026-07-31' },
      { number: '2026-002', state: 'open', currency: 'SEK', amount: 123450, due_amount: 123450, issue_date: '2026-08-31' },
      { number: '2026-003', state: 'draft', currency: 'SEK', amount: 50000, due_amount: 50000, issue_date: '2026-09-10' },
    ]);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n, 2);

    const again = importInvoiceCsv(database, harvestInvoices, DEFAULT_SETTINGS);
    assert.equal(again.imported, 0);
    assert.equal(again.updated, 3);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n, 3);
  } finally {
    cleanup();
  }
});

test('imports both files of an export together, in either order', () => {
  const { database, cleanup } = fixture();
  try {
    const report = importCsvFiles(database, [
      { name: 'harvest_invoice_report.csv', text: harvestInvoices },
      { name: 'harvest_time_report.csv', text: harvestTime },
    ], DEFAULT_SETTINGS);
    assert.equal(report.time?.imported, 2);
    assert.equal(report.invoices?.imported, 3);
    // The invoice for the time report's client lands on the client the time report created.
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM clients WHERE name = 'Example Client'").get() as { n: number }).n, 1);
  } finally {
    cleanup();
  }
});

test('a failing file leaves nothing from the others behind', () => {
  const { database, cleanup } = fixture();
  try {
    const broken = harvestInvoices.replace('2026-08-31', '08/09/2026');
    assert.throws(() => importCsvFiles(database, [
      { name: 'time.csv', text: harvestTime },
      { name: 'invoices.csv', text: broken },
    ], DEFAULT_SETTINGS), /ambiguous date/);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM time_entries').get() as { n: number }).n, 0);
    assert.throws(() => importCsvFiles(database, [{ name: 'other.csv', text: 'Name\nAda\n' }], DEFAULT_SETTINGS), /neither/);
  } finally {
    cleanup();
  }
});

test('a re-import fills in the rates on entries imported before they were read', () => {
  const { database, cleanup } = fixture();
  try {
    importTimeCsv(database, harvestTime, DEFAULT_SETTINGS);
    database.prepare('UPDATE time_entries SET billable_rate = NULL, cost_rate = NULL').run();
    importTimeCsv(database, harvestTime, DEFAULT_SETTINGS);
    const rates = database.prepare('SELECT billable_rate FROM time_entries WHERE billable = 1').all().map((row) => ({ ...row }));
    assert.deepEqual(rates, [{ billable_rate: 100000 }]);
  } finally {
    cleanup();
  }
});

// Harvest's real invoice report: no status column, currency by name, space thousands.
const statuslessInvoices = `Issue Date,Last Payment Date,ID,PO Number,Client,Subject,Invoice Amount,Paid Amount,Balance,Subtotal,Discount,Tax,Tax2,Currency,Currency Symbol,Document Type
2026-01-10,2026-02-01,101,"",Example Client,Paid in full,"20 160,0","20 160,0","0,0","16 128,0","0,0","4 032,0","0,0",Swedish Krona - SEK,kr,Standard Invoice
2026-01-11,"",102,"",Example Client,Written off,"1 000,0","0,0",0,"1 000,0","0,0","0,0","0,0",Swedish Krona - SEK,kr,Standard Invoice
2026-01-12,"",103,"",Example Client,Still owed,"500,0","0,0","500,0","500,0","0,0","0,0","0,0",Euro - EUR,€,Standard Invoice
`;

test('reads state, currency and tax from an invoice report with no status column', () => {
  const { database, cleanup } = fixture();
  try {
    importInvoiceCsv(database, statuslessInvoices, DEFAULT_SETTINGS);
    const invoices = database.prepare('SELECT number, state, currency, amount, due_amount, tax_amount FROM invoices ORDER BY number').all().map((row) => ({ ...row }));
    assert.deepEqual(invoices, [
      { number: '101', state: 'paid', currency: 'SEK', amount: 2016000, due_amount: 0, tax_amount: 403200 },
      { number: '102', state: 'closed', currency: 'SEK', amount: 100000, due_amount: 0, tax_amount: 0 },
      { number: '103', state: 'open', currency: 'EUR', amount: 50000, due_amount: 50000, tax_amount: 0 },
    ]);
  } finally {
    cleanup();
  }
});

const billingCsv = `Date,Client,Project,Task,Hours,Hours Rounded,Billable?,Invoiced?,First Name,Last Name,Employee?,Billable Rate,Cost Rate,Currency
2026-03-02,Example Client,One Rate,Consulting,1,1,Yes,Yes,Ada,Lovelace,Yes,900,400,Swedish Krona - SEK
2026-04-02,Example Client,One Rate,Consulting,1,1,Yes,No,Ada,Lovelace,Yes,1000,400,Swedish Krona - SEK
2026-04-03,Example Client,One Rate,Consulting,1,1,Yes,No,Grace,Hopper,No,1000,500,Swedish Krona - SEK
2026-04-02,Example Client,Per Person,Consulting,1,1,Yes,No,Ada,Lovelace,Yes,1000,400,Swedish Krona - SEK
2026-04-03,Example Client,Per Person,Consulting,1,1,Yes,No,Grace,Hopper,No,1200,500,Swedish Krona - SEK
2026-04-03,Example Client,Internal,Admin,1,1,No,No,Grace,Hopper,No,0,500,Swedish Krona - SEK
`;

test('invoiced time comes in locked, as Harvest locks it', () => {
  const { database, cleanup } = fixture();
  try {
    importTimeCsv(database, billingCsv, DEFAULT_SETTINGS);
    const locks = database.prepare('SELECT is_billed, is_locked, locked_reason FROM time_entries ORDER BY is_billed DESC LIMIT 2').all().map((row) => ({ ...row }));
    assert.deepEqual(locks, [
      { is_billed: 1, is_locked: 1, locked_reason: 'Item Invoiced' },
      { is_billed: 0, is_locked: 0, locked_reason: null },
    ]);
  } finally {
    cleanup();
  }
});

test('each project bills at the rate it was last billed at, so new time is priced', () => {
  const { database, cleanup } = fixture();
  try {
    const report = importTimeCsv(database, billingCsv, DEFAULT_SETTINGS);
    assert.equal(report.currency, 'SEK');
    const projects = database.prepare('SELECT name, bill_by, hourly_rate, is_billable FROM projects ORDER BY name').all().map((row) => ({ ...row }));
    assert.deepEqual(projects, [
      // No billable time, so no billing mode and not billable.
      { name: 'Internal', bill_by: null, hourly_rate: null, is_billable: 0 },
      // Both people were last billed at 1 000: the project's rate, not Ada's older 900.
      { name: 'One Rate', bill_by: 'Project', hourly_rate: 100000, is_billable: 1 },
      // Different rates per person: each person's own.
      { name: 'Per Person', bill_by: 'People', hourly_rate: null, is_billable: 1 },
    ]);
    const perPerson = database.prepare(`SELECT u.first_name, ua.use_default_rates, ua.hourly_rate FROM user_assignments ua
      JOIN projects p ON p.id = ua.project_id JOIN users u ON u.id = ua.user_id WHERE p.name = 'Per Person' ORDER BY u.first_name`).all().map((row) => ({ ...row }));
    assert.deepEqual(perPerson, [
      { first_name: 'Ada', use_default_rates: 0, hourly_rate: 100000 },
      { first_name: 'Grace', use_default_rates: 0, hourly_rate: 120000 },
    ]);
    const people = database.prepare('SELECT first_name, is_contractor, cost_rate FROM users ORDER BY first_name').all().map((row) => ({ ...row }));
    assert.deepEqual(people, [
      { first_name: 'Ada', is_contractor: 0, cost_rate: 40000 },
      { first_name: 'Grace', is_contractor: 1, cost_rate: 50000 },
    ]);
    assert.equal((database.prepare("SELECT billable FROM task_assignments ta JOIN projects p ON p.id = ta.project_id WHERE p.name = 'Internal'").get() as { billable: number }).billable, 0);
  } finally {
    cleanup();
  }
});

test('an invoice report fills in a client address it did not have', () => {
  const { database, cleanup } = fixture();
  try {
    importInvoiceCsv(database, `Issue Date,ID,Client,Invoice Amount,Paid Amount,Balance,Client Address
2026-01-10,1,Example Client,100,100,0,"Example Client AB
Storgatan 1"
`, DEFAULT_SETTINGS);
    assert.equal((database.prepare('SELECT address FROM clients').get() as { address: string }).address, 'Example Client AB\nStorgatan 1');
  } finally {
    cleanup();
  }
});
