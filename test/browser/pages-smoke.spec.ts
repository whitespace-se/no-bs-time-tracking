// Smoke test for every rendered page. Logs in, seeds one client/project/task so the detail
// pages have real records, then loads each route in a real browser and asserts it returns 200
// with no console or page errors. This is the coverage the HTTP tests can't give: a broken
// template, a bad query, a clipped menu or a throwing inline script shows up here and nowhere
// else. It does not assert on page content — only that every page renders cleanly.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(ROOT, 'dist', 'server', 'entry.mjs');

const ADMIN = {
  company_name: 'Synthetic Studio',
  first_name: 'Test',
  last_name: 'Admin',
  email: 'admin@synthetic.test',
  password: 'correct horse battery staple',
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decode Astro actions' devalue answer far enough to read the created row's id. */
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
      Object.entries(value as Record<string, number>).map(([k, i]) => [k, hydrate(i)]),
    );
  };
  return hydrate(0);
}

let child: ChildProcess | null = null;
let instanceDir = '';
let base = '';
let cookie = '';
const seeded = { clientId: 0, projectId: 0, taskId: 0 };

test.beforeAll(async () => {
  test.skip(!existsSync(ENTRY), `no build at ${ENTRY} — run \`npm run build\` first`);

  instanceDir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-pw-smoke-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, INSTANCE_DIR: instanceDir, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      await fetch(base + '/', { redirect: 'manual' });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('server did not start within 20s');
      await sleep(200);
    }
  }

  const setup = await fetch(base + '/api/setup/fresh', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ ...ADMIN, confirm: ADMIN.password }),
    redirect: 'manual',
  });
  const set = setup.headers.getSetCookie().find((c) => c.startsWith('tt_session='));
  if (!set) throw new Error(`setup did not return a session cookie (status ${setup.status})`);
  cookie = set.split(';')[0]!;

  // Seed one of each so the detail/edit pages have a real record to render.
  const call = async (name: string, fields: Record<string, string>): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}/_actions/${name}`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${name} failed (${res.status}): ${text}`);
    return undevalue(text) as Record<string, unknown>;
  };
  seeded.clientId = Number((await call('saveClient', { name: 'Smoke Client', currency: 'EUR', is_active: 'on' })).id);
  seeded.taskId = Number((await call('saveTask', { name: 'Smoke Task', billable_by_default: 'on', is_active: 'on' })).id);
  seeded.projectId = Number((await call('saveProject', {
    client_id: String(seeded.clientId), name: 'Smoke Project', code: 'SMK',
    is_billable: 'on', bill_by: 'Project', budget_by: 'none', is_active: 'on',
  })).id);
});

test.afterAll(async () => {
  if (instanceDir) rmSync(instanceDir, { recursive: true, force: true });
  if (child && child.exitCode === null) {
    const gone = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([gone, sleep(5_000).then(() => child!.kill('SIGKILL'))]);
  }
});

test('every page renders with 200 and no console errors', async ({ page }) => {
  await page.context().addCookies([{ name: 'tt_session', value: cookie.slice('tt_session='.length), url: base }]);

  const today = new Date().toISOString().slice(0, 10);
  const routes = [
    '/', // redirects to this week's grid
    '/reports', '/log', '/account',
    '/projects', '/projects/new', `/projects/${seeded.projectId}`,
    '/clients', `/clients/${seeded.clientId}`,
    '/tasks', `/tasks/${seeded.taskId}`,
    '/team', '/team/new', '/team/1',
    '/invoices', '/estimates', '/expenses',
    '/tokens', '/import', '/docs', '/export',
    `/day/${today}/1`,
  ];

  const failures: string[] = [];
  for (const route of routes) {
    const errors: string[] = [];
    const onConsole = (m: import('@playwright/test').ConsoleMessage) => m.type() === 'error' && errors.push(m.text());
    const onError = (e: Error) => errors.push(String(e));
    page.on('console', onConsole);
    page.on('pageerror', onError);

    const response = await page.goto(base + route, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status !== 200) failures.push(`${route} → HTTP ${status}`);
    if (errors.length) failures.push(`${route} → console: ${errors.join(' | ')}`);

    page.off('console', onConsole);
    page.off('pageerror', onError);
  }

  expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
});
