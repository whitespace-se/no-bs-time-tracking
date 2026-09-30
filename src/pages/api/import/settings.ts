/**
 * Fill in, from Harvest, the project, client, task and people settings a CSV import could not
 * know. Administrators only. The token comes from storage or the form, as for a sync.
 */

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/index.ts';
import { canAdminister } from '../../../lib/auth/session.ts';
import { readCredentials, saveCredentials, usableCredentials } from '../../../lib/harvest/credentials.ts';
import { applyHarvestSettings, fetchHarvestSettings } from '../../../lib/harvest/settings.ts';
import { HarvestError, harvestErrorMessage } from '../../../lib/harvest/client.ts';
import { isSyncRunning, startJob, verifyCredentials } from '../../../lib/harvest/sync.ts';

function back(param: 'error' | 'notice', message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/import?${param}=${encodeURIComponent(message)}` },
  });
}

export const POST: APIRoute = async (context) => {
  const viewer = context.locals.user;
  if (!viewer || !canAdminister(viewer)) {
    return new Response('Only administrators can run an import.', { status: 403 });
  }
  if (isSyncRunning()) return context.redirect('/import', 303);

  const database = db();
  const form = await context.request.formData();
  const typedToken = String(form.get('access_token') ?? '').trim();

  let credentials = usableCredentials(database);
  if (typedToken) {
    const stored = readCredentials(database);
    const accountId = String(form.get('account_id') ?? stored.accountId ?? '').trim();
    const contact = String(form.get('contact') ?? stored.contact ?? '').trim();
    if (!accountId || !contact) return back('error', 'Account ID and contact address are both required.');
    credentials = { accountId, accessToken: typedToken, contact };
  }
  if (!credentials) return back('error', 'No stored token. Paste one to read the settings.');

  // Checked here, before the page moves on, so a wrong token is said at once and never kept.
  try {
    await verifyCredentials(credentials);
  } catch (error) {
    if (error instanceof HarvestError) return back('error', harvestErrorMessage(error));
    return back('error', error instanceof Error ? error.message : String(error));
  }
  if (typedToken && form.get('keep_token') === 'true') saveCredentials(database, credentials, true);
  const using = credentials;
  startJob(database, 'harvest-settings', 'harvest-settings', async (progress) => {
    const fetched = await fetchHarvestSettings(using, progress);
    progress.phase = 'writing';
    const report = applyHarvestSettings(database, fetched);
    const unmatched = report.unmatchedProjects.length;
    return `Settings read from Harvest: ${report.projects.matched} projects (${report.projects.fixedFee} fixed fee), ` +
      `${report.clients.matched} clients, ${report.tasks.matched} tasks, ${report.users.matched} people ` +
      `(${report.users.emails} emails filled in).` +
      (unmatched ? ` ${unmatched} projects here had no match in Harvest and keep their CSV defaults.` : '');
  });
  return context.redirect('/import', 303);
};
