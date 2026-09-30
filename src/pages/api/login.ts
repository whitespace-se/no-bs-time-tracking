/**
 * Sign in.
 *
 * An API route rather than an Astro Action, because actions can't issue a redirect and
 * login must land the user where they were headed. Plain form post, works without JS.
 */

import type { APIRoute } from 'astro';
import { isSecureOrigin } from '../../lib/public-origin.ts';
import { db } from '../../lib/db/index.ts';
import { verifyPassword } from '../../lib/auth/password.ts';
import { cookieOptions, createSession, purgeExpired, SESSION_COOKIE } from '../../lib/auth/session.ts';
import { row } from '../../lib/db/index.ts';

/** Only ever redirect inside this app — an open redirect is a phishing primitive. */
function safeNext(next: FormDataEntryValue | null): string {
  const value = typeof next === 'string' ? next : '';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export const POST: APIRoute = async (context) => {
  // The cross-site check lives in src/middleware.ts, which runs before this and knows the
  // instance's public origin (APP_URL). Repeating it here compared against the socket's own
  // host, which is wrong behind a reverse proxy, and accepted a missing Origin header.

  const form = await context.request.formData();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const next = safeNext(form.get('next'));

  const database = db();
  const account = row<{ id: number; password_hash: string | null }>(
    database
      .prepare('SELECT id, password_hash FROM users WHERE lower(email) = lower(?) AND is_active = 1')
      .get(email),
  );

  // Runs the same work whether or not the account exists, so timing doesn't leak which
  // emails are real.
  const ok = await verifyPassword(password, account?.password_hash ?? null);

  if (!ok || !account) {
    const back = next === '/' ? '/login?error=1' : `/login?next=${encodeURIComponent(next)}&error=1`;
    return context.redirect(back, 303);
  }

  purgeExpired(database);
  const session = createSession(database, account.id, {
    userAgent: context.request.headers.get('user-agent'),
    ip: context.clientAddress,
  });

  context.cookies.set(SESSION_COOKIE, session.id, cookieOptions(isSecureOrigin(context.url)));
  return context.redirect(next, 303);
};
