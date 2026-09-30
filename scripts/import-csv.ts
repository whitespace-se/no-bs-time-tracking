import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openDb } from '../src/lib/db/index.ts';
import { resolveInstance } from '../src/lib/instance.ts';
import { importCsvFiles } from '../src/lib/import/csv.ts';
import { readSettings } from '../src/lib/settings.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Usage: npm run import:csv -- harvest_time_report.csv [harvest_invoice_report.csv]');
  process.exitCode = 2;
} else {
  const database = openDb();
  const files = await Promise.all(paths.map(async (path) => ({ name: basename(path), text: await readFile(path, 'utf8') })));
  const { time, invoices } = importCsvFiles(database, files, readSettings(database));
  if (time) {
    console.log(`Time: imported ${time.imported} new rows; updated ${time.updated}.`);
    console.log(`${time.users} people, ${time.clients} clients, ${time.projects} projects, ${time.tasks} tasks.`);
    console.log(`Source hours: ${(time.sourceSeconds / 3600).toFixed(2)}; stored hours: ${(time.storedSeconds / 3600).toFixed(2)}.`);
  }
  if (invoices) {
    console.log(`Invoices: imported ${invoices.imported} new; updated ${invoices.updated}; skipped ${invoices.skipped} heading or total rows.`);
  }
  for (const warning of [...(time?.warnings ?? []), ...(invoices?.warnings ?? [])]) console.warn(`Warning: ${warning}`);
  console.log(`Database: ${resolveInstance().databasePath}`);
}
