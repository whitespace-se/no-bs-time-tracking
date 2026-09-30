import assert from 'node:assert/strict';
import test from 'node:test';
import { dayEntries, defaultUserId, getWeek, latestEntryDate, listUsers } from '../src/lib/timesheet/week.ts';
import { STAMP, addEntry, plain, seedBasics, tempDb } from './fixture.ts';

// 2026-03-02 is a Monday.
const WEEK = '2026-03-02';

function seeded() {
  const fixture = tempDb();
  seedBasics(fixture.db);
  const { db } = fixture;
  // Ada, this week: Website/Development on Mon and Tue (two entries on Tue), Retainer/Development on Fri.
  addEntry(db, { id: 1, date: '2026-03-02', user: 1, project: 100, task: 200, seconds: 3600 });
  addEntry(db, { id: 2, date: '2026-03-03', user: 1, project: 100, task: 200, seconds: 1800, notes: 'morning' });
  addEntry(db, { id: 3, date: '2026-03-03', user: 1, project: 100, task: 200, seconds: 900, notes: 'afternoon' });
  addEntry(db, { id: 4, date: '2026-03-06', user: 1, project: 101, task: 200, seconds: 7200, locked: true, lockedReason: 'Item Invoiced' });
  // Ada, previous week: one row's worth.
  addEntry(db, { id: 5, date: '2026-02-25', user: 1, project: 100, task: 201, seconds: 600 });
  // Bob, this week: must not leak into Ada's payload.
  addEntry(db, { id: 6, date: '2026-03-04', user: 2, project: 101, task: 200, seconds: 5400 });
  return fixture;
}

test('getWeek groups entries into (project, task) rows with seven Monday-first cells', () => {
  const { db, cleanup } = seeded();
  try {
    const week = getWeek(db, 1, WEEK);
    assert.equal(week.week_of, WEEK);
    assert.equal(week.user_id, 1);
    assert.deepEqual(week.dates, ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
    assert.equal(week.entries.length, 4);
    assert.ok(week.entries.every((e) => e.spent_date >= '2026-03-02' && e.spent_date <= '2026-03-08'));

    // Ordered by client, then project, then task: Alpha/Website before Beta/Retainer.
    assert.deepEqual(week.rows.map((r) => [r.client_name, r.project_name, r.project_code, r.task_name]), [
      ['Alpha Client', 'Website', 'WEB', 'Development'],
      ['Beta Client', 'Retainer', null, 'Development'],
    ]);

    const website = week.rows[0]!;
    assert.deepEqual(website.cells.map((c) => c.seconds), [3600, 2700, 0, 0, 0, 0, 0]);
    // The compound case: two entries in one cell, summed, both kept.
    assert.deepEqual(website.cells[1]!.entries.map((e) => e.notes), ['morning', 'afternoon']);
    assert.equal(website.total, 6300);
    assert.equal(website.locked, false);

    const retainer = week.rows[1]!;
    assert.deepEqual(retainer.cells.map((c) => c.seconds), [0, 0, 0, 0, 7200, 0, 0]);
    assert.equal(retainer.locked, true);
    assert.equal(retainer.locked_reason, 'Item Invoiced');
    assert.equal(retainer.cells[4]!.locked, true);
    assert.equal(retainer.cells[0]!.locked, false);

    assert.deepEqual(week.day_totals, [3600, 2700, 0, 0, 7200, 0, 0]);
    assert.equal(week.total, 13500);
  } finally {
    cleanup();
  }
});

test('copy_from_last_week reports how many rows the previous week had', () => {
  const { db, cleanup } = seeded();
  try {
    assert.deepEqual(getWeek(db, 1, WEEK).copy_from_last_week, { available: true, source: '2026-02-23', rows: 1 });
    assert.deepEqual(getWeek(db, 1, '2026-02-23').copy_from_last_week, { available: false, source: '2026-02-16', rows: 0 });
    // Two distinct (project, task) pairs in this week → two rows to copy next week.
    assert.equal(getWeek(db, 1, '2026-03-09').copy_from_last_week.rows, 2);
  } finally {
    cleanup();
  }
});

test('an empty week still has seven dates and zero totals', () => {
  const { db, cleanup } = seeded();
  try {
    const week = getWeek(db, 2, '2025-06-02');
    assert.equal(week.rows.length, 0);
    assert.deepEqual(week.day_totals, [0, 0, 0, 0, 0, 0, 0]);
    assert.equal(week.total, 0);
  } finally {
    cleanup();
  }
});

test('dayEntries filters the week payload without another query', () => {
  const { db, cleanup } = seeded();
  try {
    const week = getWeek(db, 1, WEEK);
    assert.deepEqual(dayEntries(week, '2026-03-03').map((e) => e.id), [2, 3]);
    assert.deepEqual(dayEntries(week, '2026-03-04'), []);
  } finally {
    cleanup();
  }
});

test('listUsers, defaultUserId and latestEntryDate', () => {
  const { db, cleanup } = seeded();
  try {
    db.prepare(`INSERT INTO users (id, email, first_name, last_name, role, is_active, created_at, updated_at)
                VALUES (3, 'gone@example.test', 'Gone', 'Person', 'member', 0, ?, ?)`).run(STAMP, STAMP);
    assert.deepEqual(listUsers(db).map(plain), [
      { id: 1, name: 'Ada Example', is_active: 1 },
      { id: 2, name: 'Bob Example', is_active: 1 },
    ]);
    assert.equal(defaultUserId(db), 1); // Ada has the most entries
    assert.equal(latestEntryDate(db, 1), '2026-03-06');
    assert.equal(latestEntryDate(db, 2), '2026-03-04');
    assert.equal(latestEntryDate(db, 3), null);
  } finally {
    cleanup();
  }
});

test('defaultUserId falls back to 1 on an empty instance', () => {
  const { db, cleanup } = tempDb();
  try {
    assert.equal(defaultUserId(db), 1);
  } finally {
    cleanup();
  }
});
