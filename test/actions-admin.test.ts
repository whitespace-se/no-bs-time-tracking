/**
 * The administrative actions: src/actions/admin.ts, src/actions/tokens.ts, src/actions/auth.ts.
 *
 * Same arrangement as test/actions-time.test.ts — `astro:actions` and `astro:schema` are
 * re-pointed at the packages they re-export, and each action is called directly with a
 * synthetic request context. What matters here is who may call what, what the form schemas
 * accept, and the two pieces of behaviour that are easy to get wrong: which budget column a
 * project writes, and what archiving does to a project's locked time entries.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { rmSync } from 'node:fs';
import test, { after, beforeEach } from 'node:test';
import { addEntry, count, plain, STAMP, tempDir } from './fixture.ts';
import { withEnv } from './support.ts';
import type { SessionUser } from '../src/lib/auth/session.ts';

const ASTRO_SERVER = new URL('../node_modules/astro/dist/actions/runtime/server.js', import.meta.url).href;
const ASTRO_CLIENT = new URL('../node_modules/astro/dist/actions/runtime/client.js', import.meta.url).href;

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

const instanceDir = tempDir('no-bs-actions-admin-test-');
const { server, database, sessions, password } = await withEnv(
  { INSTANCE_DIR: instanceDir, INSTANCE_LOG: 'off' },
  async () => {
    const actions = await import('../src/actions/index.ts');
    const { db } = await import('../src/lib/db/index.ts');
    return {
      server: actions.server,
      database: db(),
      sessions: await import('../src/lib/auth/session.ts'),
      password: await import('../src/lib/auth/password.ts'),
    };
  },
);

after(() => {
  database.close();
  rmSync(instanceDir, { recursive: true, force: true });
});

database.exec(`
  INSERT INTO users (id, email, first_name, last_name, role, is_active, created_at, updated_at)
  VALUES (1, 'ada@example.test', 'Ada', 'Example', 'admin', 1, '${STAMP}', '${STAMP}'),
         (2, 'bob@example.test', 'Bob', 'Example', 'member', 1, '${STAMP}', '${STAMP}'),
         (3, 'mia@example.test', 'Mia', 'Example', 'manager', 1, '${STAMP}', '${STAMP}');
  INSERT INTO clients (id, name, currency, is_active, created_at, updated_at)
  VALUES (10, 'Alpha Client', 'SEK', 1, '${STAMP}', '${STAMP}');
  INSERT INTO tasks (id, name, billable_by_default, is_active, created_at, updated_at)
  VALUES (200, 'Development', 1, 1, '${STAMP}', '${STAMP}');
`);

const ada: SessionUser = { id: 1, email: 'ada@example.test', name: 'Ada Example', role: 'admin' };
const bob: SessionUser = { id: 2, email: 'bob@example.test', name: 'Bob Example', role: 'member' };
const mia: SessionUser = { id: 3, email: 'mia@example.test', name: 'Mia Example', role: 'manager' };

// ── Calling an action ────────────────────────────────────────────────────────

interface Cookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

interface Context {
  locals: { user: SessionUser | null };
  request: Request;
  url: URL;
  clientAddress: string;
  cookies: { set: (name: string, value: string, options: Record<string, unknown>) => void };
}

/** The slice of the request context these handlers read, plus the cookies they set. */
function as(user: SessionUser | null): Context & { written: Cookie[] } {
  const written: Cookie[] = [];
  const url = new URL('https://tracker.example.test/account');
  return {
    locals: { user },
    request: new Request(url, { method: 'POST', headers: { 'user-agent': 'test-agent' } }),
    url,
    clientAddress: '203.0.113.7',
    cookies: { set: (name, value, options) => written.push({ name, value, options }) },
    written,
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function refused(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const action = error as { code?: string; message?: string };
    assert.ok(action.code, `not an ActionError: ${String(error)}`);
    return { code: String(action.code), message: String(action.message) };
  }
  return assert.fail('the action went through when it should have been refused');
}

function get<T extends object>(sql: string, ...params: (string | number | null)[]): T {
  return plain(database.prepare(sql).get(...params) as unknown as T);
}

beforeEach(() => {
  database.exec('DELETE FROM time_entries; DELETE FROM api_tokens; DELETE FROM sessions;');
});

// ── Only administrators ──────────────────────────────────────────────────────

/** A valid form for each admin action, so the refusal is the permission check and not zod. */
const ADMIN_CALLS: [string, Record<string, string>][] = [
  ['saveClient', { name: 'Gamma Client' }],
  ['saveProject', { client_id: '10', name: 'New project' }],
  ['saveTask', { name: 'New task' }],
  ['saveUser', { email: 'new@example.test' }],
  ['setUserAssignment', { project_id: '1', user_id: '2', active: 'on' }],
  ['setTaskAssignment', { project_id: '1', task_id: '200', active: 'on', billable: 'on' }],
];

test('every admin action refuses a caller who is not signed in', async () => {
  for (const [name, fields] of ADMIN_CALLS) {
    const refusal = await refused(() =>
      (server as Record<string, { orThrow: (input: FormData) => Promise<unknown> }>)[name]!.orThrow.call(
        as(null),
        form(fields),
      ),
    );
    assert.equal(refusal.code, 'UNAUTHORIZED', name);
  }
});

test('every admin action refuses a member and a manager', async () => {
  for (const [name, fields] of ADMIN_CALLS) {
    for (const actor of [bob, mia]) {
      const refusal = await refused(() =>
        (server as Record<string, { orThrow: (input: FormData) => Promise<unknown> }>)[name]!.orThrow.call(
          as(actor),
          form(fields),
        ),
      );
      assert.equal(refusal.code, 'FORBIDDEN', `${name} as ${actor.role}`);
      assert.match(refusal.message, /administrators/i);
    }
  }
  assert.equal(count(database, 'clients', "name = 'Gamma Client'"), 0);
});

// ── Clients ──────────────────────────────────────────────────────────────────

test('a client needs a name', async () => {
  assert.equal((await refused(() => server.saveClient.orThrow.call(as(ada), form({ name: '' })))).code, 'BAD_REQUEST');
});

test('a new client takes the instance currency when the field is blank', async () => {
  const { id } = await server.saveClient.orThrow.call(as(ada), form({ name: 'Delta Client', currency: '' }));
  assert.equal(get<{ currency: string }>('SELECT currency FROM clients WHERE id = ?', id).currency, 'SEK');
});

test('a currency is normalised, and anything that is not three letters is ignored', async () => {
  const good = await server.saveClient.orThrow.call(as(ada), form({ name: 'Euro Client', currency: ' eur ' }));
  const bad = await server.saveClient.orThrow.call(as(ada), form({ name: 'Odd Client', currency: 'euros' }));
  assert.equal(get<{ currency: string }>('SELECT currency FROM clients WHERE id = ?', good.id).currency, 'EUR');
  assert.equal(get<{ currency: string }>('SELECT currency FROM clients WHERE id = ?', bad.id).currency, 'SEK');
});

test('archiving a client stamps archived_at, and restoring it clears the stamp', async () => {
  const { id } = await server.saveClient.orThrow.call(as(ada), form({ name: 'Later Archived', is_active: 'on' }));
  assert.equal(get<{ archived_at: string | null }>('SELECT archived_at FROM clients WHERE id = ?', id).archived_at, null);

  await server.saveClient.orThrow.call(as(ada), form({ id: String(id), name: 'Later Archived' }));
  const archived = get<{ is_active: number; archived_at: string | null }>(
    'SELECT is_active, archived_at FROM clients WHERE id = ?', id,
  );
  assert.equal(archived.is_active, 0, 'an absent checkbox means unchecked, never "keep as it was"');
  assert.ok(archived.archived_at);

  await server.saveClient.orThrow.call(as(ada), form({ id: String(id), name: 'Later Archived', is_active: 'on' }));
  assert.equal(get<{ archived_at: string | null }>('SELECT archived_at FROM clients WHERE id = ?', id).archived_at, null);
});

// ── Projects ─────────────────────────────────────────────────────────────────

async function project(fields: Record<string, string>): Promise<number> {
  const { id } = await server.saveProject.orThrow.call(
    as(ada),
    form({ client_id: '10', name: 'A project', is_active: 'on', ...fields }),
  );
  return id!;
}

test('a project stores the rate and the billing mode it was given', async () => {
  const id = await project({ name: 'Rated', bill_by: 'Project', hourly_rate: '1250,50' });
  const saved = get<{ bill_by: string; hourly_rate: number }>(
    'SELECT bill_by, hourly_rate FROM projects WHERE id = ?', id,
  );
  assert.equal(saved.bill_by, 'Project');
  assert.equal(saved.hourly_rate, 125050, 'money is stored in minor units, and a comma is a decimal point');
});

test('an unknown billing or budget mode falls back rather than failing the save', async () => {
  const id = await project({ bill_by: 'Whatever', budget_by: 'nonsense' });
  const saved = get<{ bill_by: string; budget_by: string }>('SELECT bill_by, budget_by FROM projects WHERE id = ?', id);
  assert.equal(saved.bill_by, 'none');
  assert.equal(saved.budget_by, 'none');
});

test('exactly one budget column is filled, and it follows budget_by', async () => {
  const hours = await project({ budget_by: 'project', budget_hours: '40', budget_money: '90000' });
  const money = await project({ budget_by: 'project_cost', budget_hours: '40', budget_money: '90000' });
  const none = await project({ budget_by: 'none', budget_hours: '40', budget_money: '90000' });

  assert.deepEqual(
    get('SELECT budget_seconds, budget_amount FROM projects WHERE id = ?', hours),
    { budget_seconds: 144000, budget_amount: null },
  );
  assert.deepEqual(
    get('SELECT budget_seconds, budget_amount FROM projects WHERE id = ?', money),
    { budget_seconds: null, budget_amount: 9000000 },
  );
  assert.deepEqual(
    get('SELECT budget_seconds, budget_amount FROM projects WHERE id = ?', none),
    { budget_seconds: null, budget_amount: null },
  );
});

test('an over-budget threshold is a whole percentage, clamped', async () => {
  const id = await project({ notify_when_over_budget: 'on', over_budget_notification_percentage: '120,4' });
  assert.equal(
    get<{ over_budget_notification_percentage: number }>(
      'SELECT over_budget_notification_percentage FROM projects WHERE id = ?', id,
    ).over_budget_notification_percentage,
    100,
  );
});

test('editing a project that is not there is not found', async () => {
  const refusal = await refused(() =>
    server.saveProject.orThrow.call(as(ada), form({ id: '9999', client_id: '10', name: 'Ghost' })),
  );
  assert.equal(refusal.code, 'NOT_FOUND');
});

test('archiving a project locks its time entries, composing with an invoice lock', async () => {
  const id = await project({ name: 'To be archived' });
  addEntry(database, { id: 800, date: '2026-01-05', user: 2, project: id, task: 200, seconds: 3600 });
  addEntry(database, { id: 801, date: '2026-01-05', user: 2, project: id, task: 200, seconds: 3600, billed: true });
  addEntry(database, {
    id: 802, date: '2026-01-05', user: 2, project: id, task: 200, seconds: 3600,
    locked: true, lockedReason: 'Item Locked for this Time Period',
  });

  await server.saveProject.orThrow.call(as(ada), form({ id: String(id), client_id: '10', name: 'To be archived' }));

  const reasons = (
    database.prepare('SELECT id, is_locked, locked_reason FROM time_entries ORDER BY id').all() as {
      id: number; is_locked: number; locked_reason: string | null;
    }[]
  ).map(plain);
  assert.deepEqual(reasons, [
    { id: 800, is_locked: 1, locked_reason: 'Item Archived' },
    { id: 801, is_locked: 1, locked_reason: 'Item Invoiced and Archived' },
    { id: 802, is_locked: 1, locked_reason: 'Item Locked for this Time Period' },
  ]);
});

test('un-archiving releases the archive lock but never the invoice one', async () => {
  const id = await project({ name: 'Back again' });
  addEntry(database, {
    id: 803, date: '2026-01-05', user: 2, project: id, task: 200, seconds: 3600,
    locked: true, lockedReason: 'Item Archived',
  });
  addEntry(database, {
    id: 804, date: '2026-01-05', user: 2, project: id, task: 200, seconds: 3600, billed: true,
    locked: true, lockedReason: 'Item Invoiced and Archived',
  });
  addEntry(database, {
    id: 805, date: '2026-01-05', user: 2, project: id, task: 200, seconds: 3600,
    locked: true, lockedReason: 'Item Locked for this Time Period',
  });
  database.prepare('UPDATE projects SET is_active = 0 WHERE id = ?').run(id);

  await server.saveProject.orThrow.call(
    as(ada),
    form({ id: String(id), client_id: '10', name: 'Back again', is_active: 'on' }),
  );

  const reasons = (
    database.prepare('SELECT id, is_locked, locked_reason FROM time_entries ORDER BY id').all() as {
      id: number; is_locked: number; locked_reason: string | null;
    }[]
  ).map(plain);
  assert.deepEqual(reasons, [
    { id: 803, is_locked: 0, locked_reason: null },
    { id: 804, is_locked: 1, locked_reason: 'Item Invoiced' },
    { id: 805, is_locked: 1, locked_reason: 'Item Locked for this Time Period' },
  ]);
});

// ── Tasks ────────────────────────────────────────────────────────────────────

test('a task needs a name, and keeps its default rate in minor units', async () => {
  assert.equal((await refused(() => server.saveTask.orThrow.call(as(ada), form({ name: '' })))).code, 'BAD_REQUEST');

  const { id } = await server.saveTask.orThrow.call(
    as(ada),
    form({ name: 'Consulting', billable_by_default: 'on', default_hourly_rate: '900', is_active: 'on' }),
  );
  assert.deepEqual(
    get('SELECT name, billable_by_default, default_hourly_rate, archived_at FROM tasks WHERE id = ?', id),
    { name: 'Consulting', billable_by_default: 1, default_hourly_rate: 90000, archived_at: null },
  );
});

test('archiving a task stamps archived_at', async () => {
  const { id } = await server.saveTask.orThrow.call(as(ada), form({ name: 'Retired', is_active: 'on' }));
  await server.saveTask.orThrow.call(as(ada), form({ id: String(id), name: 'Retired' }));
  const saved = get<{ is_active: number; archived_at: string | null }>(
    'SELECT is_active, archived_at FROM tasks WHERE id = ?', id,
  );
  assert.equal(saved.is_active, 0);
  assert.ok(saved.archived_at);
});

// ── People ───────────────────────────────────────────────────────────────────

test('a person needs an address that looks like one', async () => {
  assert.equal((await refused(() => server.saveUser.orThrow.call(as(ada), form({ email: 'not-an-address' })))).code, 'BAD_REQUEST');
});

test('a new person is stored with capacity in seconds and rates in minor units', async () => {
  const { id } = await server.saveUser.orThrow.call(
    as(ada),
    form({
      email: 'new.person@example.test', first_name: 'New', last_name: 'Person', role: 'manager',
      weekly_capacity_hours: '37,5', default_billable_rate: '1100', cost_rate: '500', is_active: 'on',
    }),
  );
  assert.deepEqual(
    get('SELECT role, weekly_capacity_seconds, default_billable_rate, cost_rate FROM users WHERE id = ?', id),
    { role: 'manager', weekly_capacity_seconds: 135000, default_billable_rate: 110000, cost_rate: 50000 },
  );
});

test('an unknown role is refused, and an absent one is a member', async () => {
  const refusal = await refused(() =>
    server.saveUser.orThrow.call(as(ada), form({ email: 'role.invalid@example.test', role: 'owner', is_active: 'on' })),
  );
  assert.equal(refusal.code, 'BAD_REQUEST');

  const { id } = await server.saveUser.orThrow.call(
    as(ada),
    form({ email: 'role.default@example.test', is_active: 'on' }),
  );
  assert.equal(get<{ role: string }>('SELECT role FROM users WHERE id = ?', id).role, 'member');
});

test('a password given on the form is stored hashed, never as typed', async () => {
  const { id } = await server.saveUser.orThrow.call(
    as(ada),
    form({ email: 'with.password@example.test', is_active: 'on', password: 'correct horse battery staple' }),
  );
  const hash = get<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = ?', id).password_hash;
  assert.ok(hash);
  assert.doesNotMatch(hash, /correct horse/);
  assert.equal(await password.verifyPassword('correct horse battery staple', hash), true);
});

test('an admin cannot demote or deactivate themselves', async () => {
  const demote = await refused(() =>
    server.saveUser.orThrow.call(as(ada), form({ id: '1', email: ada.email, role: 'member', is_active: 'on' })),
  );
  const deactivate = await refused(() =>
    server.saveUser.orThrow.call(as(ada), form({ id: '1', email: ada.email, role: 'admin' })),
  );
  assert.equal(demote.code, 'BAD_REQUEST');
  assert.match(demote.message, /your own admin access/i);
  assert.equal(deactivate.code, 'BAD_REQUEST');
  assert.equal(get<{ role: string; is_active: number }>('SELECT role, is_active FROM users WHERE id = 1').role, 'admin');
});

test('setting a password or deactivating somebody signs their sessions out', async () => {
  const forPassword = sessions.createSession(database, 2);
  await server.saveUser.orThrow.call(
    as(ada),
    form({ id: '2', email: bob.email, role: 'member', is_active: 'on', password: 'a whole new password' }),
  );
  assert.equal(sessions.resolveSession(database, forPassword.id), null);

  const forDeactivation = sessions.createSession(database, 2);
  await server.saveUser.orThrow.call(as(ada), form({ id: '2', email: bob.email, role: 'member' }));
  assert.equal(sessions.resolveSession(database, forDeactivation.id), null);

  // Put Bob back the way the rest of the file expects him.
  database.prepare("UPDATE users SET is_active = 1, archived_at = NULL WHERE id = 2").run();
});

// ── Assignments ──────────────────────────────────────────────────────────────

test('assigning a person to a project is an upsert, so it can be undone', async () => {
  const id = await project({ name: 'Assignable' });
  await server.setUserAssignment.orThrow.call(as(ada), form({ project_id: String(id), user_id: '2', active: 'on' }));
  await server.setUserAssignment.orThrow.call(as(ada), form({ project_id: String(id), user_id: '2' }));

  assert.equal(count(database, 'user_assignments', `project_id = ${id} AND user_id = 2`), 1, 'one row, not two');
  assert.equal(
    get<{ is_active: number }>('SELECT is_active FROM user_assignments WHERE project_id = ? AND user_id = 2', id).is_active,
    0,
  );
});

test('a task assignment carries its own billability, and can be switched off', async () => {
  const id = await project({ name: 'Task assignable' });
  await server.setTaskAssignment.orThrow.call(
    as(ada),
    form({ project_id: String(id), task_id: '200', active: 'on', billable: 'on' }),
  );
  await server.setTaskAssignment.orThrow.call(
    as(ada),
    form({ project_id: String(id), task_id: '200', active: 'on' }),
  );

  assert.equal(count(database, 'task_assignments', `project_id = ${id}`), 1);
  assert.deepEqual(
    get('SELECT is_active, billable FROM task_assignments WHERE project_id = ? AND task_id = 200', id),
    { is_active: 1, billable: 0 },
  );
});

// ── Personal access tokens ───────────────────────────────────────────────────

test('a token is minted for the person asking, and only its hash is kept', async () => {
  const result = await server.createApiToken.orThrow.call(as(bob), form({ name: '  CI  ', expires_in_days: '30' }));
  assert.match(result.token, /^tt_[A-Za-z0-9_-]{20,}$/);
  assert.equal(result.name, 'CI', 'the name is trimmed');
  assert.ok(result.token.startsWith(result.prefix));

  const stored = get<{ user_id: number; token_hash: string; prefix: string; expires_at: string | null }>(
    'SELECT user_id, token_hash, prefix, expires_at FROM api_tokens WHERE name = ?', 'CI',
  );
  assert.equal(stored.user_id, 2, 'always the caller, never somebody else');
  assert.notEqual(stored.token_hash, result.token);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(result.token.slice(12)), 'the secret is not in the row');
  assert.ok(stored.expires_at && Date.parse(stored.expires_at) > Date.now());
});

test('a token with no expiry says so rather than expiring at the epoch', async () => {
  const result = await server.createApiToken.orThrow.call(as(bob), form({ name: 'Forever', expires_in_days: '0' }));
  assert.equal(result.expires_at, null);
});

test('a token needs a name and one of the offered lifetimes', async () => {
  assert.equal((await refused(() => server.createApiToken.orThrow.call(as(bob), form({ name: '  ', expires_in_days: '30' })))).code, 'BAD_REQUEST');
  assert.equal((await refused(() => server.createApiToken.orThrow.call(as(bob), form({ name: 'Odd', expires_in_days: '7' })))).code, 'BAD_REQUEST');
  assert.equal((await refused(() => server.createApiToken.orThrow.call(as(bob), form({ name: 'x'.repeat(81), expires_in_days: '30' })))).code, 'BAD_REQUEST');
  assert.equal(count(database, 'api_tokens'), 0);
});

test('minting a token requires a session', async () => {
  const refusal = await refused(() =>
    server.createApiToken.orThrow.call(as(null), form({ name: 'Anonymous', expires_in_days: '30' })),
  );
  assert.equal(refusal.code, 'UNAUTHORIZED');
});

test('a person may revoke their own token, and revoking is a timestamp rather than a delete', async () => {
  const created = await server.createApiToken.orThrow.call(as(bob), form({ name: 'Mine', expires_in_days: '30' }));
  const id = get<{ id: number }>('SELECT id FROM api_tokens WHERE name = ?', 'Mine').id;

  await server.revokeApiToken.orThrow.call(as(bob), form({ id: String(id) }));
  assert.ok(get<{ revoked_at: string | null }>('SELECT revoked_at FROM api_tokens WHERE id = ?', id).revoked_at);
  assert.equal(count(database, 'api_tokens', `id = ${id}`), 1, 'the record of what existed is kept');
  assert.ok(created.token);

  const again = await refused(() => server.revokeApiToken.orThrow.call(as(bob), form({ id: String(id) })));
  assert.equal(again.code, 'NOT_FOUND');
});

test('a member may not revoke somebody else’s token, and is not told it exists', async () => {
  await server.createApiToken.orThrow.call(as(mia), form({ name: 'Hers', expires_in_days: '90' }));
  const id = get<{ id: number }>('SELECT id FROM api_tokens WHERE name = ?', 'Hers').id;

  const refusal = await refused(() => server.revokeApiToken.orThrow.call(as(bob), form({ id: String(id) })));
  assert.equal(refusal.code, 'NOT_FOUND');
  assert.match(refusal.message, /no such token of yours/i);
  assert.equal(get<{ revoked_at: string | null }>('SELECT revoked_at FROM api_tokens WHERE id = ?', id).revoked_at, null);
});

test('an admin may revoke anyone’s token — the case is the owner who has left', async () => {
  await server.createApiToken.orThrow.call(as(bob), form({ name: 'Left behind', expires_in_days: '365' }));
  const id = get<{ id: number }>('SELECT id FROM api_tokens WHERE name = ?', 'Left behind').id;

  await server.revokeApiToken.orThrow.call(as(ada), form({ id: String(id) }));
  assert.ok(get<{ revoked_at: string | null }>('SELECT revoked_at FROM api_tokens WHERE id = ?', id).revoked_at);
});

// ── Changing a password ──────────────────────────────────────────────────────

async function givePassword(userId: number, plaintext: string): Promise<void> {
  database
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(await password.hashPassword(plaintext), userId);
}

test('changing a password needs the current one', async () => {
  await givePassword(2, 'the current password');
  const refusal = await refused(() =>
    server.changePassword.orThrow.call(
      as(bob),
      form({ current: 'not it at all', next: 'a brand new password', confirm: 'a brand new password' }),
    ),
  );
  assert.equal(refusal.code, 'FORBIDDEN');
  assert.match(refusal.message, /current password is wrong/i);
});

test('the two new passwords must match, and may be any length', async () => {
  await givePassword(2, 'the current password');
  const differ = await refused(() =>
    server.changePassword.orThrow.call(
      as(bob),
      form({ current: 'the current password', next: 'a brand new password', confirm: 'something else entirely' }),
    ),
  );
  assert.equal(differ.code, 'BAD_REQUEST');
  assert.match(differ.message, /differ/i);

  const empty = await refused(() =>
    server.changePassword.orThrow.call(as(bob), form({ current: 'the current password', next: '', confirm: '' })),
  );
  assert.equal(empty.code, 'BAD_REQUEST');

  // A short one is the account holder's choice.
  await server.changePassword.orThrow.call(as(bob), form({ current: 'the current password', next: 'abc', confirm: 'abc' }));
});

test('changing a password signs every other device out and issues a fresh session', async () => {
  await givePassword(2, 'the current password');
  const elsewhere = sessions.createSession(database, 2);
  const context = as(bob);

  const result = await server.changePassword.orThrow.call(
    context,
    form({ current: 'the current password', next: 'a brand new password', confirm: 'a brand new password' }),
  );
  assert.deepEqual(plain(result), { ok: true });

  assert.equal(sessions.resolveSession(database, elsewhere.id), null, 'the other device is signed out');
  const cookie = context.written.at(-1);
  assert.equal(cookie?.name, 'tt_session');
  assert.equal(sessions.resolveSession(database, cookie!.value)?.id, 2, 'this device gets a working session');
  assert.equal(cookie?.options.httpOnly, true);
  assert.equal(cookie?.options.secure, true, 'the request came over https');

  const hash = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = 2').password_hash;
  assert.equal(await password.verifyPassword('a brand new password', hash), true);
});

test('changing a password requires a session', async () => {
  const refusal = await refused(() =>
    server.changePassword.orThrow.call(
      as(null),
      form({ current: 'whatever it is', next: 'a brand new password', confirm: 'a brand new password' }),
    ),
  );
  assert.equal(refusal.code, 'UNAUTHORIZED');
});

test('a person with no password set cannot talk their way past the current-password check', async () => {
  database.prepare('UPDATE users SET password_hash = NULL WHERE id = 3').run();
  const refusal = await refused(() =>
    server.changePassword.orThrow.call(
      as(mia),
      form({ current: '', next: 'a brand new password', confirm: 'a brand new password' }),
    ),
  );
  // The empty `current` is refused by the schema before the comparison is even reached.
  assert.equal(refusal.code, 'BAD_REQUEST');

  const withValue = await refused(() =>
    server.changePassword.orThrow.call(
      as(mia),
      form({ current: 'anything at all', next: 'a brand new password', confirm: 'a brand new password' }),
    ),
  );
  assert.equal(withValue.code, 'FORBIDDEN');
});

// ── saveProfile: self-service, and only ever the caller's own row ─────────────

test('saveProfile lets a member change their own name and email', async () => {
  await server.saveProfile.orThrow.call(
    as(bob),
    form({ first_name: 'Bobby', last_name: 'Tables', email: 'bobby@example.test' }),
  );
  const u = get<{ first_name: string; last_name: string; email: string; role: string }>(
    'SELECT first_name, last_name, email, role FROM users WHERE id = 2',
  );
  assert.equal(u.first_name, 'Bobby');
  assert.equal(u.last_name, 'Tables');
  assert.equal(u.email, 'bobby@example.test');
  assert.equal(u.role, 'member', 'the role is untouched');
});

test('saveProfile cannot change role or active status, even when those fields are posted', async () => {
  // A member forging role=admin / is_active off in the form must get nowhere: the schema does
  // not accept those fields, so they are dropped before the handler ever runs.
  await server.saveProfile.orThrow.call(
    as(bob),
    form({ first_name: 'Bob', last_name: 'Example', email: 'bob2@example.test', role: 'admin', is_active: '' }),
  );
  const u = get<{ role: string; is_active: number }>('SELECT role, is_active FROM users WHERE id = 2');
  assert.equal(u.role, 'member', 'no privilege escalation');
  assert.equal(u.is_active, 1, 'still active — cannot deactivate self here');
});

test('saveProfile refuses an email another account already uses, but keeps your own', async () => {
  // Re-saving with your own current address is fine.
  await server.saveProfile.orThrow.call(
    as(bob),
    form({ first_name: 'Bob', last_name: 'Example', email: 'bob2@example.test' }),
  );
  // ada (id 1) owns ada@example.test; the check is case-insensitive.
  const clash = await refused(() =>
    server.saveProfile.orThrow.call(
      as(bob),
      form({ first_name: 'Bob', last_name: 'Example', email: 'ADA@example.test' }),
    ),
  );
  assert.equal(clash.code, 'CONFLICT');
});

test('saveProfile requires a session', async () => {
  const refusal = await refused(() =>
    server.saveProfile.orThrow.call(
      as(null),
      form({ first_name: 'X', last_name: 'Y', email: 'nobody@example.test' }),
    ),
  );
  assert.equal(refusal.code, 'UNAUTHORIZED');
});
