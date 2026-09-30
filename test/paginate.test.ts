import assert from 'node:assert/strict';
import test from 'node:test';
import { PER_PAGE_OPTIONS, pageHref, pageNumbers, paginate, readPageParams } from '../src/lib/paginate.ts';

const url = (query: string) => new URL(`http://example.test/projects${query}`);

test('readPageParams reads page and a permitted per-page size', () => {
  assert.deepEqual(readPageParams(url('?per=100&page=3')), { page: 3, perPage: 100 });
  assert.deepEqual(readPageParams(url('?per=250')), { page: 1, perPage: 250 });
  assert.deepEqual(readPageParams(url('?per=25&page=1')), { page: 1, perPage: 25 });
});

test('readPageParams falls back to page 1 and 50 per page', () => {
  assert.deepEqual(readPageParams(url('')), { page: 1, perPage: 50 });
  assert.deepEqual(readPageParams(url('?per=30')), { page: 1, perPage: 50 });
  assert.deepEqual(readPageParams(url('?per=abc&page=abc')), { page: 1, perPage: 50 });
  assert.deepEqual(readPageParams(url('?per=&page=')), { page: 1, perPage: 50 });
});

test('readPageParams rejects zero, negative and fractional pages', () => {
  assert.equal(readPageParams(url('?page=0')).page, 1);
  assert.equal(readPageParams(url('?page=-2')).page, 1);
  assert.equal(readPageParams(url('?page=2.5')).page, 1);
  assert.equal(readPageParams(url('?page=Infinity')).page, 1);
});

test('PER_PAGE_OPTIONS is ascending and includes the default', () => {
  assert.deepEqual([...PER_PAGE_OPTIONS], [25, 50, 100, 250]);
  assert.ok(PER_PAGE_OPTIONS.includes(readPageParams(url('')).perPage as 50));
});

test('paginate an empty set shows one empty page', () => {
  assert.deepEqual(paginate(0, 1, 50), {
    page: 1, perPage: 50, offset: 0, total: 0, pages: 1, from: 0, to: 0, hasPrev: false, hasNext: false,
  });
});

test('paginate a set that fits on one page', () => {
  const page = paginate(50, 1, 50);
  assert.equal(page.pages, 1);
  assert.deepEqual({ from: page.from, to: page.to }, { from: 1, to: 50 });
  assert.equal(page.hasPrev, false);
  assert.equal(page.hasNext, false);
});

test('paginate a partial last page', () => {
  const first = paginate(101, 1, 50);
  assert.deepEqual({ pages: first.pages, offset: first.offset, from: first.from, to: first.to }, { pages: 3, offset: 0, from: 1, to: 50 });
  assert.equal(first.hasNext, true);

  const middle = paginate(101, 2, 50);
  assert.deepEqual({ offset: middle.offset, from: middle.from, to: middle.to, hasPrev: middle.hasPrev, hasNext: middle.hasNext },
    { offset: 50, from: 51, to: 100, hasPrev: true, hasNext: true });

  const last = paginate(101, 3, 50);
  assert.deepEqual({ offset: last.offset, from: last.from, to: last.to, hasPrev: last.hasPrev, hasNext: last.hasNext },
    { offset: 100, from: 101, to: 101, hasPrev: true, hasNext: false });
});

test('paginate clamps a page past the end to the last page', () => {
  const page = paginate(100, 9, 25);
  assert.deepEqual(
    { page: page.page, pages: page.pages, offset: page.offset, from: page.from, to: page.to, hasNext: page.hasNext },
    { page: 4, pages: 4, offset: 75, from: 76, to: 100, hasNext: false },
  );
  assert.equal(paginate(0, 7, 25).page, 1);
});

test('pageHref replaces, adds and removes query params on the same path', () => {
  const current = url('?q=abc&page=2&per=50');
  assert.equal(pageHref(current, { page: 3 }), '/projects?q=abc&page=3&per=50');
  assert.equal(pageHref(current, { page: null }), '/projects?q=abc&per=50');
  assert.equal(pageHref(current, { q: '', page: 1 }), '/projects?page=1&per=50');
  assert.equal(pageHref(current, { sort: 'name' }), '/projects?q=abc&page=2&per=50&sort=name');
  assert.equal(pageHref(current, { q: null, page: null, per: null }), '/projects');
});

test('pageHref keeps the path and encodes values, never leaking the host', () => {
  assert.equal(pageHref(url(''), { q: 'a b&c' }), '/projects?q=a+b%26c');
  assert.equal(pageHref(url(''), {}), '/projects');
  assert.equal(pageHref(new URL('http://example.test/clients/7?x=1'), { page: 2 }), '/clients/7?x=1&page=2');
});

test('pageNumbers lists every page when there are seven or fewer', () => {
  assert.deepEqual(pageNumbers(1, 0), []);
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(4, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test('pageNumbers windows around the current page with gaps', () => {
  assert.deepEqual(pageNumbers(5, 41), [1, null, 3, 4, 5, 6, 7, null, 41]);
  assert.deepEqual(pageNumbers(1, 41), [1, 2, 3, null, 41]);
  assert.deepEqual(pageNumbers(41, 41), [1, null, 39, 40, 41]);
});

test('pageNumbers omits a gap that would hide no pages', () => {
  assert.deepEqual(pageNumbers(4, 41), [1, 2, 3, 4, 5, 6, null, 41]);
  assert.deepEqual(pageNumbers(38, 41), [1, null, 36, 37, 38, 39, 40, 41]);
  assert.deepEqual(pageNumbers(5, 8), [1, null, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(pageNumbers(2, 8), [1, 2, 3, 4, null, 8]);
});

test('pageNumbers honours a custom window', () => {
  assert.deepEqual(pageNumbers(20, 41, 0), [1, null, 20, null, 41]);
  assert.deepEqual(pageNumbers(20, 41, 1), [1, null, 19, 20, 21, null, 41]);
});
