/**
 * Auth gate.
 *
 * Everything requires a session except the login page, the login action, and static assets.
 * Deny-by-default: a new route is protected the moment it exists, rather than protected once
 * someone remembers to add it to a list.
 */

import { defineMiddleware } from 'astro:middleware';
import type { APIContext, MiddlewareNext } from 'astro';
import { bootstrapInstance } from './lib/instance.ts';
import { printBanner } from './lib/banner.ts';
import { db } from './lib/db/index.ts';

// At module load, which for middleware is server start: the instance folder is resolved and
// its .env is loaded before a single request is served, so nothing can read a setting that is
// about to change underneath it. The banner goes first, before the instance log starts
// copying stdout into the folder.
printBanner();
bootstrapInstance();
import { resolveSession, SESSION_COOKIE, type SessionUser } from './lib/auth/session.ts';
import { resolveToken, touchToken } from './lib/auth/api-token.ts';
import { fail, rateHeaders, rateLimit, unauthorized } from './lib/api/http.ts';
import { isCrossSiteWrite } from './lib/public-origin.ts';
import { needsSetup } from './lib/setup.ts';
import { isImportWriting } from './lib/harvest/sync.ts';

const PUBLIC_PATHS = new Set(['/login', '/api/login']);

/**
 * Open only while nobody can sign in.
 *
 * This is the one door that has to be unlocked before there is anyone to unlock it for, so
 * it closes the instant the first password exists — including mid-session, which is why it
 * is re-checked per request rather than cached at boot.
 */
function isSetupPath(pathname: string): boolean {
  return pathname === '/setup' || pathname.startsWith('/api/setup/');
}

/**
 * Static assets served by the adapter, and Astro's development endpoints.
 *
 * The adapter's own static handler answers these before the middleware runs, so in the normal
 * case this never fires. It matters when an asset is *missing* — a browser holding a page from
 * an earlier build asks for a filename whose hash no longer exists. Without this the request
 * falls through to the gate below and is redirected to /setup or /login, so a stylesheet
 * answers with a page, which is a confusing way to say 404.
 */
function isAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/_astro/') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/node_modules/') ||
    pathname === '/favicon.ico'
  );
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || isAsset(pathname);
}

/**
 * A browser submitting a <form> straight to an action endpoint, as the time views do.
 *
 * The endpoint answers with the action's data, which is what a script or a test wants and
 * what a person looking at the page does not: the browser would show `[{"id":1},…]` in place
 * of the timesheet. Only a navigation is redirected, so fetch callers keep the data.
 */
function isFormNavigation(context: APIContext): boolean {
  const headers = context.request.headers;
  return (
    context.request.method === 'POST' &&
    context.url.pathname.startsWith('/_actions/') &&
    (headers.get('sec-fetch-mode') === 'navigate' || /\btext\/html\b/.test(headers.get('accept') ?? ''))
  );
}

/**
 * Post/redirect/get: back to the page the form was on, so a reload does not post it again.
 *
 * Only the path and query of the Referer are used, never its host, so this cannot be turned
 * into a redirect to another site. On success the parameters that opened a dialog or an
 * unsaved week row are dropped, because what they pointed at is now saved; on failure they
 * stay, and the action's message travels along to be shown on the page.
 */
async function backToForm(context: APIContext, response: Response): Promise<Response> {
  let back: URL;
  try {
    const referer = new URL(context.request.headers.get('referer') ?? '/', context.url);
    back = new URL(referer.pathname + referer.search, context.url);
  } catch {
    back = new URL('/', context.url);
  }
  back.searchParams.delete('action_error');
  if (response.ok) {
    for (const name of ['edit', 'p', 't']) back.searchParams.delete(name);
  } else {
    back.searchParams.set('action_error', await actionMessage(response));
  }
  return new Response(null, { status: 303, headers: { Location: back.pathname + back.search } });
}

async function actionMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; fields?: Record<string, string[] | undefined> };
    const field = Object.entries(body.fields ?? {}).find(([, messages]) => messages?.length);
    if (field) return `${field[0].replace(/_/g, ' ')}: ${field[1]![0]}`;
    if (body.message) return body.message;
  } catch {
    // Not JSON: an error from outside the action, such as the cross-site check.
  }
  return response.status === 401 ? 'Your session has ended. Sign in again.' : 'That could not be saved.';
}

/** A read, for the purposes of "this credential may only read". */
function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** The JSON API answers in JSON, including when it refuses. */
function isApi(pathname: string): boolean {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

/**
 * Headers every response carries.
 *
 * `nosniff` matters concretely here: receipts are served with a content type that came from
 * imported data. `frame-ancestors` keeps the admin UI out of somebody else's iframe. The CSP
 * is deliberately narrow — this application loads no third-party script, style, font or
 * image, and the vendored Swagger UI is served from this origin like everything else.
 */
function harden(response: Response): Response {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; " +
      "form-action 'self'",
  );
  return response;
}

export const onRequest = defineMiddleware(async (context, next) => harden(await gate(context, next)));

async function gate(context: APIContext, next: MiddlewareNext): Promise<Response> {
  // Before anything else, including before a session is resolved: a forged cross-site POST
  // must not reach a handler even to be rejected by it. This replaces the framework's own
  // check — see the `security` block in astro.config.mjs for why.
  if (isCrossSiteWrite(context.request, context.url)) {
    return new Response(`Cross-site ${context.request.method} requests are forbidden`, {
      status: 403,
    });
  }

  const token = context.cookies.get(SESSION_COOKIE)?.value;
  const user: SessionUser | null = resolveSession(db(), token);

  context.locals.user = user;
  context.locals.apiToken = null;

  const setupNeeded = needsSetup(db());
  const path = context.url.pathname;

  // ── Harvest's API, answered from this instance ───────────────────────────
  // It checks Harvest's credentials itself (lib/harvest-api/serve.ts), as Harvest would, and
  // answers in Harvest's shapes: no session, no redirect, no rate limit of ours.
  if (path === '/v2' || path.startsWith('/v2/')) return next();

  // ── the JSON API ─────────────────────────────────────────────────────────
  // Handled before everything below, because none of it applies: an API caller must not be
  // redirected to a login page, and a browser session is not the credential it presents.
  if (isApi(path)) {
    const bearer = resolveToken(db(), context.request.headers.get('authorization'));

    // Personal access tokens are read-only by construction, not merely because no write route
    // happens to exist under this prefix today.
    if (bearer && !isRead(context.request.method)) {
      return fail(405, 'method_not_allowed', 'Personal access tokens are read-only.');
    }

    // A session is accepted as well as a token, so the docs page can call these endpoints
    // in the browser as whoever is signed in. A token is the documented way.
    const caller = bearer?.user ?? user;
    if (!caller) return unauthorized();

    // Per token, or per person when a browser session is being used, so one noisy integration
    // cannot spend another's budget.
    const verdict = rateLimit(bearer ? `token:${bearer.tokenId}` : `user:${caller.id}`);
    const headers = rateHeaders(verdict);
    if (!verdict.ok) {
      return fail(429, 'rate_limited', `More than ${headers['RateLimit-Limit']} requests in a minute. Try again in ${headers['RateLimit-Reset']}s.`, headers);
    }

    context.locals.user = caller;
    if (bearer) {
      context.locals.apiToken = { id: bearer.tokenId, name: bearer.tokenName };
      touchToken(db(), bearer.tokenId);
    }

    const response = await next();
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }

  // Downloadable exports are also automation endpoints. A browser session keeps the normal
  // click-to-download flow, while the same read-only bearer tokens used by /api/v1 allow
  // scheduled CSV/PDF exports without storing a user's password or session cookie.
  // Only a Bearer header means "authenticate as a token". Anything else — HTTP Basic added by
  // a reverse proxy, most commonly — is not ours, and must not stop a perfectly good session
  // cookie from being used.
  if (path.startsWith('/export/') && /^Bearer\s/i.test(context.request.headers.get('authorization') ?? '')) {
    const bearer = resolveToken(db(), context.request.headers.get('authorization'));
    if (!bearer) return unauthorized();
    if (!isRead(context.request.method)) {
      return fail(405, 'method_not_allowed', 'Personal access tokens are read-only.');
    }

    const verdict = rateLimit(`token:${bearer.tokenId}`);
    const headers = rateHeaders(verdict);
    if (!verdict.ok) {
      return fail(429, 'rate_limited', `More than ${headers['RateLimit-Limit']} requests a minute.`, headers);
    }

    context.locals.user = bearer.user;
    context.locals.apiToken = { id: bearer.tokenId, name: bearer.tokenName };
    touchToken(db(), bearer.tokenId);
    const response = await next();
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }

  // A missing asset is a 404, never a redirect to a page. See isAsset above.
  if (isAsset(path)) return next();

  if (setupNeeded && (isSetupPath(path) || path === '/api/import/status')) return next();

  // Once the instance is set up, /setup is not a page any more — not even for an admin, who
  // has /import for the same operations with an audit trail behind them.
  if (!setupNeeded && isSetupPath(path)) return context.redirect('/import', 302);

  // Nobody can sign in yet, so a login page would be a dead end. Send them to setup instead.
  if (setupNeeded && !user) return context.redirect('/setup', 302);

  // A CSV import pauses inside its transaction to report progress; a write made meanwhile
  // would join that transaction. See isImportWriting. Reads carry on as normal.
  if (user && context.request.method !== 'GET' && context.request.method !== 'HEAD' && isImportWriting()) {
    const message = 'An import is being written. Try again in a few seconds.';
    if (isFormNavigation(context)) {
      return backToForm(context, new Response(JSON.stringify({ message }), { status: 503 }));
    }
    return new Response(message, { status: 503, headers: { 'Retry-After': '5' } });
  }

  if (user || isPublic(path)) {
    const response = await next();
    return isFormNavigation(context) ? backToForm(context, response) : response;
  }

  // Actions get a 401 rather than a redirect — a form post shouldn't land on a login page
  // rendered inside whatever was expecting JSON.
  if (context.url.pathname.startsWith('/_actions/')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const target = context.url.pathname + context.url.search;
  const next_ = target === '/' ? '' : `?next=${encodeURIComponent(target)}`;
  return context.redirect(`/login${next_}`, 302);
}
