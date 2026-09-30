/**
 * GET /api/v1 — what is here.
 *
 * A caller who has a token and no documentation should be able to start from the root and
 * find their way, so this lists every endpoint with its URL rather than assuming they already
 * have the spec.
 */

import type { APIRoute } from 'astro';
import { json, RATE_LIMIT_PER_MINUTE } from '../../../lib/api/http.ts';
import { isPrivileged, RESOURCES } from '../../../lib/api/resources.ts';

export const GET: APIRoute = (context) => {
  const viewer = context.locals.user!;
  const base = `${context.url.origin}/api/v1`;

  return json({
    data: {
      version: 'v1',
      openapi: `${base}/openapi.json`,
      documentation: `${context.url.origin}/docs`,
      rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
      endpoints: [
        { name: 'me', url: `${base}/me`, readable: true, description: 'Who this token belongs to.' },
        ...RESOURCES.map((resource) => ({
          name: resource.name,
          url: `${base}/${resource.name}`,
          readable: resource.access === 'everyone' || isPrivileged(viewer),
          description: resource.summary,
        })),
      ],
    },
  });
};
