/**
 * Start a sync from the import page.
 *
 * Administrators only. The token comes from storage when it is there and from the form when
 * it is not, which is what makes "remember the token" optional rather than load-bearing.
 */

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/index.ts';
import { canAdminister } from '../../../lib/auth/session.ts';
import { HarvestError, harvestErrorMessage } from '../../../lib/harvest/client.ts';
import { readCredentials, saveCredentials, usableCredentials } from '../../../lib/harvest/credentials.ts';
import { isSyncRunning, startSync, verifyCredentials } from '../../../lib/harvest/sync.ts';

function back(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/import?error=${encodeURIComponent(message)}` },
  });
}

export const POST: APIRoute = async (context) => {
  // The cross-site check lives in src/middleware.ts, which runs before this and knows the
  // instance's public origin (APP_URL). Repeating it here compared against the socket's own
  // host, which is wrong behind a reverse proxy, and accepted a missing Origin header.
  const viewer = context.locals.user;
  if (!viewer || !canAdminister(viewer)) {
    return new Response('Only administrators can run an import.', { status: 403 });
  }
  if (isSyncRunning()) return context.redirect('/import', 303);

  const database = db();
  const form = await context.request.formData();
  const mode = form.get('mode') === 'full' ? 'full' : 'incremental';
  const typedToken = String(form.get('access_token') ?? '').trim();

  let credentials = usableCredentials(database);
  if (typedToken) {
    const stored = readCredentials(database);
    const accountId = String(form.get('account_id') ?? stored.accountId ?? '').trim();
    const contact = String(form.get('contact') ?? stored.contact ?? '').trim();
    if (!accountId || !contact) return back('Account ID and contact address are both required.');
    credentials = { accountId, accessToken: typedToken, contact };
  }

  if (!credentials) {
    return back('No stored token. Paste one to run this sync.');
  }

  try {
    await verifyCredentials(credentials);
  } catch (error) {
    if (error instanceof HarvestError) return back(harvestErrorMessage(error));
    return back(error instanceof Error ? error.message : String(error));
  }

  if (typedToken && form.get('keep_token') === 'true') {
    saveCredentials(database, credentials, true);
  }

  startSync(database, credentials, { mode });
  return context.redirect('/import', 303);
};
