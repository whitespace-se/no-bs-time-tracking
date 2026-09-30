/**
 * Step 3 of setup: claim an imported account and become the administrator.
 *
 * Harvest cannot export passwords, so every imported user arrives without one. This is where
 * the first person gets in. It is the single most sensitive route in the product — it grants
 * administrator rights with no prior authentication — so it is only reachable while nobody at
 * all can sign in, and the `needsSetup` check is re-read here rather than trusted from the
 * middleware, because a route that hands out admin should not depend on something upstream
 * having remembered to guard it.
 */

import type { APIRoute } from 'astro';
import { isSecureOrigin } from '../../../lib/public-origin.ts';
import { db, nowIso, row, transaction } from '../../../lib/db/index.ts';
import { hashPassword } from '../../../lib/auth/password.ts';
import { cookieOptions, createSession, SESSION_COOKIE } from '../../../lib/auth/session.ts';
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

  const database = db();
  if (!needsSetup(database)) return context.redirect('/import', 303);

  const form = await context.request.formData();
  const userId = Number(form.get('user_id'));
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  if (!Number.isInteger(userId) || userId <= 0) return back('Choose which account is yours.');
  if (password !== confirm) return back('The two passwords do not match.');
  if (password.length === 0) return back('Enter a password.');

  const account = row<{ id: number; email: string }>(
    database.prepare('SELECT id, email FROM users WHERE id = ?').get(userId),
  );
  if (!account) return back('That account no longer exists.');

  const hash = await hashPassword(password);
  transaction(database, () => {
    database
      .prepare("UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, updated_at = ? WHERE id = ?")
      .run(hash, nowIso(), account.id);
  });

  const session = createSession(database, account.id, {
    userAgent: context.request.headers.get('user-agent'),
    ip: context.clientAddress,
  });
  context.cookies.set(SESSION_COOKIE, session.id, cookieOptions(isSecureOrigin(context.url)));

  return context.redirect('/', 303);
};
