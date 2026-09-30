/**
 * The Harvest import, run from the app instead of from a terminal.
 *
 * Pulling a large account's time entries takes minutes, far longer than a request may live.
 * So a sync is a background job: the page starts one, then polls a status endpoint. State
 * lives in a module singleton because one process serves one instance — there is exactly one
 * account to sync and never a second one running concurrently, so a queue would be machinery
 * without a purpose.
 *
 * The singleton is memory, and memory dies with the process. Every run is therefore also a
 * row in `import_runs`, and a row still marked `running` at boot is a run whose process went
 * away — `reapStaleRuns` closes those out rather than leaving a job that appears live forever.
 */

import type { Db } from '../db/index.ts';
import { nowIso, row } from '../db/index.ts';
import { HarvestClient, HarvestError, harvestErrorMessage } from './client.ts';
import { log } from '../instance-log.ts';
import {
  importSnapshot,
  recordRun,
  reportOk,
  type HarvestSnapshot,
  type ImportReport,
} from './import.ts';
import { fetchPayments } from './invoices.ts';
import {
  downloadReceipts,
  fetchEstimateMessages,
  fetchInvoiceMessages,
  fetchTeammates,
  fetchUserRates,
} from './extras.ts';
import { resolveInstance } from '../instance.ts';
import { join } from 'node:path';
import type {
  HarvestClientRecord,
  HarvestCompany,
  HarvestContact,
  HarvestEstimate,
  HarvestEstimateItemCategory,
  HarvestExpense,
  HarvestExpenseCategory,
  HarvestInvoice,
  HarvestInvoiceItemCategory,
  HarvestProject,
  HarvestRole,
  HarvestTask,
  HarvestTaskAssignment,
  HarvestTimeEntry,
  HarvestUser,
  HarvestUserAssignment,
} from './types.ts';

export const PHASES = [
  'connecting',
  // A CSV import: parsing the files, writing each, then working out project billing.
  'reading',
  'time_report',
  'invoice_report',
  'billing',
  'users',
  'clients',
  'tasks',
  'projects',
  'user_assignments',
  'task_assignments',
  'time_entries',
  'invoices',
  'invoice_payments',
  'invoice_messages',
  'contacts',
  'roles',
  'expenses',
  'receipts',
  'estimates',
  'categories',
  'user_rates',
  'teammates',
  'writing',
  'done',
  'failed',
] as const;
export type Phase = (typeof PHASES)[number];

/** What runs: a Harvest API pull, CSV files, or Harvest's settings onto a CSV import. */
export type JobKind = 'harvest-api' | 'csv' | 'harvest-settings';

/** What the status endpoint hands the page. Never contains the token. */
export interface SyncProgress {
  runId: number;
  kind: JobKind;
  mode: 'full' | 'incremental';
  phase: Phase;
  /** Records pulled so far, per entity. Live — time entries tick up as pages arrive. */
  counts: Record<string, number>;
  /** How many there are in all, where that is known up front — a CSV's rows. */
  totals: Record<string, number>;
  /** One line saying what was done, once it is done. */
  summary: string | null;
  requests: number;
  startedAt: string;
  finishedAt: string | null;
  company: string | null;
  error: string | null;
  report: ImportReport | null;
}

let current: SyncProgress | null = null;

export function currentSync(): SyncProgress | null {
  return current;
}

export function isSyncRunning(): boolean {
  return current !== null && current.finishedAt === null;
}

export interface SyncCredentials {
  accountId: string;
  accessToken: string;
  contact: string;
}

/**
 * Check credentials before starting anything.
 *
 * `/company` is the cheapest authenticated call Harvest has, and its response is what seeds
 * the instance settings, so a successful check and a useful answer are the same request.
 */
export async function verifyCredentials(credentials: SyncCredentials): Promise<HarvestCompany> {
  const client = new HarvestClient(credentials);
  return client.get<HarvestCompany>('/company');
}

/** Rows left `running` by a process that died. Called once on boot. */
export function reapStaleRuns(db: Db): void {
  db.prepare(
    `UPDATE import_runs SET status = 'failed', finished_at = ?,
                            error = 'Interrupted — the server stopped while this run was in flight.'
      WHERE status = 'running'`,
  ).run(nowIso());
}

/**
 * Where an incremental sync should start reading.
 *
 * The earlier of the last good run's cursor and when that run started — both recorded, neither
 * invented. For a live pull the run starts moments before its cursor is stamped, so the window
 * reaches back over that gap. For a dump imported the next day the cursor is the older of the
 * two, and using it is what stops the day in between being skipped.
 *
 * The overlap this produces is whatever those two timestamps actually were, rather than a
 * made-up margin: re-reading records costs nothing, since every write is an upsert keyed on
 * the Harvest id, while a record falling between two adjacent windows is gone for good.
 */
export function lastSuccessfulCursor(db: Db): string | null {
  const found = row<{ cursor_updated_since: string | null; started_at: string }>(
    db
      .prepare(
        `SELECT cursor_updated_since, started_at FROM import_runs
          WHERE status = 'ok' ORDER BY id DESC LIMIT 1`,
      )
      .get(),
  );
  if (!found) return null;
  if (!found.cursor_updated_since) return found.started_at;
  return found.cursor_updated_since < found.started_at
    ? found.cursor_updated_since
    : found.started_at;
}

/**
 * Run some other import in the background, reporting through the same progress the pages
 * already poll for a sync: a CSV import, or Harvest's settings onto one. `work` updates the
 * progress it is handed and resolves with the one-line summary. Its own rows in import_runs
 * are its business; a failure is recorded here, under `source`.
 */
export function startJob(
  db: Db,
  kind: Exclude<JobKind, 'harvest-api'>,
  source: string,
  work: (progress: SyncProgress) => Promise<string>,
): SyncProgress {
  if (isSyncRunning()) throw new Error('An import is already running.');
  const progress: SyncProgress = {
    runId: 0,
    kind,
    mode: 'full',
    phase: kind === 'csv' ? 'reading' : 'connecting',
    counts: {},
    totals: {},
    summary: null,
    requests: 0,
    startedAt: nowIso(),
    finishedAt: null,
    company: null,
    error: null,
    report: null,
  };
  current = progress;
  void (async () => {
    try {
      progress.summary = await work(progress);
      progress.phase = 'done';
    } catch (error) {
      const stoppedIn = progress.phase;
      progress.error = error instanceof HarvestError ? harvestErrorMessage(error)
        : error instanceof Error ? error.message : String(error);
      progress.phase = 'failed';
      db.prepare(
        `INSERT INTO import_runs (source, started_at, finished_at, status, error, stats_json)
         VALUES (?, ?, ?, 'failed', ?, ?)`,
      ).run(source, progress.startedAt, nowIso(), progress.error,
        JSON.stringify({ failure: { phase: stoppedIn, pulled: progress.counts, requests: progress.requests } }));
      log.error(`[import] ${kind} failed in ${stoppedIn}: ${progress.error}`, {
        import: { kind, outcome: 'failed', phase: stoppedIn, pulled: progress.counts },
      });
    } finally {
      progress.finishedAt = nowIso();
    }
  })();
  return progress;
}

/**
 * True while a CSV import holds its transaction open. It yields to the event loop between
 * batches so progress can be read, and anything another request wrote in that time would
 * land inside the import's transaction and be rolled back with it if the import failed.
 * The middleware turns writes away for those seconds.
 */
export function isImportWriting(): boolean {
  return current !== null && current.finishedAt === null && current.kind === 'csv'
    && (current.phase === 'time_report' || current.phase === 'invoice_report' || current.phase === 'billing');
}

export interface StartOptions {
  mode: 'full' | 'incremental';
  /** Overrides the stored cursor. Only used for incremental runs. */
  since?: string | null;
}

/**
 * Kick off a sync and return immediately with its starting state.
 *
 * The promise this spawns is deliberately not awaited — the caller is an HTTP handler that
 * has to answer now. Failures land in `current.error` and in the `import_runs` row, which is
 * what the page reads; nothing is lost by not awaiting, and an unhandled rejection is
 * impossible because the whole body is wrapped.
 */
export function startSync(db: Db, credentials: SyncCredentials, options: StartOptions): SyncProgress {
  if (isSyncRunning()) throw new Error('A sync is already running.');

  const startedAt = nowIso();
  const result = db
    .prepare('INSERT INTO import_runs (source, started_at, status) VALUES (?,?,?)')
    .run(options.mode === 'full' ? 'harvest-api' : 'harvest-api-incremental', startedAt, 'running');

  const progress: SyncProgress = {
    runId: Number(result.lastInsertRowid),
    kind: 'harvest-api',
    mode: options.mode,
    phase: 'connecting',
    counts: {},
    totals: {},
    summary: null,
    requests: 0,
    startedAt,
    finishedAt: null,
    company: null,
    error: null,
    report: null,
  };
  current = progress;

  void run(db, credentials, options, progress);
  return progress;
}

async function run(
  db: Db,
  credentials: SyncCredentials,
  options: StartOptions,
  progress: SyncProgress,
): Promise<void> {
  // The cursor is stamped *before* the pull, not after. Anything changed while the pull is in
  // flight then falls inside the next run's window. Stamping afterwards would skip it.
  const cursor = nowIso();

  try {
    const client = new HarvestClient({
      ...credentials,
      onRequest: () => {
        progress.requests += 1;
      },
    });

    const company = await client.get<HarvestCompany>('/company');
    progress.company = (company as { name?: string }).name ?? null;

    // An incremental run narrows every entity, not just time entries: a project renamed
    // yesterday matters as much as an entry logged yesterday.
    const previous = options.since ?? lastSuccessfulCursor(db);
    const since = options.mode === 'incremental' && previous ? previous : undefined;

    const collect = async <T>(path: string, resource: string, phase: Phase): Promise<T[]> => {
      progress.phase = phase;
      progress.counts[resource] = 0;
      const out: T[] = [];
      for await (const record of client.paginate<T>(path, resource, { updated_since: since })) {
        out.push(record);
        progress.counts[resource] = out.length;
      }
      return out;
    };

    const snapshot: HarvestSnapshot = {
      company,
      users: await collect<HarvestUser>('/users', 'users', 'users'),
      clients: await collect<HarvestClientRecord>('/clients', 'clients', 'clients'),
      tasks: await collect<HarvestTask>('/tasks', 'tasks', 'tasks'),
      projects: await collect<HarvestProject>('/projects', 'projects', 'projects'),
      user_assignments: await collect<HarvestUserAssignment>(
        '/user_assignments',
        'user_assignments',
        'user_assignments',
      ),
      task_assignments: await collect<HarvestTaskAssignment>(
        '/task_assignments',
        'task_assignments',
        'task_assignments',
      ),
      time_entries: await collect<HarvestTimeEntry>('/time_entries', 'time_entries', 'time_entries'),
      invoices: await collect<HarvestInvoice>('/invoices', 'invoices', 'invoices'),
    };

    // One request per invoice that has a payment on it, so this is the slow phase of a full
    // import — about as long again as everything above. The count that climbs here is
    // payments found, not invoices checked.
    progress.phase = 'invoice_payments';
    progress.counts.invoice_payments = 0;
    snapshot.invoice_payments = await fetchPayments(client, snapshot.invoices ?? [], (found) => {
      progress.counts.invoice_payments! += found.length;
    });

    // Send history, one request per invoice that was sent. The second slow phase.
    progress.phase = 'invoice_messages';
    progress.counts.invoice_messages = 0;
    snapshot.invoice_messages = await fetchInvoiceMessages(client, snapshot.invoices ?? [], (found) => {
      progress.counts.invoice_messages! += found.length;
    });

    snapshot.contacts = await collect<HarvestContact>('/contacts', 'contacts', 'contacts');
    // Roles have no updated_since, and the list is small, so it is simply read every time.
    progress.phase = 'roles';
    snapshot.roles = await client.list<HarvestRole>('/roles', 'roles');
    progress.counts.roles = snapshot.roles.length;

    snapshot.expense_categories = await collect<HarvestExpenseCategory>(
      '/expense_categories', 'expense_categories', 'expenses',
    );
    snapshot.expenses = await collect<HarvestExpense>('/expenses', 'expenses', 'expenses');
    progress.phase = 'receipts';
    progress.counts.receipts = 0;
    const receiptDir = join(resolveInstance().dir, 'receipts');
    await downloadReceipts(client, snapshot.expenses, receiptDir, () => {
      progress.counts.receipts! += 1;
    });

    snapshot.estimates = await collect<HarvestEstimate>('/estimates', 'estimates', 'estimates');
    snapshot.estimate_messages = await fetchEstimateMessages(client, snapshot.estimates);
    progress.counts.estimate_messages = snapshot.estimate_messages.length;

    progress.phase = 'categories';
    snapshot.invoice_item_categories = await client.list<HarvestInvoiceItemCategory>(
      '/invoice_item_categories', 'invoice_item_categories',
    );
    snapshot.estimate_item_categories = await client.list<HarvestEstimateItemCategory>(
      '/estimate_item_categories', 'estimate_item_categories',
    );
    progress.counts.categories =
      snapshot.invoice_item_categories.length + snapshot.estimate_item_categories.length;

    // Two requests a head, for the people in this snapshot — everyone on a full run, only
    // those who changed on an incremental one.
    progress.phase = 'user_rates';
    progress.counts.user_rates = 0;
    const rates = await fetchUserRates(client, snapshot.users, () => {
      progress.counts.user_rates! += 1;
    });
    snapshot.user_billable_rates = rates.billable;
    snapshot.user_cost_rates = rates.cost;

    progress.phase = 'teammates';
    progress.counts.teammates = 0;
    snapshot.teammates = await fetchTeammates(client, snapshot.users, () => {
      progress.counts.teammates! += 1;
    });

    progress.phase = 'writing';
    const report = importSnapshot(db, snapshot, {
      partial: options.mode === 'incremental',
      receiptDir,
    });

    // Fold the log back into the database now rather than whenever a checkpoint happens to
    // run. A full import leaves a write-ahead log the size of the account — 250 MB — and an
    // instance folder that is twice the size of its data is a thing somebody notices, backs
    // up, and pays for.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    const ok = reportOk(report);
    db.prepare(
      `UPDATE import_runs SET finished_at = ?, status = ?, stats_json = ?, cursor_updated_since = ?
        WHERE id = ?`,
    ).run(nowIso(), ok ? 'ok' : 'failed', JSON.stringify(report), cursor, progress.runId);

    progress.report = report;
    progress.summary = `Read ${Object.entries(report.counts).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}.`;
    progress.phase = ok ? 'done' : 'failed';
    progress.error = ok ? null : describeMismatch(report);
    progress.finishedAt = nowIso();

    log.info(
      `[import] run ${progress.runId} ${progress.phase} in ${elapsed(progress.startedAt)} — ` +
        `${Object.entries(report.counts).map(([k, n]) => `${n} ${k}`).join(', ')}` +
        (progress.error ? ` — ${progress.error}` : ''),
      {
        import: {
          run: progress.runId,
          mode: progress.mode,
          outcome: progress.phase,
          seconds: Math.round((Date.now() - Date.parse(progress.startedAt)) / 1000),
          requests: progress.requests,
          counts: report.counts,
          reconciled: report.reconciliation.matches,
          difference_hours: report.reconciliation.difference,
        },
      },
    );
  } catch (error) {
    const message = describeFailure(error);
    // Where it stopped, taken before the phase is overwritten with 'failed'.
    const stoppedIn = progress.phase;

    progress.error = message;
    progress.phase = 'failed';
    progress.finishedAt = nowIso();

    // Where it stopped, and what it had reached — the phase and the counts live in memory,
    // which is gone by the time anyone reads the history. "Failed" alone does not tell you
    // whether Harvest refused the first call or whether four minutes of pulling died on the
    // write, and those two need entirely different responses.
    db.prepare(
      'UPDATE import_runs SET finished_at = ?, status = ?, error = ?, stats_json = ? WHERE id = ?',
    ).run(
      nowIso(),
      'failed',
      message,
      JSON.stringify({
        failure: {
          phase: stoppedIn,
          pulled: progress.counts,
          requests: progress.requests,
          company: progress.company,
        },
      }),
      progress.runId,
    );

    // The page shows the message; the log keeps the stack and the state it died in. A failure
    // four minutes into a pull needs more than one line afterwards, and the log is in the
    // instance folder, so whoever is handed the folder is handed the reason.
    log.error(
      `[import] run ${progress.runId} failed after ${elapsed(progress.startedAt)}: ${message}`,
      {
        import: {
          run: progress.runId,
          mode: progress.mode,
          outcome: 'failed',
          phase: stoppedIn,
          seconds: Math.round((Date.now() - Date.parse(progress.startedAt)) / 1000),
          requests: progress.requests,
          pulled: progress.counts,
        },
        error: {
          message,
          raw: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      },
    );
  }
}

/** Which of the two reconciliations disagreed, and by how much. */
export function describeMismatch(report: ImportReport): string {
  const parts: string[] = [];
  if (!report.reconciliation.matches) {
    parts.push(`Hours did not reconcile: ${report.reconciliation.difference.toFixed(2)} h out.`);
  }
  if (report.invoices && !report.invoices.matches) {
    parts.push(`Invoices did not reconcile: ${report.invoices.difference.toFixed(2)} out.`);
  }
  return parts.join(' ');
}

function elapsed(from: string): string {
  const seconds = Math.round((Date.now() - Date.parse(from)) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Turn whatever went wrong into a sentence worth putting on a screen.
 *
 * Two things every failure here has to say. First, what actually broke — a raw
 * "UNIQUE constraint failed: users.email" names neither the person nor the cause, so the
 * constraints that can realistically fire are translated. Second, that nothing was written:
 * the import is a single transaction, so a failure anywhere leaves the instance exactly as it
 * was, and not knowing that is the difference between running it again and not daring to.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof HarvestError) {
    return `${harvestErrorMessage(error)} (${error.url})`;
  }

  const raw = error instanceof Error ? error.message : String(error);

  if (/UNIQUE constraint failed: users\.email/i.test(raw)) {
    return (
      'An account here already uses an email address that Harvest also has, under a different ' +
      'identity. Nothing was written — the import is one transaction, so the instance is ' +
      'unchanged. Sign in as that person and re-run, or remove the local account first.'
    );
  }

  if (/UNIQUE constraint failed/i.test(raw)) {
    return `${raw}. Nothing was written — the import is one transaction, so the instance is unchanged.`;
  }

  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return (
      'A record referred to something the import did not have — usually a partial sync missing ' +
      'a project or person. Nothing was written; a full re-import reads everything and repairs it.'
    );
  }

  return `${raw} Nothing was written — the import is one transaction, so the instance is unchanged.`;
}

export interface RunRow {
  id: number;
  source: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  stats_json: string | null;
  error: string | null;
}

export { recordRun };
