/**
 * Post-build step: put the migration SQL where the built server can find it.
 *
 * The migrations are plain .sql files read at boot. `astro build` bundles the JavaScript and
 * leaves every non-imported file behind, so without this the built server throws ENOENT on
 * its first request — the Docker image would ship and serve nothing but 500s.
 *
 * They land in `dist/server/`, one level above the bundled chunk that looks for them, which
 * is what `findMigrationsDir` in src/lib/db/index.ts walks up to find.
 */

import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'lib', 'db', 'migrations');
const to = join(root, 'dist', 'server', 'migrations');

if (!existsSync(join(root, 'dist', 'server'))) {
  throw new Error('No dist/server to copy migrations into. Run `astro build` first.');
}

cpSync(from, to, { recursive: true });

const copied = readdirSync(to).filter((name) => name.endsWith('.sql'));
if (copied.length === 0) throw new Error(`No migrations found in ${from}.`);
console.log(`Copied ${copied.length} migrations to dist/server/migrations.`);
