/**
 * Personal access tokens, created and revoked by the person they belong to.
 *
 * A token is always created for the person creating it. An administrator cannot mint one for
 * somebody else, because that token would act as them — an impersonation primitive rather than
 * an administrative convenience.
 *
 * Revoking runs the other way: an administrator may revoke anyone's, since the case that
 * matters is the token whose owner has left and cannot revoke it themselves.
 */

import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro:schema';
import { db, nowIso } from '../lib/db/index.ts';
import { createToken, revokeAnyToken, revokeToken } from '../lib/auth/api-token.ts';
import { log } from '../lib/instance-log.ts';

/** Long enough to outlive a holiday, short enough that a forgotten token expires by itself. */
const EXPIRY_CHOICES = [30, 90, 365, 0] as const;

export const tokens = {
  createApiToken: defineAction({
    accept: 'form',
    input: z.object({
      name: z.string().trim().min(1, 'Give the token a name, so you can tell them apart later.').max(80),
      expires_in_days: z.coerce.number().int().refine((n) => (EXPIRY_CHOICES as readonly number[]).includes(n), 'Pick one of the offered lifetimes.'),
    }),
    handler: (input, context) => {
      const user = context.locals.user;
      if (!user) throw new ActionError({ code: 'UNAUTHORIZED', message: 'Sign in first.' });

      const expiresAt = input.expires_in_days === 0
        ? null
        : new Date(Date.now() + input.expires_in_days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

      const { token, record } = createToken(db(), user.id, input.name, expiresAt);

      // The name and the prefix, never the token. A log is a file that gets copied.
      log.info(`[api] token "${record.name}" (${record.prefix}…) created for ${user.email}`, {
        api_token: { id: record.id, prefix: record.prefix, user: user.id, expires_at: expiresAt },
      });

      // The only time the plaintext exists outside the caller's hands. The page shows it once.
      return { token, prefix: record.prefix, name: record.name, expires_at: expiresAt, created_at: record.created_at };
    },
  }),

  revokeApiToken: defineAction({
    accept: 'form',
    input: z.object({ id: z.coerce.number().int().positive() }),
    handler: (input, context) => {
      const user = context.locals.user;
      if (!user) throw new ActionError({ code: 'UNAUTHORIZED', message: 'Sign in first.' });

      const revoked =
        user.role === 'admin' ? revokeAnyToken(db(), input.id) : revokeToken(db(), user.id, input.id);
      if (!revoked) {
        throw new ActionError({
          code: 'NOT_FOUND',
          message:
            user.role === 'admin'
              ? 'No such token, or it was already revoked.'
              : 'No such token of yours, or it was already revoked.',
        });
      }

      log.info(`[api] token ${input.id} revoked by ${user.email}`, {
        api_token: { id: input.id, user: user.id, revoked_at: nowIso() },
      });
      return { ok: true };
    },
  }),
};

export { EXPIRY_CHOICES };
