/**
 * The per-record endpoints behind the rest of the account (migration 007).
 *
 * Each of these is one request per parent — per invoice, per estimate, per person — so each
 * is asked only where the parent says there is something to find. Messages exist only on
 * invoices and estimates that were sent; teammates only on managers; a receipt only where
 * the expense names one. The rate endpoints have no such tell and are asked for every person
 * handed in, which on an incremental sync is only the people who changed.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { HarvestClient, HarvestError } from './client.ts';
import type {
  HarvestEstimate,
  HarvestEstimateMessage,
  HarvestExpense,
  HarvestInvoice,
  HarvestInvoiceMessage,
  HarvestTeammates,
  HarvestUser,
  HarvestUserRate,
} from './types.ts';

export async function fetchInvoiceMessages(
  client: HarvestClient,
  invoices: readonly HarvestInvoice[],
  onInvoice?: (found: readonly HarvestInvoiceMessage[]) => void,
): Promise<HarvestInvoiceMessage[]> {
  const out: HarvestInvoiceMessage[] = [];
  for (const invoice of invoices) {
    if (!invoice.sent_at) continue;
    const found = await client.list<Omit<HarvestInvoiceMessage, 'invoice'>>(
      `/invoices/${invoice.id}/messages`,
      'invoice_messages',
    );
    const stamped = found.map((m) => ({ ...m, invoice: { id: invoice.id } }));
    out.push(...stamped);
    onInvoice?.(stamped);
  }
  return out;
}

export async function fetchEstimateMessages(
  client: HarvestClient,
  estimates: readonly HarvestEstimate[],
  onEstimate?: (found: readonly HarvestEstimateMessage[]) => void,
): Promise<HarvestEstimateMessage[]> {
  const out: HarvestEstimateMessage[] = [];
  for (const estimate of estimates) {
    if (!estimate.sent_at) continue;
    const found = await client.list<Omit<HarvestEstimateMessage, 'estimate'>>(
      `/estimates/${estimate.id}/messages`,
      'estimate_messages',
    );
    const stamped = found.map((m) => ({ ...m, estimate: { id: estimate.id } }));
    out.push(...stamped);
    onEstimate?.(stamped);
  }
  return out;
}

/** Both rate histories for each person, stamped with the person. Two requests a head. */
export async function fetchUserRates(
  client: HarvestClient,
  users: readonly HarvestUser[],
  onUser?: () => void,
): Promise<{ billable: HarvestUserRate[]; cost: HarvestUserRate[] }> {
  const billable: HarvestUserRate[] = [];
  const cost: HarvestUserRate[] = [];
  for (const user of users) {
    const stamp = (rates: Omit<HarvestUserRate, 'user'>[]) =>
      rates.map((r) => ({ ...r, user: { id: user.id } }));
    billable.push(...stamp(await client.list(`/users/${user.id}/billable_rates`, 'billable_rates')));
    cost.push(...stamp(await client.list(`/users/${user.id}/cost_rates`, 'cost_rates')));
    onUser?.();
  }
  return { billable, cost };
}

/**
 * Who each manager may see. Harvest answers 422 for anyone who is not a manager, and for
 * some who are — that is Harvest saying "no list here", which is an answer, not a failure.
 */
export async function fetchTeammates(
  client: HarvestClient,
  users: readonly HarvestUser[],
  onUser?: () => void,
): Promise<HarvestTeammates[]> {
  const out: HarvestTeammates[] = [];
  for (const user of users) {
    if (!(user.access_roles ?? []).includes('manager')) continue;
    try {
      const teammates = await client.list<{ id: number }>(`/users/${user.id}/teammates`, 'teammates');
      out.push({ manager_id: user.id, user_ids: teammates.map((t) => t.id) });
    } catch (error) {
      if (!(error instanceof HarvestError) || error.status !== 422) throw error;
      out.push({ manager_id: user.id, user_ids: [] });
    }
    onUser?.();
  }
  return out;
}

/** The file name a receipt is kept under: the expense's id, with the original extension. */
export function receiptFileName(expense: Pick<HarvestExpense, 'id' | 'receipt'>): string | null {
  if (!expense.receipt) return null;
  const ext = extname(expense.receipt.file_name || '').toLowerCase() || '';
  return `${expense.id}${ext}`;
}

/**
 * Download every receipt into `dir`, and point each expense at its file.
 *
 * A file already there under the expected name is not fetched again: receipts are immutable
 * in Harvest — replacing one is a new receipt on the same expense, with a new file name —
 * and a size match is enough to say it is the same file.
 */
export async function downloadReceipts(
  client: HarvestClient,
  expenses: HarvestExpense[],
  dir: string,
  onReceipt?: () => void,
): Promise<number> {
  let fetched = 0;
  for (const expense of expenses) {
    const name = receiptFileName(expense);
    if (!name || !expense.receipt) continue;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    if (!existsSync(path)) {
      const { bytes } = await client.download(expense.receipt.url);
      await writeFile(path, bytes);
      fetched += 1;
    }
    expense.receipt_file = path;
    onReceipt?.();
  }
  return fetched;
}
