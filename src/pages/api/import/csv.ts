import type { APIRoute } from 'astro';
import { canAdminister } from '../../../lib/auth/session.ts';
import { db } from '../../../lib/db/index.ts';
import { csvProgress, describeCsvImport, importCsvFilesAsync, sortFiles } from '../../../lib/import/csv.ts';
import { isSyncRunning, startJob } from '../../../lib/harvest/sync.ts';
import { readSettings } from '../../../lib/settings.ts';

/** Matches the adapter's body ceiling in astro.config.mjs, which stops the request earlier. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function back(message: string): Response {
  return new Response(null, { status: 303, headers: { Location: `/import?error=${encodeURIComponent(message)}` } });
}

export const POST: APIRoute = async (context) => {
  const viewer = context.locals.user;
  if (!viewer) return new Response('Unauthorized', { status: 401 });
  if (!canAdminister(viewer)) return new Response('Administrators only.', { status: 403 });
  // The cross-site check lives in src/middleware.ts, which runs before this and knows the
  // instance's public origin (APP_URL).

  try {
    // Checked on the declared length first. `upload.size` is only knowable after the whole
    // body has been buffered in memory, so enforcing the limit there means accepting the
    // upload in full before refusing it — on this route, before anyone has even signed in.
    if (Number(context.request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
      return back('That file is larger than 32 MB. Use npm run import:csv for large exports.');
    }

    const form = await context.request.formData();
    const uploads = form.getAll('csv').filter((value): value is File => value instanceof File && value.size > 0);
    if (uploads.length === 0) return back('Choose a Harvest time report or invoice report CSV.');
    if (uploads.reduce((sum, upload) => sum + upload.size, 0) > MAX_UPLOAD_BYTES) return back('The files come to more than 32 MB. Use npm run import:csv for large exports.');
    const files = await Promise.all(uploads.map(async (upload) => ({ name: upload.name, text: await upload.text() })));
    if (isSyncRunning()) return back('An import is already running. Wait for it to finish.');
    // Told apart now, so a wrong file is refused here rather than after the page has moved on.
    sortFiles(files);
    const database = db();
    startJob(database, 'csv', 'harvest-csv', async (progress) =>
      describeCsvImport(await importCsvFilesAsync(database, files, readSettings(database), csvProgress(progress))));
    return context.redirect('/import', 303);
  } catch (error) {
    return back(error instanceof Error ? error.message : String(error));
  }
};
