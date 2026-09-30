/// <reference types="astro/client" />

import type { SessionUser } from './lib/auth/session.ts';

declare global {
  namespace App {
    interface Locals {
      /** Set by middleware on every request. Null only on public routes. */
      user: SessionUser | null;
      /** Set when the caller authenticated with a personal access token, not a cookie. */
      apiToken: { id: number; name: string } | null;
    }
  }
}

export {};
