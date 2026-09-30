/**
 * Harvest's API v2, answered from this instance.
 *
 * Scripts written against Harvest — a monthly payroll report that reads everyone's time, say —
 * keep working when pointed here instead: the same paths, the same credentials, the same
 * record shapes under the same keys, paged and filtered the same way. Unlike a copy of an
 * export, every record is built from this instance's own tables, so time imported from a CSV,
 * imported through the API or logged here since all come out alike.
 *
 * Read-only, and the part of the API such scripts use: the company, people, clients, projects,
 * tasks and time entries. Ids are this instance's own.
 */

import type { Db } from '../db/index.ts';
import { row, rows } from '../db/index.ts';
import { resolveToken, type TokenBearer } from '../auth/api-token.ts';
import { readSettings } from '../settings.ts';

/** Harvest's page size: 2000 at most, and by default. */
const MAX_PER_PAGE = 2000;

/** Harvest's general limit: 100 requests in 15 seconds, per token. */
const RATE_WINDOW_MS = 15_000;
const RATE_LIMIT = 100;

type Record_ = Record<string, unknown>;
type Filter = (value: string) => { clause: string; args: (string | number)[] } | null;

interface ListSpec {
  /** FROM … with the joins the shape needs. */
  from: string;
  /** SELECT list; `shape` turns a row of it into Harvest's record. */
  select: string;
  order: string;
  shape: (row: Record_) => Record_;
  filters: Record<string, Filter>;
  /** What a member may see: their own rows only. */
  own?: string;
}

const hours = (seconds: unknown) => Math.round((Number(seconds ?? 0) / 3600) * 100) / 100;
const major = (minor: unknown) => (minor === null || minor === undefined ? null : Number(minor) / 100);
const flag = (value: unknown) => Boolean(value);

const eqNumber = (column: string): Filter => (value) =>
  /^\d+$/.test(value) ? { clause: `${column} = ?`, args: [Number(value)] } : null;
const eqBool = (column: string): Filter => (value) =>
  value === 'true' || value === 'false' ? { clause: `${column} = ?`, args: [value === 'true' ? 1 : 0] } : null;
const onOrAfter = (column: string): Filter => (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? { clause: `${column} >= ?`, args: [value] } : null;
const onOrBefore = (column: string): Filter => (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? { clause: `${column} <= ?`, args: [value] } : null;
const since = (column: string): Filter => (value) => {
  if (Number.isNaN(Date.parse(value))) return null;
  return { clause: `${column} >= ?`, args: [new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')] };
};

const LISTS: Record<string, ListSpec> = {
  users: {
    from: 'FROM users u',
    select: 'u.*',
    order: 'u.created_at DESC, u.id DESC',
    own: 'u.id',
    filters: { is_active: eqBool('u.is_active'), updated_since: since('u.updated_at') },
    shape: (u) => ({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      telephone: '',
      timezone: u.timezone ?? null,
      has_access_to_all_future_projects: false,
      is_contractor: flag(u.is_contractor),
      is_active: flag(u.is_active),
      weekly_capacity: u.weekly_capacity_seconds ?? null,
      default_hourly_rate: major(u.default_billable_rate),
      cost_rate: major(u.cost_rate),
      roles: [],
      access_roles: [u.role === 'admin' ? 'administrator' : u.role === 'manager' ? 'manager' : 'member'],
      avatar_url: u.avatar_url ?? null,
      created_at: u.created_at,
      updated_at: u.updated_at,
    }),
  },
  clients: {
    from: 'FROM clients c',
    select: 'c.*',
    order: 'c.created_at DESC, c.id DESC',
    filters: { is_active: eqBool('c.is_active'), updated_since: since('c.updated_at') },
    shape: (c) => ({
      id: c.id, name: c.name, is_active: flag(c.is_active), address: c.address ?? null,
      statement_key: null, currency: c.currency, created_at: c.created_at, updated_at: c.updated_at,
    }),
  },
  tasks: {
    from: 'FROM tasks t',
    select: 't.*',
    order: 't.created_at DESC, t.id DESC',
    filters: { is_active: eqBool('t.is_active'), updated_since: since('t.updated_at') },
    shape: (t) => ({
      id: t.id, name: t.name, billable_by_default: flag(t.billable_by_default),
      default_hourly_rate: major(t.default_hourly_rate), is_default: flag(t.is_default),
      is_active: flag(t.is_active), created_at: t.created_at, updated_at: t.updated_at,
    }),
  },
  projects: {
    from: 'FROM projects p JOIN clients c ON c.id = p.client_id',
    select: 'p.*, c.name AS client_name, c.currency AS client_currency',
    order: 'p.created_at DESC, p.id DESC',
    filters: { is_active: eqBool('p.is_active'), client_id: eqNumber('p.client_id'), updated_since: since('p.updated_at') },
    shape: (p) => ({
      id: p.id,
      name: p.name,
      code: p.code ?? null,
      is_active: flag(p.is_active),
      is_billable: flag(p.is_billable),
      is_fixed_fee: flag(p.is_fixed_fee),
      bill_by: p.bill_by ?? 'none',
      budget: p.budget_amount !== null && p.budget_amount !== undefined ? major(p.budget_amount)
        : p.budget_seconds !== null && p.budget_seconds !== undefined ? hours(p.budget_seconds) : null,
      budget_by: p.budget_by ?? 'none',
      budget_is_monthly: flag(p.budget_is_monthly),
      hourly_rate: major(p.hourly_rate),
      fee: major(p.fee),
      cost_budget: major(p.cost_budget),
      notes: p.notes ?? '',
      starts_on: p.starts_on ?? null,
      ends_on: p.ends_on ?? null,
      created_at: p.created_at,
      updated_at: p.updated_at,
      client: { id: p.client_id, name: p.client_name, currency: p.client_currency },
    }),
  },
  time_entries: {
    from: `FROM time_entries te
             JOIN users u ON u.id = te.user_id
             JOIN projects p ON p.id = te.project_id
             JOIN clients c ON c.id = te.client_id
             JOIN tasks t ON t.id = te.task_id
        LEFT JOIN invoices i ON i.harvest_id = te.invoice_id`,
    select: `te.*, TRIM(u.first_name || ' ' || u.last_name) AS user_name, p.name AS project_name,
             p.code AS project_code, c.name AS client_name, c.currency AS client_currency,
             t.name AS task_name, i.id AS invoice_local_id, i.number AS invoice_number`,
    order: 'te.spent_date DESC, te.created_at DESC, te.id DESC',
    own: 'te.user_id',
    filters: {
      user_id: eqNumber('te.user_id'), client_id: eqNumber('te.client_id'), project_id: eqNumber('te.project_id'),
      task_id: eqNumber('te.task_id'), is_billed: eqBool('te.is_billed'), is_running: eqBool('te.is_running'),
      from: onOrAfter('te.spent_date'), to: onOrBefore('te.spent_date'), updated_since: since('te.updated_at'),
    },
    shape: (te) => {
      // Hours as the source recorded them where it did, otherwise from the stored seconds.
      const worked = te.source_hours !== null && te.source_hours !== undefined ? Number(te.source_hours) : hours(te.duration_seconds);
      return {
        id: te.id,
        spent_date: te.spent_date,
        hours: worked,
        hours_without_timer: worked,
        rounded_hours: hours(te.rounded_seconds),
        // Harvest gives null where there is no note.
        notes: te.notes ?? null,
        is_locked: flag(te.is_locked),
        locked_reason: te.locked_reason ?? null,
        is_explicitly_locked: flag(te.is_explicitly_locked),
        approval_status: te.approval_status ?? 'unsubmitted',
        is_closed: false,
        is_billed: flag(te.is_billed),
        timer_started_at: te.timer_started_at ?? null,
        started_time: te.started_time ?? null,
        ended_time: te.ended_time ?? null,
        is_running: flag(te.is_running),
        billable: flag(te.billable),
        budgeted: flag(te.budgeted),
        billable_rate: major(te.billable_rate),
        cost_rate: major(te.cost_rate),
        created_at: te.created_at,
        updated_at: te.updated_at,
        user: { id: te.user_id, name: te.user_name },
        client: { id: te.client_id, name: te.client_name, currency: te.client_currency },
        project: { id: te.project_id, name: te.project_name, code: te.project_code ?? null },
        task: { id: te.task_id, name: te.task_name },
        invoice: te.invoice_local_id ? { id: te.invoice_local_id, number: te.invoice_number } : null,
        external_reference: null,
      };
    },
  },
};

// ── responses, in Harvest's shapes ─────────────────────────────────────────────

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const notFound = () => respond({ status: 404, error: 'Not Found' }, 404);
const invalidToken = () => respond({
  error: 'invalid_token',
  error_description: 'The access token provided is expired, revoked, malformed or invalid for other reasons.',
}, 401);

// ── credentials and rate limit ─────────────────────────────────────────────────

const windows = new Map<number, number[]>();

/** Harvest's sliding window, per token. Seconds to wait, or null to go ahead. */
function rateLimited(tokenId: number, now = Date.now()): number | null {
  const recent = (windows.get(tokenId) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    windows.set(tokenId, recent);
    return Math.ceil((recent[0]! + RATE_WINDOW_MS - now) / 1000);
  }
  recent.push(now);
  windows.set(tokenId, recent);
  return null;
}

/**
 * The account id to insist on, when HARVEST_ACCOUNT_ID is set — so a script keeps sending the
 * one it always sent. Unset, any is taken: an instance holds a single account.
 */
function expectedAccountId(): string | null {
  return process.env.HARVEST_ACCOUNT_ID?.trim() || null;
}

// ── the handler ────────────────────────────────────────────────────────────────

export function serveHarvest(database: Db, request: Request, url: URL, path: string): Response {
  if (request.method !== 'GET') {
    return respond({ status: 405, error: 'This Harvest-compatible API only reads.' }, 405, { Allow: 'GET' });
  }
  if (!request.headers.get('user-agent')) {
    return respond({ status: 400, error: 'A User-Agent header is required.' }, 400);
  }

  // Harvest takes the token and account from headers, or from the query string.
  const header = request.headers.get('authorization')
    ?? (url.searchParams.get('access_token') ? `Bearer ${url.searchParams.get('access_token')}` : null);
  const bearer = resolveToken(database, header);
  if (!bearer) return invalidToken();
  const account = request.headers.get('harvest-account-id') ?? url.searchParams.get('account_id');
  const expected = expectedAccountId();
  if (!account || (expected && account.trim() !== expected)) return invalidToken();

  const wait = rateLimited(bearer.tokenId);
  if (wait !== null) {
    return respond({ status: 429, error: 'Too Many Requests' }, 429, { 'Retry-After': String(wait) });
  }

  const parts = path.split('/').filter(Boolean);
  if (parts.length === 1 && parts[0] === 'company') return respond(company(database, url));

  const [resource, id] = parts;
  const spec = resource ? LISTS[resource] : undefined;
  if (!spec) return notFound();

  if (parts.length === 2 && resource === 'users' && id === 'me') {
    return single(database, spec, 'u.id', bearer.user.id, bearer);
  }
  if (parts.length === 2 && /^\d+$/.test(id!)) {
    const key = spec.from.match(/FROM \w+ (\w+)/)![1]!;
    return single(database, spec, `${key}.id`, Number(id), bearer);
  }
  if (parts.length === 1) return list(database, url, resource!, spec, bearer);
  return notFound();
}

/** A member reads their own time and themselves; managers and administrators, everyone's. */
function visibility(spec: ListSpec, bearer: TokenBearer): { clause: string; args: number[] } | null {
  if (bearer.user.role !== 'member' || !spec.own) return null;
  return { clause: `${spec.own} = ?`, args: [bearer.user.id] };
}

function single(database: Db, spec: ListSpec, idColumn: string, id: number, bearer: TokenBearer): Response {
  const own = visibility(spec, bearer);
  const found = row<Record_>(
    database.prepare(`SELECT ${spec.select} ${spec.from} WHERE ${idColumn} = ?${own ? ` AND ${own.clause}` : ''}`)
      .get(id, ...(own?.args ?? [])),
  );
  return found ? respond(spec.shape(found)) : notFound();
}

function list(database: Db, url: URL, key: string, spec: ListSpec, bearer: TokenBearer): Response {
  const page = Number(url.searchParams.get('page') ?? 1);
  const perPage = Number(url.searchParams.get('per_page') ?? MAX_PER_PAGE);
  if (!Number.isInteger(page) || page < 1) return respond({ status: 422, error: 'page must be a positive integer' }, 422);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) {
    return respond({ status: 422, error: `per_page must be between 1 and ${MAX_PER_PAGE}` }, 422);
  }

  const clauses: string[] = ['1 = 1'];
  const args: (string | number)[] = [];
  const own = visibility(spec, bearer);
  if (own) {
    clauses.push(own.clause);
    args.push(...own.args);
  }
  for (const [name, filter] of Object.entries(spec.filters)) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    const applied = filter(value);
    if (!applied) return respond({ status: 422, error: `${name} is not valid` }, 422);
    clauses.push(applied.clause);
    args.push(...applied.args);
  }
  const where = clauses.join(' AND ');

  const total = (database.prepare(`SELECT COUNT(*) AS n ${spec.from} WHERE ${where}`).get(...args) as { n: number }).n;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const found = rows<Record_>(
    database.prepare(`SELECT ${spec.select} ${spec.from} WHERE ${where} ORDER BY ${spec.order} LIMIT ? OFFSET ?`)
      .all(...args, perPage, (page - 1) * perPage),
  );

  const at = (n: number) => {
    const target = new URL(url);
    target.searchParams.delete('access_token');
    target.searchParams.delete('account_id');
    target.searchParams.set('page', String(n));
    target.searchParams.set('per_page', String(perPage));
    return target.toString();
  };
  const next = page < totalPages ? page + 1 : null;
  const previous = page > 1 ? page - 1 : null;
  return respond({
    [key]: found.map(spec.shape),
    per_page: perPage,
    total_pages: totalPages,
    total_entries: total,
    next_page: next,
    previous_page: previous,
    page,
    links: { first: at(1), next: next ? at(next) : null, previous: previous ? at(previous) : null, last: at(totalPages) },
  });
}

const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function company(database: Db, url: URL): Record_ {
  const settings = readSettings(database);
  return {
    base_uri: url.origin,
    full_domain: url.host,
    name: settings.companyName,
    is_active: true,
    week_start_day: DAY_NAME[settings.weekStartDay] ?? 'Monday',
    wants_timestamp_timers: false,
    time_format: settings.timeFormat,
    date_format: '%Y-%m-%d',
    plan_type: 'business',
    clock: '24h',
    currency: settings.currency,
    decimal_symbol: settings.decimalSymbol,
    thousands_separator: settings.thousandsSeparator,
    weekly_capacity: 144000,
    expense_feature: true,
    invoice_feature: true,
    estimate_feature: true,
    approval_feature: true,
    team_feature: true,
  };
}
