/**
 * Instance settings — the account-level preferences that shape formatting and rounding.
 *
 * These were hardcoded (0.25 rounding, Monday weeks, SEK) while the `settings` table sat
 * empty. Hardcoding them is wrong twice over: the values differ per organization, and a
 * self-hosted instance has no one to change the source for it.
 *
 * Seeded from the Harvest company record at import, editable afterwards.
 */

import type { Db } from './db/index.ts';
import { rows } from './db/index.ts';

export interface Settings {
  /** ISO 4217. Harvest: `company.currency`. */
  currency: string;
  /** 0 = Sunday … 1 = Monday. Harvest: `company.week_start_day`. */
  weekStartDay: number;
  /** Rounding increment in hours. Harvest: `round_to` (0.25 = nearest 15 minutes). */
  roundToHours: number;
  /** Harvest: `rounding_style`. */
  roundingStyle: 'round' | 'up' | 'down';
  /** `hours_minutes` renders 2:30; `decimal` renders 2,5. Harvest: `time_format`. */
  timeFormat: 'hours_minutes' | 'decimal';
  /** How many days back a project stays offered in the picker after being archived. */
  recentProjectDays: number;
  companyName: string;
  /** Harvest: `company.decimal_symbol`. Much of Europe writes 896 398,50, not 896,398.50. */
  decimalSymbol: string;
  /** Harvest: `company.thousands_separator`. A non-breaking space on many European accounts. */
  thousandsSeparator: string;
  /**
   * Month the financial year starts in, 1 = January. Decides where quarters fall.
   *
   * Harvest does not put this in the company record, so there is nothing to import and it
   * simply defaults to January — but it is a setting rather than a literal in a report,
   * because the people who need it are precisely the ones who cannot edit the source.
   */
  fiscalYearStart: number;
}

export const DEFAULT_SETTINGS: Settings = {
  currency: 'SEK',
  weekStartDay: 1,
  roundToHours: 0.25,
  roundingStyle: 'round',
  timeFormat: 'hours_minutes',
  recentProjectDays: 90,
  companyName: '',
  decimalSymbol: '.',
  thousandsSeparator: ',',
  fiscalYearStart: 1,
};

const DAY_NUMBER: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export function readSettings(db: Db): Settings {
  const stored = new Map(
    rows<{ key: string; value: string }>(db.prepare('SELECT key, value FROM settings').all()).map(
      (r) => [r.key, r.value],
    ),
  );

  const num = (key: string, fallback: number) => {
    const raw = Number(stored.get(key));
    return Number.isFinite(raw) ? raw : fallback;
  };

  return {
    currency: stored.get('currency') ?? DEFAULT_SETTINGS.currency,
    weekStartDay: num('week_start_day', DEFAULT_SETTINGS.weekStartDay),
    roundToHours: num('round_to_hours', DEFAULT_SETTINGS.roundToHours),
    roundingStyle:
      (stored.get('rounding_style') as Settings['roundingStyle']) ?? DEFAULT_SETTINGS.roundingStyle,
    timeFormat:
      (stored.get('time_format') as Settings['timeFormat']) ?? DEFAULT_SETTINGS.timeFormat,
    recentProjectDays: num('recent_project_days', DEFAULT_SETTINGS.recentProjectDays),
    companyName: stored.get('company_name') ?? DEFAULT_SETTINGS.companyName,
    // `??` not `||`: a thousands separator of "" is a real choice and must survive.
    decimalSymbol: stored.get('decimal_symbol') ?? DEFAULT_SETTINGS.decimalSymbol,
    thousandsSeparator: stored.get('thousands_separator') ?? DEFAULT_SETTINGS.thousandsSeparator,
    fiscalYearStart: num('fiscal_year_start', DEFAULT_SETTINGS.fiscalYearStart),
  };
}

export function writeSettings(db: Db, values: Partial<Record<string, string | number>>): void {
  const put = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) put.run(key, String(value));
  }
}

/** Map a Harvest company record onto our settings keys. */
export function settingsFromCompany(company: Record<string, unknown>): Record<string, string | number> {
  const week = company.week_start_day;
  const weekStartDay =
    typeof week === 'number' ? week : DAY_NUMBER[String(week ?? '').toLowerCase()] ?? 1;

  return {
    company_name: String(company.name ?? ''),
    currency: String(company.currency ?? DEFAULT_SETTINGS.currency),
    week_start_day: weekStartDay,
    round_to_hours: Number(company.round_to ?? DEFAULT_SETTINGS.roundToHours),
    rounding_style: String(company.rounding_style ?? DEFAULT_SETTINGS.roundingStyle),
    time_format: String(company.time_format ?? DEFAULT_SETTINGS.timeFormat),
    decimal_symbol: String(company.decimal_symbol ?? DEFAULT_SETTINGS.decimalSymbol),
    thousands_separator: String(company.thousands_separator ?? DEFAULT_SETTINGS.thousandsSeparator),
  };
}
