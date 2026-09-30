import type { APIRoute } from 'astro';
import { isSecureOrigin } from '../../../lib/public-origin.ts';
import { createSession, cookieOptions, SESSION_COOKIE } from '../../../lib/auth/session.ts';
import { db } from '../../../lib/db/index.ts';
import { createFreshAdmin } from '../../../lib/fresh-start.ts';
import { hasImportedData, needsSetup } from '../../../lib/setup.ts';

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
  if (!needsSetup(database)) return context.redirect('/', 303);
  if (hasImportedData(database)) return back('This instance already contains imported accounts. Claim yours below.');

  const form = await context.request.formData();
  const companyName = String(form.get('company_name') ?? '').trim();
  const firstName = String(form.get('first_name') ?? '').trim();
  const lastName = String(form.get('last_name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');
  const currency = String(form.get('currency') ?? '').trim().toUpperCase();
  const weekStartDay = form.get('week_start_day') === '0' ? 0 : 1;
  const numberFormat = form.get('number_format') === 'comma' ? 'comma' : 'point';

  if (!companyName) return back('Enter your organization name.');
  if (currency && !/^[A-Z]{3}$/.test(currency)) return back('Use a three-letter currency code, such as EUR.');
  if (!firstName) return back('Enter your first name.');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return back('Enter a valid email address.');
  if (password !== confirm) return back('The two passwords do not match.');
  if (password.length === 0) return back('Enter a password.');

  try {
    const userId = await createFreshAdmin(database, {
      companyName, email, firstName, lastName, password, currency, weekStartDay, numberFormat,
    });
    const session = createSession(database, userId, {
      userAgent: context.request.headers.get('user-agent'),
      ip: context.clientAddress,
    });
    context.cookies.set(SESSION_COOKIE, session.id, cookieOptions(isSecureOrigin(context.url)));
    return context.redirect('/', 303);
  } catch (error) {
    return back(error instanceof Error ? error.message : String(error));
  }
};
