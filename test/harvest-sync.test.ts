/**
 * The sync job: where an incremental run starts reading, what a failure is called, and — with
 * a stubbed `fetch` standing in for Harvest — a whole run from `/company` to the written
 * report, then an incremental one that narrows every entity with `updated_since`.
 *
 * No network: `globalThis.fetch` is replaced for the duration of each case and restored in a
 * `finally`. The account is four records, hand-written in the shape of harvest/types.ts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db } from '../src/lib/db/index.ts';
import { HarvestError } from '../src/lib/harvest/client.ts';
import type { ImportReport } from '../src/lib/harvest/import.ts';
import {
  PHASES,
  currentSync,
  describeFailure,
  describeMismatch,
  isSyncRunning,
  lastSuccessfulCursor,
  reapStaleRuns,
  startSync,
  verifyCredentials,
} from '../src/lib/harvest/sync.ts';
import type { SyncProgress } from '../src/lib/harvest/sync.ts';
import { plain, tempDb } from './fixture.ts';
import { withEnv } from './support.ts';

const T = '2026-01-01T00:00:00Z';
const CREDENTIALS = { accountId: '123456', accessToken: 'pat.synthetic', contact: 'ops@example.test' };

// ── local helpers ────────────────────────────────────────────────────────────

function withDb<T>(fn: (db: Db, dir: string) => T): T {
  const fixture = tempDb();
  try {
    return fn(fixture.db, fixture.dir);
  } finally {
    fixture.cleanup();
  }
}

function insertRun(
  db: Db,
  run: { status: string; startedAt: string; cursor?: string | null; finishedAt?: string | null },
): number {
  const result = db
    .prepare(
      `INSERT INTO import_runs (source, started_at, finished_at, status, cursor_updated_since)
       VALUES ('harvest-api', ?, ?, ?, ?)`,
    )
    .run(run.startedAt, run.finishedAt ?? run.startedAt, run.status, run.cursor ?? null);
  return Number(result.lastInsertRowid);
}

function report(over: { hours?: boolean; invoices?: boolean | null } = {}): ImportReport {
  return {
    counts: {},
    skipped: {},
    reconciliation: {
      source_hours: 10,
      imported_hours: over.hours === false ? 8.5 : 10,
      difference: over.hours === false ? -1.5 : 0,
      matches: over.hours !== false,
      per_year: {},
    },
    invoices:
      over.invoices === null || over.invoices === undefined
        ? null
        : {
            source_amount: 100,
            imported_amount: over.invoices ? 100 : 75.5,
            difference: over.invoices ? 0 : -24.5,
            matches: over.invoices,
          },
    first_date: '2026-01-01',
    last_date: '2026-01-31',
  };
}

// ── phases ───────────────────────────────────────────────────────────────────

test('the phases run from connecting to a terminal done or failed', () => {
  assert.equal(PHASES[0], 'connecting');
  assert.deepEqual(PHASES.slice(-3), ['writing', 'done', 'failed']);
  assert.equal(new Set(PHASES).size, PHASES.length, 'each phase is named once');
  for (const phase of ['users', 'clients', 'projects', 'time_entries', 'invoices', 'receipts']) {
    assert.ok((PHASES as readonly string[]).includes(phase), phase);
  }
});

test('nothing is running before anything has started', () => {
  // A module singleton, so this only holds before the first drive below.
  if (currentSync() === null) assert.equal(isSyncRunning(), false);
});

// ── where to resume ──────────────────────────────────────────────────────────

test('an instance that has never synced has no cursor', () =>
  withDb((db) => {
    assert.equal(lastSuccessfulCursor(db), null);
  }));

test('only a run that finished well is allowed to say where to resume', () =>
  withDb((db) => {
    insertRun(db, { status: 'failed', startedAt: '2026-01-01T08:00:00Z', cursor: '2026-01-01T08:05:00Z' });
    insertRun(db, { status: 'running', startedAt: '2026-01-02T08:00:00Z', cursor: '2026-01-02T08:05:00Z' });
    assert.equal(lastSuccessfulCursor(db), null);

    insertRun(db, { status: 'ok', startedAt: '2026-01-03T08:00:00Z', cursor: '2026-01-03T08:05:00Z' });
    assert.equal(lastSuccessfulCursor(db), '2026-01-03T08:00:00Z');
  }));

test('the window reaches back to whichever of the two recorded moments is earlier', () =>
  withDb((db) => {
    // A live pull: the run starts, then stamps its cursor moments later.
    insertRun(db, { status: 'ok', startedAt: '2026-02-01T08:00:00Z', cursor: '2026-02-01T08:00:30Z' });
    assert.equal(lastSuccessfulCursor(db), '2026-02-01T08:00:00Z', 'the start covers the gap');
  }));

test('a dump imported the next day resumes from when the dump was pulled', () =>
  withDb((db) => {
    insertRun(db, { status: 'ok', startedAt: '2026-02-02T09:00:00Z', cursor: '2026-02-01T23:00:00Z' });
    assert.equal(lastSuccessfulCursor(db), '2026-02-01T23:00:00Z', 'the day in between is not skipped');
  }));

test('a run with no cursor at all falls back to when it started', () =>
  withDb((db) => {
    insertRun(db, { status: 'ok', startedAt: '2026-02-03T09:00:00Z', cursor: null });
    assert.equal(lastSuccessfulCursor(db), '2026-02-03T09:00:00Z');
  }));

test('the most recent good run is the one that decides', () =>
  withDb((db) => {
    insertRun(db, { status: 'ok', startedAt: '2026-01-01T08:00:00Z', cursor: '2026-01-01T08:00:00Z' });
    insertRun(db, { status: 'ok', startedAt: '2026-03-01T08:00:00Z', cursor: '2026-03-01T08:00:00Z' });
    insertRun(db, { status: 'failed', startedAt: '2026-04-01T08:00:00Z', cursor: '2026-04-01T08:00:00Z' });
    assert.equal(lastSuccessfulCursor(db), '2026-03-01T08:00:00Z');
  }));

// ── runs whose process went away ─────────────────────────────────────────────

test('a run still marked running at boot is closed out as interrupted', () =>
  withDb((db) => {
    const stale = insertRun(db, { status: 'running', startedAt: '2026-01-01T08:00:00Z', finishedAt: null });
    const ok = insertRun(db, { status: 'ok', startedAt: '2026-01-02T08:00:00Z' });
    const failed = insertRun(db, { status: 'failed', startedAt: '2026-01-03T08:00:00Z' });

    reapStaleRuns(db);

    const row = (id: number) =>
      plain(db.prepare('SELECT status, finished_at, error FROM import_runs WHERE id = ?').get(id) as Record<string, unknown>);
    const reaped = row(stale);
    assert.equal(reaped.status, 'failed');
    assert.match(String(reaped.error), /^Interrupted — the server stopped/);
    assert.ok(String(reaped.finished_at).endsWith('Z'));

    assert.equal(row(ok).status, 'ok', 'a finished run is left alone');
    assert.equal(row(ok).error, null);
    assert.equal(row(failed).status, 'failed');
  }));

test('reaping twice is harmless', () =>
  withDb((db) => {
    insertRun(db, { status: 'running', startedAt: T, finishedAt: null });
    reapStaleRuns(db);
    const first = plain(db.prepare('SELECT * FROM import_runs').get() as Record<string, unknown>);
    reapStaleRuns(db);
    assert.deepEqual(plain(db.prepare('SELECT * FROM import_runs').get() as Record<string, unknown>), first);
  }));

// ── what a failure is called ─────────────────────────────────────────────────

test('a mismatch names the side that disagreed and by how much', () => {
  assert.equal(describeMismatch(report()), '');
  assert.equal(describeMismatch(report({ hours: false })), 'Hours did not reconcile: -1.50 h out.');
  assert.equal(describeMismatch(report({ invoices: false })), 'Invoices did not reconcile: -24.50 out.');
  assert.equal(
    describeMismatch(report({ hours: false, invoices: false })),
    'Hours did not reconcile: -1.50 h out. Invoices did not reconcile: -24.50 out.',
  );
  assert.equal(describeMismatch(report({ invoices: true })), '', 'both sides agreed');
});

test("a Harvest refusal is explained in Harvest's terms, with the URL that was asked", () => {
  const message = describeFailure(
    new HarvestError('401 Unauthorized', 401, 'https://api.harvestapp.com/v2/company', ''),
  );
  assert.match(message, /account ID and the personal access token are two different values/);
  assert.match(message, /\(https:\/\/api\.harvestapp\.com\/v2\/company\)$/);
});

test('a clash of email addresses is explained as the thing it is, and says nothing was written', () => {
  const message = describeFailure(new Error('UNIQUE constraint failed: users.email'));
  assert.match(message, /An account here already uses an email address that Harvest also has/);
  assert.match(message, /Nothing was written/);
  assert.match(message, /Sign in as that person and re-run/);
});

test('every other failure still says the instance is unchanged', () => {
  assert.match(
    describeFailure(new Error('UNIQUE constraint failed: clients.harvest_id')),
    /^UNIQUE constraint failed: clients\.harvest_id\. Nothing was written/,
  );
  assert.match(
    describeFailure(new Error('FOREIGN KEY constraint failed')),
    /^A record referred to something the import did not have.*Nothing was written/s,
  );
  assert.match(describeFailure(new Error('disk is full')), /^disk is full Nothing was written/);
  assert.match(describeFailure('a bare string'), /^a bare string Nothing was written/);
  assert.match(describeFailure(undefined), /^undefined Nothing was written/);
});

// ── a fake Harvest ───────────────────────────────────────────────────────────

interface Account {
  users: unknown[];
  clients: unknown[];
  tasks: unknown[];
  projects: unknown[];
  user_assignments: unknown[];
  task_assignments: unknown[];
  time_entries: unknown[];
}

const ADA = {
  id: 1,
  first_name: 'Ada',
  last_name: 'Example',
  email: 'ada@example.test',
  telephone: null,
  timezone: 'Europe/Stockholm',
  has_access_to_all_future_projects: true,
  is_contractor: false,
  is_active: true,
  weekly_capacity: 144000,
  default_hourly_rate: 1200,
  cost_rate: 600,
  roles: [],
  access_roles: ['administrator'],
  avatar_url: null,
  created_at: T,
  updated_at: T,
};

const ALPHA = { id: 10, name: 'Alpha Client', is_active: true, address: null, currency: 'SEK', created_at: T, updated_at: T };
const DEV = {
  id: 200, name: 'Development', billable_by_default: true, default_hourly_rate: 1000,
  is_default: false, is_active: true, created_at: T, updated_at: T,
};
const WEBSITE = {
  id: 100, name: 'Website', code: 'WEB', client: { id: 10, name: 'Alpha Client' }, is_active: true,
  is_billable: true, is_fixed_fee: false, bill_by: 'Project', hourly_rate: 1200, budget: null,
  budget_by: 'none', budget_is_monthly: false, notify_when_over_budget: false,
  over_budget_notification_percentage: null, show_budget_to_all: false, cost_budget: null,
  cost_budget_include_expenses: false, fee: null, notes: null, starts_on: null, ends_on: null,
  created_at: T, updated_at: T,
};

function timeEntry(id: number, spentDate: string, hours: number, updatedAt: string) {
  return {
    id,
    spent_date: spentDate,
    user: { id: 1, name: 'Ada Example' },
    user_assignment: null,
    client: { id: 10, name: 'Alpha Client' },
    project: { id: 100, name: 'Website' },
    task: { id: 200, name: 'Development' },
    task_assignment: null,
    external_reference: null,
    invoice: null,
    hours,
    hours_without_timer: null,
    rounded_hours: hours,
    notes: null,
    is_locked: false,
    locked_reason: null,
    is_closed: false,
    approval_status: 'unsubmitted',
    is_billed: false,
    timer_started_at: null,
    started_time: null,
    ended_time: null,
    is_running: false,
    billable: true,
    budgeted: false,
    billable_rate: 1200,
    cost_rate: 600,
    created_at: T,
    updated_at: updatedAt,
  };
}

const FULL: Account = {
  users: [ADA],
  clients: [ALPHA],
  tasks: [DEV],
  projects: [WEBSITE],
  user_assignments: [
    {
      id: 300, project: { id: 100, name: 'Website' }, user: { id: 1, name: 'Ada Example' },
      is_active: true, is_project_manager: true, use_default_rates: true, hourly_rate: 1200,
      budget: null, created_at: T, updated_at: T,
    },
  ],
  task_assignments: [
    {
      id: 400, project: { id: 100, name: 'Website' }, task: { id: 200, name: 'Development' },
      is_active: true, billable: true, hourly_rate: 1200, budget: null, created_at: T, updated_at: T,
    },
  ],
  time_entries: [timeEntry(900, '2026-01-05', 5, T)],
};

/** What each list path answers with, and under which key. */
const LIST_PATHS: Record<string, keyof Account | null> = {
  '/v2/users': 'users',
  '/v2/clients': 'clients',
  '/v2/tasks': 'tasks',
  '/v2/projects': 'projects',
  '/v2/user_assignments': 'user_assignments',
  '/v2/task_assignments': 'task_assignments',
  '/v2/time_entries': 'time_entries',
};

/** Everything else the run asks for, all of it empty in this account. */
const EMPTY_PATHS: Record<string, string> = {
  '/v2/invoices': 'invoices',
  '/v2/contacts': 'contacts',
  '/v2/roles': 'roles',
  '/v2/expense_categories': 'expense_categories',
  '/v2/expenses': 'expenses',
  '/v2/estimates': 'estimates',
  '/v2/invoice_item_categories': 'invoice_item_categories',
  '/v2/estimate_item_categories': 'estimate_item_categories',
  '/v2/users/1/billable_rates': 'billable_rates',
  '/v2/users/1/cost_rates': 'cost_rates',
};

const COMPANY = {
  base_uri: 'https://example.harvestapp.com',
  full_domain: 'example.harvestapp.com',
  name: 'Synthetic Studio',
  is_active: true,
  week_start_day: 'Monday',
  wants_timestamp_timers: false,
  time_format: 'decimal',
  date_format: '%Y-%m-%d',
  plan_type: 'simple',
  currency: 'SEK',
  decimal_symbol: ',',
  thousands_separator: ' ',
  color_scheme: 'orange',
  clock: '24h',
  expense_feature: true,
  invoice_feature: true,
  estimate_feature: true,
  approval_required: false,
};

interface Harvest {
  urls: string[];
  /** Records handed out when a request carries `updated_since`. */
  delta: Partial<Account>;
}

/** Install a fake Harvest for the duration of `fn`, and always put `fetch` back. */
async function withHarvest<T>(fn: (harvest: Harvest) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const harvest: Harvest = { urls: [], delta: {} };

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    harvest.urls.push(url.toString());
    const since = url.searchParams.get('updated_since');

    const answer = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

    if (url.pathname === '/v2/company') return Promise.resolve(answer(COMPANY));

    const listKey = LIST_PATHS[url.pathname];
    if (listKey) {
      const records = since ? harvest.delta[listKey] ?? [] : FULL[listKey];
      return Promise.resolve(answer({ [listKey]: records, links: { next: null } }));
    }

    const emptyKey = EMPTY_PATHS[url.pathname];
    if (emptyKey) return Promise.resolve(answer({ [emptyKey]: [], links: { next: null } }));

    return Promise.resolve(new Response(`no route for ${url.pathname}`, { status: 404 }));
  }) as typeof fetch;

  try {
    return await fn(harvest);
  } finally {
    globalThis.fetch = real;
  }
}

/** Wait for a started sync to finish, or fail the test rather than hang forever. */
async function settle(progress: SyncProgress, timeoutMs = 60_000): Promise<SyncProgress> {
  const deadline = Date.now() + timeoutMs;
  while (progress.finishedAt === null) {
    if (Date.now() > deadline) assert.fail(`the sync never finished (phase ${progress.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return progress;
}

function paramsOf(urls: string[], pathname: string): URLSearchParams[] {
  return urls.filter((u) => new URL(u).pathname === pathname).map((u) => new URL(u).searchParams);
}

// ── verifying credentials ────────────────────────────────────────────────────

test('verifying credentials asks Harvest for the company and nothing else', () =>
  withHarvest(async (harvest) => {
    const company = await verifyCredentials(CREDENTIALS);
    assert.equal(company.name, 'Synthetic Studio');
    assert.equal(company.currency, 'SEK');
    assert.equal(harvest.urls.length, 1);
    assert.equal(new URL(harvest.urls[0]!).pathname, '/v2/company');
  }));

test('bad credentials surface as a Harvest error rather than an empty account', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response('{"error":"invalid_token"}', { status: 401 }))) as typeof fetch;
  try {
    await assert.rejects(() => verifyCredentials(CREDENTIALS), (error: unknown) => {
      assert.ok(error instanceof HarvestError);
      assert.equal(error.status, 401);
      return true;
    });
  } finally {
    globalThis.fetch = real;
  }
});

// ── a whole run, then an incremental one ─────────────────────────────────────

test('a full sync pulls the account, writes it, and records a run that reconciles', async () => {
  const fixture = tempDb();
  try {
    await withEnv({ INSTANCE_DIR: fixture.dir }, () =>
      withHarvest(async (harvest) => {
        const progress = await settle(startSync(fixture.db, CREDENTIALS, { mode: 'full' }));

        assert.equal(progress.error, null, 'no failure');
        assert.equal(progress.phase, 'done');
        assert.equal(progress.mode, 'full');
        assert.equal(progress.company, 'Synthetic Studio');
        assert.ok(progress.requests >= 10, `requests counted: ${progress.requests}`);
        assert.equal(progress.counts.users, 1);
        assert.equal(progress.counts.time_entries, 1);

        const report = progress.report!;
        assert.equal(report.counts.time_entries, 1);
        assert.equal(report.reconciliation.source_hours, 5);
        assert.equal(report.reconciliation.imported_hours, 5);
        assert.equal(report.reconciliation.matches, true);

        // Nothing was narrowed: a full run asks for the whole account.
        for (const url of harvest.urls) {
          assert.equal(new URL(url).searchParams.has('updated_since'), false, url);
        }

        const run = plain(
          fixture.db
            .prepare('SELECT * FROM import_runs WHERE id = ?')
            .get(progress.runId) as Record<string, unknown>,
        );
        assert.equal(run.source, 'harvest-api');
        assert.equal(run.status, 'ok');
        assert.ok(String(run.cursor_updated_since).endsWith('Z'), 'a cursor was stamped');
        assert.ok(String(run.cursor_updated_since) >= String(run.started_at));
        assert.equal(isSyncRunning(), false);

        // ── and now the incremental run ────────────────────────────────────
        const cursor = lastSuccessfulCursor(fixture.db);
        assert.equal(cursor, run.started_at, 'the earlier of the two recorded moments');

        harvest.urls.length = 0;
        harvest.delta = { time_entries: [timeEntry(901, '2026-01-06', 2, '2026-06-01T00:00:00Z')] };

        const second = await settle(startSync(fixture.db, CREDENTIALS, { mode: 'incremental' }));
        assert.equal(second.error, null);
        assert.equal(second.phase, 'done');
        assert.equal(second.mode, 'incremental');
        assert.notEqual(second.runId, progress.runId);

        // Every entity is narrowed, not just time entries: a project renamed yesterday
        // matters as much as an entry logged yesterday.
        for (const pathname of Object.keys(LIST_PATHS)) {
          const asked = paramsOf(harvest.urls, pathname);
          assert.equal(asked.length, 1, pathname);
          assert.equal(asked[0]!.get('updated_since'), cursor, pathname);
        }
        assert.equal(paramsOf(harvest.urls, '/v2/company')[0]?.has('updated_since'), false);

        const delta = second.report!;
        assert.equal(delta.counts.time_entries, 2, 'the new entry joined the old one');
        assert.equal(delta.reconciliation.source_hours, 2, 'a delta reconciles over itself');
        assert.equal(delta.reconciliation.imported_hours, 2);
        assert.equal(delta.reconciliation.matches, true);

        const stored = fixture.db.prepare('SELECT id, duration_seconds FROM time_entries ORDER BY id').all();
        assert.deepEqual(stored.map((r) => (r as { id: number }).id), [900, 901]);
        assert.equal((stored[1] as { duration_seconds: number }).duration_seconds, 7200);

        const runs = fixture.db.prepare("SELECT source, status FROM import_runs ORDER BY id").all();
        assert.deepEqual(runs.map((r) => plain(r as Record<string, unknown>)), [
          { source: 'harvest-api', status: 'ok' },
          { source: 'harvest-api-incremental', status: 'ok' },
        ]);
      }),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a second sync is refused while one is in flight, and the failure is recorded', async () => {
  const fixture = tempDb();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = globalThis.fetch;
  // A 401 rather than a 5xx: not retryable, so the run ends on the first answer instead of
  // spending half a minute backing off.
  globalThis.fetch = (async () => {
    await held;
    return new Response('{"error":"invalid_token"}', { status: 401, statusText: 'Unauthorized' });
  }) as typeof fetch;

  try {
    await withEnv({ INSTANCE_DIR: fixture.dir }, async () => {
      const progress = startSync(fixture.db, CREDENTIALS, { mode: 'full' });
      assert.equal(isSyncRunning(), true);
      assert.throws(
        () => startSync(fixture.db, CREDENTIALS, { mode: 'full' }),
        /A sync is already running\./,
      );
      assert.equal(
        plain(
          fixture.db.prepare('SELECT status FROM import_runs WHERE id = ?').get(progress.runId) as Record<string, unknown>,
        ).status,
        'running',
        'the row says so while it is in flight',
      );

      release();
      await settle(progress);

      assert.equal(progress.phase, 'failed');
      assert.match(String(progress.error), /Harvest rejected the credentials \(401\)/);
      const run = plain(
        fixture.db.prepare('SELECT * FROM import_runs WHERE id = ?').get(progress.runId) as Record<string, unknown>,
      );
      assert.equal(run.status, 'failed');
      assert.match(String(run.error), /Harvest rejected the credentials \(401\)/);
      // Where it stopped and what it had reached, for whoever reads the history later.
      const stats = JSON.parse(String(run.stats_json)) as { failure: { phase: string; requests: number } };
      // Where it stopped, not the 'failed' it became: that is what the history is for.
      assert.equal(stats.failure.phase, 'connecting');
      assert.ok(stats.failure.requests >= 1);
      assert.equal(lastSuccessfulCursor(fixture.db), null, 'a failed run never moves the cursor');
    });
  } finally {
    release();
    globalThis.fetch = real;
    fixture.cleanup();
  }
});
