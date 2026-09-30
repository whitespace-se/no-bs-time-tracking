import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionUser } from '../src/lib/auth/session.ts';
import {
  buildWhere,
  countEntries,
  detailRows,
  filtersToQuery,
  groupTotals,
  readFilters,
  totals,
  type ReportFilters,
} from '../src/lib/timesheet/report.ts';
import { addEntry, plain, seedBasics, tempDb } from './fixture.ts';

const admin: SessionUser = { id: 1, email: 'ada@example.test', name: 'Ada Example', role: 'admin' };
const member: SessionUser = { id: 2, email: 'bob@example.test', name: 'Bob Example', role: 'member' };
const defaults = { from: '2026-03-01', to: '2026-03-31' };

const all = (): ReportFilters => ({
  from: '2026-03-01', to: '2026-03-31', userId: null, clientId: null, projectId: null, taskId: null, billable: null,
});

function seeded() {
  const fixture = tempDb();
  seedBasics(fixture.db);
  // March: three entries across two people, two clients and two tasks. One in April, out of range.
  addEntry(fixture.db, { id: 1, date: '2026-03-02', user: 1, project: 100, task: 200, seconds: 3600, notes: 'Build' });
  addEntry(fixture.db, { id: 2, date: '2026-03-03', user: 1, project: 100, task: 200, seconds: 1500, rounded: 1800, billed: true });
  addEntry(fixture.db, { id: 3, date: '2026-03-03', user: 2, project: 101, task: 201, seconds: 2700, billable: false });
  addEntry(fixture.db, { id: 4, date: '2026-04-01', user: 2, project: 100, task: 201, seconds: 600, rounded: 900 });
  return fixture;
}

test('readFilters lets a privileged viewer pick anyone and validates every value', () => {
  const url = new URL('http://x/reports?from=2026-02-01&to=2026-02-28&user=2&client=10&project=100&task=200&billable=yes');
  assert.deepEqual(readFilters(url, admin, defaults), {
    from: '2026-02-01', to: '2026-02-28', userId: 2, clientId: 10, projectId: 100, taskId: 200, billable: true,
  });

  const junk = new URL('http://x/reports?from=yesterday&to=2026-13&user=abc&client=-1&project=1.5&task=0&billable=maybe');
  assert.deepEqual(readFilters(junk, admin, defaults), {
    from: '2026-03-01', to: '2026-03-31', userId: null, clientId: null, projectId: null, taskId: null, billable: null,
  });
  assert.equal(readFilters(new URL('http://x/?billable=no'), admin, defaults).billable, false);
});

test('readFilters pins a member to their own rows whatever the URL says', () => {
  const url = new URL('http://x/reports?user=1');
  assert.equal(readFilters(url, member, defaults).userId, 2);
  assert.equal(readFilters(new URL('http://x/reports'), member, defaults).userId, 2);
});

test('buildWhere binds every filter as a parameter in declaration order', () => {
  const where = buildWhere({ ...all(), userId: 2, clientId: 10, projectId: 100, taskId: 200, billable: false });
  assert.equal(
    where.clause,
    'te.spent_date >= ? AND te.spent_date <= ? AND te.user_id = ? AND p.client_id = ? AND te.project_id = ? AND te.task_id = ? AND te.billable = ?',
  );
  assert.deepEqual(where.args, ['2026-03-01', '2026-03-31', 2, 10, 100, 200, 0]);

  const bare = buildWhere(all());
  assert.equal(bare.clause, 'te.spent_date >= ? AND te.spent_date <= ?');
  assert.deepEqual(bare.args, ['2026-03-01', '2026-03-31']);
});

test('filtersToQuery round-trips through readFilters and lets extras add or drop keys', () => {
  const filters: ReportFilters = { ...all(), userId: 1, projectId: 100, billable: true };
  const query = filtersToQuery(filters);
  assert.equal(query, 'from=2026-03-01&to=2026-03-31&user=1&project=100&billable=yes');
  assert.deepEqual(readFilters(new URL(`http://x/?${query}`), admin, defaults), filters);

  const extra = filtersToQuery(filters, { group: 'client', page: 2, user: null, project: '' });
  const params = new URLSearchParams(extra);
  assert.equal(params.get('group'), 'client');
  assert.equal(params.get('page'), '2');
  assert.equal(params.has('user'), false);
  assert.equal(params.has('project'), false);
});

test('totals: exact versus rounded seconds, billable and uninvoiced time', () => {
  const { db, cleanup } = seeded();
  try {
    const march = totals(db, buildWhere(all()));
    assert.deepEqual(plain(march), {
      entries: 3,
      seconds: 3600 + 1500 + 2700,
      rounded: 3600 + 1800 + 2700,
      // Billable is counted in rounded seconds, uninvoiced in exact seconds.
      billable: 3600 + 1800,
      uninvoiced: 3600,
    });

    const april = totals(db, buildWhere({ ...all(), from: '2026-04-01', to: '2026-04-30' }));
    assert.deepEqual(plain(april), { entries: 1, seconds: 600, rounded: 900, billable: 900, uninvoiced: 600 });

    const empty = totals(db, buildWhere({ ...all(), from: '2025-01-01', to: '2025-01-31' }));
    assert.deepEqual(plain(empty), { entries: 0, seconds: 0, rounded: 0, billable: 0, uninvoiced: 0 });
  } finally {
    cleanup();
  }
});

test('billable, person, client, project and task filters narrow the same query', () => {
  const { db, cleanup } = seeded();
  try {
    assert.equal(totals(db, buildWhere({ ...all(), billable: true })).seconds, 5100);
    assert.equal(totals(db, buildWhere({ ...all(), billable: false })).seconds, 2700);
    assert.equal(countEntries(db, buildWhere({ ...all(), userId: 1 })), 2);
    assert.equal(countEntries(db, buildWhere({ ...all(), clientId: 11 })), 1);
    assert.equal(countEntries(db, buildWhere({ ...all(), projectId: 100 })), 2);
    assert.equal(countEntries(db, buildWhere({ ...all(), taskId: 201 })), 1);
    assert.equal(countEntries(db, buildWhere({ ...all(), taskId: 201, userId: 1 })), 0);
  } finally {
    cleanup();
  }
});

test('groupTotals sums exact seconds per client, project, task, person and date', () => {
  const { db, cleanup } = seeded();
  try {
    const where = buildWhere(all());
    assert.deepEqual([...groupTotals(db, where, 'client')], [['Alpha Client', 5100], ['Beta Client', 2700]]);
    assert.deepEqual([...groupTotals(db, where, 'project')], [['Retainer', 2700], ['[WEB] Website', 5100]]);
    assert.deepEqual([...groupTotals(db, where, 'task')], [['Development', 5100], ['Meeting', 2700]]);
    assert.deepEqual([...groupTotals(db, where, 'person')], [['Ada Example', 5100], ['Bob Example', 2700]]);
    assert.deepEqual([...groupTotals(db, where, 'date')], [['2026-03-02', 3600], ['2026-03-03', 4200]]);
  } finally {
    cleanup();
  }
});

test('detailRows returns the declared shape, honours sort and pages with limit/offset', () => {
  const { db, cleanup } = seeded();
  try {
    const where = buildWhere(all());
    // Newest day first, then by first name: 2026-03-03 Ada, 2026-03-03 Bob, 2026-03-02 Ada.
    const byDate = detailRows(db, where, 'date', 10, 0);
    assert.deepEqual(byDate.map((r) => r.id), [2, 3, 1]);
    assert.deepEqual(plain(byDate[2]!), {
      id: 1, spent_date: '2026-03-02', person: 'Ada Example', user_id: 1,
      client: 'Alpha Client', project: 'Website', project_code: 'WEB', project_id: 100,
      task: 'Development', notes: 'Build', duration_seconds: 3600, rounded_seconds: 3600,
      billable: 1, is_billed: 0, is_locked: 0, locked_reason: null,
    });

    assert.deepEqual(detailRows(db, where, 'hours', 10, 0).map((r) => r.id), [1, 3, 2]);
    assert.deepEqual(detailRows(db, where, 'person', 10, 0).map((r) => r.person), ['Ada Example', 'Ada Example', 'Bob Example']);
    assert.deepEqual(detailRows(db, where, 'client', 10, 0).map((r) => r.client), ['Alpha Client', 'Alpha Client', 'Beta Client']);
    assert.deepEqual(detailRows(db, where, 'task', 10, 0).map((r) => r.task), ['Development', 'Development', 'Meeting']);
    assert.deepEqual(detailRows(db, where, 'date', 2, 0).map((r) => r.id), [2, 3]);
    assert.deepEqual(detailRows(db, where, 'date', 2, 2).map((r) => r.id), [1]);
  } finally {
    cleanup();
  }
});
