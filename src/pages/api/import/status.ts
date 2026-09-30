/**
 * Live progress for a running sync.
 *
 * A plain JSON endpoint polled by the setup and import pages. It is deliberately readable by
 * anyone signed in, and by anyone at all while the instance is still unconfigured, because
 * during setup there is by definition no session to check. It never returns the token, and
 * the only thing it discloses about an unconfigured instance is that it is unconfigured —
 * which the setup page already says out loud.
 */

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/index.ts';
import { currentSync } from '../../../lib/harvest/sync.ts';
import { needsSetup } from '../../../lib/setup.ts';

export const GET: APIRoute = ({ locals }) => {
  if (!locals.user && !needsSetup(db())) {
    return new Response('Unauthorized', { status: 401 });
  }

  return new Response(JSON.stringify({ sync: currentSync() }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
