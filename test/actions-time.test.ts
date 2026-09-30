/**
 * The time-entry actions in src/actions/index.ts.
 *
 * These are Astro Actions, and `defineAction` returns a callable whose `this` is the request
 * context. `astro:actions` and `astro:schema` are virtual modules that only exist inside
 * Astro's Vite pipeline, so both are re-pointed at the packages they re-export (the same
 * trick test/forms.test.ts uses for `astro:schema`) and each action is then invoked directly
 * with a synthetic context — `.orThrow` so a refusal arrives as the ActionError it is.
 *
 * What is being pinned here: the rate snapshot stored on a new or edited entry, which entries
 * a given person may touch, that a locked entry refuses writes, and the timer rules.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { rmSync } from 'node:fs';
import test, { after, beforeEach } from 'node:test';
import { addEntry, count, plain, STAMP, tempDir } from './fixture.ts';
import { isoFromNow, withEnv } from './support.ts';
import type { SessionUser } from '../src/lib/auth/session.ts';

const ASTRO_SERVER = new URL('../node_modules/astro/dist/actions/runtime/server.js', import.meta.url).href;
const ASTRO_CLIENT = new URL('../node_modules/astro/dist/actions/runtime/client.js', import.meta.url).href;

/** What `astro:actions` re-exports, reachable from plain Node. */
const ACTIONS_SHIM =
  'data:text/javascript,' +
  encodeURIComponent(
    `export { defineAction } from ${JSON.stringify(ASTRO_SERVER)};` +
      `export { ActionError, isActionError, isInputError } from ${JSON.stringify(ASTRO_CLIENT)};`,
  );

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'astro:schema') return next('astro/zod', context);
    if (specifier === 'astro:actions') return next(ACTIONS_SHIM, context);
    return next(specifier, context);
  },
});

// The actions reach for the process-wide database handle, which resolves the instance folder
// out of the environment exactly once — so the environment is set for the import, and the
// handle is then whatever this throwaway folder holds.
const instanceDir = tempDir('no-bs-actions-test-');
const { server, database } = await withEnv(
  { INSTANCE_DIR: instanceDir, INSTANCE_LOG: 'off' },
  async () => {
    const actions = await import('../src/actions/index.ts');
    const { db } = await import('../src/lib/db/index.ts');
    return { server: actions.server, database: db() };
  },
);

after(() => {
  database.close();
  rmSync(instanceDir, { recursive: true, force: true });
});

// ── The account ──────────────────────────────────────────────────────────────

/**
 * Rates are minor units per hour: 1 500,00 is 150000.
 *
 * Deliberately not seedBasics(): every rate column that `resolveRates` reads needs a project,
 * task or person that exercises one branch of it and only that one.
 */
database.exec(`
  INSERT INTO users (id, email, first_name, last_name, role, is_active,
                     default_billable_rate, cost_rate, created_at, updated_at)
  VALUES (1, 'ada@example.test', 'Ada', 'Example', 'admin', 1, NULL, NULL, '${STAMP}', '${STAMP}'),
         (2, 'bob@example.test', 'Bob', 'Example', 'member', 1, 110000, 50000, '${STAMP}', '${STAMP}'),
         (3, 'mia@example.test', 'Mia', 'Example', 'manager', 1, 100000, 45000, '${STAMP}', '${STAMP}'),
         (4, 'sam@example.test', 'Sam', 'Example', 'member', 1, NULL, NULL, '${STAMP}', '${STAMP}');

  INSERT INTO clients (id, name, currency, is_active, created_at, updated_at)
  VALUES (10, 'Alpha Client', 'SEK', 1, '${STAMP}', '${STAMP}');

  INSERT INTO projects (id, client_id, name, bill_by, hourly_rate, is_active, is_billable,
                        created_at, updated_at)
  VALUES (110, 10, 'Billed by project',  'Project', 150000, 1, 1, '${STAMP}', '${STAMP}'),
         (111, 10, 'Billed by task',     'Tasks',     NULL, 1, 1, '${STAMP}', '${STAMP}'),
         (112, 10, 'Billed by person',   'People',    NULL, 1, 1, '${STAMP}', '${STAMP}'),
         (113, 10, 'Billed by nothing',   NULL,       NULL, 1, 1, '${STAMP}', '${STAMP}'),
         (114, 10, 'Project rate unset', 'Project',   NULL, 1, 1, '${STAMP}', '${STAMP}');

  INSERT INTO tasks (id, name, billable_by_default, default_hourly_rate, is_active,
                     created_at, updated_at)
  VALUES (210, 'Design',   1,  90000, 1, '${STAMP}', '${STAMP}'),
         (211, 'Research', 1,   NULL, 1, '${STAMP}', '${STAMP}'),
         (212, 'Support',  0,  80000, 1, '${STAMP}', '${STAMP}');

  INSERT INTO task_assignments (project_id, task_id, is_active, billable, hourly_rate,
                                created_at, updated_at)
  VALUES (110, 210, 1, 1,   NULL, '${STAMP}', '${STAMP}'),
         (110, 211, 1, 0,   NULL, '${STAMP}', '${STAMP}'),
         (111, 210, 1, 1, 120000, '${STAMP}', '${STAMP}'),
         (111, 211, 1, 1,   NULL, '${STAMP}', '${STAMP}'),
         (111, 212, 1, 1,   NULL, '${STAMP}', '${STAMP}'),
         (112, 210, 1, 1,   NULL, '${STAMP}', '${STAMP}'),
         (113, 210, 1, 1,   NULL, '${STAMP}', '${STAMP}'),
         (114, 210, 1, 1,   NULL, '${STAMP}', '${STAMP}');

  INSERT INTO user_assignments (project_id, user_id, is_active, hourly_rate, created_at, updated_at)
  VALUES (112, 2, 1, 130000, '${STAMP}', '${STAMP}');
`);

const ada: SessionUser = { id: 1, email: 'ada@example.test', name: 'Ada Example', role: 'admin' };
const bob: SessionUser = { id: 2, email: 'bob@example.test', name: 'Bob Example', role: 'member' };
const mia: SessionUser = { id: 3, email: 'mia@example.test', name: 'Mia Example', role: 'manager' };
const sam: SessionUser = { id: 4, email: 'sam@example.test', name: 'Sam Example', role: 'member' };

const DAY = '2026-01-05';

beforeEach(() => {
  database.exec('DELETE FROM time_entries');
});

// ── Calling an action ────────────────────────────────────────────────────────

/** The slice of the request context these handlers read. */
function as(user: SessionUser | null): { locals: { user: SessionUser | null } } {
  return { locals: { user } };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

interface Refusal {
  code: string;
  message: string;
}

/** Run something that must be refused, and hand back the ActionError's code and message. */
async function refused(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    const action = error as { code?: string; message?: string };
    assert.ok(action.code, `not an ActionError: ${String(error)}`);
    return { code: String(action.code), message: String(action.message) };
  }
  return assert.fail('the action went through when it should have been refused');
}

interface Entry {
  id: number;
  user_id: number;
  project_id: number;
  task_id: number;
  client_id: number | null;
  spent_date: string;
  duration_seconds: number;
  rounded_seconds: number;
  notes: string | null;
  billable: number;
  billable_rate: number | null;
  cost_rate: number | null;
  is_running: number;
  timer_started_at: string | null;
  is_locked: number;
}

function entry(id: number): Entry {
  return plain(database.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as unknown as Entry);
}

function create(
  user: SessionUser | null,
  fields: Record<string, string>,
): Promise<{ id: number; running: boolean }> {
  return server.createEntry.orThrow.call(
    as(user),
    form({ user_id: String(user?.id ?? 0), spent_date: DAY, hours: '1:00', ...fields }),
  );
}

// ── The rate snapshot ────────────────────────────────────────────────────────

test('bill_by Project snapshots the project rate', async () => {
  const { id } = await create(bob, { project_id: '110', task_id: '210' });
  assert.equal(entry(id).billable_rate, 150000);
});

test('bill_by Project with no rate on the project stores nothing rather than zero', async () => {
  const { id } = await create(bob, { project_id: '114', task_id: '210' });
  assert.equal(entry(id).billable_rate, null);
});

test("bill_by Tasks prefers the assignment's rate", async () => {
  const { id } = await create(bob, { project_id: '111', task_id: '210' });
  assert.equal(entry(id).billable_rate, 120000);
});

test("bill_by Tasks falls back to the task's default rate", async () => {
  const { id } = await create(bob, { project_id: '111', task_id: '212' });
  assert.equal(entry(id).billable_rate, 80000);
});

test('bill_by Tasks with neither rate set stores nothing', async () => {
  const { id } = await create(bob, { project_id: '111', task_id: '211' });
  assert.equal(entry(id).billable_rate, null);
});

test("bill_by People prefers the person's rate on that project", async () => {
  const { id } = await create(bob, { project_id: '112', task_id: '210' });
  assert.equal(entry(id).billable_rate, 130000);
});

test('bill_by People falls back to the person’s default rate when they have no assignment', async () => {
  const { id } = await create(mia, { project_id: '112', task_id: '210' });
  assert.equal(entry(id).billable_rate, 100000);
});

test('bill_by People with no rate anywhere stores nothing', async () => {
  const { id } = await create(sam, { project_id: '112', task_id: '210' });
  assert.equal(entry(id).billable_rate, null);
});

test('a project that bills by nothing snapshots no rate, even where rates exist', async () => {
  const { id } = await create(bob, { project_id: '113', task_id: '210' });
  assert.equal(entry(id).billable_rate, null);
});

test("the cost rate is the person's, whatever the project bills by", async () => {
  const byProject = await create(bob, { project_id: '110', task_id: '210' });
  const byNothing = await create(bob, { project_id: '113', task_id: '210' });
  assert.equal(entry(byProject.id).cost_rate, 50000);
  assert.equal(entry(byNothing.id).cost_rate, 50000, 'cost is tracked even when nothing is billed');
  assert.equal(entry((await create(ada, { project_id: '110', task_id: '210' })).id).cost_rate, null);
});

test('a non-billable task carries no billable rate, but still carries the cost', async () => {
  const { id } = await create(bob, { project_id: '110', task_id: '211' });
  const saved = entry(id);
  assert.equal(saved.billable, 0, 'billability comes from the project↔task assignment');
  assert.equal(saved.billable_rate, null, 'a project rate must not leak onto a non-billable entry');
  assert.equal(saved.cost_rate, 50000);
});

test('billability falls back to the task when the project has no assignment for it', async () => {
  // Task 212 is billable_by_default = 0 and project 110 does not carry it.
  const { id } = await create(bob, { project_id: '110', task_id: '212' });
  assert.equal(entry(id).billable, 0);
});

test('the snapshot does not move when the project rate is changed afterwards', async () => {
  const { id } = await create(bob, { project_id: '110', task_id: '210' });
  try {
    database.prepare('UPDATE projects SET hourly_rate = ? WHERE id = ?').run(999900, 110);
    assert.equal(entry(id).billable_rate, 150000, 'history must not be rewritten by a rate change');
  } finally {
    database.prepare('UPDATE projects SET hourly_rate = ? WHERE id = ?').run(150000, 110);
  }
});

test('moving an entry to another project re-snapshots at that project’s rate', async () => {
  const { id } = await create(bob, { project_id: '110', task_id: '210' });
  await server.updateEntry.orThrow.call(
    as(bob),
    form({ id: String(id), project_id: '111', task_id: '210', spent_date: DAY, hours: '1:00' }),
  );
  const saved = entry(id);
  assert.equal(saved.billable_rate, 120000);
  assert.equal(saved.client_id, 10, 'the client follows the project');
});

test('an edit re-snapshots against the entry owner, not the person editing', async () => {
  const { id } = await create(bob, { project_id: '112', task_id: '210' });
  await server.updateEntry.orThrow.call(
    as(ada),
    form({ id: String(id), project_id: '112', task_id: '210', spent_date: DAY, hours: '2:00' }),
  );
  const saved = entry(id);
  assert.equal(saved.user_id, 2, 'an admin edit does not move the entry to the admin');
  assert.equal(saved.billable_rate, 130000, "Bob's rate on that project, not Ada's absence of one");
  assert.equal(saved.cost_rate, 50000);
});

// ── Who may write ────────────────────────────────────────────────────────────

test('signed out is refused before anything is read', async () => {
  const refusal = await refused(() => create(null, { user_id: '2', project_id: '110', task_id: '210' }));
  assert.equal(refusal.code, 'UNAUTHORIZED');
  assert.equal(count(database, 'time_entries'), 0);
});

test('a member may not log time on somebody else’s timesheet', async () => {
  const refusal = await refused(() =>
    server.createEntry.orThrow.call(
      as(bob),
      form({ user_id: '4', project_id: '110', task_id: '210', spent_date: DAY, hours: '1:00' }),
    ),
  );
  assert.equal(refusal.code, 'FORBIDDEN');
  assert.match(refusal.message, /not your timesheet/i);
  assert.equal(count(database, 'time_entries'), 0);
});

test('an admin and a manager may log time on somebody else’s timesheet', async () => {
  for (const actor of [ada, mia]) {
    const created = await server.createEntry.orThrow.call(
      as(actor),
      form({ user_id: '2', project_id: '110', task_id: '210', spent_date: DAY, hours: '1:00' }),
    );
    assert.equal(entry(created.id).user_id, 2);
  }
});

test('editing is authorised against the entry owner, not the editor', async () => {
  const { id } = await create(bob, { project_id: '110', task_id: '210' });
  const edit = (actor: SessionUser) =>
    server.updateEntry.orThrow.call(
      as(actor),
      form({ id: String(id), project_id: '110', task_id: '210', spent_date: DAY, hours: '3:00' }),
    );

  // Sam is a member like Bob, and carries his own id in the session — it is the *entry* that
  // decides, and the entry is Bob's.
  assert.equal((await refused(() => edit(sam))).code, 'FORBIDDEN');
  assert.equal(entry(id).duration_seconds, 3600, 'nothing was written');

  await edit(bob);
  assert.equal(entry(id).duration_seconds, 10800);
  await edit(ada);
  assert.equal(entry(id).duration_seconds, 10800);
});

test('deleting is authorised against the entry owner too', async () => {
  const { id } = await create(bob, { project_id: '110', task_id: '210' });
  assert.equal((await refused(() => server.deleteEntry.orThrow.call(as(sam), form({ id: String(id) })))).code, 'FORBIDDEN');
  assert.equal(count(database, 'time_entries'), 1);

  await server.deleteEntry.orThrow.call(as(ada), form({ id: String(id) }));
  assert.equal(count(database, 'time_entries'), 0);
});

test('starting and stopping somebody else’s timer is refused the same way', async () => {
  const { id } = await create(bob, { project_id: '110', task_id: '210' });
  assert.equal((await refused(() => server.startTimer.orThrow.call(as(sam), form({ id: String(id) })))).code, 'FORBIDDEN');
  assert.equal((await refused(() => server.stopTimer.orThrow.call(as(sam), form({ id: String(id) })))).code, 'FORBIDDEN');
  assert.equal(entry(id).is_running, 0);
});

test('an entry that does not exist is not somebody a member may edit, and is not found for an admin', async () => {
  assert.equal((await refused(() => server.deleteEntry.orThrow.call(as(bob), form({ id: '9999' })))).code, 'FORBIDDEN');
  assert.equal((await refused(() => server.deleteEntry.orThrow.call(as(ada), form({ id: '9999' })))).code, 'NOT_FOUND');
});

// ── Locked entries ───────────────────────────────────────────────────────────

test('a locked entry refuses an edit, and says why', async () => {
  addEntry(database, {
    id: 500, date: DAY, user: 2, project: 110, task: 210, seconds: 3600,
    locked: true, lockedReason: 'Item Invoiced',
  });
  const refusal = await refused(() =>
    server.updateEntry.orThrow.call(
      as(bob),
      form({ id: '500', project_id: '110', task_id: '210', spent_date: DAY, hours: '9:00' }),
    ),
  );
  assert.equal(refusal.code, 'FORBIDDEN');
  assert.equal(refusal.message, 'This entry is locked: item invoiced.');
  assert.equal(entry(500).duration_seconds, 3600);
});

test('a locked entry with no reason still refuses', async () => {
  addEntry(database, { id: 501, date: DAY, user: 2, project: 110, task: 210, seconds: 3600, locked: true });
  const refusal = await refused(() => server.deleteEntry.orThrow.call(as(bob), form({ id: '501' })));
  assert.equal(refusal.message, 'This entry is locked and cannot be changed.');
  assert.equal(count(database, 'time_entries', 'id = 501'), 1);
});

test('a locked entry refuses a timer', async () => {
  addEntry(database, {
    id: 502, date: DAY, user: 2, project: 110, task: 210, seconds: 3600,
    locked: true, lockedReason: 'Item Archived',
  });
  assert.equal((await refused(() => server.startTimer.orThrow.call(as(bob), form({ id: '502' })))).code, 'FORBIDDEN');
  assert.equal(entry(502).is_running, 0);
});

test('an admin cannot write to a locked entry either', async () => {
  addEntry(database, { id: 503, date: DAY, user: 2, project: 110, task: 210, seconds: 3600, locked: true });
  assert.equal((await refused(() => server.deleteEntry.orThrow.call(as(ada), form({ id: '503' })))).code, 'FORBIDDEN');
});

// ── Durations ────────────────────────────────────────────────────────────────

test('a duration it cannot read is refused, and quotes what was typed', async () => {
  const refusal = await refused(() => create(bob, { project_id: '110', task_id: '210', hours: 'banana' }));
  assert.equal(refusal.code, 'BAD_REQUEST');
  assert.match(refusal.message, /banana/);
  assert.equal(count(database, 'time_entries'), 0, 'nothing is stored on a bad duration');
});

test('the forms a person actually types are all accepted', async () => {
  const typed: [string, number][] = [
    ['1:30', 5400], ['1,5', 5400], ['1.5', 5400], ['90m', 5400], ['2h', 7200], ['1h30', 5400], ['2', 7200],
  ];
  for (const [text, seconds] of typed) {
    const { id } = await create(bob, { project_id: '110', task_id: '210', hours: text });
    assert.equal(entry(id).duration_seconds, seconds, `“${text}”`);
  }
});

test('junk that merely contains a number is still junk', async () => {
  for (const text of ['1:75', 'half an hour', '1:30:00', '-2', 'h']) {
    assert.equal(
      (await refused(() => create(bob, { project_id: '110', task_id: '210', hours: text }))).code,
      'BAD_REQUEST',
      `“${text}”`,
    );
  }
});

test('rounded_seconds follows the account rounding rule, and the raw duration is kept', async () => {
  // The default is 0.25 h, rounded to nearest: 1:10 bills as 1:15.
  const { id } = await create(bob, { project_id: '110', task_id: '210', hours: '1:10' });
  const saved = entry(id);
  assert.equal(saved.duration_seconds, 4200);
  assert.equal(saved.rounded_seconds, 4500);
});

test('notes are trimmed, and blank notes become nothing at all', async () => {
  const withNotes = await create(bob, { project_id: '110', task_id: '210', notes: '  Wrote the brief  ' });
  const blank = await create(bob, { project_id: '110', task_id: '210', notes: '   ' });
  assert.equal(entry(withNotes.id).notes, 'Wrote the brief');
  assert.equal(entry(blank.id).notes, null);
});

test('the input schema refuses a malformed date, a bad id and an essay', async () => {
  assert.equal((await refused(() => create(bob, { project_id: '110', task_id: '210', spent_date: '5 Jan 2026' }))).code, 'BAD_REQUEST');
  assert.equal((await refused(() => create(bob, { project_id: '0', task_id: '210' }))).code, 'BAD_REQUEST');
  assert.equal((await refused(() => create(bob, { project_id: '110', task_id: '210', notes: 'x'.repeat(4001) }))).code, 'BAD_REQUEST');
  assert.equal(count(database, 'time_entries'), 0);
});

// ── Timers ───────────────────────────────────────────────────────────────────

/** The timer path: no `hours` field at all. The blank-field spelling is covered below. */
function startsTimer(user: SessionUser, fields: Record<string, string>): Promise<{ id: number; running: boolean }> {
  return server.createEntry.orThrow.call(
    as(user),
    form({ user_id: String(user.id), spent_date: DAY, ...fields }),
  );
}

test('an empty duration starts the clock instead of recording hours', async () => {
  const created = await startsTimer(bob, { project_id: '110', task_id: '210' });
  assert.equal(created.running, true);
  const saved = entry(created.id);
  assert.equal(saved.duration_seconds, 0);
  assert.equal(saved.is_running, 1);
  assert.ok(saved.timer_started_at, 'the clock has a start time');
});

test('a timer entry is still given its rate snapshot', async () => {
  const created = await startsTimer(bob, { project_id: '110', task_id: '210' });
  assert.equal(entry(created.id).billable_rate, 150000);
});

test('a blank hours field starts a timer, which is what the day dialog posts', async () => {
  // The dialog says "Leave hours blank to start a timer" and submits `hours=`. Astro's form
  // parsing turns any falsy field into null, so the schema has to accept null as "" — a
  // `.default('')` only covers undefined, and used to reject this before the handler ran.
  const created = await create(bob, { project_id: '110', task_id: '210', hours: '' });
  assert.equal(created.running, true);
  const saved = entry(created.id);
  assert.equal(saved.duration_seconds, 0);
  assert.equal(saved.is_running, 1);
  assert.ok(saved.timer_started_at, 'the clock has a start time');
});

test('a filled duration records hours and starts nothing', async () => {
  const created = await create(bob, { project_id: '110', task_id: '210', hours: '0:45' });
  assert.equal(created.running, false);
  assert.equal(entry(created.id).is_running, 0);
  assert.equal(entry(created.id).timer_started_at, null);
});

test('one running timer per person: starting a second one stops the first', async () => {
  const first = await startsTimer(bob, { project_id: '110', task_id: '210' });
  const second = await startsTimer(bob, { project_id: '111', task_id: '210' });
  assert.equal(entry(first.id).is_running, 0);
  assert.equal(entry(first.id).timer_started_at, null);
  assert.equal(entry(second.id).is_running, 1);
  assert.equal(count(database, 'time_entries', 'user_id = 2 AND is_running = 1'), 1);
});

test('two people may each have a timer running', async () => {
  await startsTimer(bob, { project_id: '110', task_id: '210' });
  await startsTimer(sam, { project_id: '110', task_id: '210' });
  assert.equal(count(database, 'time_entries', 'is_running = 1'), 2);
});

test('starting a timer on an existing entry banks what the running one accrued', async () => {
  addEntry(database, { id: 600, date: DAY, user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 601, date: DAY, user: 2, project: 111, task: 210, seconds: 0 });
  database
    .prepare('UPDATE time_entries SET is_running = 1, timer_started_at = ? WHERE id = 600')
    .run(isoFromNow(-60_000));

  const result = await server.startTimer.orThrow.call(as(bob), form({ id: '601' }));
  assert.equal(result.stopped, 600);
  assert.equal(result.onDate, DAY);

  const banked = entry(600);
  assert.equal(banked.is_running, 0);
  assert.equal(banked.timer_started_at, null);
  assert.ok(banked.duration_seconds >= 3660, `banked ${banked.duration_seconds}s, expected the minute that elapsed`);
  assert.ok(banked.duration_seconds < 3600 + 300, 'and not much more than that');
  assert.equal(banked.rounded_seconds % 900, 0, 'the banked total is rounded like any other');

  assert.equal(entry(601).is_running, 1);
  assert.equal(count(database, 'time_entries', 'user_id = 2 AND is_running = 1'), 1);
});

test('stopping a timer adds the elapsed time to what was already there', async () => {
  addEntry(database, { id: 602, date: DAY, user: 2, project: 110, task: 210, seconds: 1800 });
  database
    .prepare('UPDATE time_entries SET is_running = 1, timer_started_at = ? WHERE id = 602')
    .run(isoFromNow(-120_000));

  const result = await server.stopTimer.orThrow.call(as(bob), form({ id: '602' }));
  const saved = entry(602);
  assert.equal(saved.is_running, 0);
  assert.equal(saved.timer_started_at, null);
  assert.ok(saved.duration_seconds >= 1920, `expected at least the two minutes, got ${saved.duration_seconds}`);
  assert.equal(result.seconds, saved.duration_seconds);
});

test('stopping an entry whose clock was never started changes nothing but the timestamp', async () => {
  addEntry(database, { id: 603, date: DAY, user: 2, project: 110, task: 210, seconds: 1800 });
  const result = await server.stopTimer.orThrow.call(as(bob), form({ id: '603' }));
  assert.equal(result.seconds, 1800);
  assert.equal(entry(603).duration_seconds, 1800);
});

test('stopping an entry that is not there is not found', async () => {
  assert.equal((await refused(() => server.stopTimer.orThrow.call(as(ada), form({ id: '9999' })))).code, 'NOT_FOUND');
});

test('editing an entry stops its timer', async () => {
  const created = await startsTimer(bob, { project_id: '110', task_id: '210' });
  await server.updateEntry.orThrow.call(
    as(bob),
    form({ id: String(created.id), project_id: '110', task_id: '210', spent_date: DAY, hours: '2:00' }),
  );
  const saved = entry(created.id);
  assert.equal(saved.is_running, 0);
  assert.equal(saved.timer_started_at, null);
  assert.equal(saved.duration_seconds, 7200);
});

// ── The week grid ────────────────────────────────────────────────────────────

const WEEK = '2026-01-05'; // a Monday

test('saveWeek creates, updates and deletes the cells that changed', async () => {
  addEntry(database, { id: 700, date: '2026-01-06', user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 701, date: '2026-01-07', user: 2, project: 110, task: 210, seconds: 3600 });

  const result = await server.saveWeek.orThrow.call(
    as(bob),
    form({
      user_id: '2',
      week: WEEK,
      'c_2026-01-05_110_210': '2:00', // new
      'c_2026-01-06_110_210': '3:00', // changed
      'c_2026-01-07_110_210': '0', // emptied
      'c_2026-01-08_110_210': '', // untouched, and stays absent
    }),
  );

  assert.deepEqual(plain(result), {
    created: 1, updated: 1, deleted: 1, skippedLocked: 0, week: WEEK, user_id: 2,
  });
  assert.equal(entry(700).duration_seconds, 10800);
  assert.equal(count(database, 'time_entries', "spent_date = '2026-01-07'"), 0);
  assert.equal(count(database, 'time_entries', "spent_date = '2026-01-08'"), 0);
});

test('saveWeek never rewrites a locked cell, and says how many it left alone', async () => {
  addEntry(database, {
    id: 702, date: '2026-01-06', user: 2, project: 110, task: 210, seconds: 3600,
    locked: true, lockedReason: 'Item Invoiced',
  });
  const result = await server.saveWeek.orThrow.call(
    as(bob),
    form({ user_id: '2', week: WEEK, 'c_2026-01-06_110_210': '8:00' }),
  );
  assert.equal(result.skippedLocked, 1);
  assert.equal(entry(702).duration_seconds, 3600);
});

test('saveWeek absorbs the difference into the most recently updated of several entries', async () => {
  addEntry(database, { id: 703, date: '2026-01-06', user: 2, project: 110, task: 210, seconds: 3600, updatedAt: '2026-01-06T09:00:00Z' });
  addEntry(database, { id: 704, date: '2026-01-06', user: 2, project: 110, task: 210, seconds: 1800, notes: 'Kept', updatedAt: '2026-01-06T11:00:00Z' });

  await server.saveWeek.orThrow.call(
    as(bob),
    form({ user_id: '2', week: WEEK, 'c_2026-01-06_110_210': '3:00' }),
  );
  assert.equal(entry(703).duration_seconds, 3600, 'the older entry is left alone');
  assert.equal(entry(704).duration_seconds, 7200, 'the newest one absorbs the delta');
  assert.equal(entry(704).notes, 'Kept', 'and keeps its notes');
});

test('saveWeek refuses somebody else’s week, and writes nothing', async () => {
  const refusal = await refused(() =>
    server.saveWeek.orThrow.call(as(bob), form({ user_id: '4', week: WEEK, 'c_2026-01-05_110_210': '2:00' })),
  );
  assert.equal(refusal.code, 'FORBIDDEN');
  assert.equal(count(database, 'time_entries'), 0);
});

test('saveWeek rolls the whole batch back when one cell is unreadable', async () => {
  const refusal = await refused(() =>
    server.saveWeek.orThrow.call(
      as(bob),
      form({
        user_id: '2',
        week: WEEK,
        'c_2026-01-05_110_210': '2:00',
        'c_2026-01-06_110_210': 'banana',
      }),
    ),
  );
  assert.equal(refusal.code, 'BAD_REQUEST');
  assert.equal(count(database, 'time_entries'), 0, 'a half-saved week is worse than none');
});

test('saveWeek ignores fields that are not cells', async () => {
  const result = await server.saveWeek.orThrow.call(
    as(bob),
    form({
      user_id: '2',
      week: WEEK,
      csrf: 'whatever',
      'c_not-a-date_110_210': '2:00',
      'c_2026-01-05_110_210': '2:00',
    }),
  );
  assert.equal(result.created, 1);
  assert.equal(count(database, 'time_entries'), 1);
});

test('deleteRow clears one project↔task row across the week but leaves locked entries', async () => {
  addEntry(database, { id: 705, date: '2026-01-05', user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 706, date: '2026-01-11', user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 707, date: '2026-01-12', user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 708, date: '2026-01-06', user: 2, project: 110, task: 210, seconds: 3600, locked: true });
  addEntry(database, { id: 709, date: '2026-01-06', user: 2, project: 111, task: 210, seconds: 3600 });

  const result = await server.deleteRow.orThrow.call(
    as(bob),
    form({ user_id: '2', week: WEEK, row: '110:210' }),
  );
  assert.equal(result.deleted, 2, 'the Monday and the Sunday of that week');
  assert.deepEqual(
    (database.prepare('SELECT id FROM time_entries ORDER BY id').all() as { id: number }[]).map((r) => r.id),
    [707, 708, 709],
  );
});

test('deleteRow refuses a row that is not a project:task pair, and somebody else’s week', async () => {
  assert.equal((await refused(() => server.deleteRow.orThrow.call(as(bob), form({ user_id: '2', week: WEEK, row: '110' })))).code, 'BAD_REQUEST');
  assert.equal((await refused(() => server.deleteRow.orThrow.call(as(bob), form({ user_id: '4', week: WEEK, row: '110:210' })))).code, 'FORBIDDEN');
});

test('copying last week in projects mode brings the rows across with no hours', async () => {
  addEntry(database, { id: 710, date: '2025-12-29', user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 711, date: '2025-12-31', user: 2, project: 110, task: 210, seconds: 7200 });
  addEntry(database, { id: 712, date: '2025-12-31', user: 2, project: 111, task: 210, seconds: 1800 });

  const result = await server.copyFromLastWeek.orThrow.call(
    as(bob),
    form({ user_id: '2', week: WEEK, mode: 'projects' }),
  );
  assert.deepEqual(plain(result), { copied: 2, mode: 'projects' });

  const placed = database
    .prepare('SELECT spent_date, project_id, duration_seconds FROM time_entries WHERE id > 712 ORDER BY project_id')
    .all() as { spent_date: string; project_id: number; duration_seconds: number }[];
  assert.deepEqual(placed.map(plain), [
    { spent_date: WEEK, project_id: 110, duration_seconds: 0 },
    { spent_date: WEEK, project_id: 111, duration_seconds: 0 },
  ]);
});

test('projects mode does not duplicate a row the week already has', async () => {
  addEntry(database, { id: 713, date: '2025-12-29', user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 714, date: '2026-01-07', user: 2, project: 110, task: 210, seconds: 0 });

  const result = await server.copyFromLastWeek.orThrow.call(
    as(bob),
    form({ user_id: '2', week: WEEK, mode: 'projects' }),
  );
  assert.equal(result.copied, 0);
  assert.equal(count(database, 'time_entries'), 2);
});

test('entries mode brings the hours across, shifted by seven days', async () => {
  addEntry(database, { id: 715, date: '2025-12-30', user: 2, project: 110, task: 210, seconds: 3600 });
  addEntry(database, { id: 716, date: '2025-12-31', user: 2, project: 110, task: 210, seconds: 0 });

  const result = await server.copyFromLastWeek.orThrow.call(
    as(bob),
    form({ user_id: '2', week: WEEK, mode: 'entries' }),
  );
  assert.equal(result.copied, 1, 'an empty placeholder is not worth copying');
  const copied = plain(
    database.prepare('SELECT spent_date, duration_seconds, rounded_seconds FROM time_entries WHERE id > 716').get() as {
      spent_date: string; duration_seconds: number; rounded_seconds: number;
    },
  );
  assert.deepEqual(copied, { spent_date: '2026-01-06', duration_seconds: 3600, rounded_seconds: 3600 });
});

test('copying a week with nothing in it says so rather than doing nothing quietly', async () => {
  const refusal = await refused(() =>
    server.copyFromLastWeek.orThrow.call(as(bob), form({ user_id: '2', week: WEEK, mode: 'entries' })),
  );
  assert.equal(refusal.code, 'BAD_REQUEST');
  assert.match(refusal.message, /nothing to copy/i);
});

test('copying somebody else’s week is refused', async () => {
  addEntry(database, { id: 717, date: '2025-12-30', user: 4, project: 110, task: 210, seconds: 3600 });
  const refusal = await refused(() =>
    server.copyFromLastWeek.orThrow.call(as(bob), form({ user_id: '4', week: WEEK, mode: 'entries' })),
  );
  assert.equal(refusal.code, 'FORBIDDEN');
  assert.equal(count(database, 'time_entries'), 1);
});
