import type { APIRoute } from 'astro';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../../lib/db/index.ts';
import { canAdminister } from '../../lib/auth/session.ts';
import { SECRET_SETTINGS } from '../../lib/instance-key.ts';
import { readSettings } from '../../lib/settings.ts';

/**
 * Download the whole instance database.
 *
 * This ships from day one, without the instance owner having to ask. It is the concrete
 * answer to "what if this project goes away".
 *
 * VACUUM INTO rather than copying the file: it takes a consistent snapshot while the app is
 * running, which a plain copy of a WAL database does not.
 *
 * The snapshot goes out without anything that authenticates against a live instance: the
 * instance key, the stored Harvest token, live sessions and API tokens. Since the key moved
 * into the database, "download the database" would otherwise mean "hand out a working Harvest
 * credential" every time an admin took a backup, over whatever channel that file then travels.
 * Sessions matter for the same reason and more sharply — a session id is the cookie value
 * verbatim, so a backup handed to a bookkeeper would otherwise sign them in as whoever was
 * logged in when it was taken.
 *
 * Everything else is here, so a restored copy is a working instance. It asks for the Harvest
 * token again and everyone signs in again, which is the correct amount of friction for a file
 * that has left the building.
 */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!canAdminister(user)) return new Response('Administrators only.', { status: 403 });

  // A private directory, not a predictable name in the shared one: between VACUUM INTO and
  // the rm below, the file holds every rate, hash and session in the instance, and /tmp is
  // world-readable. mkdtemp gives 0700 and an unguessable name, which also closes the
  // symlink race a `Date.now()` filename invites.
  const dir = await mkdtemp(join(tmpdir(), 'timetrack-'));
  const snapshot = join(dir, 'snapshot.db');
  try {
    db().exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);

    // Opened separately, and only to remove secrets: the live database keeps all of this.
    const copy = new DatabaseSync(snapshot);
    const drop = copy.prepare('DELETE FROM settings WHERE key = ?');
    for (const setting of SECRET_SETTINGS) drop.run(setting);
    // Credentials authenticate against the instance they were issued for. A restored copy
    // re-authenticates; it does not inherit anyone's browser session or integration token.
    copy.exec('DELETE FROM sessions');
    copy.exec('DELETE FROM api_tokens');
    // A DELETE only unlinks rows: the bytes stay legible in the pages it frees, and this file
    // is about to be handed to somebody. VACUUM rebuilds it without them.
    copy.exec('VACUUM');
    copy.close();

    const bytes = await readFile(snapshot);
    const company = readSettings(db()).companyName.replace(/[^\w-]+/g, '-').toLowerCase() || 'instance';
    const name = `${company}-${new Date().toISOString().slice(0, 10)}.db`;

    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
