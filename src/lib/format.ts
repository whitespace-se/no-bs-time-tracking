/**
 * Duration and date formatting.
 *
 * The account runs `time_format: hours_minutes`, so `2:00` is canonical for display — not
 * `2,5`. Input is parsed permissively: a Swede on an English UI still types `1,5` out of
 * muscle memory, and someone coming from a decimal setup types `1.5`. Both work, and both
 * render back as `1:30`.
 */

/** Seconds → `h:mm`. Zero renders as a bare `0`, matching Harvest's grid. */
export function formatDuration(seconds: number): string {
  if (!seconds) return '0';
  const sign = seconds < 0 ? '-' : '';
  const total = Math.round(Math.abs(seconds) / 60);
  return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Like formatDuration but blank for zero — what an empty grid cell shows. */
export function formatCell(seconds: number): string {
  return seconds ? formatDuration(seconds) : '';
}

/** Seconds → decimal hours with two places, for reports and CSV. */
export function formatHours(
  seconds: number,
  format?: { decimalSymbol: string; thousandsSeparator: string },
): string {
  const decimal = (seconds / 3600).toFixed(2);
  // Without a format this stays a plain machine number, which is what the CSV export wants.
  // On screen the account's own conventions apply — this one writes 1 266,50, not 1266.50.
  if (!format) return decimal;
  const point = decimal.lastIndexOf('.');
  const grouped = decimal
    .slice(0, point)
    .replace(/\B(?=(\d{3})+(?!\d))/g, format.thousandsSeparator);
  return `${grouped}${format.decimalSymbol}${decimal.slice(point + 1)}`;
}

/**
 * Parse a duration a human typed. Returns seconds, or null if unintelligible.
 *
 *   "1:30" → 5400    "1,5" → 5400     "1.5" → 5400
 *   "90m"  → 5400    "2h"  → 7200     "1h30" → 5400
 *   "2"    → 7200    ""    → 0
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return 0;

  // h:mm
  const colon = /^(\d+):([0-5]?\d)$/.exec(text);
  if (colon) return Number(colon[1]) * 3600 + Number(colon[2]) * 60;

  // 1h30 / 1h30m / 2h
  const hm = /^(\d+)h(?:([0-5]?\d)m?)?$/.exec(text);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2] ?? 0) * 60;

  // 90m
  const mins = /^(\d+)m$/.exec(text);
  if (mins) return Number(mins[1]) * 60;

  // decimal hours, comma or point
  const dec = /^(\d+)(?:[.,](\d+))?$/.exec(text);
  if (dec) return Math.round(Number(`${dec[1]}.${dec[2] ?? 0}`) * 3600);

  return null;
}

/**
 * Round to the account's increment (`round_to`, 0.25 = nearest 15 minutes).
 * This drives `rounded_seconds`, which is what reports and invoices use.
 */
export function roundSeconds(
  seconds: number,
  roundToHours: number,
  style: 'round' | 'up' | 'down' = 'round',
): number {
  const step = Math.round(roundToHours * 3600);
  if (step <= 0) return seconds;
  const fn = style === 'up' ? Math.ceil : style === 'down' ? Math.floor : Math.round;
  return fn(seconds / step) * step;
}

// ── Dates ────────────────────────────────────────────────────────────────────
// spent_date is a plain `YYYY-MM-DD` string throughout. Never a timestamp: an entry
// logged at 23:30 CET belongs to that day, not the previous one in UTC.

export type IsoDate = string;

export function toIsoDate(date: Date): IsoDate {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function parseIsoDate(date: IsoDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/**
 * Which day a week begins on is a per-instance setting, seeded from Harvest's
 * `week_start_day`. Monday across most of Europe, Sunday in the US — never a default
 * buried in a signature.
 */
export function startOfWeek(date: IsoDate, weekStartDay: number): IsoDate {
  const d = parseIsoDate(date);
  const shift = (d.getUTCDay() - weekStartDay + 7) % 7;
  return addDays(date, -shift);
}

export function weekDates(weekStart: IsoDate): IsoDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function isWeekend(date: IsoDate): boolean {
  const day = parseIsoDate(date).getUTCDay();
  return day === 0 || day === 6;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function dayShort(date: IsoDate): string {
  return DAY_NAMES[parseIsoDate(date).getUTCDay()] ?? '';
}

export function dayLong(date: IsoDate): string {
  return DAY_LONG[parseIsoDate(date).getUTCDay()] ?? '';
}

/** `17 Aug` */
export function dayMonth(date: IsoDate): string {
  const d = parseIsoDate(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** `17 – 23 Aug 2026`, collapsing the month when both ends share it. */
export function weekLabel(weekStart: IsoDate): string {
  const start = parseIsoDate(weekStart);
  const end = parseIsoDate(addDays(weekStart, 6));
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const left = sameMonth ? String(start.getUTCDate()) : `${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]}`;
  return `${left} – ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}

const MS_PER_DAY = 86_400_000;

/** Days covered by an inclusive date range: 2026-05-01 to 2026-05-31 is 31, not 30. */
export function daysInclusive(from: IsoDate, to: IsoDate): number {
  return (parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / MS_PER_DAY + 1;
}

export function todayIso(): IsoDate {
  return toIsoDate(new Date());
}

/**
 * Money, written the way the account writes it.
 *
 * Harvest carries `decimal_symbol` and `thousands_separator` on the company record — this
 * account uses a comma and a space, so 896 398,50 rather than 896,398.50. Formatting through
 * a fixed locale would quietly render every figure in a notation the account does not use,
 * and on a self-hosted instance there would be nobody to change the source for them.
 *
 * Takes minor units (öre, cents) and returns the major amount, always with two decimals.
 */
export function formatMoney(
  minorUnits: number,
  format: { decimalSymbol: string; thousandsSeparator: string },
): string {
  const negative = minorUnits < 0;
  const digits = Math.round(Math.abs(minorUnits)).toString().padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, format.thousandsSeparator);
  return `${negative ? '-' : ''}${grouped}${format.decimalSymbol}${fraction}`;
}

/** A plain count — 139 777 — grouped the same way as money. */
export function formatCount(value: number, format: { thousandsSeparator: string }): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, format.thousandsSeparator);
}
