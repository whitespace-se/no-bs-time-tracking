import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/index.ts';
import { csvProgress, describeCsvImport, importCsvFilesAsync, sortFiles } from '../../../lib/import/csv.ts';
import { isSyncRunning, startJob } from '../../../lib/harvest/sync.ts';
import { readSettings, writeSettings } from '../../../lib/settings.ts';
import { needsSetup } from '../../../lib/setup.ts';

/** Matches the adapter's body ceiling in astro.config.mjs, which stops the request earlier. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function back(message: string): Response {
  return new Response(null, { status: 303, headers: { Location: `/setup?error=${encodeURIComponent(message)}` } });
}

export const POST: APIRoute = async (context) => {
  // The cross-site check lives in src/middleware.ts, which runs before this and knows the
  // instance's public origin (APP_URL). Repeating it here compared against the socket's own
  // host, which is wrong behind a reverse proxy, and accepted a missing Origin header.
  const database = db();
  if (!needsSetup(database)) return context.redirect('/import', 303);

  try {
    // Checked on the declared length first. `upload.size` is only knowable after the whole
    // body has been buffered in memory, so enforcing the limit there means accepting the
    // upload in full before refusing it — on this route, before anyone has even signed in.
    if (Number(context.request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
      return back('That file is larger than 32 MB. Use the command-line importer for large exports.');
    }

    const form = await context.request.formData();
    const uploads = form.getAll('csv').filter((value): value is File => value instanceof File && value.size > 0);
    if (uploads.length === 0) return back('Choose a Harvest time report or invoice report CSV.');
    if (uploads.reduce((sum, upload) => sum + upload.size, 0) > MAX_UPLOAD_BYTES) return back('The files come to more than 32 MB. Use the command-line importer for large exports.');
    const files = await Promise.all(uploads.map(async (upload) => ({ name: upload.name, text: await upload.text() })));
    if (isSyncRunning()) return back('An import is already running. Wait for it to finish.');
    // Invoices alone leave nobody to sign in as, so setup needs the time report.
    if (!sortFiles(files).time) return back('Include the time report: it creates the people who sign in.');
    startJob(database, 'csv', 'harvest-csv', async (progress) => {
      const result = await importCsvFilesAsync(database, files, readSettings(database), csvProgress(progress));
      // A new workspace has only the default currency; the export says which it really uses.
      if (result.time?.currency) writeSettings(database, { currency: result.time.currency });
      return describeCsvImport(result);
    });
    return context.redirect('/setup', 303);
  } catch (error) {
    return back(error instanceof Error ? error.message : String(error));
  }
};
