/**
 * End-to-end over HTTP against the production build.
 *
 * Spawns `node dist/server/entry.mjs` on a free port with a throwaway instance folder and
 * drives it the way a browser and an API client would: plain fetch, manual redirects, manual
 * cookies. Nothing here imports application code — if it passes, the built artifact works.
 *
 * Skips (rather than fails) when `dist/` is missing, so `npm test` without a build still
 * runs the unit tests. Run `npm run build` first to exercise this one.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = join(ROOT, 'dist', 'server', 'entry.mjs');

const STARTUP_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;

const ADMIN = {
  company_name: 'Synthetic Studio',
  first_name: 'Test',
  last_name: 'Admin',
  email: 'admin@synthetic.test',
  password: 'correct horse battery staple',
};

// ── helpers ──────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Astro actions answer in devalue's flattened form: `[root, ...values]`, where an object's
 * property values and an array's items are indices into the same list. Enough of a decoder
 * for the flat records these actions return.
 */
function undevalue(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return parsed;
  const values = parsed as unknown[];
  const hydrate = (index: number): unknown => {
    if (index < 0) return undefined;
    const value = values[index];
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((i) => hydrate(i as number));
    return Object.fromEntries(
      Object.entries(value as Record<string, number>).map(([key, i]) => [key, hydrate(i)]),
    );
  };
  return hydrate(0);
}

function sessionCookie(response: Response): string | null {
  const set = response.headers.getSetCookie().find((c) => c.startsWith('tt_session='));
  return set ? set.split(';')[0]! : null;
}

/** Split RFC 4180 CSV as this app writes it: BOM, CRLF, quotes only where needed. */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/^﻿/, '').split('\r\n').filter((line) => line.length > 0);
  const split = (line: string): string[] => {
    const out: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(field); field = ''; }
      else field += ch;
    }
    out.push(field);
    return out;
  };
  const [head = '', ...body] = lines;
  return { headers: split(head), rows: body.map(split) };
}

// ── the test ─────────────────────────────────────────────────────────────────

test('end to end over HTTP against the built server', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!existsSync(ENTRY)) {
    t.skip(`no build at ${ENTRY} — run \`npm run build\` first to include the HTTP end-to-end test`);
    return;
  }

  const instanceDir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-e2e-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const stderr: string[] = [];
  let child: ChildProcess | null = null;
  let failed = false;

  const request = (
    path: string,
    init: {
      method?: 'GET' | 'POST';
      form?: Record<string, string>;
      cookie?: string | null;
      bearer?: string | null;
      origin?: string | null;
      /** Send it the way a browser submits a <form>: a navigation, from this page. */
      from?: string;
    } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init.cookie) headers.cookie = init.cookie;
    if (init.from) {
      headers['sec-fetch-mode'] = 'navigate';
      headers.accept = 'text/html,application/xhtml+xml';
      headers.referer = base + init.from;
    }
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    const method = init.method ?? (init.form ? 'POST' : 'GET');
    // Browsers send Origin on every POST; Astro's CSRF check rejects form posts without one.
    if (method === 'POST') headers.origin = init.origin === undefined ? base : (init.origin ?? '');
    if (init.origin === null) delete headers.origin;
    return fetch(base + path, {
      method,
      headers,
      body: init.form ? new URLSearchParams(init.form) : undefined,
      redirect: 'manual',
    });
  };

  /** Call an Astro action the way a no-JS form post reaches it, and decode the answer. */
  const action = async (
    name: string,
    form: Record<string, string>,
    cookie: string,
  ): Promise<Record<string, unknown>> => {
    const response = await request(`/_actions/${name}`, { form, cookie });
    const text = await response.text();
    assert.equal(response.status, 200, `${name} failed: ${text}`);
    return undevalue(text) as Record<string, unknown>;
  };

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await t.test(name, async () => {
      try {
        await fn();
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  };

  try {
    // ── boot ─────────────────────────────────────────────────────────────
    child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: { ...process.env, INSTANCE_DIR: instanceDir, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    let exited: string | null = null;
    child.once('exit', (code, signal) => { exited = `exit code ${code}, signal ${signal}`; });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (exited) break;
      try {
        await fetch(base + '/', { redirect: 'manual' });
        ready = true;
      } catch {
        await sleep(200);
      }
    }
    assert.ok(ready, `server did not start within ${STARTUP_TIMEOUT_MS}ms (${exited ?? 'still running'})\n${stderr.join('')}`);

    let cookie = '';
    let clientId = 0;
    let projectId = 0;
    let taskId = 0;
    let entryId = 0;
    let token = '';
    const userId = 1; // The first row in an empty users table; verified against the API below.

    // ── 1. fresh-start flow ──────────────────────────────────────────────
    await step('an instance nobody can sign in to sends / to /setup', async () => {
      const response = await request('/');
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/setup');
      assert.equal((await request('/setup')).status, 200);
    });

    await step('the setup page arrives with its stylesheets, and a stale asset is a 404', async () => {
      // Every asset the first screen references has to be served while nobody can sign in yet.
      // A missing one must answer 404 rather than being swept into the /setup redirect, or a
      // browser holding a page from an earlier build receives HTML where it asked for CSS.
      const html = await (await request('/setup')).text();
      const assets = [...html.matchAll(/(?:href|src)="(\/_astro\/[^"]+)"/g)].map((m) => m[1]!);
      assert.ok(assets.length > 0, 'the setup page references at least one bundled asset');
      for (const asset of assets) {
        const response = await request(asset);
        assert.equal(response.status, 200, `${asset} should be served, not redirected`);
      }
      const css = assets.find((a) => a.endsWith('.css'));
      if (css) {
        assert.match((await request(css)).headers.get('content-type') ?? '', /text\/css/);
      }

      const stale = await request('/_astro/from-an-older-build.css');
      assert.equal(stale.status, 404, 'a missing asset is a 404, not a redirect to a page');
    });

    await step('setup refuses mismatched passwords and bounces back to the form', async () => {
      const response = await request('/api/setup/fresh', {
        form: { ...ADMIN, confirm: 'something else entirely' },
      });
      assert.equal(response.status, 303);
      const location = response.headers.get('location') ?? '';
      assert.ok(location.startsWith('/setup?error='), `unexpected redirect: ${location}`);
      assert.match(decodeURIComponent(location), /do not match/);
      assert.equal(sessionCookie(response), null);
      // Nothing was created: the instance still needs setting up.
      assert.equal((await request('/')).headers.get('location'), '/setup');
    });

    await step('setup refuses a cross-origin form post', async () => {
      const response = await request('/api/setup/fresh', {
        form: { ...ADMIN, confirm: ADMIN.password },
        origin: 'https://evil.example',
      });
      assert.equal(response.status, 403);
      assert.equal(sessionCookie(response), null);
      assert.equal((await request('/')).headers.get('location'), '/setup');
    });

    await step('setup creates the administrator and signs them in', async () => {
      const response = await request('/api/setup/fresh', {
        form: { ...ADMIN, confirm: ADMIN.password },
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/');
      const set = response.headers.getSetCookie().find((c) => c.startsWith('tt_session=')) ?? '';
      assert.match(set, /HttpOnly/i);
      assert.match(set, /SameSite=Lax/i);
      assert.match(set, /Path=\//);
      cookie = sessionCookie(response) ?? '';
      assert.ok(cookie.length > 'tt_session='.length, 'a session cookie was set');
    });

    await step('a second setup post is refused once someone can sign in', async () => {
      const response = await request('/api/setup/fresh', {
        form: { ...ADMIN, email: 'second@synthetic.test', confirm: ADMIN.password },
      });
      assert.ok([302, 303].includes(response.status), `expected a redirect, got ${response.status}`);
      assert.notEqual(response.headers.get('location'), '/setup');
      assert.equal(sessionCookie(response), null);
      // And it did not sneak a second account in.
      const people = parseCsv(await (await request('/export/people', { cookie })).text());
      assert.equal(people.rows.length, 1);
      assert.equal(people.rows[0]![people.headers.indexOf('Email')], ADMIN.email);
      assert.equal(people.rows[0]![people.headers.indexOf('Role')], 'admin');
    });

    // ── 2. sessions ──────────────────────────────────────────────────────
    await step('with the session, / renders and /setup is gone', async () => {
      // `/` is a pointer, not a page: it sends you to this week's grid (src/pages/index.astro).
      const home = await request('/', { cookie });
      assert.equal(home.status, 302);
      assert.match(home.headers.get('location') ?? '', /^\/week\/\d{4}-\d{2}-\d{2}\/\d+$/);
      const grid = await request(home.headers.get('location')!, { cookie });
      assert.equal(grid.status, 200);
      assert.match(grid.headers.get('content-type') ?? '', /text\/html/);
      const setup = await request('/setup', { cookie });
      assert.notEqual(setup.status, 200, '/setup must not be served after setup');
      assert.equal(setup.status, 302);
      assert.equal(setup.headers.get('location'), '/import');
      const api = await request('/api/setup/fresh', { form: { company_name: 'x' }, cookie });
      assert.notEqual(api.status, 200);
    });

    await step('logout destroys the session server-side', async () => {
      const response = await request('/api/logout', { method: 'POST', cookie });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/login');
      const cleared = response.headers.getSetCookie().find((c) => c.startsWith('tt_session=')) ?? '';
      assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/);

      // The old cookie value is dead even if a client keeps sending it.
      const stale = await request('/', { cookie });
      assert.equal(stale.status, 302);
      assert.equal(stale.headers.get('location'), '/login');
      const anonymous = await request('/reports');
      assert.equal(anonymous.status, 302);
      assert.equal(anonymous.headers.get('location'), '/login?next=%2Freports');
    });

    await step('login rejects the wrong password without leaking a session', async () => {
      const response = await request('/api/login', {
        form: { email: ADMIN.email, password: 'not the password' },
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/login?error=1');
      assert.equal(sessionCookie(response), null);
    });

    await step('login accepts the right password and only redirects within the app', async () => {
      const response = await request('/api/login', {
        form: { email: ADMIN.email.toUpperCase(), password: ADMIN.password, next: '/reports' },
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/reports');
      cookie = sessionCookie(response) ?? '';
      assert.ok(cookie.length > 'tt_session='.length);
      assert.equal((await request('/', { cookie })).status, 302, 'the new session works');

      // An open redirect would be a phishing primitive.
      const open = await request('/api/login', {
        form: { email: ADMIN.email, password: ADMIN.password, next: '//evil.example/x' },
      });
      assert.equal(open.headers.get('location'), '/');
    });

    // ── 3. actions ───────────────────────────────────────────────────────
    await step('actions create a client, a project with a rate, and a task', async () => {
      const client = await action('saveClient', { name: 'Acme Synthetic', currency: 'SEK', is_active: 'on' }, cookie);
      clientId = Number(client.id);
      assert.ok(clientId > 0);

      const project = await action('saveProject', {
        client_id: String(clientId),
        name: 'Website relaunch',
        code: 'WEB',
        hourly_rate: '1250',
        is_billable: 'on',
        bill_by: 'Project',
        budget_by: 'none',
        is_active: 'on',
      }, cookie);
      projectId = Number(project.id);
      assert.ok(projectId > 0);

      const task = await action('saveTask', { name: 'Development', billable_by_default: 'on', is_active: 'on' }, cookie);
      taskId = Number(task.id);
      assert.ok(taskId > 0);

      const assignment = await action('setTaskAssignment', {
        project_id: String(projectId), task_id: String(taskId), active: 'on', billable: 'on',
      }, cookie);
      assert.equal(assignment.ok, true);

      const projects = parseCsv(await (await request('/export/projects', { cookie })).text());
      const row = projects.rows.find((r) => r[projects.headers.indexOf('Code')] === 'WEB');
      assert.ok(row, 'the project is in the export');
      assert.equal(row[projects.headers.indexOf('Client')], 'Acme Synthetic');
      assert.equal(row[projects.headers.indexOf('Hourly rate')], '1250');
    });

    await step('an invalid action input is a 400 with field errors, not a crash', async () => {
      const response = await request('/_actions/saveClient', { form: { is_active: 'on' }, cookie });
      assert.equal(response.status, 400);
      const body = JSON.parse(await response.text()) as { type: string; fields?: Record<string, string[]> };
      assert.equal(body.type, 'AstroActionInputError');
      assert.ok(body.fields?.name?.length, 'the name field is reported');
    });

    await step('a time entry snapshots the project rate and shows up in the CSV export', async () => {
      const entry = await action('createEntry', {
        user_id: String(userId),
        project_id: String(projectId),
        task_id: String(taskId),
        spent_date: '2026-09-10',
        hours: '1:30',
        notes: 'Synthetic e2e entry, "quoted", with a comma',
      }, cookie);
      entryId = Number(entry.id);
      assert.ok(entryId > 0);
      assert.equal(entry.running, false);

      const response = await request('/export/time-entries', { cookie });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
      assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="time-entries-\d{4}-\d{2}-\d{2}\.csv"/);
      // text() runs a UTF-8 decode, which swallows the BOM; the bytes on the wire keep it.
      const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
      assert.ok(text.startsWith('\uFEFF'), 'UTF-8 BOM for Excel');
      const csv = parseCsv(text);
      assert.equal(csv.rows.length, 1);
      const row = csv.rows[0]!;
      const col = (name: string) => row[csv.headers.indexOf(name)];
      assert.equal(col('Date'), '2026-09-10');
      assert.equal(col('Email'), ADMIN.email);
      assert.equal(col('Client'), 'Acme Synthetic');
      assert.equal(col('Project code'), 'WEB');
      assert.equal(col('Task'), 'Development');
      assert.equal(col('Notes'), 'Synthetic e2e entry, "quoted", with a comma');
      assert.equal(col('Billable'), 'yes');
      assert.equal(col('Locked'), 'no');
      assert.equal(col('Billable rate'), '1250', 'the rate snapshot equals the project rate');
    });

    // ── 4. API tokens ────────────────────────────────────────────────────
    await step('the JSON API refuses anonymous and bogus callers with 401', async () => {
      const anonymous = await request('/api/v1/time-entries');
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
      const body = JSON.parse(await anonymous.text()) as { error: { code: string } };
      assert.equal(body.error.code, 'unauthorized');

      const bogus = await request('/api/v1/time-entries', { bearer: 'tt_not-a-real-token' });
      assert.equal(bogus.status, 401);
    });

    await step('a personal access token reads the entry with rate-limit headers', async () => {
      const created = await action('createApiToken', { name: 'e2e', expires_in_days: '30' }, cookie);
      token = String(created.token);
      assert.ok(token.startsWith('tt_'), 'tokens are prefixed');
      assert.equal(created.prefix, token.slice(0, 11));
      assert.equal(created.name, 'e2e');

      const response = await request('/api/v1/time-entries', { bearer: token });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(response.headers.get('ratelimit-limit'), '240');
      assert.ok(response.headers.get('ratelimit-remaining'), 'RateLimit-Remaining is set');
      assert.ok(response.headers.get('ratelimit-reset'), 'RateLimit-Reset is set');
      assert.equal(response.headers.get('cache-control'), 'no-store');

      const body = JSON.parse(await response.text()) as {
        data: Record<string, unknown>[];
        pagination: { total: number; next: string | null };
      };
      assert.equal(body.pagination.total, 1);
      assert.equal(body.pagination.next, null);
      const found = body.data.find((e) => e.id === entryId);
      assert.ok(found, 'the entry is in the API listing');
      assert.equal(found.user_id, userId);
      assert.equal(found.project_id, projectId);
      assert.equal(found.task_id, taskId);
      assert.equal(found.client_id, clientId);
      assert.equal(found.spent_date, '2026-09-10');
      assert.equal(found.duration_seconds, 5400);
      assert.equal(found.billable, true);
      // 1250 per hour stored as minor units — the stored snapshot, not a live lookup.
      assert.equal(found.billable_rate, 125_000);

      // The record endpoint agrees with the listing.
      const one = await request(`/api/v1/time-entries/${entryId}`, { bearer: token });
      assert.equal(one.status, 200);
      const missing = await request('/api/v1/time-entries/999999', { bearer: token });
      assert.equal(missing.status, 404);
    });

    await step('the same token downloads CSV exports; a bogus one cannot', async () => {
      const response = await request('/export/time-entries', { bearer: token });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
      assert.equal(response.headers.get('ratelimit-limit'), '240');
      const csv = parseCsv(await response.text());
      assert.equal(csv.rows.length, 1);
      assert.equal(csv.rows[0]![csv.headers.indexOf('Project code')], 'WEB');

      const bogus = await request('/export/time-entries', { bearer: 'tt_not-a-real-token' });
      assert.equal(bogus.status, 401);
      const revokedLater = await request('/export/clients', { bearer: token });
      assert.equal(revokedLater.status, 200, 'admin exports are open to an admin token');

      // Without any credential the export is a page redirect, never data.
      const anonymous = await request('/export/time-entries');
      assert.equal(anonymous.status, 302);
    });

    // ── 5. CSRF and the database snapshot ────────────────────────────────
    await step('a cross-origin action post is refused even with a valid session', async () => {
      const before = parseCsv(await (await request('/export/clients', { cookie })).text()).rows.length;
      const response = await request('/_actions/saveClient', {
        form: { name: 'Injected', is_active: 'on' },
        cookie,
        origin: 'https://evil.example',
      });
      assert.equal(response.status, 403);
      const logout = await request('/api/logout', { method: 'POST', cookie, origin: 'https://evil.example' });
      assert.equal(logout.status, 403);
      assert.equal((await request('/', { cookie })).status, 302, 'the session survived the forged logout');
      const after = parseCsv(await (await request('/export/clients', { cookie })).text()).rows.length;
      assert.equal(after, before, 'nothing was written');

      // Without a session an action is a 401, not a login-page redirect.
      const anonymous = await request('/_actions/saveClient', { form: { name: 'x', is_active: 'on' } });
      assert.equal(anonymous.status, 401);
    });

    await step('the database snapshot needs an admin session and is a real SQLite file', async () => {
      const anonymous = await request('/api/database');
      assert.equal(anonymous.status, 302);
      assert.equal(anonymous.headers.get('location'), '/login?next=%2Fapi%2Fdatabase');

      // Read-only API tokens do not get the whole database.
      const viaToken = await request('/api/database', { bearer: token });
      assert.notEqual(viaToken.status, 200);

      const response = await request('/api/database', { cookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/vnd.sqlite3');
      assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="synthetic-studio-\d{4}-\d{2}-\d{2}\.db"/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.ok(bytes.length > 0);
      assert.equal(bytes.length % 512, 0, 'SQLite files are a whole number of pages');
      const magic = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
      assert.equal(magic, 'SQLite format 3\0');
      // The snapshot must never carry a Harvest credential.
      const text = Buffer.from(bytes).toString('latin1');
      assert.ok(!text.includes('harvest_access_token'), 'no Harvest token setting in the snapshot');
      assert.ok(text.includes('Acme Synthetic'), 'the data itself is in the snapshot');

      // A session id is the cookie value verbatim, so a snapshot carrying the sessions table
      // signs its reader in as whoever was logged in when it was taken. Same for API tokens.
      const sessionId = cookie.slice('tt_session='.length);
      assert.ok(sessionId.length > 20, 'a session id to look for');
      assert.ok(!text.includes(sessionId), 'no live session travels in the snapshot');
      // Stored as a SHA-256, so that is what to look for.
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
      assert.ok(!text.includes(tokenHash), 'no API token travels in the snapshot');
    });

    await step('every response carries the hardening headers', async () => {
      for (const path of ['/login', '/reports']) {
        const response = await request(path, { cookie });
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
        assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
        assert.equal(response.headers.get('referrer-policy'), 'same-origin', path);
        assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
      }
    });

    await step('a read-only token cannot write, and a proxy Basic header does not lock exports out', async () => {
      // Read-only by construction, not merely because no write route exists under the prefix.
      const write = await request('/api/v1/time_entries', { method: 'POST', bearer: token });
      assert.equal(write.status, 405);
      const exportWrite = await request('/export/time-entries', { method: 'POST', bearer: token });
      assert.equal(exportWrite.status, 405);

      // A reverse proxy adding HTTP Basic must not stop a signed-in person downloading.
      const viaBasic = await fetch(`${base}/export/time-entries`, {
        headers: { cookie, authorization: 'Basic ' + Buffer.from('proxy:secret').toString('base64') },
        redirect: 'manual',
      });
      assert.equal(viaBasic.status, 200, 'the session still works behind proxy Basic auth');
    });

    await step('a report sort parameter cannot reach through the prototype chain', async () => {
      for (const value of ['constructor', 'toString', '__proto__', 'valueOf']) {
        const reports = await request(`/reports?sort=${value}`, { cookie });
        assert.equal(reports.status, 200, `sort=${value}`);
        const log = await request(`/log?group=${value}`, { cookie });
        assert.equal(log.status, 200, `group=${value}`);
      }
    });

    await step('an oversized upload is refused on its declared length', async () => {
      // A real body just over the limit, so Content-Length is honest and the route has to
      // refuse it from the header rather than after buffering the whole thing.
      const oversized = new File(['x'.repeat(33 * 1024 * 1024)], 'huge.csv', { type: 'text/csv' });
      const body = new FormData();
      body.set('csv', oversized);
      const response = await fetch(`${base}/api/import/csv`, {
        method: 'POST',
        headers: { cookie, origin: base },
        body,
        redirect: 'manual',
      });
      assert.equal(response.status, 303);
      assert.match(decodeURIComponent(response.headers.get('location') ?? ''), /larger than 32 MB/);
    });

    await step('adding time from the day view returns to the day view, not to raw data', async () => {
      const response = await request('/_actions/createEntry', {
        form: {
          user_id: String(userId), project_id: String(projectId), task_id: String(taskId),
          spent_date: '2026-09-11', hours: '0:45',
        },
        cookie,
        from: `/day/2026-09-11/${userId}?edit=999`,
      });
      assert.equal(response.status, 303);
      // Back to the page, with the dialog it was opened from closed.
      assert.equal(response.headers.get('location'), `/day/2026-09-11/${userId}`);

      const day = await request(`/day/2026-09-11/${userId}`, { cookie });
      assert.equal(day.status, 200);
      assert.match(await day.text(), /0:45/);
    });

    await step('saving the week grid returns to the week, and the hours are there', async () => {
      const response = await request('/_actions/saveWeek', {
        form: {
          user_id: String(userId),
          week: '2026-09-07',
          [`c_2026-09-08_${projectId}_${taskId}`]: '2:15',
        },
        cookie,
        from: `/week/2026-09-07/${userId}?p=${projectId}&t=${taskId}`,
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), `/week/2026-09-07/${userId}`);

      const week = await request(`/week/2026-09-07/${userId}`, { cookie });
      assert.equal(week.status, 200);
      assert.match(await week.text(), /2:15/);
    });

    await step('a form post an action rejects comes back to the page with the reason shown', async () => {
      const response = await request('/_actions/createEntry', {
        form: {
          user_id: String(userId), project_id: String(projectId), task_id: String(taskId),
          spent_date: 'not a date', hours: '1',
        },
        cookie,
        from: `/day/2026-09-11/${userId}`,
      });
      assert.equal(response.status, 303);
      const location = response.headers.get('location') ?? '';
      assert.match(location, /^\/day\/2026-09-11\/\d+\?action_error=/);

      const page = await request(location, { cookie });
      assert.match(await page.text(), /role="alert">spent date: Expected YYYY-MM-DD/);
    });

    await step('the redirect never leaves the site, whatever the Referer says', async () => {
      const response = await fetch(`${base}/_actions/stopTimer`, {
        method: 'POST',
        headers: {
          cookie, origin: base, accept: 'text/html',
          referer: 'https://evil.example/phish?x=1',
        },
        body: new URLSearchParams({ id: '999999' }),
        redirect: 'manual',
      });
      assert.equal(response.status, 303);
      assert.match(response.headers.get('location') ?? '', /^\/phish\?x=1&action_error=/);
    });

    await step('reports show a chosen from–to range, with the fields to change it', async () => {
      const response = await request('/reports?kind=custom&from=2026-09-01&till=2026-09-30', { cookie });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /01 – 30 Sep 2026/);
      assert.match(html, /type="date" name="from" value="2026-09-01"/);
      assert.match(html, /type="date" name="till" value="2026-09-30"/);
    });
  } finally {
    if (child && child.exitCode === null) {
      const gone = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([gone, sleep(5_000).then(() => child!.kill('SIGKILL'))]);
    }
    if (failed && stderr.length) {
      console.error(`--- server stderr (${base}) ---\n${stderr.join('')}\n--- end server stderr ---`);
    }
    rmSync(instanceDir, { recursive: true, force: true });
  }
});
