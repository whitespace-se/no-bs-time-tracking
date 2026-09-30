// Importing a Harvest export's two CSV files from the Import page: one labelled field for each,
// both filled and submitted together, as a person would.
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

  instanceDir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-pw-import-'));
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


const timeReport = {
  name: 'harvest_time_report.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(
    'Date,Client,Project,Task,Hours,Hours Rounded,Billable?,Invoiced?,First Name,Last Name,Billable Rate,Cost Rate\n' +
    '2026-08-03,Example Client,Migration,Consulting,1.5,1.5,Yes,Yes,Test,Admin,1000,400\n' +
    '2026-08-04,Example Client,Fastpris,Consulting,2,2,Yes,No,Test,Admin,1000,400\n',
  ),
};

const invoiceReport = {
  name: 'harvest_invoice_report.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(
    'Status,Issue Date,ID,Client,Invoice Amount,Paid Amount,Balance\n' +
    'Paid,2026-08-31,2026-001,Example Client,1500.00,1500.00,0.00\n',
  ),
};

test('the Import page takes the time report and the invoice report in their own fields', async ({ page }) => {
  await page.goto(`${base}/import`);
  await page.getByLabel(/Time report/).setInputFiles(timeReport);
  await page.getByLabel(/Invoice report/).setInputFiles(invoiceReport);
  await page.getByRole('button', { name: 'Import CSV' }).click();

  // The import runs in the background; the page follows it and says what it did.
  await page.waitForURL(`${base}/import`);
  await expect(page.getByRole('status')).toContainText('Imported 2 time entries', { timeout: 20_000 });
  await expect(page.getByRole('status')).toContainText('1 invoices');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.goto(`${base}/invoices`);
  await expect(page.locator('main')).toContainText('2026-001');

  // The report carries no lines, and the invoice page says why instead of showing it empty.
  await page.goto(`${base}/invoices/2026-001`);
  await expect(page.locator('main')).toContainText('Not in a CSV export');

  // Reports price billable time from the rates the export carried: 1.5 h at 1 000.
  await page.goto(`${base}/reports?kind=month&from=2026-08-01&till=2026-08-31&tab=clients&fixed=1`);
  const amount = page.locator('.stat').filter({ hasText: 'Billable amount' }).locator('.stat__big');
  await expect(amount).toContainText(/3[ ,.\u00a0\u202f]?500[.,]00/);
});

const billable = (page: import('@playwright/test').Page) =>
  page.locator('.stat').filter({ hasText: 'Billable amount' }).locator('.stat__big');
const AUGUST = '/reports?kind=month&from=2026-08-01&till=2026-08-31&tab=clients';

test('the fixed-fee toggle says why it does nothing until projects are marked, then works', async ({ page }) => {
  // Depends on the import above. A CSV export does not say which projects are fixed fee.
  await page.goto(`${base}${AUGUST}`);
  await expect(billable(page)).toContainText(/3[ ,.\u00a0\u202f]?500[.,]00/);
  await expect(page.getByRole('note')).toContainText('No project is marked fixed fee');

  // On an instance from CSV, the Import page offers Harvest's settings, never a sync that
  // would add every entry again.
  await page.goto(`${base}/import`);
  await expect(page.getByRole('button', { name: 'Get project settings from Harvest' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Full re-import' })).toHaveCount(0);

  // Mark one project fixed fee by hand, on its own page.
  await page.goto(`${base}/projects`);
  await page.getByRole('link', { name: 'Fastpris' }).first().click();
  await page.getByText('Edit project').click();
  await page.locator('input[name="is_fixed_fee"]').check();
  await page.getByRole('button', { name: 'Save project' }).click();
  await page.waitForURL(/\/projects\/\d+$/);

  // Now the two links differ: 1.5 h at 1 000 without the fixed-fee project, 3.5 h with it.
  await page.goto(`${base}${AUGUST}`);
  await expect(billable(page)).toContainText(/1[ ,.\u00a0\u202f]?500[.,]00/);
  await expect(page.getByRole('note')).toHaveCount(0);
  await page.goto(`${base}${AUGUST}&fixed=1`);
  await expect(billable(page)).toContainText(/3[ ,.\u00a0\u202f]?500[.,]00/);
});

test('a large CSV shows its upload, then the import counting through its rows', async ({ page }) => {
  // Enough rows that the import takes a few seconds, so its progress can be watched.
  const rows = 60_000;
  let csv = 'Date,Client,Project,Task,Hours,Hours Rounded,Billable?,Invoiced?,First Name,Last Name,Billable Rate\n';
  for (let i = 0; i < rows; i += 1) {
    csv += `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')},Big Client,Big Project,Consulting,1,1,Yes,No,Test,Admin,1000\n`;
  }
  await page.goto(`${base}/import`);
  await page.getByLabel(/Time report/).setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Import CSV' }).click();

  await page.waitForURL(`${base}/import`);
  const panel = page.locator('#progress');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Importing CSV files');
  await expect(panel.locator('[data-total="time_report"]')).toContainText('of 60,000');
  await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /\d+/);
  // Other forms are out of the way while it runs.
  await expect(page.getByRole('button', { name: 'Import CSV' })).toBeHidden();

  await expect(page.getByRole('status')).toContainText('Imported 60000 time entries', { timeout: 60_000 });
  await expect(panel).toHaveCount(0);
});
