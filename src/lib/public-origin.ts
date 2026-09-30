/**
 * What this instance looks like from a browser.
 *
 * Two things depend on the answer: whether a POST is same-site, and whether the session cookie
 * may be marked `Secure`. Both are wrong by default behind a reverse proxy, which is how the
 * README tells people to deploy this — the proxy terminates TLS and forwards plain HTTP to
 * localhost, so the request the application sees says `http://localhost:4321` while the
 * browser says `https://track.example.com`.
 *
 * The framework can be told to trust `X-Forwarded-*`, but only at build time, and a build-time
 * hostname is no use to a project that ships one Docker image to many hosts. So the public
 * origin is a runtime setting instead. It is also the honest place for it: whether a forwarded
 * header can be believed is a fact about the deployment, not about the code.
 *
 * Unset — correct for `npm run dev`, and for a container reached directly — the request's own
 * origin is used and the cookie is not marked `Secure`, because the connection is not.
 */

let warned = false;

function configured(): URL | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    if (!warned) {
      warned = true;
      console.warn(`APP_URL is not a valid URL (${raw}); falling back to the request's own origin.`);
    }
    return null;
  }
}

/** The origin a browser sees, against which an `Origin` header is judged. */
export function publicOrigin(requestOrigin: string): string {
  return configured()?.origin ?? requestOrigin;
}

/**
 * Whether browsers reach this instance over TLS, and the session cookie may say `Secure`.
 *
 * Marking it `Secure` on a plain-HTTP deployment would stop the cookie being sent at all, so
 * this answers no unless it is actually known — either because `APP_URL` says https, or
 * because the request itself arrived over TLS.
 */
export function isSecureOrigin(requestUrl: URL): boolean {
  const url = configured();
  if (url) return url.protocol === 'https:';
  return requestUrl.protocol === 'https:';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The CSRF check, failing closed.
 *
 * Every browser has sent `Origin` on same-origin POSTs for years, so a state-changing request
 * without one is not a browser form and gets no benefit of the doubt. This is deliberately
 * stricter than the per-route checks it backs up, which only compare an `Origin` that is
 * present.
 */
export function isCrossSiteWrite(request: Request, url: URL): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  return request.headers.get('origin') !== publicOrigin(url.origin);
}
