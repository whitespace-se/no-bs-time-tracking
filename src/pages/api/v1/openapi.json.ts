/**
 * GET /api/v1/openapi.json — the machine-readable description of everything below /api/v1.
 *
 * Generated per request from the same declarations the handlers use, so it describes this
 * instance rather than a version of it: the server URL is the one you asked on, and the title
 * carries the company's own name.
 */

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/index.ts';
import { buildOpenApi } from '../../../lib/api/openapi.ts';
import { readSettings } from '../../../lib/settings.ts';

export const GET: APIRoute = (context) => {
  const spec = buildOpenApi(context.url.origin, readSettings(db()).companyName || 'Time tracking');
  return new Response(JSON.stringify(spec, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
