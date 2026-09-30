/**
 * Literal values Harvest writes into its data, kept in one place.
 *
 * These are Harvest's exact strings, observed in the imported account. They are matched and
 * written in several places, and a typo in any of them silently unlocks billed history — so
 * they are constants, not string literals sprinkled through SQL.
 */

/** `time_entries.locked_reason`. The four causes compose: archived, invoiced, or both. */
export const LOCK_REASON = {
  archived: 'Item Archived',
  invoiced: 'Item Invoiced',
  invoicedAndArchived: 'Item Invoiced and Archived',
  /** The scheduled auto-lock. Never cleared by archiving or un-archiving. */
  period: 'Item Locked for this Time Period',
} as const;

export type LockReason = (typeof LOCK_REASON)[keyof typeof LOCK_REASON];

/** `time_entries.approval_status`. */
export const APPROVAL_STATUS = ['unsubmitted', 'submitted', 'approved'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

/**
 * `projects.bill_by` — how hours turn into an invoice line.
 *
 * Harvest capitalises these and does not capitalise `budget_by`. Both spellings are its own.
 */
export const BILL_BY = {
  none: 'No billing',
  Project: 'Project hourly rate',
  Tasks: 'Task hourly rate',
  People: "Person's hourly rate",
} as const;

/**
 * `projects.budget_by` — what the budget counts, which also decides the *unit* of the budget.
 * Hours modes fill `budget_seconds`; money modes fill `budget_amount`. See migration 003.
 */
export const BUDGET_BY = {
  none: { label: 'No budget', unit: null },
  project: { label: 'Total project hours', unit: 'hours' },
  project_cost: { label: 'Total project fees', unit: 'money' },
  task: { label: 'Hours per task', unit: 'hours' },
  task_fees: { label: 'Fees per task', unit: 'money' },
  person: { label: 'Hours per person', unit: 'hours' },
} as const;

export type BudgetBy = keyof typeof BUDGET_BY;

export const HOURS_BUDGETS: ReadonlySet<string> = new Set(
  Object.entries(BUDGET_BY).filter(([, v]) => v.unit === 'hours').map(([k]) => k),
);
export const MONEY_BUDGETS: ReadonlySet<string> = new Set(
  Object.entries(BUDGET_BY).filter(([, v]) => v.unit === 'money').map(([k]) => k),
);

/**
 * `invoices.state` — Harvest's four, verbatim.
 *
 * `paid` and `closed` are terminal; `closed` is an invoice written off rather than paid.
 * Some teams draft invoices in Harvest and issue them from an accounting system, so `draft` is a normal
 * resting state in this account, not an unfinished one.
 */
export const INVOICE_STATE = {
  draft: 'Draft',
  open: 'Open',
  paid: 'Paid',
  closed: 'Closed',
} as const;

export type InvoiceState = keyof typeof INVOICE_STATE;
