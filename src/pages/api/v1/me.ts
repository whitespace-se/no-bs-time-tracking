/**
 * GET /api/v1/me — who this token belongs to, and what it may do.
 *
 * The first call anyone makes, and the one that answers "is this token live and which
 * permissions does it carry" without them having to guess from a 403 elsewhere.
 */

import type { APIRoute } from 'astro';
import { json, RATE_LIMIT_PER_MINUTE } from '../../../lib/api/http.ts';
import { isPrivileged } from '../../../lib/api/resources.ts';

export const GET: APIRoute = ({ locals }) => {
  const user = locals.user!;
  return json({
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      privileged: isPrivileged(user),
      token: locals.apiToken ? { id: locals.apiToken.id, name: locals.apiToken.name } : null,
      rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
    },
  });
};
