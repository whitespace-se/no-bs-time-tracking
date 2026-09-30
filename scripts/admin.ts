/**
 * Create or update an administrator, from a terminal.
 *
 *   node scripts/admin.ts                                     # asks for everything
 *   node scripts/admin.ts --instance /srv/instances/acme
 *   node scripts/admin.ts --name 'Alva Lind' --email alva@example.com
 *   node scripts/admin.ts --email alva@example.com --password '…' --yes
 *
 * The setup wizard covers a fresh instance, whether it is imported or empty. This is the way
 * back in when that is no longer available: the one administrator is locked out, or the
 * instance needs another one provisioned without a browser.
 *
 * It asks rather than takes arguments, because the alternative is a password in shell history
 * and in the process list.
 *
 *   --instance PATH  the instance directory to open; otherwise INSTANCE_DIR applies
 *   --email, --name  supply what it would otherwise prompt for
 *   --password       for scripted provisioning, at the cost noted above
 *   --yes            skip the confirmation before replacing an existing password
 *   --force          --yes, and drop the ten-character minimum. Recovery only.
 */

import { createInterface } from 'node:readline/promises';
import { bootstrapInstance } from '../src/lib/instance.ts';
import { printBanner } from '../src/lib/banner.ts';
import { openDb, nowIso, row, transaction } from '../src/lib/db/index.ts';
import { hashPassword, hashWeak } from '../src/lib/auth/password.ts';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  // `--password --yes` means the password was omitted, not that it is "--yes". Taking the
  // next token unconditionally would set an admin password to the name of the next flag.
  return value === undefined || value.startsWith('--') ? null : value;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

// `--instance` before anything reads the environment, since the folder's .env is part of it.
const instanceArg = arg('instance');
if (instanceArg) process.env.INSTANCE_DIR = instanceArg;
printBanner();
const instance = bootstrapInstance();

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, fallback = ''): Promise<string> {
  const answer = (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim();
  return answer || fallback;
}

/**
 * A password prompt that does not echo.
 *
 * Raw mode rather than a readline trick, because the point is that the characters never reach
 * the terminal at all. Chunks can carry several characters at once — a paste, or a multi-byte
 * key — so the whole chunk is walked rather than switched on.
 */
function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return rl.question(`${question} `); // piped input: nothing to hide from

  return new Promise((resolve) => {
    process.stdout.write(`${question} `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') return done();
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };

    stdin.on('data', onData);
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

try {
  const db = openDb(instance.databasePath);

  const existing = row<{ n: number }>(db.prepare('SELECT COUNT(*) AS n FROM users').get())?.n ?? 0;
  console.log(`\n  Instance   ${instance.dir}`);
  console.log(`  Accounts   ${existing}\n`);

  // ── Who ──────────────────────────────────────────────────────────────────
  let email = arg('email') ?? '';
  while (!EMAIL.test(email)) {
    if (email) console.log('  That does not look like an email address.');
    email = (await ask('  Email:')).toLowerCase();
  }

  const found = row<{ id: number; name: string; role: string; has_password: number }>(
    db
      .prepare(
        `SELECT id, TRIM(first_name || ' ' || last_name) AS name, role,
                CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password
           FROM users WHERE lower(email) = lower(?)`,
      )
      .get(email),
  );

  let first = '';
  let last = '';

  if (found) {
    console.log(
      `\n  ${email} already exists: ${found.name || '(no name)'} · ${found.role}` +
        `${found.has_password ? ' · has a password' : ' · no password yet'}`,
    );
    // Only the destructive half needs confirming. Promoting and setting a password is what
    // was asked for; overwriting a password someone is currently using is worth a pause.
    if (found.has_password && !flag('force') && !flag('yes')) {
      const confirm = await ask('  Replace their password and make them an admin? (y/N)', 'n');
      if (confirm.toLowerCase() !== 'y') {
        console.log('  Nothing changed.\n');
        process.exit(0);
      }
    }
  } else {
    const name = arg('name') ?? (await ask('  Full name:'));
    const parts = name.trim().split(/\s+/);
    first = parts[0] ?? '';
    last = parts.slice(1).join(' ');
    if (!first) {
      console.error('  A name is required.\n');
      process.exit(1);
    }
  }

  // ── Password ─────────────────────────────────────────────────────────────
  const minimum = flag('force') ? 1 : 10;
  let password = arg('password') ?? '';
  while (password.length < minimum) {
    if (password) console.log(`  At least ${minimum} characters.`);
    password = await askSecret('  Password:');
    if (password.length >= minimum) {
      const again = await askSecret('  Confirm:');
      if (again !== password) {
        console.log('  Those did not match.');
        password = '';
      }
    }
  }

  const hash = flag('force') ? await hashWeak(password) : await hashPassword(password);
  const now = nowIso();

  transaction(db, () => {
    if (found) {
      db.prepare(
        `UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, archived_at = NULL,
                          updated_at = ?
          WHERE id = ?`,
      ).run(hash, now, found.id);
      // A password change signs that account out everywhere — the point of a reset is that
      // whoever was already in is not still in.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(found.id);
    } else {
      db.prepare(
        `INSERT INTO users (email, first_name, last_name, role, is_active, is_contractor,
                            password_hash, created_at, updated_at)
         VALUES (?,?,?,'admin',1,0,?,?,?)`,
      ).run(email, first, last, hash, now, now);
    }
  });

  const who = found ? found.name || email : `${first} ${last}`.trim();
  console.log(`\n  ${found ? 'Updated' : 'Created'} ${who} <${email}> as an administrator.`);
  console.log('  Sign in at /login on this instance.\n');

  db.close();
} finally {
  rl.close();
}
