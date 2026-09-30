/**
 * Where this process's instance lives.
 *
 * An instance is a **folder**, and that is the only way to name one. Point the app at it and
 * everything belonging to that organization is inside: the database, its write-ahead log,
 * its `.env`, its log. Moving one is `rsync -a` of a directory; running several on one
 * box is several directories and several ports; backing one up is copying it.
 *
 *     INSTANCE_DIR=/srv/instances/acme node dist/server/entry.mjs
 *
 * There was a `DATABASE_PATH` that pointed at one exact file, and it is gone. Two ways to say
 * where the data is means two things to check when an instance comes up empty, and the file
 * form could name a database with no folder around it — no `.env`, no log, none of the things
 * that make an instance a unit. Scripts still take an explicit path as an argument; that is
 * an argument, not a second configuration mechanism.
 *
 * The one piece of helpfulness here is adoption. `/api/database` hands out a snapshot named
 * `acme-2026-08-27.db`, and the obvious way to restore it is to drop it in a folder and start
 * the app. So a folder with exactly one `.db` file in it uses that file, whatever it is
 * called. Two of them is ambiguous, and ambiguity about which database an instance is serving
 * is not something to resolve by guessing — that errors out and says what it found.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { startInstanceLog } from './instance-log.ts';

/** The name a new instance's database gets. */
export const DATABASE_FILE = 'timetrack.db';

/** Where an instance goes when nobody said. One folder per instance, all of them siblings. */
export const DEFAULT_INSTANCE_DIR = './instances/default';

export interface Instance {
  /** The folder that is the instance. */
  dir: string;
  databasePath: string;
  /** True when the database was found under a name other than `timetrack.db`. */
  adopted: boolean;
}

function databasesIn(dir: string): string[] {
  try {
    // `.db-wal` and `.db-shm` do not end in `.db`, so they are not candidates.
    return readdirSync(dir).filter((name) => name.endsWith('.db')).sort();
  } catch {
    return []; // A folder that does not exist yet is an empty one; openDb creates it.
  }
}

export function resolveInstance(env: NodeJS.ProcessEnv = process.env): Instance {
  const raw = env.INSTANCE_DIR?.trim() || DEFAULT_INSTANCE_DIR;
  const dir = isAbsolute(raw) ? raw : resolve(raw);
  const preferred = join(dir, DATABASE_FILE);

  const found = databasesIn(dir);
  if (found.includes(DATABASE_FILE) || found.length === 0) {
    return { dir, databasePath: preferred, adopted: false };
  }

  if (found.length > 1) {
    throw new Error(
      `${dir} holds ${found.length} databases (${found.join(', ')}) and none is named ` +
        `${DATABASE_FILE}. Rename the one to serve, or move the others out of the folder.`,
    );
  }

  return { dir, databasePath: join(dir, found[0]!), adopted: true };
}

/**
 * The one setting a file inside the instance may not change.
 *
 * The folder decides which instance it is; a file inside the folder saying otherwise is a
 * loop, and a confusing one — you would be reading `/srv/acme/.env` to find out that this
 * instance is actually serving some other organization.
 */
const NOT_FROM_INSTANCE_ENV = ['INSTANCE_DIR'];

/**
 * Load `<instance>/.env`, if it is there.
 *
 * Per-instance configuration belongs with the instance: an instance that needs its own port,
 * its own `SECRET_KEY` or its own Harvest contact address should carry that in the folder
 * that gets copied, not in a systemd unit somewhere that has to be copied separately and
 * eventually is not.
 *
 * Real environment variables win over the file. That is the way round that lets an operator
 * override one setting for one run — `PORT=4400 node …` — without editing the instance's
 * file, and it is what makes the file a default rather than a decree.
 *
 * `SECRET_KEY` here is worth knowing about: in the folder, it is beside the database but not
 * *in* it, so the instance travels as one directory while a downloaded database snapshot
 * still carries nothing that can decrypt its Harvest token.
 */
export function loadInstanceEnv(instance: Instance): string | null {
  const file = join(instance.dir, '.env');
  if (!existsSync(file)) return null;

  const before = { ...process.env };
  process.loadEnvFile(file);

  // Node's loader overwrites what is already set, so precedence is put back afterwards rather
  // than by parsing the file here — one parser, and it is the same one `node --env-file` uses.
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
  for (const key of NOT_FROM_INSTANCE_ENV) {
    if (before[key] === undefined) delete process.env[key];
  }

  return file;
}

let bootstrapped: Instance | null = null;

/**
 * Resolve the instance and load its environment, once per process.
 *
 * Called from the middleware (so the app is configured before it serves anything) and from
 * `db()` (so a script that opens the database gets the same configuration as the app). Both,
 * because "every entry point remembered to call bootstrap" is not a property that survives
 * someone adding an entry point.
 */
export function bootstrapInstance(): Instance {
  if (bootstrapped) return bootstrapped;
  const instance = resolveInstance();
  // .env first: it may carry INSTANCE_LOG, and a setting that arrives after the thing it
  // configures has already started is a setting that does nothing.
  loadInstanceEnv(instance);
  startInstanceLog(instance);
  bootstrapped = instance;
  return instance;
}

/** One line at boot, so it is never a mystery which instance a process is serving. */
export function describeInstance(instance: Instance): string {
  const adopted = instance.adopted ? ` (adopted ${instance.databasePath.split('/').pop()})` : '';
  const env = existsSync(join(instance.dir, '.env')) ? ' · .env' : '';
  return `Instance ${instance.dir}${adopted}${env}`;
}
