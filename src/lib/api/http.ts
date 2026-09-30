/**
 * The parts of the JSON API that are the same on every endpoint: how an error looks, how a
 * page is described, how a filter is read, and how often a token may ask.
 *
 * One shape for every answer, so a caller writes the error handling once.
 */

import type { APIContext } from 'astro';
import type { SessionUser } from '../auth/session.ts';
import type { Filter, Resource } from './resources.ts';
import { isPrivileged } from './resources.ts';

export const API_VERSION = 'v1';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?Z?$/;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // A private answer about one company's timesheets has no business in a shared cache.
  'Cache-Control': 'no-store',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * Every failure looks the same: a stable `code` to branch on and a `message` to read. The
 * code is what a client should test; the message is for the person reading the log.
 */
export function fail(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

export const unauthorized = () =>
  fail(
    401,
    'unauthorized',
    'Send a personal access token as "Authorization: Bearer <token>". Create one at /tokens.',
    { 'WWW-Authenticate': 'Bearer' },
  );

export const forbidden = (message: string) => fail(403, 'forbidden', message);
export const notFound = (what: string) => fail(404, 'not_found', `No such ${what}.`);
export const badRequest = (message: string) => fail(400, 'bad_request', message);

export interface Paging {
  limit: number;
  offset: number;
}

/**
 * Offset paging, matching the admin lists (lib/paginate.ts). Cursor paging would be the
 * answer at a scale one instance will not reach, and offsets let a caller jump.
 */
export function readPaging(url: URL): Paging | Response {
  const rawLimit = url.searchParams.get('limit');
  const rawOffset = url.searchParams.get('offset');

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return badRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    }
    limit = n;
  }

  let offset = 0;
  if (rawOffset !== null) {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) return badRequest('offset must be a whole number, 0 or more.');
    offset = n;
  }

  return { limit, offset };
}

export interface Where {
  clause: string;
  args: (string | number)[];
}

/**
 * Read this resource's declared filters off the query string.
 *
 * Only declared names are looked at, and every value is checked against its declared type, so
 * nothing a caller writes reaches SQL except as a bound parameter. An unknown parameter is
 * rejected rather than ignored: silently dropping a misspelled filter answers with more data
 * than the caller asked for, which they may not notice until it matters.
 */
export function buildWhere(resource: Resource, url: URL, viewer: SessionUser): Where | Response {
  const parts: string[] = [];
  const args: (string | number)[] = [];

  if (resource.where) parts.push(resource.where);

  const known = new Set([...resource.filters.map((f) => f.name), 'limit', 'offset']);
  for (const name of url.searchParams.keys()) {
    if (!known.has(name)) {
      return badRequest(
        `Unknown parameter "${name}". This endpoint accepts: ${[...known].sort().join(', ')}.`,
      );
    }
  }

  for (const filter of resource.filters) {
    const raw = url.searchParams.get(filter.name);
    if (raw === null || raw === '') continue;

    const value = readFilterValue(filter, raw);
    if (value instanceof Response) return value;

    parts.push(`${filter.column} ${filter.op === 'like' ? 'LIKE' : filter.op} ?`);
    args.push(value);
  }

  // A member is confined to their own rows whatever the query string said. Applied last, so
  // it cannot be widened by a filter above it.
  if (resource.viewerColumn && !isPrivileged(viewer)) {
    parts.push(`${resource.viewerColumn} = ?`);
    args.push(viewer.id);
  }

  return { clause: parts.length ? parts.join(' AND ') : '1 = 1', args };
}

function readFilterValue(filter: Filter, raw: string): string | number | Response {
  switch (filter.type) {
    case 'integer': {
      const n = Number(raw);
      if (!Number.isInteger(n)) return badRequest(`${filter.name} must be a whole number.`);
      return n;
    }
    case 'boolean': {
      if (raw !== 'true' && raw !== 'false') return badRequest(`${filter.name} must be true or false.`);
      return raw === 'true' ? 1 : 0;
    }
    case 'date': {
      if (!DATE.test(raw)) return badRequest(`${filter.name} must be a date as YYYY-MM-DD.`);
      return raw;
    }
    default: {
      if (filter.op === 'like') return `%${raw}%`;
      // `updated_since` and friends compare against stored ISO timestamps.
      if (filter.op === '>=' || filter.op === '<=') {
        if (!TIMESTAMP.test(raw)) {
          return badRequest(`${filter.name} must be a date or timestamp, such as 2026-01-31 or 2026-01-31T09:00:00Z.`);
        }
      }
      return raw;
    }
  }
}

/** The envelope every collection comes back in. */
export function page(
  context: APIContext,
  data: unknown[],
  paging: Paging,
  total: number,
): Response {
  const nextOffset = paging.offset + paging.limit;
  const url = new URL(context.url);
  url.searchParams.set('limit', String(paging.limit));
  url.searchParams.set('offset', String(nextOffset));

  return json({
    data,
    pagination: {
      limit: paging.limit,
      offset: paging.offset,
      total,
      next: nextOffset < total ? url.toString() : null,
    },
  });
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// A fixed window per token, held in memory. Memory is the right place here for the same
// reason the sync's progress lives there: one process serves one company, so there
// is no second node whose counter would disagree. It resets when the process does, which is
// the honest trade for having no dependency at all.

const WINDOW_MS = 60_000;
const PER_WINDOW = 240;

const windows = new Map<string, { count: number; resetAt: number }>();

export interface RateVerdict {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(key: string, now = Date.now()): RateVerdict {
  const found = windows.get(key);

  if (!found || found.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + WINDOW_MS };
    windows.set(key, fresh);
    // Old keys would otherwise accumulate for every token ever seen. Cheap to sweep here,
    // where it happens once a window rather than on every request.
    if (windows.size > 1000) {
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
    }
    return { ok: true, remaining: PER_WINDOW - 1, resetAt: fresh.resetAt };
  }

  found.count += 1;
  return { ok: found.count <= PER_WINDOW, remaining: Math.max(0, PER_WINDOW - found.count), resetAt: found.resetAt };
}

export function rateHeaders(verdict: RateVerdict): Record<string, string> {
  return {
    'RateLimit-Limit': String(PER_WINDOW),
    'RateLimit-Remaining': String(verdict.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((verdict.resetAt - Date.now()) / 1000))),
  };
}

export const RATE_LIMIT_PER_MINUTE = PER_WINDOW;
