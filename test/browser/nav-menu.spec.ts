// The header's "Other" and "Admin" drop-downs are native <details>/<summary> menus: clicking
// the summary must reveal the panel. The HTTP tests can never catch a regression here — they
// read the returned HTML, in which an open and a closed <details> look identical — so this is a
// real browser clicking the real control.
//
// Runs against the built server, spawned as test/e2e-http.test.ts does. The account is created
// over HTTP so the browser is spent only on the interaction under test.
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

  instanceDir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-pw-'));
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

  // Create the admin + workspace over HTTP; keep the session cookie for the browser.
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
  const { name, value } = { name: cookie.split('=')[0]!, value: cookie.split('=').slice(1).join('=') };
  await context.addCookies([{ name, value, url: base }]);
  // A pointer at this week's grid; follow it to the real app shell with the header nav.
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/week\/\d{4}-\d{2}-\d{2}\/\d+$/);
});

for (const menu of [
  { label: 'Admin', item: 'Import', href: '/import' },
  { label: 'Other', item: 'Expenses', href: '/expenses' },
]) {
  test(`the ${menu.label} drop-down opens and its items are usable`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    const nav = page.getByRole('navigation');
    const summary = nav.getByText(menu.label, { exact: true });
    const item = nav.getByRole('link', { name: menu.item });

    await expect(summary).toBeVisible();
    await expect(item).toBeHidden(); // closed to start

    await summary.click();

    // Not just "visible": the panel must actually be painted where it sits, on top and
    // reachable. `toBeVisible` ignores ancestor-overflow clipping and `locator.click` quietly
    // scrolls a clipped panel into view first — both would pass on the bug. Hit-test instead:
    // the element at the item's own centre must be the item, exactly as a real pointer sees it.
    const onTop = await item.evaluate((link) => {
      const r = link.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === link || link.contains(hit));
    });
    expect(onTop, `${menu.item} is open but clipped/covered — not reachable by a pointer`).toBe(true);

    // And it genuinely works as a link.
    await item.click();
    await page.waitForURL(base + menu.href);

    expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  });
}

// A second <details> menu, on /log, whose panel likewise must open and be reachable on click.
test('the Filters panel on /log opens on click', async ({ page }) => {
  await page.goto(base + '/log', { waitUntil: 'domcontentloaded' });
  const summary = page.getByText('Filters', { exact: true });
  const fromField = page.locator('#from');

  await expect(summary).toBeVisible();
  await expect(fromField).toBeHidden();

  await summary.click();

  const open = await summary.evaluate((el) => el.closest('details')?.open ?? null);
  console.log(`[diagnosis] /log Filters: details.open after click = ${open}`);
  await expect(fromField).toBeVisible();
});
