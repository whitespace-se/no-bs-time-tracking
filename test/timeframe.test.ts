import assert from 'node:assert/strict';
import test from 'node:test';
import { todayIso } from '../src/lib/format.ts';
import {
  TIMEFRAME_KINDS,
  TIMEFRAME_LABELS,
  readTimeframe,
  resolve,
  step,
  type Timeframe,
} from '../src/lib/timeframe.ts';

const options = { weekStartDay: 1, fiscalYearStart: 1 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function span(frame: Timeframe): { from: string; to: string } {
  return { from: frame.from, to: frame.to };
}

test('steps complete calendar months in both directions', () => {
  const september = resolve('month', '2026-09-11', options);
  assert.deepEqual(
    { from: september.from, to: september.to },
    { from: '2026-09-01', to: '2026-09-30' },
  );
  const august = step(september, -1, options);
  const october = step(september, 1, options);
  assert.deepEqual({ from: august.from, to: august.to }, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual({ from: october.from, to: october.to }, { from: '2026-10-01', to: '2026-10-31' });
});

// ── Week ─────────────────────────────────────────────────────────────────────

test('week frames follow the week start day', () => {
  // 2026-09-11 is a Friday.
  const monday = resolve('week', '2026-09-11', { weekStartDay: 1 });
  assert.deepEqual(span(monday), { from: '2026-09-07', to: '2026-09-13' });
  assert.equal(monday.label, 'Week: 07 – 13 Sep 2026');

  const sunday = resolve('week', '2026-09-11', { weekStartDay: 0 });
  assert.deepEqual(span(sunday), { from: '2026-09-06', to: '2026-09-12' });

  const saturday = resolve('week', '2026-09-11', { weekStartDay: 6 });
  assert.deepEqual(span(saturday), { from: '2026-09-05', to: '2026-09-11' });
});

test('every anchor inside a week resolves to the same week', () => {
  const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'];
  for (const date of dates) {
    assert.deepEqual(span(resolve('week', date, options)), { from: '2026-09-07', to: '2026-09-13' });
  }
});

test('week steps cross the year boundary and label both years', () => {
  const turn = resolve('week', '2025-12-31', options);
  assert.deepEqual(span(turn), { from: '2025-12-29', to: '2026-01-04' });
  assert.equal(turn.label, 'Week: 29 Dec 2025 – 04 Jan 2026');

  const next = step(turn, 1, options);
  assert.deepEqual(span(next), { from: '2026-01-05', to: '2026-01-11' });
  assert.equal(next.label, 'Week: 05 – 11 Jan 2026');

  const previous = step(turn, -1, options);
  assert.deepEqual(span(previous), { from: '2025-12-22', to: '2025-12-28' });
  assert.equal(previous.kind, 'week');
});

test('stepping a week with a different start day keeps that start day', () => {
  const frame = resolve('week', '2026-09-11', { weekStartDay: 0 });
  const next = step(frame, 1, { weekStartDay: 0 });
  assert.deepEqual(span(next), { from: '2026-09-13', to: '2026-09-19' });
});

// ── Month ────────────────────────────────────────────────────────────────────

test('month frames know February in leap and common years', () => {
  assert.deepEqual(span(resolve('month', '2024-02-10', options)), { from: '2024-02-01', to: '2024-02-29' });
  const common = resolve('month', '2026-02-28', options);
  assert.deepEqual(span(common), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(common.label, 'Month: 01 – 28 Feb 2026');
});

test('month steps cross the year boundary', () => {
  const january = resolve('month', '2026-01-31', options);
  assert.deepEqual(span(step(january, -1, options)), { from: '2025-12-01', to: '2025-12-31' });
  const december = resolve('month', '2025-12-15', options);
  assert.deepEqual(span(step(december, 1, options)), { from: '2026-01-01', to: '2026-01-31' });
});

test('stepping from a 31-day month into February does not overflow', () => {
  const january = resolve('month', '2026-01-31', options);
  assert.deepEqual(span(step(january, 1, options)), { from: '2026-02-01', to: '2026-02-28' });
});

// ── Quarter ──────────────────────────────────────────────────────────────────

test('quarters are calendar quarters when the fiscal year starts in January', () => {
  const q3 = resolve('quarter', '2026-09-11', options);
  assert.deepEqual(span(q3), { from: '2026-07-01', to: '2026-09-30' });
  assert.equal(q3.label, 'Quarter: 01 Jul – 30 Sep 2026');
  assert.deepEqual(span(resolve('quarter', '2026-01-01', options)), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(span(resolve('quarter', '2026-12-31', options)), { from: '2026-10-01', to: '2026-12-31' });
  // A missing fiscalYearStart means January.
  assert.deepEqual(span(resolve('quarter', '2026-05-05', { weekStartDay: 1 })), { from: '2026-04-01', to: '2026-06-30' });
});

test('quarters follow a July fiscal year start', () => {
  const july = { weekStartDay: 1, fiscalYearStart: 7 };
  assert.deepEqual(span(resolve('quarter', '2026-09-11', july)), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(span(resolve('quarter', '2026-12-15', july)), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(span(resolve('quarter', '2026-02-10', july)), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(span(resolve('quarter', '2026-06-30', july)), { from: '2026-04-01', to: '2026-06-30' });
});

test('a fiscal quarter can straddle the calendar year', () => {
  const november = { weekStartDay: 1, fiscalYearStart: 11 };
  const q1 = resolve('quarter', '2026-01-15', november);
  assert.deepEqual(span(q1), { from: '2025-11-01', to: '2026-01-31' });
  assert.equal(q1.label, 'Quarter: 01 Nov 2025 – 31 Jan 2026');
  // The same quarter seen from its first month.
  assert.deepEqual(span(resolve('quarter', '2025-11-01', november)), { from: '2025-11-01', to: '2026-01-31' });
  assert.deepEqual(span(resolve('quarter', '2026-02-01', november)), { from: '2026-02-01', to: '2026-04-30' });
});

test('quarter steps cross the year boundary', () => {
  const q4 = resolve('quarter', '2026-11-01', options);
  assert.deepEqual(span(step(q4, 1, options)), { from: '2027-01-01', to: '2027-03-31' });
  const q1 = resolve('quarter', '2026-02-01', options);
  assert.deepEqual(span(step(q1, -1, options)), { from: '2025-10-01', to: '2025-12-31' });
});

test('stepping four quarters lands on the same quarter a year on', () => {
  let frame = resolve('quarter', '2026-05-05', { weekStartDay: 1, fiscalYearStart: 4 });
  assert.deepEqual(span(frame), { from: '2026-04-01', to: '2026-06-30' });
  for (let i = 0; i < 4; i++) frame = step(frame, 1, { weekStartDay: 1, fiscalYearStart: 4 });
  assert.deepEqual(span(frame), { from: '2027-04-01', to: '2027-06-30' });
});

// ── Year ─────────────────────────────────────────────────────────────────────

test('year frames are calendar years by default', () => {
  const year = resolve('year', '2026-09-11', options);
  assert.deepEqual(span(year), { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(year.label, 'Year: 01 Jan – 31 Dec 2026');
  assert.deepEqual(span(step(year, -1, options)), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(span(step(year, 1, options)), { from: '2027-01-01', to: '2027-12-31' });
});

test('a July fiscal year runs from July to the following June', () => {
  const july = { weekStartDay: 1, fiscalYearStart: 7 };
  const spring = resolve('year', '2026-03-15', july);
  assert.deepEqual(span(spring), { from: '2025-07-01', to: '2026-06-30' });
  assert.equal(spring.label, 'Year: 01 Jul 2025 – 30 Jun 2026');
  assert.deepEqual(span(resolve('year', '2026-09-11', july)), { from: '2026-07-01', to: '2027-06-30' });
  // The fiscal year's first and last days belong to it.
  assert.deepEqual(span(resolve('year', '2026-07-01', july)), { from: '2026-07-01', to: '2027-06-30' });
  assert.deepEqual(span(resolve('year', '2026-06-30', july)), { from: '2025-07-01', to: '2026-06-30' });
  assert.deepEqual(span(step(spring, -1, july)), { from: '2024-07-01', to: '2025-06-30' });
  assert.deepEqual(span(step(spring, 1, july)), { from: '2026-07-01', to: '2027-06-30' });
});

// ── All time and custom ──────────────────────────────────────────────────────

test('all time spans the bounds and cannot be stepped', () => {
  const frame = resolve('all', '2026-09-11', {
    weekStartDay: 1,
    bounds: { first: '2019-03-04', last: '2026-08-31' },
  });
  assert.deepEqual(span(frame), { from: '2019-03-04', to: '2026-08-31' });
  assert.equal(frame.label, 'All time: 04 Mar 2019 – 31 Aug 2026');
  assert.equal(frame.steppable, false);
  assert.equal(frame.canReturn, false);
  assert.equal(step(frame, 1, options), frame);
  assert.equal(step(frame, -1, options), frame);
});

test('all time without bounds falls back to 2000 through today', () => {
  const frame = resolve('all', '2026-09-11', { weekStartDay: 1 });
  assert.equal(frame.from, '2000-01-01');
  assert.match(frame.to, DATE);
  assert.ok(frame.to >= frame.from);
  const half = resolve('all', '2026-09-11', { weekStartDay: 1, bounds: { first: null, last: '2026-01-31' } });
  assert.deepEqual(span(half), { from: '2000-01-01', to: '2026-01-31' });
});

test('custom frames keep the given range and cannot be stepped', () => {
  const frame = resolve('custom', '2026-09-11', options, { from: '2026-03-03', to: '2026-03-09' });
  assert.deepEqual(span(frame), { from: '2026-03-03', to: '2026-03-09' });
  assert.equal(frame.label, 'Custom: 03 – 09 Mar 2026');
  assert.equal(frame.steppable, false);
  assert.equal(frame.canReturn, false);
  assert.equal(step(frame, 1, options), frame);
});

test('a custom frame without a range is today alone', () => {
  const frame = resolve('custom', '2026-09-11', options);
  assert.match(frame.from, DATE);
  assert.equal(frame.from, frame.to);
});

// ── canReturn ────────────────────────────────────────────────────────────────

test('canReturn is set only for steppable frames that do not contain today', () => {
  assert.equal(resolve('month', '2001-06-15', options).canReturn, true);
  assert.equal(resolve('week', '2001-06-15', options).canReturn, true);
  assert.equal(resolve('year', '2001-06-15', options).canReturn, true);
  assert.equal(resolve('month', todayIso(), options).canReturn, false);
  assert.equal(resolve('week', todayIso(), options).canReturn, false);
  assert.equal(resolve('quarter', todayIso(), options).canReturn, false);
  assert.equal(resolve('year', todayIso(), options).canReturn, false);
});

// ── Kinds and labels ─────────────────────────────────────────────────────────

test('every kind has a label and a frame', () => {
  assert.deepEqual(Object.keys(TIMEFRAME_LABELS).sort(), [...TIMEFRAME_KINDS].sort());
  for (const kind of TIMEFRAME_KINDS) {
    const frame = resolve(kind, '2026-09-11', options);
    assert.equal(frame.kind, kind);
    assert.ok(frame.label.startsWith(`${TIMEFRAME_LABELS[kind]}: `), frame.label);
    assert.ok(frame.from <= frame.to, `${kind}: ${frame.from} > ${frame.to}`);
  }
});

// ── readTimeframe ────────────────────────────────────────────────────────────

test('readTimeframe uses from as an anchor for steppable kinds', () => {
  const url = new URL('http://example.test/reports?kind=quarter&from=2026-02-10&till=2026-02-11');
  const frame = readTimeframe(url, options);
  assert.equal(frame.kind, 'quarter');
  assert.deepEqual(span(frame), { from: '2026-01-01', to: '2026-03-31' });
});

test('readTimeframe defaults to the month containing today', () => {
  const frame = readTimeframe(new URL('http://example.test/reports'), options);
  assert.equal(frame.kind, 'month');
  assert.ok(frame.from.endsWith('-01'));
  assert.equal(frame.canReturn, false);
  assert.ok(frame.from <= todayIso() && todayIso() <= frame.to);
});

test('readTimeframe falls back to month for an unknown kind or a malformed date', () => {
  const unknown = readTimeframe(new URL('http://example.test/?kind=decade&from=2001-06-15'), options);
  assert.equal(unknown.kind, 'month');
  assert.deepEqual(span(unknown), { from: '2001-06-01', to: '2001-06-30' });

  const malformed = readTimeframe(new URL('http://example.test/?kind=week&from=2001-6-15'), options);
  assert.equal(malformed.kind, 'week');
  assert.equal(malformed.canReturn, false);
});

test('readTimeframe reads custom ranges from till or to', () => {
  const till = readTimeframe(new URL('http://example.test/?kind=custom&from=2026-03-03&till=2026-03-09'), options);
  assert.deepEqual(span(till), { from: '2026-03-03', to: '2026-03-09' });
  const to = readTimeframe(new URL('http://example.test/?kind=custom&from=2026-03-03&to=2026-03-09'), options);
  assert.deepEqual(span(to), { from: '2026-03-03', to: '2026-03-09' });
  const both = readTimeframe(new URL('http://example.test/?kind=custom&from=2026-03-03&till=2026-03-05&to=2026-03-09'), options);
  assert.equal(both.to, '2026-03-05');
});

test('readTimeframe replaces malformed custom dates with today', () => {
  const frame = readTimeframe(new URL('http://example.test/?kind=custom&from=yesterday&till=03/09/2026'), options);
  assert.equal(frame.kind, 'custom');
  assert.match(frame.from, DATE);
  assert.equal(frame.from, frame.to);
});

test('readTimeframe puts a custom range typed backwards the right way round', () => {
  const frame = readTimeframe(new URL('http://example.test/?kind=custom&from=2026-03-09&till=2026-03-03'), options);
  assert.equal(frame.from, '2026-03-03');
  assert.equal(frame.to, '2026-03-09');
});
