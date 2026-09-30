// The account page: reachable from the header name by any signed-in user, and able to change
// your own name (which the header reflects) and password. A real browser, because this is
// exactly the kind of wiring — a header link, two form posts — the HTTP tests don't exercise.
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

  instanceDir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-pw-acct-'));
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

test('the header name links to the account page', async ({ page }) => {
  const account = page.locator('header a[href="/account"]');
  await expect(account).toContainText('Test Admin');
  await account.click();
  await page.waitForURL(base + '/account');
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
});

test('editing your name saves and shows in the header', async ({ page }) => {
  await page.goto(base + '/account', { waitUntil: 'domcontentloaded' });
  await page.fill('#first', 'Ada');
  await page.fill('#last', 'Lovelace');
  await page.getByRole('button', { name: 'Save details' }).click();

  await expect(page.getByRole('status')).toHaveText('Saved.');
  // The header derives the name from the same row. It is resolved before the action writes, so
  // it reflects the new name on the next request rather than in this response — reload to see it.
  await page.reload();
  await expect(page.locator('header a[href="/account"]')).toContainText('Ada Lovelace');
  await expect(page.locator('#first')).toHaveValue('Ada'); // and the change persisted
});

test('changing your password succeeds with the right current password', async ({ page }) => {
  await page.goto(base + '/account', { waitUntil: 'domcontentloaded' });
  await page.fill('#current', ADMIN.password);
  await page.fill('#next', 'an entirely different passphrase');
  await page.fill('#confirm', 'an entirely different passphrase');
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page.getByText('Password changed.')).toBeVisible();
});
