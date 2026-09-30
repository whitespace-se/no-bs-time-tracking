/**
 * The per-record endpoints behind the rest of the account.
 *
 * Each of these is one request per parent, so what matters is *which* parents are asked
 * about: only invoices and estimates that were sent, only managers, only expenses that name
 * a receipt. A stub client stands in for HarvestClient — nothing here reaches the network.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { HarvestClient, HarvestError } from '../src/lib/harvest/client.ts';
import {
  downloadReceipts,
  fetchEstimateMessages,
  fetchInvoiceMessages,
  fetchTeammates,
  fetchUserRates,
  receiptFileName,
} from '../src/lib/harvest/extras.ts';
import type {
  HarvestEstimate,
  HarvestExpense,
  HarvestInvoice,
  HarvestReceipt,
  HarvestUser,
} from '../src/lib/harvest/types.ts';
import { tempDir } from './fixture.ts';

const T = '2026-01-01T00:00:00Z';

// ── a stub client ────────────────────────────────────────────────────────────

interface Stub {
  client: HarvestClient;
  /** Every `path` asked for, in order. */
  asked: string[];
  downloaded: string[];
}

/**
 * A stand-in for HarvestClient with just the two methods these functions use. Cast rather
 * than subclassed: the real class has private fields, and the point here is what is asked
 * for, not how the asking is done.
 */
function stub(
  answers: Record<string, unknown[]> = {},
  onList?: (path: string) => void,
): Stub {
  const asked: string[] = [];
  const downloaded: string[] = [];
  const client = {
    list: (path: string) => {
      asked.push(path);
      onList?.(path);
      return Promise.resolve(answers[path] ?? []);
    },
    download: (url: string) => {
      downloaded.push(url);
      return Promise.resolve({ bytes: new TextEncoder().encode(`bytes of ${url}`), contentType: 'application/pdf' });
    },
  } as unknown as HarvestClient;
  return { client, asked, downloaded };
}

// ── fixtures ─────────────────────────────────────────────────────────────────

function invoice(id: number, sentAt: string | null): HarvestInvoice {
  return {
    id,
    client: { id: 10, name: 'Alpha Client' },
    line_items: [],
    estimate: null,
    retainer: null,
    creator: null,
    client_key: 'k',
    number: `A-${id}`,
    purchase_order: null,
    amount: 100,
    due_amount: 0,
    tax: null,
    tax_amount: 0,
    tax2: null,
    tax2_amount: 0,
    discount: null,
    discount_amount: 0,
    subject: null,
    notes: null,
    currency: 'SEK',
    state: 'open',
    period_start: null,
    period_end: null,
    issue_date: '2026-01-31',
    due_date: null,
    payment_term: null,
    payment_options: [],
    sent_at: sentAt,
    paid_at: null,
    paid_date: null,
    closed_at: null,
    recurring_invoice_id: null,
    created_at: T,
    updated_at: T,
  };
}

function estimate(id: number, sentAt: string | null): HarvestEstimate {
  return {
    id,
    client: { id: 10, name: 'Alpha Client' },
    line_items: [],
    creator: null,
    client_key: 'k',
    number: `E-${id}`,
    purchase_order: null,
    amount: 100,
    tax: null,
    tax_amount: 0,
    tax2: null,
    tax2_amount: 0,
    discount: null,
    discount_amount: 0,
    subject: null,
    notes: null,
    currency: 'SEK',
    state: 'sent',
    issue_date: '2026-01-02',
    sent_at: sentAt,
    accepted_at: null,
    declined_at: null,
    created_at: T,
    updated_at: T,
  };
}

function person(id: number, accessRoles: string[]): HarvestUser {
  return {
    id,
    first_name: 'Person',
    last_name: String(id),
    email: `person${id}@example.test`,
    telephone: null,
    timezone: null,
    has_access_to_all_future_projects: false,
    is_contractor: false,
    is_active: true,
    weekly_capacity: null,
    default_hourly_rate: null,
    cost_rate: null,
    roles: [],
    access_roles: accessRoles,
    avatar_url: null,
    created_at: T,
    updated_at: T,
  };
}

function receipt(fileName: string): HarvestReceipt {
  return {
    url: `https://cache.harvestapp.com/receipts/${fileName}`,
    file_name: fileName,
    file_size: 12,
    content_type: 'application/pdf',
  };
}

function expense(id: number, file: HarvestReceipt | null): HarvestExpense {
  return {
    id,
    spent_date: '2026-01-05',
    user: { id: 1, name: 'Ada Example' },
    user_assignment: null,
    client: { id: 10, name: 'Alpha Client', currency: 'SEK' },
    project: { id: 100, name: 'Website', code: 'WEB' },
    expense_category: { id: 800, name: 'Travel', unit_price: null, unit_name: null },
    invoice: null,
    receipt: file,
    notes: null,
    units: 1,
    total_cost: 100,
    billable: true,
    reimbursement: false,
    approval_status: 'unsubmitted',
    is_closed: false,
    is_locked: false,
    is_explicitly_locked: false,
    is_billed: false,
    locked_reason: null,
    created_at: T,
    updated_at: T,
  };
}

async function withDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = tempDir();
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── send history ─────────────────────────────────────────────────────────────

test('only an invoice that was sent is asked about, and each message names its invoice', async () => {
  const seen: number[] = [];
  const { client, asked } = stub({
    '/invoices/700/messages': [{ id: 1, subject: 'January' }],
    '/invoices/702/messages': [{ id: 2, subject: 'March' }, { id: 3, subject: 'Reminder' }],
  });

  const messages = await fetchInvoiceMessages(
    client,
    [invoice(700, '2026-01-31T10:00:00Z'), invoice(701, null), invoice(702, '2026-03-31T10:00:00Z')],
    (found) => seen.push(found.length),
  );

  assert.deepEqual(asked, ['/invoices/700/messages', '/invoices/702/messages'], 'a draft is not asked about');
  assert.deepEqual(messages.map((m) => [m.id, m.invoice.id]), [[1, 700], [2, 702], [3, 702]]);
  assert.deepEqual(seen, [1, 2], 'the callback counts what each invoice had');
});

test('an account that has never sent an invoice makes no requests at all', async () => {
  const { client, asked } = stub();
  assert.deepEqual(await fetchInvoiceMessages(client, [invoice(700, null)]), []);
  assert.deepEqual(await fetchInvoiceMessages(client, []), []);
  assert.deepEqual(asked, []);
});

test('estimates are asked about on the same rule, and stamped with their estimate', async () => {
  const seen: number[] = [];
  const { client, asked } = stub({ '/estimates/800/messages': [{ id: 9, subject: 'Quote' }] });
  const messages = await fetchEstimateMessages(
    client,
    [estimate(800, '2026-01-02T10:00:00Z'), estimate(801, null)],
    (found) => seen.push(found.length),
  );
  assert.deepEqual(asked, ['/estimates/800/messages']);
  assert.deepEqual(messages.map((m) => [m.id, m.estimate.id]), [[9, 800]]);
  assert.deepEqual(seen, [1]);
});

// ── rate history ─────────────────────────────────────────────────────────────

test('both rate histories are fetched for every person, and stamped with the person', async () => {
  const ticks: number[] = [];
  const { client, asked } = stub({
    '/users/1/billable_rates': [{ id: 10, amount: 1200 }],
    '/users/1/cost_rates': [{ id: 11, amount: 600 }],
    '/users/2/billable_rates': [],
    '/users/2/cost_rates': [{ id: 12, amount: 500 }],
  });

  const rates = await fetchUserRates(client, [person(1, ['administrator']), person(2, ['member'])], () =>
    ticks.push(ticks.length + 1),
  );

  assert.deepEqual(asked, [
    '/users/1/billable_rates',
    '/users/1/cost_rates',
    '/users/2/billable_rates',
    '/users/2/cost_rates',
  ], 'two requests a head, in that order');
  assert.deepEqual(rates.billable.map((r) => [r.id, r.user.id]), [[10, 1]]);
  assert.deepEqual(rates.cost.map((r) => [r.id, r.user.id]), [[11, 1], [12, 2]]);
  assert.deepEqual(ticks, [1, 2], 'the callback fires once per person, not once per request');
});

test('nobody to ask about is no requests and two empty histories', async () => {
  const { client, asked } = stub();
  assert.deepEqual(await fetchUserRates(client, []), { billable: [], cost: [] });
  assert.deepEqual(asked, []);
});

// ── who a manager may see ────────────────────────────────────────────────────

test('only a manager is asked about, and the answer is turned into ids', async () => {
  const { client, asked } = stub({ '/users/2/teammates': [{ id: 1 }, { id: 3 }] });
  const teammates = await fetchTeammates(client, [
    person(1, ['administrator']),
    person(2, ['manager', 'project_manager']),
    person(3, ['member']),
  ]);
  assert.deepEqual(asked, ['/users/2/teammates'], 'an administrator is not a Harvest "manager"');
  assert.deepEqual(teammates, [{ manager_id: 2, user_ids: [1, 3] }]);
});

test('Harvest answering 422 means "no list here", which is an answer rather than a failure', async () => {
  const client = {
    list: (path: string) => {
      assert.equal(path, '/users/2/teammates');
      return Promise.reject(new HarvestError('422 Unprocessable', 422, path, ''));
    },
  } as unknown as HarvestClient;

  const ticks: number[] = [];
  const teammates = await fetchTeammates(client, [person(2, ['manager'])], () => ticks.push(1));
  assert.deepEqual(teammates, [{ manager_id: 2, user_ids: [] }]);
  assert.deepEqual(ticks, [1]);
});

test('any other refusal is still a failure and stops the run', async () => {
  const refuse = (error: unknown) =>
    ({ list: () => Promise.reject(error) }) as unknown as HarvestClient;

  await assert.rejects(
    () => fetchTeammates(refuse(new HarvestError('500', 500, '/users/2/teammates', '')), [person(2, ['manager'])]),
    (error: unknown) => error instanceof HarvestError && error.status === 500,
  );
  await assert.rejects(
    () => fetchTeammates(refuse(new Error('socket hang up')), [person(2, ['manager'])]),
    /socket hang up/,
  );
});

test('a person with no grants at all is simply not a manager', async () => {
  const { client, asked } = stub();
  const missing = { ...person(4, []), access_roles: undefined } as HarvestUser;
  assert.deepEqual(await fetchTeammates(client, [missing]), []);
  assert.deepEqual(asked, []);
});

// ── receipts ─────────────────────────────────────────────────────────────────

test('a receipt is kept under the expense id, with the original extension in lower case', () => {
  assert.equal(receiptFileName(expense(850, receipt('ticket.PDF'))), '850.pdf');
  assert.equal(receiptFileName(expense(851, receipt('scan.jpeg'))), '851.jpeg');
  assert.equal(receiptFileName(expense(852, receipt('receipt'))), '852', 'no extension, no dot');
  assert.equal(receiptFileName(expense(853, receipt('a.b.png'))), '853.png');
  assert.equal(receiptFileName(expense(854, null)), null, 'no receipt, no name');
});

test('each receipt is downloaded once, into the folder, and the expense points at it', () =>
  withDir(async (dir) => {
    const receipts = join(dir, 'receipts');
    const expenses = [expense(850, receipt('ticket.pdf')), expense(851, null), expense(852, receipt('scan.png'))];
    const ticks: number[] = [];
    const { client, downloaded } = stub();

    const fetched = await downloadReceipts(client, expenses, receipts, () => ticks.push(1));

    assert.equal(fetched, 2);
    assert.deepEqual(downloaded, [
      'https://cache.harvestapp.com/receipts/ticket.pdf',
      'https://cache.harvestapp.com/receipts/scan.png',
    ]);
    assert.deepEqual(ticks, [1, 1], 'an expense with no receipt is skipped entirely');
    assert.equal(expenses[0]!.receipt_file, join(receipts, '850.pdf'));
    assert.equal(expenses[1]!.receipt_file, undefined);
    assert.equal(expenses[2]!.receipt_file, join(receipts, '852.png'));
    assert.ok(existsSync(join(receipts, '850.pdf')));
    assert.match(readFileSync(join(receipts, '850.pdf'), 'utf8'), /^bytes of https:/);
  }));

test('a receipt already on disk is not fetched again, but is still pointed at', () =>
  withDir(async (dir) => {
    const receipts = join(dir, 'receipts');
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, '850.pdf'), 'already here');

    const expenses = [expense(850, receipt('ticket.pdf'))];
    const { client, downloaded } = stub();
    const fetched = await downloadReceipts(client, expenses, receipts);

    assert.equal(fetched, 0);
    assert.deepEqual(downloaded, [], 'receipts are immutable in Harvest, so one visit is enough');
    assert.equal(expenses[0]!.receipt_file, join(receipts, '850.pdf'));
    assert.equal(readFileSync(join(receipts, '850.pdf'), 'utf8'), 'already here');
  }));

test('an account with no receipts leaves no folder behind and asks for nothing', () =>
  withDir(async (dir) => {
    const receipts = join(dir, 'receipts');
    const { client, downloaded } = stub();
    assert.equal(await downloadReceipts(client, [expense(851, null)], receipts), 0);
    assert.deepEqual(downloaded, []);
    assert.equal(existsSync(receipts), false);
  }));
