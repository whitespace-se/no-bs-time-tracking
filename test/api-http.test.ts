/**
 * The pieces every JSON API endpoint shares: paging, filter parsing, the error envelope and
 * the page envelope.
 *
 * Rate limiting lives in the same module but is covered by test/api-token.test.ts; nothing
 * here touches it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIContext } from 'astro';
import type { SessionUser } from '../src/lib/auth/session.ts';
import {
  API_VERSION,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  badRequest,
  buildWhere,
  fail,
  forbidden,
  json,
  notFound,
  page,
  readPaging,
  unauthorized,
} from '../src/lib/api/http.ts';
import type { Filter, Resource } from '../src/lib/api/resources.ts';
import { findResource } from '../src/lib/api/resources.ts';

// ── local helpers ────────────────────────────────────────────────────────────

const ADMIN: SessionUser = { id: 1, email: 'ada@example.test', name: 'Ada Example', role: 'admin' };
const MANAGER: SessionUser = { id: 2, email: 'mia@example.test', name: 'Mia Example', role: 'manager' };
const MEMBER: SessionUser = { id: 3, email: 'bob@example.test', name: 'Bob Example', role: 'member' };

function url(query = ''): URL {
  return new URL(`https://tracking.example.test/api/v1/time-entries${query}`);
}

/** The one resource every case below leans on, taken from the real declaration. */
function timeEntries(): Resource {
  const resource = findResource('time-entries');
  assert.ok(resource, 'time-entries must exist');
  return resource;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorOf(value: unknown): { code: string; message: string } {
  return (value as { error: { code: string; message: string } }).error;
}

/** `page()` reads only `url` off the context. */
function contextFor(target: URL): APIContext {
  return { url: target } as unknown as APIContext;
}

function whereOrFail(resource: Resource, target: URL, viewer: SessionUser) {
  const result = buildWhere(resource, target, viewer);
  assert.ok(!(result instanceof Response), 'expected a WHERE clause, got a Response');
  return result;
}

async function rejection(resource: Resource, target: URL, viewer: SessionUser) {
  const result = buildWhere(resource, target, viewer);
  assert.ok(result instanceof Response, 'expected a rejection');
  assert.equal(result.status, 400);
  return errorOf(await body(result));
}

// ── constants ────────────────────────────────────────────────────────────────

test('the version and paging limits are what the spec and the handlers share', () => {
  assert.equal(API_VERSION, 'v1');
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(MAX_LIMIT, 200);
  assert.ok(DEFAULT_LIMIT <= MAX_LIMIT);
});

// ── error helpers ────────────────────────────────────────────────────────────

test('every answer is JSON that no cache may keep', async () => {
  const response = json({ data: [] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await body(response), { data: [] });
});

test('json pretty-prints, and extra headers win over the defaults', async () => {
  const response = json({ a: 1 }, 201, { 'Cache-Control': 'max-age=60', 'X-Extra': 'yes' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Cache-Control'), 'max-age=60');
  assert.equal(response.headers.get('X-Extra'), 'yes');
  assert.equal(await response.text(), '{\n  "a": 1\n}');
});

test('fail carries a stable code beside a readable message', async () => {
  const response = fail(418, 'teapot', 'Short and stout.', { 'X-Trace': 'abc' });
  assert.equal(response.status, 418);
  assert.equal(response.headers.get('X-Trace'), 'abc');
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(await body(response), { error: { code: 'teapot', message: 'Short and stout.' } });
});

test('unauthorized asks for a bearer token and says where to get one', async () => {
  const response = unauthorized();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
  const error = errorOf(await body(response));
  assert.equal(error.code, 'unauthorized');
  assert.match(error.message, /Authorization: Bearer/);
  assert.match(error.message, /\/tokens/);
});

test('forbidden, notFound and badRequest each have their own code and status', async () => {
  const cases: [Response, number, string][] = [
    [forbidden('Managers only.'), 403, 'forbidden'],
    [notFound('invoice'), 404, 'not_found'],
    [badRequest('limit must be a number.'), 400, 'bad_request'],
  ];
  for (const [response, status, code] of cases) {
    assert.equal(response.status, status);
    assert.equal(errorOf(await body(response)).code, code);
  }
  assert.equal(errorOf(await body(notFound('invoice'))).message, 'No such invoice.');
});

// ── paging ───────────────────────────────────────────────────────────────────

test('paging defaults to the first page of DEFAULT_LIMIT', () => {
  assert.deepEqual(readPaging(url()), { limit: DEFAULT_LIMIT, offset: 0 });
});

test('an empty limit or offset is a refusal, not the default', async () => {
  // `?limit=` reads as 0, which is out of range. A filter left empty is skipped instead
  // (see buildWhere below); paging is the stricter of the two on purpose.
  const emptyLimit = readPaging(url('?limit='));
  assert.ok(emptyLimit instanceof Response);
  assert.equal(errorOf(await body(emptyLimit)).code, 'bad_request');
  // An empty offset reads as 0, which *is* in range, so it is simply the first page.
  assert.deepEqual(readPaging(url('?offset=')), { limit: DEFAULT_LIMIT, offset: 0 });
});

test('paging accepts the whole declared range and nothing outside it', () => {
  assert.deepEqual(readPaging(url('?limit=1')), { limit: 1, offset: 0 });
  assert.deepEqual(readPaging(url(`?limit=${MAX_LIMIT}&offset=400`)), { limit: MAX_LIMIT, offset: 400 });
});

test('a limit that is not a whole number in range is refused, not clamped', async () => {
  for (const raw of ['0', '-1', String(MAX_LIMIT + 1), '1.5', 'ten', 'NaN', 'Infinity', '1e3']) {
    const result = readPaging(url(`?limit=${raw}`));
    assert.ok(result instanceof Response, `limit=${raw} should be refused`);
    assert.equal(result.status, 400);
    const error = errorOf(await body(result));
    assert.equal(error.code, 'bad_request');
    assert.match(error.message, /limit must be a whole number from 1 to 200\./);
  }
});

test('a negative or fractional offset is refused', async () => {
  for (const raw of ['-1', '2.5', 'x']) {
    const result = readPaging(url(`?offset=${raw}`));
    assert.ok(result instanceof Response, `offset=${raw} should be refused`);
    assert.equal(errorOf(await body(result)).message, 'offset must be a whole number, 0 or more.');
  }
});

// ── filters ──────────────────────────────────────────────────────────────────

test('no filters means a clause that matches everything, with no arguments', () => {
  const where = whereOrFail(timeEntries(), url(), ADMIN);
  assert.deepEqual(where, { clause: '1 = 1', args: [] });
});

test('a declared filter becomes a bound parameter, never inlined SQL', () => {
  const where = whereOrFail(timeEntries(), url('?project_id=100&from=2026-01-01'), ADMIN);
  assert.equal(where.clause, 't.spent_date >= ? AND t.project_id = ?');
  assert.deepEqual(where.args, ['2026-01-01', 100]);
  assert.ok(!where.clause.includes('100'), 'the value must not reach the clause');
});

test("a value that looks like SQL travels as an argument and nothing else", () => {
  const injection = "1; DROP TABLE time_entries";
  const clients = findResource('clients');
  assert.ok(clients);
  const target = new URL(`https://x.test/api/v1/clients?name=${encodeURIComponent(injection)}`);
  const where = whereOrFail(clients, target, ADMIN);
  assert.equal(where.clause, 'c.name LIKE ?');
  assert.deepEqual(where.args, [`%${injection}%`]);
});

test('an empty filter value is skipped rather than matched against the empty string', () => {
  const where = whereOrFail(timeEntries(), url('?project_id=&billable='), ADMIN);
  assert.deepEqual(where, { clause: '1 = 1', args: [] });
});

test('booleans arrive as 1 and 0, and only as true or false', async () => {
  const yes = whereOrFail(timeEntries(), url('?billable=true'), ADMIN);
  assert.deepEqual(yes.args, [1]);
  const no = whereOrFail(timeEntries(), url('?billable=false'), ADMIN);
  assert.deepEqual(no.args, [0]);

  for (const raw of ['1', '0', 'yes', 'TRUE']) {
    const error = await rejection(timeEntries(), url(`?billable=${raw}`), ADMIN);
    assert.equal(error.message, 'billable must be true or false.');
  }
});

test('integer filters refuse anything that is not a whole number', async () => {
  const error = await rejection(timeEntries(), url('?project_id=abc'), ADMIN);
  assert.equal(error.message, 'project_id must be a whole number.');
  assert.deepEqual(whereOrFail(timeEntries(), url('?project_id=-4'), ADMIN).args, [-4]);
});

test('date filters insist on YYYY-MM-DD', async () => {
  for (const raw of ['2026-1-1', '01/02/2026', '2026-01-01T09:00:00Z', 'today']) {
    const error = await rejection(timeEntries(), url(`?from=${encodeURIComponent(raw)}`), ADMIN);
    assert.equal(error.message, 'from must be a date as YYYY-MM-DD.');
  }
  assert.deepEqual(whereOrFail(timeEntries(), url('?to=2026-12-31'), ADMIN).args, ['2026-12-31']);
});

test('updated_since takes a date or a timestamp, and rejects free text', async () => {
  for (const raw of ['2026-01-31', '2026-01-31T09:00Z', '2026-01-31T09:00:00Z', '2026-01-31 09:00:00']) {
    const where = whereOrFail(timeEntries(), url(`?updated_since=${encodeURIComponent(raw)}`), ADMIN);
    assert.equal(where.clause, 't.updated_at >= ?');
    assert.deepEqual(where.args, [raw]);
  }
  const error = await rejection(timeEntries(), url('?updated_since=yesterday'), ADMIN);
  assert.match(error.message, /^updated_since must be a date or timestamp/);
});

test('an unknown parameter is refused, and the answer lists what is accepted', async () => {
  const error = await rejection(timeEntries(), url('?porject_id=100'), ADMIN);
  assert.match(error.message, /^Unknown parameter "porject_id"\./);
  const accepted = error.message.replace(/^.*accepts: /, '').replace(/\.$/, '').split(', ');
  assert.deepEqual(accepted, [...accepted].sort(), 'the list is sorted');
  assert.ok(accepted.includes('limit') && accepted.includes('offset'));
  for (const filter of timeEntries().filters) assert.ok(accepted.includes(filter.name), filter.name);
});

test('limit and offset are not treated as unknown parameters', () => {
  const where = whereOrFail(timeEntries(), url('?limit=10&offset=20'), ADMIN);
  assert.deepEqual(where, { clause: '1 = 1', args: [] });
});

test('a member is confined to their own rows, and the scope is applied last', () => {
  const where = whereOrFail(timeEntries(), url('?user_id=999'), MEMBER);
  assert.equal(where.clause, 't.user_id = ? AND t.user_id = ?');
  assert.deepEqual(where.args, [999, MEMBER.id], 'their own id is the last word');
  assert.ok(where.clause.endsWith('t.user_id = ?'));
});

test('an admin and a manager are not scoped to themselves', () => {
  for (const viewer of [ADMIN, MANAGER]) {
    const where = whereOrFail(timeEntries(), url(), viewer);
    assert.equal(where.clause, '1 = 1');
    assert.deepEqual(where.args, []);
  }
});

test('a resource with an always-on restriction keeps it first', () => {
  const filter: Filter = {
    name: 'kind', column: 'x.kind', type: 'string', op: '=', description: 'Kind.',
  };
  const restricted: Resource = {
    name: 'things',
    singular: 'Thing',
    summary: 'Things',
    description: 'Synthetic.',
    from: 'FROM things x',
    where: 'x.is_visible = 1',
    order: 'x.id',
    access: 'everyone',
    viewerColumn: 'x.user_id',
    fields: [{ name: 'id', column: 'x.id', type: 'integer', description: 'Id.' }],
    filters: [filter],
  };
  const target = new URL('https://x.test/api/v1/things?kind=box');
  const where = whereOrFail(restricted, target, MEMBER);
  assert.equal(where.clause, 'x.is_visible = 1 AND x.kind = ? AND x.user_id = ?');
  assert.deepEqual(where.args, ['box', MEMBER.id]);
});

// ── the page envelope ────────────────────────────────────────────────────────

test('a page says how it was fetched and where the next one is', async () => {
  const target = url('?project_id=100&limit=2&offset=0');
  const response = page(contextFor(target), [{ id: 1 }, { id: 2 }], { limit: 2, offset: 0 }, 5);
  const payload = await body(response);
  assert.deepEqual(payload.data, [{ id: 1 }, { id: 2 }]);
  const pagination = payload.pagination as Record<string, unknown>;
  assert.equal(pagination.limit, 2);
  assert.equal(pagination.offset, 0);
  assert.equal(pagination.total, 5);

  const next = new URL(String(pagination.next));
  assert.equal(next.searchParams.get('offset'), '2');
  assert.equal(next.searchParams.get('limit'), '2');
  assert.equal(next.searchParams.get('project_id'), '100', 'the filters survive the next link');
  assert.equal(next.pathname, target.pathname);
});

test('the last page has no next link', async () => {
  const cases: [number, number, number][] = [
    [2, 4, 6], // offset 4 + limit 2 = 6, exactly the total
    [2, 4, 5], // past the end
    [50, 0, 0], // nothing at all
  ];
  for (const [limit, offset, total] of cases) {
    const response = page(contextFor(url()), [], { limit, offset }, total);
    const pagination = (await body(response)).pagination as Record<string, unknown>;
    assert.equal(pagination.next, null, `limit ${limit} offset ${offset} total ${total}`);
  }
});

test('a next link is offered exactly when records remain', async () => {
  const response = page(contextFor(url()), [{ id: 1 }], { limit: 1, offset: 0 }, 2);
  const pagination = (await body(response)).pagination as Record<string, unknown>;
  assert.equal(typeof pagination.next, 'string');
});
