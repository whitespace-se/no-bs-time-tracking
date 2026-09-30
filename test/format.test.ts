import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays,
  dayLong,
  dayMonth,
  dayShort,
  daysInclusive,
  formatCell,
  formatCount,
  formatDuration,
  formatHours,
  formatMoney,
  isWeekend,
  parseDuration,
  parseIsoDate,
  roundSeconds,
  startOfWeek,
  toIsoDate,
  todayIso,
  weekDates,
  weekLabel,
} from '../src/lib/format.ts';

const swedish = { decimalSymbol: ',', thousandsSeparator: ' ' };
const english = { decimalSymbol: '.', thousandsSeparator: ',' };

// ── Durations ────────────────────────────────────────────────────────────────

test('formatDuration renders h:mm with a bare 0 for nothing', () => {
  assert.equal(formatDuration(0), '0');
  assert.equal(formatDuration(NaN), '0');
  assert.equal(formatDuration(60), '0:01');
  assert.equal(formatDuration(5400), '1:30');
  assert.equal(formatDuration(3600 * 25), '25:00');
  assert.equal(formatDuration(-5400), '-1:30');
});

test('formatDuration rounds to the nearest minute, carrying into the hour', () => {
  assert.equal(formatDuration(29), '0:00');
  assert.equal(formatDuration(30), '0:01');
  assert.equal(formatDuration(89), '0:01');
  assert.equal(formatDuration(90), '0:02');
  assert.equal(formatDuration(3599), '1:00');
});

test('formatCell is blank for zero and otherwise identical to formatDuration', () => {
  assert.equal(formatCell(0), '');
  assert.equal(formatCell(5400), '1:30');
  assert.equal(formatCell(-60), '-0:01');
});

test('formatHours gives two decimals, plain for machines and grouped for people', () => {
  assert.equal(formatHours(5400), '1.50');
  assert.equal(formatHours(0), '0.00');
  assert.equal(formatHours(1), '0.00');
  assert.equal(formatHours(-5400), '-1.50');
  assert.equal(formatHours(4_559_400), '1266.50');
  assert.equal(formatHours(4_559_400, swedish), '1 266,50');
  assert.equal(formatHours(3600 * 1_234_567, swedish), '1 234 567,00');
  assert.equal(formatHours(3600 * 999, swedish), '999,00');
  assert.equal(formatHours(-4_559_400, english), '-1,266.50');
});

test('parseDuration accepts every notation a human types', () => {
  assert.equal(parseDuration('1:30'), 5400);
  assert.equal(parseDuration('1:5'), 3900);
  assert.equal(parseDuration('0:00'), 0);
  assert.equal(parseDuration('1,5'), 5400);
  assert.equal(parseDuration('1.5'), 5400);
  assert.equal(parseDuration('1.25'), 4500);
  assert.equal(parseDuration('90m'), 5400);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1h30'), 5400);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('2'), 7200);
  assert.equal(parseDuration('0'), 0);
});

test('parseDuration ignores whitespace and case, and blank means zero', () => {
  assert.equal(parseDuration(' 1 : 30 '), 5400);
  assert.equal(parseDuration('1H30M'), 5400);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration('   '), 0);
});

test('parseDuration rejects what it cannot read instead of guessing', () => {
  assert.equal(parseDuration('1:60'), null);
  assert.equal(parseDuration('1h60'), null);
  assert.equal(parseDuration('.5'), null);
  assert.equal(parseDuration('1,'), null);
  assert.equal(parseDuration('-1'), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('1:30:00'), null);
});

test('parseDuration rounds sub-second decimals to whole seconds', () => {
  assert.equal(parseDuration('0.001'), 4);
  assert.equal(parseDuration('0,0001'), 0);
});

test('roundSeconds honours the increment and the rounding style', () => {
  assert.equal(roundSeconds(720, 0.25), 900);
  assert.equal(roundSeconds(720, 0.25, 'round'), 900);
  assert.equal(roundSeconds(720, 0.25, 'down'), 0);
  assert.equal(roundSeconds(720, 0.25, 'up'), 900);
  assert.equal(roundSeconds(901, 0.25, 'up'), 1800);
  assert.equal(roundSeconds(901, 0.25, 'down'), 900);
  assert.equal(roundSeconds(900, 0.25), 900);
  assert.equal(roundSeconds(450, 0.25), 900);
  assert.equal(roundSeconds(449, 0.25), 0);
  assert.equal(roundSeconds(0, 0.25, 'up'), 0);
  assert.equal(roundSeconds(89, 1 / 60), 60);
  assert.equal(roundSeconds(3601, 1, 'down'), 3600);
});

test('roundSeconds with no increment leaves the value untouched', () => {
  assert.equal(roundSeconds(721, 0), 721);
  assert.equal(roundSeconds(721, -0.25, 'up'), 721);
});

// ── Dates ────────────────────────────────────────────────────────────────────

test('toIsoDate and parseIsoDate round-trip in UTC with zero padding', () => {
  assert.equal(toIsoDate(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
  assert.equal(parseIsoDate('2026-02-28').getTime(), Date.UTC(2026, 1, 28));
  assert.equal(toIsoDate(parseIsoDate('2024-02-29')), '2024-02-29');
  // A timestamp late in the evening UTC stays on that day — no local-zone drift.
  assert.equal(toIsoDate(new Date(Date.UTC(2026, 11, 31, 23, 59, 59))), '2026-12-31');
});

test('addDays crosses month, leap-day and year boundaries', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-09-11', 0), '2026-09-11');
  assert.equal(addDays('2026-09-11', 365), '2027-09-11');
});

test('startOfWeek follows the instance week start day', () => {
  // 2026-09-11 is a Friday.
  assert.equal(startOfWeek('2026-09-11', 1), '2026-09-07');
  assert.equal(startOfWeek('2026-09-11', 0), '2026-09-06');
  assert.equal(startOfWeek('2026-09-11', 6), '2026-09-05');
  // The start day itself is its own week start.
  assert.equal(startOfWeek('2026-09-07', 1), '2026-09-07');
  // A Sunday belongs to the previous Monday-week but starts a Sunday-week.
  assert.equal(startOfWeek('2026-09-13', 1), '2026-09-07');
  assert.equal(startOfWeek('2026-09-13', 0), '2026-09-13');
  // Crossing the year boundary.
  assert.equal(startOfWeek('2026-01-01', 1), '2025-12-29');
});

test('weekDates lists the seven days from a week start', () => {
  assert.deepEqual(weekDates('2026-09-07'), [
    '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
  ]);
  assert.deepEqual(weekDates('2025-12-29').slice(-2), ['2026-01-03', '2026-01-04']);
});

test('isWeekend is Saturday and Sunday only', () => {
  assert.equal(isWeekend('2026-09-11'), false);
  assert.equal(isWeekend('2026-09-12'), true);
  assert.equal(isWeekend('2026-09-13'), true);
  assert.equal(isWeekend('2026-09-14'), false);
});

test('day and month names come out in English', () => {
  assert.equal(dayShort('2026-09-11'), 'Fri');
  assert.equal(dayLong('2026-09-11'), 'Friday');
  assert.equal(dayShort('2026-09-13'), 'Sun');
  assert.equal(dayLong('2026-09-13'), 'Sunday');
  assert.equal(dayMonth('2026-08-17'), '17 Aug');
  assert.equal(dayMonth('2026-01-05'), '5 Jan');
});

test('weekLabel collapses the month when both ends share it', () => {
  assert.equal(weekLabel('2026-08-17'), '17 – 23 Aug 2026');
  assert.equal(weekLabel('2026-08-31'), '31 Aug – 6 Sep 2026');
  assert.equal(weekLabel('2025-12-29'), '29 Dec – 4 Jan 2026');
});

test('daysInclusive counts both ends', () => {
  assert.equal(daysInclusive('2026-05-01', '2026-05-31'), 31);
  assert.equal(daysInclusive('2026-05-01', '2026-05-01'), 1);
  assert.equal(daysInclusive('2024-02-01', '2024-02-29'), 29);
  assert.equal(daysInclusive('2025-12-31', '2026-01-01'), 2);
  assert.equal(daysInclusive('2025-01-01', '2025-12-31'), 365);
  assert.equal(daysInclusive('2026-05-02', '2026-05-01'), 0);
});

test('todayIso is a plain ISO date that survives a round trip', () => {
  const today = todayIso();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(toIsoDate(parseIsoDate(today)), today);
  assert.ok(!Number.isNaN(parseIsoDate(today).getTime()));
});

// ── Money and counts ─────────────────────────────────────────────────────────

test('formatMoney writes minor units the way the account writes them', () => {
  assert.equal(formatMoney(89_639_850, swedish), '896 398,50');
  assert.equal(formatMoney(89_639_850, english), '896,398.50');
  assert.equal(formatMoney(123_456_789, english), '1,234,567.89');
  assert.equal(formatMoney(100_000, swedish), '1 000,00');
  assert.equal(formatMoney(99_999, swedish), '999,99');
});

test('formatMoney always shows two decimals, even for tiny and zero amounts', () => {
  assert.equal(formatMoney(0, english), '0.00');
  assert.equal(formatMoney(5, english), '0.05');
  assert.equal(formatMoney(50, english), '0.50');
  assert.equal(formatMoney(100, english), '1.00');
});

test('formatMoney handles negatives and non-integer minor units', () => {
  assert.equal(formatMoney(-125_050, english), '-1,250.50');
  assert.equal(formatMoney(-5, english), '-0.05');
  assert.equal(formatMoney(100.4, english), '1.00');
  assert.equal(formatMoney(100.6, english), '1.01');
});

test('formatMoney with an empty thousands separator does not group', () => {
  assert.equal(formatMoney(123_456_789, { decimalSymbol: '.', thousandsSeparator: '' }), '1234567.89');
});

test('formatCount groups whole numbers like money', () => {
  assert.equal(formatCount(139_777, swedish), '139 777');
  assert.equal(formatCount(139_777, english), '139,777');
  assert.equal(formatCount(999, english), '999');
  assert.equal(formatCount(1000, english), '1,000');
  assert.equal(formatCount(0, english), '0');
  assert.equal(formatCount(-1234, english), '-1,234');
  assert.equal(formatCount(1234.6, english), '1,235');
});
