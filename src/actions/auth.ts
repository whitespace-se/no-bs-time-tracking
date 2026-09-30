/**
 * Account actions.
 *
 * Sign-in and sign-out live in src/pages/api/ because Astro Actions cannot redirect, and
 * both need to send the browser somewhere specific afterwards.
 */

import { defineAction, ActionError } from 'astro:actions';
import { isSecureOrigin } from '../lib/public-origin.ts';
import { z } from 'astro:schema';
import { db, nowIso, row } from '../lib/db/index.ts';
import { hashPassword, verifyPassword } from '../lib/auth/password.ts';
import { cookieOptions, createSession, destroyAllSessions, SESSION_COOKIE } from '../lib/auth/session.ts';

export const auth = {
  /**
   * Edit your own name and email. Anyone signed in may call it, but it only ever writes the
   * caller's own row — and the schema has no `role` or `is_active`, so this path can never
   * change what a person is allowed to do. Those stay on the admin-only `saveUser`.
   */
  saveProfile: defineAction({
    accept: 'form',
    input: z.object({
      first_name: z.string().max(120).default(''),
      last_name: z.string().max(120).default(''),
      email: z.string().email(),
    }),
    handler: async (input, context) => {
      const user = context.locals.user;
      if (!user) throw new ActionError({ code: 'UNAUTHORIZED', message: 'Sign in first.' });

      const database = db();
      // Email is UNIQUE. Retyping someone else's address is an ordinary mistake, not a 500;
      // the caller's own current address is fine, so it is excluded from the check.
      const taken = row<{ id: number }>(
        database
          .prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?')
          .get(input.email, user.id),
      );
      if (taken) {
        throw new ActionError({ code: 'CONFLICT', message: 'Somebody already uses that email address.' });
      }

      database
        .prepare('UPDATE users SET email = ?, first_name = ?, last_name = ?, updated_at = ? WHERE id = ?')
        .run(input.email, input.first_name.trim(), input.last_name.trim(), nowIso(), user.id);

      return { ok: true };
    },
  }),

  changePassword: defineAction({
    accept: 'form',
    input: z.object({
      current: z.string().min(1),
      next: z.string().min(1, 'Enter a new password.'),
      confirm: z.string().min(1),
    }),
    handler: async (input, context) => {
      const user = context.locals.user;
      if (!user) throw new ActionError({ code: 'UNAUTHORIZED', message: 'Sign in first.' });
      if (input.next !== input.confirm) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'The two new passwords differ.' });
      }

      const database = db();
      const account = row<{ password_hash: string | null }>(
        database.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id),
      );
      if (!(await verifyPassword(input.current, account?.password_hash ?? null))) {
        throw new ActionError({ code: 'FORBIDDEN', message: 'Current password is wrong.' });
      }

      database
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(await hashPassword(input.next), nowIso(), user.id);

      // Changing a password signs out every other device — that is the point of it.
      destroyAllSessions(database, user.id);
      const session = createSession(database, user.id, {
        userAgent: context.request.headers.get('user-agent'),
        ip: context.clientAddress,
      });
      context.cookies.set(SESSION_COOKIE, session.id, cookieOptions(isSecureOrigin(context.url)));

      return { ok: true };
    },
  }),
};
