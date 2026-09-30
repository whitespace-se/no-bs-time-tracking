import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/lib/db/index.ts';
import { createToken } from '../src/lib/auth/api-token.ts';
import { serveHarvest } from '../src/lib/harvest-api/serve.ts';
import { importTimeCsv } from '../src/lib/import/csv.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';

const csv = `Date,Client,Project,Project Code,Task,Notes,Hours,Hours Rounded,Billable?,Invoiced?,First Name,Last Name,Billable Rate
2026-08-03,Example Client,Web,EX1,Development," Kick-off",1.5,1.5,Yes,Yes,Ada,Lovelace,1000
2026-08-04,Example Client,Web,EX1,Semester,,8,8,No,No,Ada,Lovelace,0
2026-09-01,Example Client,Web,EX1,Development,Later,2,2,Yes,No,Grace,Hopper,1000
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-test-'));
  const database = openDb(join(dir, 'test.db'));
  importTimeCsv(database, csv, DEFAULT_SETTINGS);
  const ada = (database.prepare("SELECT id FROM users WHERE first_name = 'Ada'").get() as { id: number }).id;
  database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ada);
  const { token } = createToken(database, ada, 'test');
  return { database, token, cleanup: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const call = (database: ReturnType<typeof openDb>, path: string, headers: Record<string, string>) => {
  const url = new URL(`http://localhost/v2/${path}`);
  const response = serveHarvest(database, new Request(url, { headers }), url, path.split('?')[0]!);
  return response;
};
const harvest = (token: string) => ({ Authorization: `Bearer ${token}`, 'Harvest-Account-Id': '1', 'User-Agent': 'test' });

test('time entries come back as Harvest returns them, filtered by date and paged by links', async () => {
  const { database, token, cleanup } = fixture();
  try {
    const first = await call(database, 'time_entries?from=2026-08-01&to=2026-08-31&per_page=1', harvest(token)).json() as Record<string, any>;
    assert.equal(first.total_entries, 2);
    assert.equal(first.total_pages, 2);
    assert.equal(first.time_entries.length, 1);
    const entry = first.time_entries[0];
    // Newest first, as Harvest lists them.
    assert.equal(entry.spent_date, '2026-08-04');
    assert.deepEqual({ user: entry.user.name, task: entry.task.name, hours: entry.hours, notes: entry.notes, billable: entry.billable },
      { user: 'Ada Lovelace', task: 'Semester', hours: 8, notes: null, billable: false });
    assert.match(first.links.next, /page=2/);

    const second = await call(database, first.links.next.replace('http://localhost/v2/', ''), harvest(token)).json() as Record<string, any>;
    assert.equal(second.time_entries[0].notes, ' Kick-off', 'notes are kept as written');
    assert.equal(second.time_entries[0].is_locked, true);
    assert.equal(second.time_entries[0].locked_reason, 'Item Invoiced');
    assert.equal(second.links.next, null);
  } finally {
    cleanup();
  }
});

test('Harvest credentials are required, as Harvest requires them', async () => {
  const { database, token, cleanup } = fixture();
  try {
    assert.equal(call(database, 'users', { 'User-Agent': 'test' }).status, 401);
    assert.equal(call(database, 'users', { Authorization: `Bearer ${token}`, 'User-Agent': 'test' }).status, 401, 'no account id');
    assert.equal(call(database, 'users', { Authorization: `Bearer ${token}`, 'Harvest-Account-Id': '1' }).status, 400, 'no User-Agent');
    assert.equal(call(database, 'nothing', harvest(token)).status, 404);
    const me = await call(database, 'users/me', harvest(token)).json() as Record<string, any>;
    assert.equal(me.first_name, 'Ada');
    const company = await call(database, 'company', harvest(token)).json() as Record<string, any>;
    assert.equal(company.week_start_day, 'Monday');
  } finally {
    cleanup();
  }
});

test('a member reads only their own time', async () => {
  const { database, cleanup } = fixture();
  try {
    const grace = (database.prepare("SELECT id FROM users WHERE first_name = 'Grace'").get() as { id: number }).id;
    const { token } = createToken(database, grace, 'grace');
    const list = await call(database, 'time_entries', harvest(token)).json() as Record<string, any>;
    assert.equal(list.total_entries, 1);
    assert.equal(list.time_entries[0].user.name, 'Grace Hopper');
  } finally {
    cleanup();
  }
});
