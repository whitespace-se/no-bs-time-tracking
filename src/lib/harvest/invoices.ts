/**
 * Fetching invoice history from Harvest — the part every pull shares.
 *
 * Invoices are one list endpoint, with their lines embedded. Payments are one endpoint *per
 * invoice*, and a long-lived account has thousands of invoices; at Harvest's rate limit that
 * is many minutes of requests for a table that is empty for most of them. So payments are asked for
 * only where they exist, and Harvest says exactly where: `due_amount` is `amount` less the
 * payments recorded, so an invoice with nothing paid off it has no payments to fetch. That
 * is arithmetic, not a heuristic — typically well under half the requests, and no invoice's
 * payments are skipped.
 */

import type { HarvestClient } from './client.ts';
import type { HarvestInvoice, HarvestInvoicePayment } from './types.ts';

/** True when Harvest has at least one payment recorded against the invoice. */
export function hasPayments(invoice: Pick<HarvestInvoice, 'amount' | 'due_amount'>): boolean {
  return invoice.due_amount < invoice.amount;
}

/**
 * Every payment on every invoice that has one, each stamped with its invoice's id.
 *
 * `onInvoice` fires after each invoice's payments arrive, so a progress display can count
 * invoices checked as well as payments found.
 */
export async function fetchPayments(
  client: HarvestClient,
  invoices: readonly HarvestInvoice[],
  onInvoice?: (payments: readonly HarvestInvoicePayment[]) => void,
): Promise<HarvestInvoicePayment[]> {
  const out: HarvestInvoicePayment[] = [];
  for (const invoice of invoices) {
    if (!hasPayments(invoice)) continue;
    const found = await client.list<Omit<HarvestInvoicePayment, 'invoice'>>(
      `/invoices/${invoice.id}/payments`,
      'invoice_payments',
    );
    const stamped = found.map((payment) => ({ ...payment, invoice: { id: invoice.id } }));
    out.push(...stamped);
    onInvoice?.(stamped);
  }
  return out;
}
