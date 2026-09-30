/**
 * First-run state.
 *
 * A fresh instance has no users at all, and after a Harvest import it has everyone's names
 * and email addresses but no passwords, because Harvest does not export those and could not.
 * Either way nobody can sign in, which is the definition of "not set up yet".
 *
 * Keying on "can anybody sign in" rather than on a `setup_complete` flag means the escape
 * hatch is automatic: an instance whose only administrator was deleted is, correctly, an
 * instance that needs setting up again. A flag would have to be un-set by hand.
 */

import type { Db } from './db/index.ts';
import { row } from './db/index.ts';

export function needsSetup(db: Db): boolean {
  const found = row<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL AND password_hash <> ''").get(),
  );
  return (found?.n ?? 0) === 0;
}

export function hasImportedData(db: Db): boolean {
  const found = row<{ n: number }>(db.prepare('SELECT COUNT(*) AS n FROM users').get());
  return (found?.n ?? 0) > 0;
}
