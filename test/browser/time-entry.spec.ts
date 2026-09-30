// Adding time the way a person does: in the day view's dialog and in the week grid. Both post
// a plain form to an action; before the middleware sent such posts back to their page, the
// entry was saved but the browser was left showing the action's raw data. The HTTP tests
// imitate that post; only a browser shows where it lands and what the page then says.
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

let child: ChildProcess | null = null;
let instanceDir = '';
let base = '';
let cookie = '';

test.beforeAll(async () => {
  test.skip(!existsSync(ENTRY), `no build at ${ENTRY} — run \`npm run build\` first`);

  instanceDir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-pw-time-'));
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

  const res = await fetch(base + '/api/setup/fresh', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ ...ADMIN, confirm: ADMIN.password }),
    redirect: 'manual',
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('tt_session='));
  if (!set) throw new Error(`setup did not return a session cookie (status ${res.status})`);
  cookie = set.split(';')[0]!;

  // A client, project and task to log against, made the way a migration makes them. The one
  // imported row is outside the week under test, so it does not show in the cells checked.
  const csv = new FormData();
  csv.append('csv', new File([
    'Date,Client,Project,Task,Hours,First Name,Last Name,Billable?\n' +
    '2026-08-03,Example Client,Migration,Consulting,1,Test,Admin,Yes\n',
  ], 'harvest_time_report.csv', { type: 'text/csv' }));
  const imported = await fetch(base + '/api/import/csv', {
    method: 'POST', headers: { cookie, origin: base }, body: csv, redirect: 'manual',
  });
  if (imported.headers.get('location') !== '/import') {
    throw new Error(`import failed: ${imported.headers.get('location')}`);
  }
  // The import runs in the background; wait for it as the Import page would.
  for (;;) {
    const { sync } = await (await fetch(base + '/api/import/status', { headers: { cookie } })).json();
    if (sync?.finishedAt) {
      if (sync.error) throw new Error(`import failed: ${sync.error}`);
      break;
    }
    await sleep(100);
  }
});

test.afterAll(async () => {
  if (instanceDir) rmSync(instanceDir, { recursive: true, force: true });
  if (child && child.exitCode === null) {
    const gone = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([gone, sleep(5_000).then(() => child!.kill('SIGKILL'))]);
  }
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'tt_session', value: cookie.slice('tt_session='.length), url: base }]);
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/week\/\d{4}-\d{2}-\d{2}\/\d+$/);
});


const DAY = '2026-09-15';
const WEEK = '2026-09-14';

test('an entry added in the day view lands back on the day, with its hours', async ({ page }) => {
  await page.goto(`${base}/day/${DAY}/1`);
  await page.getByRole('link', { name: '+ Add' }).click();
  const dialog = page.locator('#new-entry');
  await expect(dialog).toBeVisible();
  await dialog.locator('select[name="project_id"]').selectOption({ label: 'Migration — Example Client' });
  await dialog.locator('select[name="task_id"]').selectOption({ label: 'Consulting' });
  await dialog.locator('input[name="hours"]').fill('1:15');
  await dialog.getByRole('button', { name: 'Save entry' }).click();

  await page.waitForURL(`${base}/day/${DAY}/1`);
  await expect(page.locator('body')).not.toContainText('"running"');
  await expect(page.locator('main')).toContainText('1:15');
});

test('hours typed into the week grid are saved and shown on the week', async ({ page }) => {
  // The day-view entry above gives the week a Migration row to type into.
  await page.goto(`${base}/week/${WEEK}/1`);
  const cell = page.locator('input.cell-input[name^="c_2026-09-17_"]').first();
  await cell.fill('2:30');
  await page.locator('#save').click();

  await page.waitForURL(`${base}/week/${WEEK}/1`);
  await expect(page.locator('input.cell-input[name^="c_2026-09-17_"]').first()).toHaveValue('2:30');
  await expect(page.locator('input.cell-input[name^="c_2026-09-15_"]').first()).toHaveValue('1:15');
});

test('a refused save comes back to the page with the reason', async ({ page }) => {
  await page.goto(`${base}/week/${WEEK}/1`);
  await page.locator('input.cell-input[name^="c_2026-09-18_"]').first().fill('not hours');
  await page.locator('#save').click();

  await page.waitForURL(new RegExp(`/week/${WEEK}/1\\?action_error=`));
  await expect(page.getByRole('alert')).toBeVisible();
});
