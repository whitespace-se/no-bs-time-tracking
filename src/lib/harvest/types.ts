/**
 * Harvest API v2 response shapes.
 *
 * Only the fields we actually consume are typed. Every fetched record is also kept
 * verbatim in `source_json`, so an unmodelled field is recoverable rather than lost.
 */

/** Envelope every list endpoint returns. `links` is the only pagination source we trust. */
export interface HarvestPage<T> {
  per_page: number;
  total_pages: number;
  total_entries: number;
  page: number | null;
  next_page: number | null;
  previous_page: number | null;
  links: {
    first: string | null;
    next: string | null;
    previous: string | null;
    last: string | null;
  };
  /** The records live under a resource-named key, e.g. `time_entries`. */
  [resource: string]: unknown;
}

/** `{ id, name }` stubs that Harvest embeds instead of bare foreign keys. */
export interface HarvestRef {
  id: number;
  name: string;
}

export interface HarvestCompany {
  base_uri: string;
  full_domain: string;
  name: string;
  is_active: boolean;
  week_start_day: string;
  wants_timestamp_timers: boolean;
  time_format: 'decimal' | 'hours_minutes';
  date_format: string;
  plan_type: string;
  currency: string;
  decimal_symbol: string;
  thousands_separator: string;
  color_scheme: string;
  /** Rounding is a real feature, not a display detail — it drives `rounded_hours`. */
  clock: '12h' | '24h';
  expense_feature: boolean;
  invoice_feature: boolean;
  estimate_feature: boolean;
  approval_required: boolean;
}

export interface HarvestUser {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  telephone: string | null;
  timezone: string | null;
  has_access_to_all_future_projects: boolean;
  is_contractor: boolean;
  is_active: boolean;
  weekly_capacity: number | null;
  default_hourly_rate: number | null;
  cost_rate: number | null;
  roles: string[];
  access_roles?: string[];
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface HarvestClientRecord {
  id: number;
  name: string;
  is_active: boolean;
  address: string | null;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface HarvestProject {
  id: number;
  client: HarvestRef;
  name: string;
  code: string | null;
  is_active: boolean;
  is_billable: boolean;
  is_fixed_fee: boolean;
  bill_by: string;
  hourly_rate: number | null;
  budget: number | null;
  budget_by: string;
  budget_is_monthly: boolean;
  notify_when_over_budget: boolean;
  over_budget_notification_percentage: number | null;
  show_budget_to_all: boolean;
  cost_budget: number | null;
  cost_budget_include_expenses: boolean;
  fee: number | null;
  notes: string | null;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface HarvestTask {
  id: number;
  name: string;
  billable_by_default: boolean;
  default_hourly_rate: number | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface HarvestUserAssignment {
  id: number;
  project?: HarvestRef;
  user: HarvestRef;
  is_active: boolean;
  is_project_manager: boolean;
  use_default_rates: boolean;
  hourly_rate: number | null;
  budget: number | null;
  created_at: string;
  updated_at: string;
}

export interface HarvestTaskAssignment {
  id: number;
  project?: HarvestRef;
  task: HarvestRef;
  is_active: boolean;
  /** Billability belongs to the project↔task pair, not to the task. */
  billable: boolean;
  hourly_rate: number | null;
  budget: number | null;
  created_at: string;
  updated_at: string;
}

export interface HarvestTimeEntry {
  id: number;
  spent_date: string;
  user: HarvestRef;
  user_assignment: HarvestUserAssignment | null;
  client: HarvestRef;
  project: HarvestRef;
  task: HarvestRef;
  task_assignment: HarvestTaskAssignment | null;
  external_reference: unknown | null;
  /** `{ id, number }` when billed. Note the list endpoint returns `null`, not `0`, here. */
  invoice: { id: number; number: string } | null;
  hours: number;
  hours_without_timer: number | null;
  /** What reports and invoices actually use, after the account's rounding rule. */
  rounded_hours: number;
  notes: string | null;
  is_locked: boolean;
  locked_reason: string | null;
  is_closed: boolean;
  approval_status: 'unsubmitted' | 'submitted' | 'approved';
  is_billed: boolean;
  timer_started_at: string | null;
  started_time: string | null;
  ended_time: string | null;
  is_running: boolean;
  billable: boolean;
  budgeted: boolean;
  billable_rate: number | null;
  cost_rate: number | null;
  created_at: string;
  updated_at: string;
}

// ── Invoices ─────────────────────────────────────────────────────────────────
// Read-only here, by decision: history comes across, nothing is issued.

export interface HarvestInvoiceLineItem {
  id: number;
  /** Harvest's invoice item category name, e.g. "Konsulttjänst". Free text per account. */
  kind: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  amount: number;
  taxed: boolean;
  taxed2: boolean;
  project: (HarvestRef & { code: string | null }) | null;
}

export interface HarvestInvoice {
  id: number;
  client: HarvestRef;
  line_items: HarvestInvoiceLineItem[];
  estimate: { id: number } | null;
  retainer: { id: number } | null;
  creator: HarvestRef | null;
  client_key: string;
  number: string;
  purchase_order: string | null;
  /** Total including tax, after discount. `due_amount` is what remains unpaid. */
  amount: number;
  due_amount: number;
  /** Percentages, possibly fractional. Null when the invoice carries no such rate. */
  tax: number | null;
  tax_amount: number;
  tax2: number | null;
  tax2_amount: number;
  discount: number | null;
  discount_amount: number;
  subject: string | null;
  notes: string | null;
  currency: string;
  state: 'draft' | 'open' | 'paid' | 'closed';
  period_start: string | null;
  period_end: string | null;
  issue_date: string;
  due_date: string | null;
  payment_term: string | null;
  payment_options: string[];
  sent_at: string | null;
  paid_at: string | null;
  paid_date: string | null;
  closed_at: string | null;
  recurring_invoice_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * A payment recorded against an invoice, from `/invoices/{id}/payments`.
 *
 * Harvest's record does not name its invoice — the endpoint is per invoice, so it never
 * needed to. The fetcher adds `invoice` before handing the record on, the same way the
 * per-project assignment fallback adds `project`.
 */
export interface HarvestInvoicePayment {
  id: number;
  /** Added by the fetcher; not in Harvest's payload. */
  invoice: { id: number };
  amount: number;
  paid_at: string | null;
  paid_date: string | null;
  recorded_by: string | null;
  recorded_by_email: string | null;
  notes: string | null;
  transaction_reference: string | null;
  payment_gateway: HarvestRef | null;
  created_at: string;
  updated_at: string;
}

// ── The rest of the account (migration 007) ──────────────────────────────────

export interface HarvestContact {
  id: number;
  client: HarvestRef;
  title: string | null;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone_office: string | null;
  phone_mobile: string | null;
  fax: string | null;
  invoice_recipient_status: 'none' | 'primary' | 'cc';
  created_at: string;
  updated_at: string;
}

/** A Harvest "role" is a team — a name and its members — not a permission. */
export interface HarvestRole {
  id: number;
  name: string;
  user_ids: number[];
  created_at: string;
  updated_at: string;
}

export interface HarvestExpenseCategory {
  id: number;
  name: string;
  unit_name: string | null;
  unit_price: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface HarvestReceipt {
  url: string;
  file_name: string;
  file_size: number;
  content_type: string;
}

export interface HarvestExpense {
  id: number;
  spent_date: string;
  user: HarvestRef;
  user_assignment: HarvestUserAssignment | null;
  client: HarvestRef & { currency: string };
  project: HarvestRef & { code: string | null };
  expense_category: HarvestRef & { unit_price: number | null; unit_name: string | null };
  invoice: { id: number; number: string } | null;
  receipt: HarvestReceipt | null;
  notes: string | null;
  units: number;
  total_cost: number;
  billable: boolean;
  reimbursement: boolean;
  approval_status: 'unsubmitted' | 'submitted' | 'approved';
  is_closed: boolean;
  is_locked: boolean;
  is_explicitly_locked: boolean;
  is_billed: boolean;
  locked_reason: string | null;
  created_at: string;
  updated_at: string;
  /** Added by the fetcher: where the receipt was downloaded to. Not in Harvest's payload. */
  receipt_file?: string;
}

export interface HarvestEstimateLineItem {
  id: number;
  kind: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  amount: number;
  taxed: boolean;
  taxed2: boolean;
}

export interface HarvestEstimate {
  id: number;
  client: HarvestRef;
  line_items: HarvestEstimateLineItem[];
  creator: HarvestRef | null;
  client_key: string;
  number: string;
  purchase_order: string | null;
  amount: number;
  tax: number | null;
  tax_amount: number;
  tax2: number | null;
  tax2_amount: number;
  discount: number | null;
  discount_amount: number;
  subject: string | null;
  notes: string | null;
  currency: string;
  state: 'draft' | 'sent' | 'accepted' | 'declined';
  issue_date: string;
  sent_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HarvestMessageRecipient {
  name: string;
  email: string;
}

export interface HarvestInvoiceMessage {
  id: number;
  /** Added by the fetcher. */
  invoice: { id: number };
  sent_by: string | null;
  sent_by_email: string | null;
  sent_from: string | null;
  sent_from_email: string | null;
  recipients: HarvestMessageRecipient[];
  subject: string | null;
  body: string | null;
  include_link_to_client_invoice: boolean;
  attach_pdf: boolean;
  send_me_a_copy: boolean;
  thank_you: boolean;
  reminder: boolean;
  send_reminder_on: string | null;
  event_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface HarvestEstimateMessage {
  id: number;
  /** Added by the fetcher. */
  estimate: { id: number };
  sent_by: string | null;
  sent_by_email: string | null;
  sent_from: string | null;
  sent_from_email: string | null;
  recipients: HarvestMessageRecipient[];
  subject: string | null;
  body: string | null;
  send_me_a_copy: boolean;
  event_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface HarvestInvoiceItemCategory {
  id: number;
  name: string;
  use_as_service: boolean;
  use_as_expense: boolean;
  created_at: string;
  updated_at: string;
}

export interface HarvestEstimateItemCategory {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

/** One dated rate from `/users/{id}/billable_rates` or `/cost_rates`. */
export interface HarvestUserRate {
  id: number;
  /** Added by the fetcher. */
  user: { id: number };
  amount: number;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
}

/** Built by the fetcher from `/users/{id}/teammates`: who a manager may see. */
export interface HarvestTeammates {
  manager_id: number;
  user_ids: number[];
}
