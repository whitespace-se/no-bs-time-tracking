/**
 * What the JSON API exposes, declared once.
 *
 * Every resource here yields three things that must agree: the SQL that reads it, the
 * permission rule that guards it, and the OpenAPI schema that describes it. Writing them
 * separately is how a published spec starts lying — a field renamed in SQL, a filter added
 * to the handler, and the documentation quietly becomes fiction. So they are one declaration,
 * and `openapi.ts` generates the spec from the same objects the handlers execute.
 *
 * Units follow the database: durations are integer seconds, money is integer minor
 * units — öre for a Swedish account — and the currency travels beside it. Nothing here
 * returns a float for money.
 */

import type { Db } from '../db/index.ts';
import { rows } from '../db/index.ts';
import type { SessionUser } from '../auth/session.ts';

export type FieldType = 'integer' | 'number' | 'string' | 'boolean';

export interface Field {
  /** Key in the JSON response. */
  name: string;
  /** SQL expression producing it. */
  column: string;
  type: FieldType;
  description: string;
  /** True where the value is a rate or a cost: omitted for a member's token. */
  privileged?: boolean;
  /** Stored as 0/1 in SQLite; sent as a real boolean. */
  boolean?: boolean;
  /** JSON held in a text column, sent as parsed JSON rather than a string. */
  json?: boolean;
  format?: 'date' | 'date-time';
}

export interface Filter {
  name: string;
  column: string;
  type: 'string' | 'integer' | 'boolean' | 'date';
  op: '=' | '>=' | '<=' | 'like';
  description: string;
}

export interface Resource {
  /** Path segment: /api/v1/<name> */
  name: string;
  singular: string;
  summary: string;
  description: string;
  /** FROM and any JOINs. The primary table is aliased as the first two letters, see below. */
  from: string;
  /** Always-on restriction, if any. */
  where?: string;
  order: string;
  fields: Field[];
  filters: Filter[];
  /** `everyone` still applies `viewerColumn`; `privileged` refuses a member outright. */
  access: 'everyone' | 'privileged';
  /**
   * Column forced to the caller's own id when they are neither admin nor manager. This is
   * what stops a member's token reading another person's time, whatever the query says.
   */
  viewerColumn?: string;
  /** Sub-collections included on the single-record endpoint. */
  expand?: { name: string; from: string; order: string; fields: Field[]; parent: string }[];
}

const ID: Field = { name: 'id', column: 'id', type: 'integer', description: "This instance's id. An imported record keeps the id its source system gave it; records created here are numbered above that range so the two cannot collide." };
const CREATED: Field[] = [
  { name: 'created_at', column: 'created_at', type: 'string', format: 'date-time', description: 'When Harvest created the record.' },
  { name: 'updated_at', column: 'updated_at', type: 'string', format: 'date-time', description: 'When Harvest last changed it.' },
];

export const RESOURCES: Resource[] = [
  {
    name: 'time-entries',
    singular: 'Time entry',
    summary: 'Logged time',
    description:
      'One row per logged entry. `duration_seconds` is what was entered; `rounded_seconds` is ' +
      'what the account bills, after its rounding rule. A member sees only their own.',
    from: `FROM time_entries t
             JOIN users u ON u.id = t.user_id
             JOIN projects p ON p.id = t.project_id
             JOIN clients c ON c.id = p.client_id
             JOIN tasks k ON k.id = t.task_id`,
    order: 't.spent_date DESC, t.id DESC',
    access: 'everyone',
    viewerColumn: 't.user_id',
    fields: [
      { ...ID, column: 't.id' },
      { name: 'spent_date', column: 't.spent_date', type: 'string', format: 'date', description: 'The day the work belongs to. A plain date, never a timestamp.' },
      { name: 'user_id', column: 't.user_id', type: 'integer', description: 'Who logged it.' },
      { name: 'user_name', column: "TRIM(u.first_name || ' ' || u.last_name)", type: 'string', description: 'Their name, for display.' },
      { name: 'client_id', column: 'c.id', type: 'integer', description: 'The project’s client.' },
      { name: 'client_name', column: 'c.name', type: 'string', description: 'Client name.' },
      { name: 'project_id', column: 't.project_id', type: 'integer', description: 'Project.' },
      { name: 'project_code', column: 'p.code', type: 'string', description: 'Short code, null on some projects.' },
      { name: 'project_name', column: 'p.name', type: 'string', description: 'Project name.' },
      { name: 'task_id', column: 't.task_id', type: 'integer', description: 'Task.' },
      { name: 'task_name', column: 'k.name', type: 'string', description: 'Task name.' },
      { name: 'duration_seconds', column: 't.duration_seconds', type: 'integer', description: 'Entered duration, in whole seconds.' },
      { name: 'rounded_seconds', column: 't.rounded_seconds', type: 'integer', description: 'Duration after the account rounding rule. What reports and invoices use.' },
      { name: 'notes', column: 't.notes', type: 'string', description: 'Free text; often empty.' },
      { name: 'billable', column: 't.billable', type: 'boolean', boolean: true, description: 'Whether the entry may be invoiced.' },
      { name: 'billable_rate', column: 't.billable_rate', type: 'integer', privileged: true, description: 'Rate applied, in minor units per hour.' },
      { name: 'cost_rate', column: 't.cost_rate', type: 'integer', privileged: true, description: 'Internal cost rate, in minor units per hour.' },
      { name: 'is_billed', column: 't.is_billed', type: 'boolean', boolean: true, description: 'Whether it has been invoiced.' },
      { name: 'invoice_id', column: 't.invoice_id', type: 'integer', description: 'The invoice it was billed on, if any.' },
      { name: 'is_locked', column: 't.is_locked', type: 'boolean', boolean: true, description: 'Locked entries cannot be edited. Imported history is usually largely locked.' },
      { name: 'locked_reason', column: 't.locked_reason', type: 'string', description: 'Why: archived, invoiced, both, or a locked period.' },
      { name: 'approval_status', column: 't.approval_status', type: 'string', description: 'unsubmitted, submitted or approved.' },
      { name: 'is_running', column: 't.is_running', type: 'boolean', boolean: true, description: 'Whether a timer is running on it now.' },
      ...CREATED.map((f) => ({ ...f, column: `t.${f.column}` })),
    ],
    filters: [
      { name: 'from', column: 't.spent_date', type: 'date', op: '>=', description: 'Earliest spent_date, inclusive.' },
      { name: 'to', column: 't.spent_date', type: 'date', op: '<=', description: 'Latest spent_date, inclusive.' },
      { name: 'user_id', column: 't.user_id', type: 'integer', op: '=', description: 'One person. Ignored for a member’s token, which is always scoped to themselves.' },
      { name: 'client_id', column: 'c.id', type: 'integer', op: '=', description: 'One client.' },
      { name: 'project_id', column: 't.project_id', type: 'integer', op: '=', description: 'One project.' },
      { name: 'task_id', column: 't.task_id', type: 'integer', op: '=', description: 'One task.' },
      { name: 'invoice_id', column: 't.invoice_id', type: 'integer', op: '=', description: 'Entries billed on one invoice.' },
      { name: 'billable', column: 't.billable', type: 'boolean', op: '=', description: 'true or false.' },
      { name: 'is_billed', column: 't.is_billed', type: 'boolean', op: '=', description: 'true or false.' },
      { name: 'updated_since', column: 't.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp. For incremental sync.' },
    ],
  },
  {
    name: 'expenses',
    singular: 'Expense',
    summary: 'Expenses',
    description: 'Money spent against a project. A member sees only their own.',
    from: `FROM expenses e
             JOIN users u ON u.id = e.user_id
             JOIN projects p ON p.id = e.project_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id`,
    order: 'e.spent_date DESC, e.id DESC',
    access: 'everyone',
    viewerColumn: 'e.user_id',
    fields: [
      { ...ID, column: 'e.id' },
      { name: 'spent_date', column: 'e.spent_date', type: 'string', format: 'date', description: 'The day the cost belongs to.' },
      { name: 'user_id', column: 'e.user_id', type: 'integer', description: 'Who recorded it.' },
      { name: 'user_name', column: "TRIM(u.first_name || ' ' || u.last_name)", type: 'string', description: 'Their name.' },
      { name: 'client_id', column: 'c.id', type: 'integer', description: 'Client.' },
      { name: 'client_name', column: 'c.name', type: 'string', description: 'Client name.' },
      { name: 'project_id', column: 'e.project_id', type: 'integer', description: 'Project.' },
      { name: 'project_name', column: 'p.name', type: 'string', description: 'Project name.' },
      { name: 'category_id', column: 'ec.id', type: 'integer', description: 'Expense category.' },
      { name: 'category_name', column: 'ec.name', type: 'string', description: 'Category name.' },
      { name: 'units', column: 'e.units', type: 'number', description: 'Count of the category’s unit, such as kilometres. Never summed across rows.' },
      { name: 'total_cost', column: 'e.total_cost', type: 'integer', description: 'Amount in minor units.' },
      { name: 'notes', column: 'e.notes', type: 'string', description: 'Free text.' },
      { name: 'billable', column: 'e.billable', type: 'boolean', boolean: true, description: 'Whether it may be invoiced.' },
      { name: 'reimbursement', column: 'e.reimbursement', type: 'boolean', boolean: true, description: 'Whether the person is owed the money.' },
      { name: 'is_billed', column: 'e.is_billed', type: 'boolean', boolean: true, description: 'Whether it has been invoiced.' },
      { name: 'invoice_id', column: 'e.invoice_id', type: 'integer', description: 'The invoice it was billed on, if any.' },
      { name: 'is_locked', column: 'e.is_locked', type: 'boolean', boolean: true, description: 'Locked expenses cannot be edited.' },
      { name: 'receipt_file_name', column: 'e.receipt_file_name', type: 'string', description: 'Original file name of the receipt, if there is one.' },
      { name: 'receipt_url', column: `CASE WHEN e.receipt_path IS NOT NULL THEN '/expenses/' || e.id || '/receipt' END`, type: 'string', description: 'Path on this instance that serves the receipt file. Needs the same credentials.' },
      ...CREATED.map((f) => ({ ...f, column: `e.${f.column}` })),
    ],
    filters: [
      { name: 'from', column: 'e.spent_date', type: 'date', op: '>=', description: 'Earliest spent_date, inclusive.' },
      { name: 'to', column: 'e.spent_date', type: 'date', op: '<=', description: 'Latest spent_date, inclusive.' },
      { name: 'user_id', column: 'e.user_id', type: 'integer', op: '=', description: 'One person. Ignored for a member’s token.' },
      { name: 'project_id', column: 'e.project_id', type: 'integer', op: '=', description: 'One project.' },
      { name: 'category_id', column: 'ec.id', type: 'integer', op: '=', description: 'One category.' },
      { name: 'billable', column: 'e.billable', type: 'boolean', op: '=', description: 'true or false.' },
      { name: 'is_billed', column: 'e.is_billed', type: 'boolean', op: '=', description: 'true or false.' },
      { name: 'updated_since', column: 'e.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
  },
  {
    name: 'clients',
    singular: 'Client',
    summary: 'Clients',
    description: 'Who the work is for.',
    from: 'FROM clients c',
    order: 'c.is_active DESC, c.name',
    access: 'everyone',
    fields: [
      { ...ID, column: 'c.id' },
      { name: 'name', column: 'c.name', type: 'string', description: 'Client name.' },
      { name: 'address', column: 'c.address', type: 'string', description: 'Postal address, as one string.' },
      { name: 'currency', column: 'c.currency', type: 'string', description: 'ISO code this client is invoiced in.' },
      { name: 'is_active', column: 'c.is_active', type: 'boolean', boolean: true, description: 'False once archived.' },
      ...CREATED.map((f) => ({ ...f, column: `c.${f.column}` })),
    ],
    filters: [
      { name: 'is_active', column: 'c.is_active', type: 'boolean', op: '=', description: 'true for current clients only.' },
      { name: 'name', column: 'c.name', type: 'string', op: 'like', description: 'Substring match on the name.' },
      { name: 'updated_since', column: 'c.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
  },
  {
    name: 'projects',
    singular: 'Project',
    summary: 'Projects',
    description:
      'Rates and budgets are omitted for a member’s token. A budget is either hours or money, ' +
      'never both: `budget_seconds` and `budget_amount` are the two, and `budget_by` says which applies.',
    from: 'FROM projects p JOIN clients c ON c.id = p.client_id',
    order: 'p.is_active DESC, c.name, p.name',
    access: 'everyone',
    fields: [
      { ...ID, column: 'p.id' },
      { name: 'name', column: 'p.name', type: 'string', description: 'Project name.' },
      { name: 'code', column: 'p.code', type: 'string', description: 'Short code. Null on some projects.' },
      { name: 'client_id', column: 'p.client_id', type: 'integer', description: 'Client.' },
      { name: 'client_name', column: 'c.name', type: 'string', description: 'Client name.' },
      { name: 'is_active', column: 'p.is_active', type: 'boolean', boolean: true, description: 'False once the project is archived. Most projects in a long-lived account are.' },
      { name: 'is_billable', column: 'p.is_billable', type: 'boolean', boolean: true, description: 'Whether time on it can be billed.' },
      { name: 'is_fixed_fee', column: 'p.is_fixed_fee', type: 'boolean', boolean: true, description: 'Whether it is sold as a fee rather than by the hour.' },
      { name: 'bill_by', column: 'p.bill_by', type: 'string', description: 'How hours become an invoice line: none, Project, Tasks or People.' },
      { name: 'hourly_rate', column: 'p.hourly_rate', type: 'integer', privileged: true, description: 'Project rate, in minor units per hour.' },
      { name: 'fee', column: 'p.fee', type: 'integer', privileged: true, description: 'Fixed fee, in minor units.' },
      { name: 'budget_by', column: 'p.budget_by', type: 'string', description: 'What the budget counts, which decides its unit.' },
      { name: 'budget_seconds', column: 'p.budget_seconds', type: 'integer', privileged: true, description: 'Budget in seconds, when budget_by counts hours.' },
      { name: 'budget_amount', column: 'p.budget_amount', type: 'integer', privileged: true, description: 'Budget in minor units, when budget_by counts money.' },
      { name: 'budget_is_monthly', column: 'p.budget_is_monthly', type: 'boolean', boolean: true, privileged: true, description: 'Whether the budget resets each month.' },
      { name: 'notes', column: 'p.notes', type: 'string', description: 'Free text.' },
      { name: 'starts_on', column: 'p.starts_on', type: 'string', format: 'date', description: 'Start date, if set.' },
      { name: 'ends_on', column: 'p.ends_on', type: 'string', format: 'date', description: 'End date, if set.' },
      ...CREATED.map((f) => ({ ...f, column: `p.${f.column}` })),
    ],
    filters: [
      { name: 'client_id', column: 'p.client_id', type: 'integer', op: '=', description: 'One client.' },
      { name: 'is_active', column: 'p.is_active', type: 'boolean', op: '=', description: 'true for current projects only.' },
      { name: 'is_billable', column: 'p.is_billable', type: 'boolean', op: '=', description: 'true or false.' },
      { name: 'name', column: 'p.name', type: 'string', op: 'like', description: 'Substring match on the name.' },
      { name: 'code', column: 'p.code', type: 'string', op: 'like', description: 'Substring match on the code.' },
      { name: 'updated_since', column: 'p.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
  },
  {
    name: 'tasks',
    singular: 'Task',
    summary: 'Tasks',
    description: 'The kinds of work that can be logged. Billability belongs to the project–task pair, not here.',
    from: 'FROM tasks t',
    order: 't.is_active DESC, t.name',
    access: 'everyone',
    fields: [
      { ...ID, column: 't.id' },
      { name: 'name', column: 't.name', type: 'string', description: 'Task name.' },
      { name: 'billable_by_default', column: 't.billable_by_default', type: 'boolean', boolean: true, description: 'What a new project–task pair inherits.' },
      { name: 'default_hourly_rate', column: 't.default_hourly_rate', type: 'integer', privileged: true, description: 'Default rate, in minor units per hour.' },
      { name: 'is_active', column: 't.is_active', type: 'boolean', boolean: true, description: 'False once archived.' },
      ...CREATED.map((f) => ({ ...f, column: `t.${f.column}` })),
    ],
    filters: [
      { name: 'is_active', column: 't.is_active', type: 'boolean', op: '=', description: 'true for current tasks only.' },
      { name: 'name', column: 't.name', type: 'string', op: 'like', description: 'Substring match on the name.' },
      { name: 'updated_since', column: 't.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
  },
  {
    name: 'users',
    singular: 'Person',
    summary: 'People',
    description: 'Everyone in the account. Rates are omitted for a member’s token.',
    from: 'FROM users u',
    order: 'u.is_active DESC, u.first_name, u.last_name',
    access: 'everyone',
    fields: [
      { ...ID, column: 'u.id' },
      { name: 'email', column: 'u.email', type: 'string', description: 'Address they sign in with.' },
      { name: 'first_name', column: 'u.first_name', type: 'string', description: 'Given name.' },
      { name: 'last_name', column: 'u.last_name', type: 'string', description: 'Family name.' },
      { name: 'role', column: 'u.role', type: 'string', description: 'This instance’s permission level: admin, manager or member.' },
      { name: 'access_roles', column: 'u.access_roles', type: 'string', json: true, description: 'Harvest’s own grants, verbatim, as an array.' },
      { name: 'is_active', column: 'u.is_active', type: 'boolean', boolean: true, description: 'False once they leave.' },
      { name: 'is_contractor', column: 'u.is_contractor', type: 'boolean', boolean: true, description: 'Whether Harvest marked them a contractor.' },
      { name: 'timezone', column: 'u.timezone', type: 'string', description: 'Their timezone.' },
      { name: 'weekly_capacity_seconds', column: 'u.weekly_capacity_seconds', type: 'integer', description: 'Contracted hours a week, in seconds.' },
      { name: 'default_billable_rate', column: 'u.default_billable_rate', type: 'integer', privileged: true, description: 'Their rate, in minor units per hour.' },
      { name: 'cost_rate', column: 'u.cost_rate', type: 'integer', privileged: true, description: 'Their internal cost, in minor units per hour.' },
      ...CREATED.map((f) => ({ ...f, column: `u.${f.column}` })),
    ],
    filters: [
      { name: 'is_active', column: 'u.is_active', type: 'boolean', op: '=', description: 'true for current people only.' },
      { name: 'email', column: 'u.email', type: 'string', op: 'like', description: 'Substring match on the address.' },
      { name: 'role', column: 'u.role', type: 'string', op: '=', description: 'admin, manager or member.' },
      { name: 'updated_since', column: 'u.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
  },
  {
    name: 'invoices',
    singular: 'Invoice',
    summary: 'Invoices',
    description:
      'Invoice history as Harvest recorded it. This instance never issues invoices, so these ' +
      'are read-only by design, not by omission. The single-invoice endpoint includes its ' +
      'lines and payments.',
    from: 'FROM invoices i JOIN clients c ON c.id = i.client_id',
    order: 'i.issue_date DESC, i.id DESC',
    access: 'privileged',
    fields: [
      { ...ID, column: 'i.id' },
      { name: 'number', column: 'i.number', type: 'string', description: 'The number printed on the invoice. Text, not always numeric.' },
      { name: 'client_id', column: 'i.client_id', type: 'integer', description: 'Client.' },
      { name: 'client_name', column: 'c.name', type: 'string', description: 'Client name.' },
      { name: 'state', column: 'i.state', type: 'string', description: 'draft, open, paid or closed.' },
      { name: 'subject', column: 'i.subject', type: 'string', description: 'Subject line.' },
      { name: 'purchase_order', column: 'i.purchase_order', type: 'string', description: 'The client’s PO number, if any.' },
      { name: 'currency', column: 'i.currency', type: 'string', description: 'ISO code. Not always the account currency.' },
      { name: 'amount', column: 'i.amount', type: 'integer', description: 'Total including tax, after discount, in minor units.' },
      { name: 'due_amount', column: 'i.due_amount', type: 'integer', description: 'Still unpaid, in minor units.' },
      { name: 'tax_rate', column: 'i.tax_rate', type: 'number', description: 'Percentage, so 25 means 25%.' },
      { name: 'tax_amount', column: 'i.tax_amount', type: 'integer', description: 'Tax in minor units.' },
      { name: 'discount_rate', column: 'i.discount_rate', type: 'number', description: 'Percentage.' },
      { name: 'discount_amount', column: 'i.discount_amount', type: 'integer', description: 'Discount in minor units.' },
      { name: 'issue_date', column: 'i.issue_date', type: 'string', format: 'date', description: 'Date of issue.' },
      { name: 'due_date', column: 'i.due_date', type: 'string', format: 'date', description: 'Date payment is due.' },
      { name: 'payment_term', column: 'i.payment_term', type: 'string', description: 'Such as "net 30".' },
      { name: 'period_start', column: 'i.period_start', type: 'string', format: 'date', description: 'Start of the period billed, if set.' },
      { name: 'period_end', column: 'i.period_end', type: 'string', format: 'date', description: 'End of the period billed, if set.' },
      { name: 'sent_at', column: 'i.sent_at', type: 'string', format: 'date-time', description: 'When Harvest recorded it as sent.' },
      { name: 'paid_at', column: 'i.paid_at', type: 'string', format: 'date-time', description: 'When it was marked paid.' },
      { name: 'paid_date', column: 'i.paid_date', type: 'string', format: 'date', description: 'The date it was paid.' },
      { name: 'closed_at', column: 'i.closed_at', type: 'string', format: 'date-time', description: 'When it was written off.' },
      { name: 'creator_name', column: 'i.creator_name', type: 'string', description: 'Who raised it in Harvest.' },
      { name: 'notes', column: 'i.notes', type: 'string', description: 'Free text printed on the invoice.' },
      ...CREATED.map((f) => ({ ...f, column: `i.${f.column}` })),
    ],
    filters: [
      { name: 'client_id', column: 'i.client_id', type: 'integer', op: '=', description: 'One client.' },
      { name: 'state', column: 'i.state', type: 'string', op: '=', description: 'draft, open, paid or closed.' },
      { name: 'number', column: 'i.number', type: 'string', op: '=', description: 'Exact invoice number.' },
      { name: 'from', column: 'i.issue_date', type: 'date', op: '>=', description: 'Earliest issue_date, inclusive.' },
      { name: 'to', column: 'i.issue_date', type: 'date', op: '<=', description: 'Latest issue_date, inclusive.' },
      { name: 'updated_since', column: 'i.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
    expand: [
      {
        name: 'line_items',
        parent: 'l.invoice_id',
        from: 'FROM invoice_line_items l LEFT JOIN projects p ON p.id = l.project_id',
        order: 'l.position',
        fields: [
          { ...ID, column: 'l.id' },
          { name: 'kind', column: 'l.kind', type: 'string', description: 'The account’s own item category, as text.' },
          { name: 'description', column: 'l.description', type: 'string', description: 'Line text.' },
          { name: 'project_id', column: 'l.project_id', type: 'integer', description: 'Project the line refers to, if any.' },
          { name: 'project_name', column: 'p.name', type: 'string', description: 'Project name.' },
          { name: 'quantity', column: 'l.quantity', type: 'number', description: 'A count on this line. Never summed across lines.' },
          { name: 'unit_price', column: 'l.unit_price', type: 'integer', description: 'Price per unit, in minor units.' },
          { name: 'amount', column: 'l.amount', type: 'integer', description: 'Line total, in minor units.' },
          { name: 'taxed', column: 'l.taxed', type: 'boolean', boolean: true, description: 'Whether the first tax applies.' },
        ],
      },
      {
        name: 'payments',
        parent: 'y.invoice_id',
        from: 'FROM invoice_payments y',
        order: 'COALESCE(y.paid_date, y.paid_at), y.id',
        fields: [
          { ...ID, column: 'y.id' },
          { name: 'amount', column: 'y.amount', type: 'integer', description: 'Amount paid, in minor units.' },
          { name: 'paid_date', column: 'y.paid_date', type: 'string', format: 'date', description: 'Date of payment.' },
          { name: 'paid_at', column: 'y.paid_at', type: 'string', format: 'date-time', description: 'Timestamp of payment.' },
          { name: 'recorded_by', column: 'y.recorded_by', type: 'string', description: 'Who entered it.' },
          { name: 'transaction_reference', column: 'y.transaction_reference', type: 'string', description: 'Bank or gateway reference.' },
          { name: 'notes', column: 'y.notes', type: 'string', description: 'Free text.' },
        ],
      },
    ],
  },
  {
    name: 'estimates',
    singular: 'Estimate',
    summary: 'Estimates',
    description: 'Quotes as Harvest recorded them. The single-estimate endpoint includes its lines.',
    from: 'FROM estimates e JOIN clients c ON c.id = e.client_id',
    order: 'e.issue_date DESC, e.id DESC',
    access: 'privileged',
    fields: [
      { ...ID, column: 'e.id' },
      { name: 'number', column: 'e.number', type: 'string', description: 'Estimate number.' },
      { name: 'client_id', column: 'e.client_id', type: 'integer', description: 'Client.' },
      { name: 'client_name', column: 'c.name', type: 'string', description: 'Client name.' },
      { name: 'state', column: 'e.state', type: 'string', description: 'draft, sent, accepted or declined.' },
      { name: 'subject', column: 'e.subject', type: 'string', description: 'Subject line.' },
      { name: 'currency', column: 'e.currency', type: 'string', description: 'ISO code.' },
      { name: 'amount', column: 'e.amount', type: 'integer', description: 'Total, in minor units.' },
      { name: 'issue_date', column: 'e.issue_date', type: 'string', format: 'date', description: 'Date of issue.' },
      { name: 'sent_at', column: 'e.sent_at', type: 'string', format: 'date-time', description: 'When it was sent.' },
      { name: 'accepted_at', column: 'e.accepted_at', type: 'string', format: 'date-time', description: 'When the client accepted.' },
      { name: 'declined_at', column: 'e.declined_at', type: 'string', format: 'date-time', description: 'When the client declined.' },
      { name: 'creator_name', column: 'e.creator_name', type: 'string', description: 'Who raised it.' },
      { name: 'notes', column: 'e.notes', type: 'string', description: 'Free text.' },
      ...CREATED.map((f) => ({ ...f, column: `e.${f.column}` })),
    ],
    filters: [
      { name: 'client_id', column: 'e.client_id', type: 'integer', op: '=', description: 'One client.' },
      { name: 'state', column: 'e.state', type: 'string', op: '=', description: 'draft, sent, accepted or declined.' },
      { name: 'from', column: 'e.issue_date', type: 'date', op: '>=', description: 'Earliest issue_date, inclusive.' },
      { name: 'to', column: 'e.issue_date', type: 'date', op: '<=', description: 'Latest issue_date, inclusive.' },
      { name: 'updated_since', column: 'e.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
    expand: [
      {
        name: 'line_items',
        parent: 'l.estimate_id',
        from: 'FROM estimate_line_items l',
        order: 'l.position',
        fields: [
          { ...ID, column: 'l.id' },
          { name: 'kind', column: 'l.kind', type: 'string', description: 'Item category, as text.' },
          { name: 'description', column: 'l.description', type: 'string', description: 'Line text.' },
          { name: 'quantity', column: 'l.quantity', type: 'number', description: 'A count on this line.' },
          { name: 'unit_price', column: 'l.unit_price', type: 'integer', description: 'Price per unit, in minor units.' },
          { name: 'amount', column: 'l.amount', type: 'integer', description: 'Line total, in minor units.' },
        ],
      },
    ],
  },
  {
    name: 'contacts',
    singular: 'Contact',
    summary: 'Client contacts',
    description: 'People at client companies, including who receives the invoices.',
    from: 'FROM contacts k JOIN clients c ON c.id = k.client_id',
    order: 'c.name, k.last_name, k.first_name',
    access: 'privileged',
    fields: [
      { ...ID, column: 'k.id' },
      { name: 'client_id', column: 'k.client_id', type: 'integer', description: 'Client they belong to.' },
      { name: 'client_name', column: 'c.name', type: 'string', description: 'Client name.' },
      { name: 'title', column: 'k.title', type: 'string', description: 'Job title.' },
      { name: 'first_name', column: 'k.first_name', type: 'string', description: 'Given name.' },
      { name: 'last_name', column: 'k.last_name', type: 'string', description: 'Family name.' },
      { name: 'email', column: 'k.email', type: 'string', description: 'Email address.' },
      { name: 'phone_office', column: 'k.phone_office', type: 'string', description: 'Office number.' },
      { name: 'phone_mobile', column: 'k.phone_mobile', type: 'string', description: 'Mobile number.' },
      { name: 'invoice_recipient_status', column: 'k.invoice_recipient_status', type: 'string', description: 'none, primary or cc.' },
      ...CREATED.map((f) => ({ ...f, column: `k.${f.column}` })),
    ],
    filters: [
      { name: 'client_id', column: 'k.client_id', type: 'integer', op: '=', description: 'One client.' },
      { name: 'email', column: 'k.email', type: 'string', op: 'like', description: 'Substring match on the address.' },
      { name: 'updated_since', column: 'k.updated_at', type: 'string', op: '>=', description: 'Only records changed at or after this timestamp.' },
    ],
  },
];

export function findResource(name: string): Resource | undefined {
  return RESOURCES.find((r) => r.name === name);
}

export function isPrivileged(user: SessionUser): boolean {
  return user.role === 'admin' || user.role === 'manager';
}

/** The fields this caller may see. */
export function visibleFields(resource: Pick<Resource, 'fields'>, user: SessionUser): Field[] {
  return isPrivileged(user) ? resource.fields : resource.fields.filter((f) => !f.privileged);
}

export function selectList(fields: readonly Field[]): string {
  return fields.map((f) => `${f.column} AS "${f.name}"`).join(', ');
}

/** Turn a database row into the shape the API promises: booleans, parsed JSON, no undefined. */
export function shape(record: Record<string, unknown>, fields: readonly Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = record[field.name] ?? null;
    if (value === null) {
      out[field.name] = null;
    } else if (field.boolean) {
      out[field.name] = Boolean(value);
    } else if (field.json) {
      try {
        out[field.name] = JSON.parse(String(value));
      } catch {
        out[field.name] = null;
      }
    } else {
      out[field.name] = value;
    }
  }
  return out;
}

/** Read a sub-collection for one parent record. */
export function expandRows(
  db: Db,
  expand: NonNullable<Resource['expand']>[number],
  parentId: number,
): Record<string, unknown>[] {
  const found = rows<Record<string, unknown>>(
    db
      .prepare(`SELECT ${selectList(expand.fields)} ${expand.from} WHERE ${expand.parent} = ? ORDER BY ${expand.order}`)
      .all(parentId),
  );
  return found.map((r) => shape(r, expand.fields));
}
