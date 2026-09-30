import type { APIRoute } from 'astro';
import { db } from '../../lib/db/index.ts';
import { destroySession, SESSION_COOKIE } from '../../lib/auth/session.ts';

export const POST: APIRoute = (context) => {
  // The cross-site check lives in src/middleware.ts, which runs before this and knows the
  // instance's public origin (APP_URL). Repeating it here compared against the socket's own
  // host, which is wrong behind a reverse proxy, and accepted a missing Origin header.
  destroySession(db(), context.cookies.get(SESSION_COOKIE)?.value);
  context.cookies.delete(SESSION_COOKIE, { path: '/' });
  return context.redirect('/login', 303);
};
