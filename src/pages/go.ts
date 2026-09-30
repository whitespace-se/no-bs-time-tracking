import type { APIRoute } from 'astro';
import { startOfWeek, todayIso } from '../lib/format.ts';
import { db } from '../lib/db/index.ts';
import { readSettings } from '../lib/settings.ts';

/**
 * Target for the user switcher, so it works as a plain GET form with no JS.
 * `?user=5&week=2026-08-17` → `/week/2026-08-17/5`
 */
export const GET: APIRoute = ({ url }) => {
  const user = Number(url.searchParams.get('user'));
  const week = url.searchParams.get('week') ?? todayIso();
  const day = url.searchParams.get('day');

  if (!Number.isInteger(user) || user <= 0) {
    return new Response('Bad request', { status: 400 });
  }

  const target = day ? `/day/${day}/${user}` : `/week/${startOfWeek(week, readSettings(db()).weekStartDay)}/${user}`;
  return new Response(null, { status: 302, headers: { Location: target } });
};
