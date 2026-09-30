import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/lib/db/index.ts';
import { currentSync, isImportWriting, isSyncRunning, startJob } from '../src/lib/harvest/sync.ts';
import { csvProgress, importCsvFilesAsync } from '../src/lib/import/csv.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-test-'));
  const database = openDb(join(dir, 'test.db'));
  return { database, cleanup: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const until = async (done: () => boolean) => {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 5));
};

test('a CSV job reports its rows as it goes, blocks writes only while writing, and ends with a summary', async () => {
  const { database, cleanup } = fixture();
  try {
    let csv = 'Date,Client,Project,Task,Hours,Billable?,First Name,Last Name,Billable Rate\n';
    for (let i = 0; i < 4500; i += 1) csv += `2026-01-${String((i % 28) + 1).padStart(2, '0')},C,P,T,1,Yes,Ada,Lovelace,100\n`;

    const seen: number[] = [];
    const writing: boolean[] = [];
    startJob(database, 'csv', 'harvest-csv', async (progress) => {
      const tick = csvProgress(progress);
      const result = await importCsvFilesAsync(database, [{ name: 't.csv', text: csv }], DEFAULT_SETTINGS, (step, done, total) => {
        tick(step, done, total);
        if (step === 'time_report') seen.push(done);
        writing.push(isImportWriting());
      });
      return `Imported ${result.time!.rows}.`;
    });
    assert.equal(isSyncRunning(), true);
    await until(() => currentSync()?.finishedAt != null);

    const job = currentSync()!;
    assert.equal(job.kind, 'csv');
    assert.equal(job.phase, 'done');
    assert.equal(job.summary, 'Imported 4500.');
    assert.deepEqual(job.totals, { time_report: 4500, billing: 1 });
    // A report per batch of 2 000 rows, and one at the end.
    assert.deepEqual(seen, [0, 2000, 4000, 4500]);
    assert.ok(writing.every(Boolean), 'writes are held off for the whole of the writing');
    assert.equal(isImportWriting(), false);
    assert.equal(isSyncRunning(), false);
  } finally {
    cleanup();
  }
});

test('a failed job says why, records where it stopped, and leaves nothing written', async () => {
  const { database, cleanup } = fixture();
  try {
    startJob(database, 'csv', 'harvest-csv', async (progress) => {
      await importCsvFilesAsync(database, [{ name: 't.csv', text: 'Date,Client,Project,Task,Hours,First Name,Last Name\n2026-01-01,C,P,T,1,Ada,Lovelace\n07/08/2026,C,P,T,1,Ada,Lovelace\n' }],
        DEFAULT_SETTINGS, csvProgress(progress));
      return 'never';
    });
    await until(() => currentSync()?.finishedAt != null);
    const job = currentSync()!;
    assert.equal(job.phase, 'failed');
    assert.match(job.error ?? '', /ambiguous date/);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM time_entries').get() as { n: number }).n, 0);
    const run = database.prepare("SELECT status, error, stats_json FROM import_runs WHERE source = 'harvest-csv'").get() as { status: string; error: string; stats_json: string };
    assert.equal(run.status, 'failed');
    assert.equal(JSON.parse(run.stats_json).failure.phase, 'time_report');
  } finally {
    cleanup();
  }
});

test('only one import runs at a time', async () => {
  const { database, cleanup } = fixture();
  try {
    let release!: () => void;
    startJob(database, 'harvest-settings', 'harvest-settings', () => new Promise((resolve) => { release = () => resolve('ok'); }));
    assert.throws(() => startJob(database, 'csv', 'harvest-csv', async () => 'x'), /already running/);
    release();
    await until(() => currentSync()?.finishedAt != null);
  } finally {
    cleanup();
  }
});
