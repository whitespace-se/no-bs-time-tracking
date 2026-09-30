/**
 * Step 1 of setup: prove the Harvest credentials work, then start the import.
 *
 * The credentials are verified before anything is stored or started. A typo in an account id
 * should come back as "Harvest says no" on the form, not as a job that fails two minutes
 * later on a progress screen.
 */

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/index.ts';
import { HarvestError, harvestErrorMessage } from '../../../lib/harvest/client.ts';
import { saveCredentials } from '../../../lib/harvest/credentials.ts';
import { isSyncRunning, startSync, verifyCredentials } from '../../../lib/harvest/sync.ts';
import { needsSetup } from '../../../lib/setup.ts';

function back(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/setup?error=${encodeURIComponent(message)}` },
  });
}

export const POST: APIRoute = async (context) => {
  // The cross-site check lives in src/middleware.ts, which runs before this and knows the
  // instance's public origin (APP_URL). Repeating it here compared against the socket's own
  // host, which is wrong behind a reverse proxy, and accepted a missing Origin header.
  if (!needsSetup(db())) return context.redirect('/import', 303);
  if (isSyncRunning()) return context.redirect('/setup', 303);

  const form = await context.request.formData();
  const credentials = {
    accountId: String(form.get('account_id') ?? '').trim(),
    accessToken: String(form.get('access_token') ?? '').trim(),
    contact: String(form.get('contact') ?? '').trim(),
  };
  const keepToken = form.get('keep_token') === 'true';

  if (!credentials.accountId || !credentials.accessToken || !credentials.contact) {
    return back('Account ID, token and contact address are all required.');
  }

  try {
    await verifyCredentials(credentials);
  } catch (error) {
    if (error instanceof HarvestError) return back(harvestErrorMessage(error));
    return back(error instanceof Error ? error.message : String(error));
  }

  const database = db();
  saveCredentials(database, credentials, keepToken);
  startSync(database, credentials, { mode: 'full' });

  return context.redirect('/setup', 303);
};
