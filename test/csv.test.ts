import assert from 'node:assert/strict';
import test from 'node:test';
import { csvResponse, stamped, toCsv } from '../src/lib/csv.ts';
import { parseIsoDate } from '../src/lib/format.ts';

const BOM = '﻿';

test('toCsv writes a BOM, a header row and CRLF line endings', () => {
  assert.equal(toCsv(['a', 'b'], [[1, 'x']]), `${BOM}a,b\r\n1,x\r\n`);
});

test('toCsv with no rows is just the header', () => {
  assert.equal(toCsv(['Date', 'Hours'], []), `${BOM}Date,Hours\r\n`);
});

test('toCsv quotes fields containing delimiters, quotes or newlines', () => {
  const csv = toCsv(['note'], [
    ['plain'],
    ['has, comma'],
    ['has "quotes"'],
    ['line\nbreak'],
    ['carriage\rreturn'],
    ['both, "kinds"'],
  ]);
  assert.deepEqual(csv.slice(BOM.length).split('\r\n'), [
    'note',
    'plain',
    '"has, comma"',
    '"has ""quotes"""',
    '"line\nbreak"',
    '"carriage\rreturn"',
    '"both, ""kinds"""',
    '',
  ]);
});

test('toCsv quotes headers by the same rule', () => {
  assert.equal(toCsv(['Name, first', 'Hours'], []), `${BOM}"Name, first",Hours\r\n`);
});

test('toCsv writes null and undefined as empty fields and stringifies the rest', () => {
  assert.equal(
    toCsv(['a', 'b', 'c', 'd', 'e'], [[null, undefined, 0, false, 1.5]]),
    `${BOM}a,b,c,d,e\r\n,,0,false,1.5\r\n`,
  );
});

test('toCsv leaves non-ASCII text unquoted and intact', () => {
  assert.equal(toCsv(['Client'], [['Åkeriet Öst AB']]), `${BOM}Client\r\nÅkeriet Öst AB\r\n`);
  assert.equal(toCsv(['x'], [['tab\tinside']]), `${BOM}x\r\ntab\tinside\r\n`);
});

test('toCsv does not pad or truncate ragged rows', () => {
  assert.equal(toCsv(['a', 'b'], [[1], [1, 2, 3]]), `${BOM}a,b\r\n1\r\n1,2,3\r\n`);
});

test('csvResponse sets the download headers and carries the body', async () => {
  const body = toCsv(['a'], [[1]]);
  const response = csvResponse('Example Studio 2026.csv', body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="Example Studio 2026.csv"');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  // Response.text() runs a UTF-8 decode, which swallows the BOM. The bytes on the wire — the
  // ones Excel actually reads — still carry it, so assert on those.
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), body);
});

test('csvResponse strips quotes from the filename so the header stays well-formed', () => {
  const response = csvResponse('say "hi".csv', '');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="say hi.csv"');
});

test('stamped appends today as an ISO date and the extension', () => {
  const name = stamped('time-entries');
  const match = /^time-entries-(\d{4}-\d{2}-\d{2})\.csv$/.exec(name);
  assert.ok(match, name);
  assert.ok(!Number.isNaN(parseIsoDate(match[1]!).getTime()));
  assert.match(stamped('report', 'pdf'), /^report-\d{4}-\d{2}-\d{2}\.pdf$/);
});
