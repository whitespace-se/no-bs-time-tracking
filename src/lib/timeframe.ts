/**
 * Report timeframes — week, month, quarter, year, all time, custom.
 *
 * Harvest's reports are driven by a timeframe you step through with ‹ ›, not by two date
 * fields you retype. That is the difference between "what did we do last month" being one
 * click and being a small chore, and it is why every Harvest report URL carries `kind`.
 *
 * Quarters follow the account's fiscal year start (Harvest: `fiscal_year_start`, 1 = January
 * here, so calendar quarters).
 */

import { addDays, parseIsoDate, startOfWeek, toIsoDate, todayIso, type IsoDate } from './format.ts';

export const TIMEFRAME_KINDS = ['week', 'month', 'quarter', 'year', 'all', 'custom'] as const;
export type TimeframeKind = (typeof TIMEFRAME_KINDS)[number];

export const TIMEFRAME_LABELS: Record<TimeframeKind, string> = {
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
  all: 'All time',
  custom: 'Custom',
};

export interface Timeframe {
  kind: TimeframeKind;
  from: IsoDate;
  to: IsoDate;
  /** `Month: 01 – 31 May 2026` */
  label: string;
  /** False when the range already contains today — nothing to return to. */
  canReturn: boolean;
  /** All time and custom ranges cannot be stepped. */
  steppable: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function ymd(year: number, month: number, day: number): IsoDate {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export interface TimeframeOptions {
  weekStartDay: number;
  /** 1 = January. Harvest's `fiscal_year_start`. */
  fiscalYearStart?: number;
  /** Earliest and latest dates that exist, for the "all time" range. */
  bounds?: { first: IsoDate | null; last: IsoDate | null };
}

/** The range containing `anchor`, for a given kind. */
export function resolve(
  kind: TimeframeKind,
  anchor: IsoDate,
  options: TimeframeOptions,
  custom?: { from: IsoDate; to: IsoDate },
): Timeframe {
  const today = todayIso();
  const date = parseIsoDate(anchor);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  let from: IsoDate;
  let to: IsoDate;
  let label: string;

  switch (kind) {
    case 'week': {
      from = startOfWeek(anchor, options.weekStartDay);
      to = addDays(from, 6);
      label = `Week: ${range(from, to)}`;
      break;
    }
    case 'month': {
      from = ymd(year, month, 1);
      to = ymd(year, month, lastDayOfMonth(year, month));
      label = `Month: ${range(from, to)}`;
      break;
    }
    case 'quarter': {
      const offset = (options.fiscalYearStart ?? 1) - 1;
      const index = Math.floor(((month - offset + 12) % 12) / 3);
      const startMonth = (offset + index * 3) % 12;
      const startYear = month < offset && startMonth > month ? year - 1 : year;
      const endMonth = (startMonth + 2) % 12;
      const endYear = endMonth < startMonth ? startYear + 1 : startYear;
      from = ymd(startYear, startMonth, 1);
      to = ymd(endYear, endMonth, lastDayOfMonth(endYear, endMonth));
      label = `Quarter: ${range(from, to)}`;
      break;
    }
    case 'year': {
      const offset = (options.fiscalYearStart ?? 1) - 1;
      const startYear = month < offset ? year - 1 : year;
      from = ymd(startYear, offset, 1);
      const endMonth = (offset + 11) % 12;
      const endYear = endMonth < offset ? startYear + 1 : startYear;
      to = ymd(endYear, endMonth, lastDayOfMonth(endYear, endMonth));
      label = `Year: ${range(from, to)}`;
      break;
    }
    case 'all': {
      from = options.bounds?.first ?? '2000-01-01';
      to = options.bounds?.last ?? today;
      label = `All time: ${range(from, to)}`;
      break;
    }
    case 'custom': {
      from = custom?.from ?? today;
      to = custom?.to ?? today;
      label = `Custom: ${range(from, to)}`;
      break;
    }
  }

  const steppable = kind !== 'all' && kind !== 'custom';
  return { kind, from, to, label, canReturn: steppable && !(from <= today && today <= to), steppable };
}

/** Move one whole period in either direction. */
export function step(frame: Timeframe, direction: -1 | 1, options: TimeframeOptions): Timeframe {
  if (!frame.steppable) return frame;

  const from = parseIsoDate(frame.from);
  let anchor: IsoDate;

  switch (frame.kind) {
    case 'week':
      anchor = addDays(frame.from, direction * 7);
      break;
    case 'month':
      anchor = shiftMonths(from, direction);
      break;
    case 'quarter':
      anchor = shiftMonths(from, direction * 3);
      break;
    case 'year':
      anchor = shiftMonths(from, direction * 12);
      break;
    default:
      anchor = frame.from;
  }

  return resolve(frame.kind, anchor, options);
}

function shiftMonths(date: Date, months: number): IsoDate {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  return toIsoDate(shifted);
}

/** `01 – 31 May 2026`, collapsing what both ends share. */
function range(from: IsoDate, to: IsoDate): string {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  const day = (d: Date) => String(d.getUTCDate()).padStart(2, '0');

  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
    return `${day(a)} – ${day(b)} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  if (a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${day(a)} ${MONTHS[a.getUTCMonth()]} – ${day(b)} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  return `${day(a)} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()} – ${day(b)} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

export function readTimeframe(url: URL, options: TimeframeOptions): Timeframe {
  const raw = url.searchParams.get('kind');
  const kind: TimeframeKind = TIMEFRAME_KINDS.includes(raw as TimeframeKind)
    ? (raw as TimeframeKind)
    : 'month';

  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('till') ?? url.searchParams.get('to');

  if (kind === 'custom') {
    const start = DATE.test(from ?? '') ? from! : todayIso();
    const end = DATE.test(to ?? '') ? to! : todayIso();
    // Typed the wrong way round, it is still the range that was meant.
    return resolve('custom', todayIso(), options, start <= end ? { from: start, to: end } : { from: end, to: start });
  }

  // `from` doubles as the anchor: any date inside the period resolves to the whole period.
  return resolve(kind, DATE.test(from ?? '') ? from! : todayIso(), options);
}
