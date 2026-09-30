/**
 * Import a Harvest account into SQLite.
 *
 *   npm run import:dump   # reuse .harvest-dump/
 *   npm run import:api    # pull live, then import; needs the Harvest settings in ./.env
 *
 * Safe to re-run: every upsert keys on harvest_id.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { openDb, nowIso } from '../src/lib/db/index.ts';
import { resolveInstance } from '../src/lib/instance.ts';
import { HarvestClient, HarvestError } from '../src/lib/harvest/client.ts';
import { importSnapshot, recordRun, reportOk, type HarvestSnapshot } from '../src/lib/harvest/import.ts';
import { fetchPayments } from '../src/lib/harvest/invoices.ts';
import {
  downloadReceipts,
  fetchEstimateMessages,
  fetchInvoiceMessages,
  fetchTeammates,
  fetchUserRates,
} from '../src/lib/harvest/extras.ts';
import type { HarvestEstimate, HarvestExpense, HarvestInvoice, HarvestUser } from '../src/lib/harvest/types.ts';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DUMP = new URL('../.harvest-dump/', import.meta.url);
const fromDump = process.argv.includes('--from-dump');

/**
 * When the dump was pulled — the moment its contents were true.
 *
 * Not when this import runs. A dump imported a day later is a day-old snapshot, and saying
 * otherwise makes the next incremental sync skip the day in between.
 */
async function dumpPulledAt(): Promise<string> {
  const { mtime } = await stat(new URL('company.json', DUMP));
  return mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function readDump(): Promise<HarvestSnapshot> {
  const load = async (name: string) =>
    JSON.parse(await readFile(new URL(`${name}.json`, DUMP), 'utf8'));
  const [company, users, clients, tasks, projects, user_assignments, task_assignments, time_entries] =
    await Promise.all([
      load('company'),
      load('users'),
      load('clients'),
      load('tasks'),
      load('projects'),
      load('user_assignments'),
      load('task_assignments'),
      load('time_entries'),
    ]);
  const snapshot: HarvestSnapshot = {
    company, users, clients, tasks, projects, user_assignments, task_assignments, time_entries,
  };
  // A dump pulled before invoices were part of the spike has neither file. Leaving the keys
  // out tells the importer they were not fetched, which leaves the invoice tables alone.
  if (existsSync(new URL('invoices.json', DUMP))) snapshot.invoices = await load('invoices');
  if (existsSync(new URL('invoice_payments.json', DUMP))) {
    snapshot.invoice_payments = await load('invoice_payments');
  }
  // The rest of the account, each file optional for the same reason.
  const REST = [
    'invoice_messages', 'contacts', 'roles', 'expense_categories', 'expenses', 'estimates',
    'estimate_messages', 'invoice_item_categories', 'estimate_item_categories',
    'user_billable_rates', 'user_cost_rates', 'teammates',
  ] as const;
  for (const key of REST) {
    if (existsSync(new URL(`${key}.json`, DUMP))) snapshot[key] = await load(key);
  }
  // Receipts in the dump are named by expense id; point each expense at its file.
  const receiptDir = fileURLToPath(new URL('receipts/', DUMP));
  for (const expense of snapshot.expenses ?? []) {
    if (!expense.receipt) continue;
    const name = `${expense.id}${(expense.receipt.file_name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()}`;
    const file = join(receiptDir, name);
    if (existsSync(file)) expense.receipt_file = file;
  }
  return snapshot;
}

async function pullLive(): Promise<HarvestSnapshot> {
  const client = new HarvestClient({
    accountId: process.env.HARVEST_ACCOUNT_ID ?? '',
    accessToken: process.env.HARVEST_ACCESS_TOKEN ?? '',
    contact: process.env.HARVEST_CONTACT ?? '',
  });
  const list = <T,>(path: string, key: string) => client.list<T>(path, key);
  const invoices = await list<HarvestInvoice>('/invoices', 'invoices');
  const users = await list<HarvestUser>('/users', 'users');
  const expenses = await list<HarvestExpense>('/expenses', 'expenses');
  await downloadReceipts(client, expenses, join(resolveInstance().dir, 'receipts'));
  const estimates = await list<HarvestEstimate>('/estimates', 'estimates');
  const rates = await fetchUserRates(client, users);
  return {
    company: await client.get('/company'),
    users,
    clients: await list('/clients', 'clients'),
    tasks: await list('/tasks', 'tasks'),
    projects: await list('/projects', 'projects'),
    user_assignments: await list('/user_assignments', 'user_assignments'),
    task_assignments: await list('/task_assignments', 'task_assignments'),
    time_entries: await list('/time_entries', 'time_entries'),
    invoices,
    invoice_payments: await fetchPayments(client, invoices),
    invoice_messages: await fetchInvoiceMessages(client, invoices),
    contacts: await list('/contacts', 'contacts'),
    roles: await list('/roles', 'roles'),
    expense_categories: await list('/expense_categories', 'expense_categories'),
    expenses,
    estimates,
    estimate_messages: await fetchEstimateMessages(client, estimates),
    invoice_item_categories: await list('/invoice_item_categories', 'invoice_item_categories'),
    estimate_item_categories: await list('/estimate_item_categories', 'estimate_item_categories'),
    user_billable_rates: rates.billable,
    user_cost_rates: rates.cost,
    teammates: await fetchTeammates(client, users),
  };
}

function hhmm(hours: number): string {
  const sign = hours < 0 ? '-' : '';
  const total = Math.round(Math.abs(hours) * 60);
  return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const CREDENTIALS = ['HARVEST_ACCOUNT_ID', 'HARVEST_ACCESS_TOKEN', 'HARVEST_CONTACT'];

async function main(): Promise<void> {
  // Said up front, by name, rather than left to surface as a 401 from Harvest.
  const missing = fromDump ? [] : CREDENTIALS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing ${missing.join(', ')}.`);
    console.error('Copy .env.example to .env and fill in its Harvest section, or set them in the environment.');
    process.exitCode = 2;
    return;
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(fromDump ? 'Importing from .harvest-dump/...\n' : 'Pulling from Harvest, then importing...\n');

  // Stamped before the pull, so anything changed while it is in flight falls inside the next
  // run's window rather than between the two.
  const cursor = fromDump ? await dumpPulledAt() : nowIso();
  const snapshot = fromDump ? await readDump() : await pullLive();
  const db = openDb();
  const report = importSnapshot(db, snapshot, { receiptDir: join(resolveInstance().dir, 'receipts') });
  recordRun(db, fromDump ? 'harvest-dump' : 'harvest-api', report, cursor, startedAt);
  if (fromDump) console.log(`  cursor set to ${cursor} (when the dump was pulled)\n`);

  const pad = (n: number) => String(n).padStart(7);
  for (const [entity, n] of Object.entries(report.counts)) {
    console.log(`  ${entity.padEnd(18)}${pad(n)}`);
  }

  const { source_hours, imported_hours, difference, per_year } = report.reconciliation;
  const matches = reportOk(report);
  console.log(`\n  ${report.first_date} → ${report.last_date}`);
  console.log(`  source hours       ${source_hours.toFixed(2)}  (${hhmm(source_hours)})`);
  console.log(`  imported hours     ${imported_hours.toFixed(2)}  (${hhmm(imported_hours)})`);
  console.log(`  difference         ${difference.toFixed(2)}   ${report.reconciliation.matches ? '✓ match' : '✗ MISMATCH'}`);
  if (report.invoices) {
    const inv = report.invoices;
    console.log(`\n  invoiced (source)  ${inv.source_amount.toFixed(2)}`);
    console.log(`  invoiced (stored)  ${inv.imported_amount.toFixed(2)}`);
    console.log(`  difference         ${inv.difference.toFixed(2)}   ${inv.matches ? '✓ match' : '✗ MISMATCH'}`);
  }

  if (!report.reconciliation.matches) {
    console.log('\n  per-year deltas:');
    for (const [year, y] of Object.entries(per_year)) {
      if (Math.abs(y.delta) >= 0.01) {
        console.log(`    ${year}  source ${y.source.toFixed(2)}  imported ${y.imported.toFixed(2)}  delta ${y.delta.toFixed(2)}`);
      }
    }
  }

  const skippedTotal = Object.values(report.skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) {
    console.log('\n  skipped (unresolved references):');
    for (const [reason, n] of Object.entries(report.skipped)) console.log(`    ${reason}: ${n}`);
  } else {
    console.log('  unmatched          0');
  }

  console.log(`\n  ${Math.round((Date.now() - started) / 1000)}s → ${resolveInstance().databasePath}`);
  process.exitCode = matches && skippedTotal === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  if (error instanceof HarvestError) console.error(`\nHarvest ${error.status}: ${error.message}`);
  else console.error(error);
  process.exitCode = 1;
});
