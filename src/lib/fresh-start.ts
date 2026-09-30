import { hashPassword } from './auth/password.ts';
import type { Db } from './db/index.ts';
import { nowIso, transaction } from './db/index.ts';
import { DEFAULT_SETTINGS, writeSettings } from './settings.ts';

export interface FreshAdminInput {
  companyName: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  /** ISO 4217. Defaults apply when the caller has nothing to say. */
  currency?: string;
  /** 0 = Sunday, 1 = Monday. */
  weekStartDay?: number;
  /** `point` writes 1,234.50; `comma` writes 1 234,50. */
  numberFormat?: 'point' | 'comma';
}

/**
 * The two separators move together, so the form asks one question instead of two.
 *
 * A Harvest import replaces both from the source account. An empty workspace has no source to
 * read them from, and nothing else in the application lets anyone change them — so getting
 * them wrong here means editing SQL later.
 */
const NUMBER_FORMATS = {
  point: { decimal_symbol: '.', thousands_separator: ',' },
  comma: { decimal_symbol: ',', thousands_separator: ' ' },
} as const;

/** Create the first local administrator without involving any external service. */
export async function createFreshAdmin(database: Db, input: FreshAdminInput): Promise<number> {
  const existing = database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (existing.n !== 0) throw new Error('This instance already contains accounts.');

  const passwordHash = await hashPassword(input.password);
  const now = nowIso();

  return transaction(database, () => {
    const format = NUMBER_FORMATS[input.numberFormat ?? 'point'];
    writeSettings(database, {
      company_name: input.companyName.trim(),
      currency: (input.currency || DEFAULT_SETTINGS.currency).trim().toUpperCase(),
      week_start_day: input.weekStartDay ?? DEFAULT_SETTINGS.weekStartDay,
      decimal_symbol: format.decimal_symbol,
      thousands_separator: format.thousands_separator,
    });
    const result = database
      .prepare(
        `INSERT INTO users (email, first_name, last_name, role, is_active, password_hash,
                            created_at, updated_at)
         VALUES (?, ?, ?, 'admin', 1, ?, ?, ?)`,
      )
      .run(
        input.email.trim().toLowerCase(),
        input.firstName.trim(),
        input.lastName.trim(),
        passwordHash,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  });
}
