import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// `astro:schema` is a virtual module that only exists inside Astro's Vite pipeline. Under
// plain Node it is re-pointed at the package it re-exports, so the schemas can be exercised
// exactly as the actions see them.
registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === 'astro:schema' ? 'astro/zod' : specifier, context);
  },
});

const { checkbox, optionalDate, optionalHours, optionalPercent, optionalRate, optionalText } =
  await import('../src/lib/forms.ts');

test('checkbox is true only for the values a checked box sends', () => {
  assert.equal(checkbox.parse('on'), true);
  assert.equal(checkbox.parse('true'), true);
  assert.equal(checkbox.parse('1'), true);
});

test('checkbox treats absent, blank and anything else as unchecked', () => {
  assert.equal(checkbox.parse(undefined), false);
  assert.equal(checkbox.parse(null), false);
  assert.equal(checkbox.parse(''), false);
  assert.equal(checkbox.parse('false'), false);
  assert.equal(checkbox.parse('0'), false);
  assert.equal(checkbox.parse('yes'), false);
  assert.equal(checkbox.parse('ON'), false);
});

test('checkbox rejects non-form values instead of coercing them', () => {
  assert.equal(checkbox.safeParse(5).success, false);
  assert.equal(checkbox.safeParse(true).success, false);
});

test('optionalText trims and collapses absent or blank to null', () => {
  assert.equal(optionalText.parse('  Notes here  '), 'Notes here');
  assert.equal(optionalText.parse('x'), 'x');
  assert.equal(optionalText.parse(''), null);
  assert.equal(optionalText.parse('   \n\t'), null);
  assert.equal(optionalText.parse(null), null);
  assert.equal(optionalText.parse(undefined), null);
});

test('optionalRate parses point and comma decimals into minor units', () => {
  assert.equal(optionalRate.parse('1250'), 125000);
  assert.equal(optionalRate.parse('1250.50'), 125050);
  assert.equal(optionalRate.parse('1250,50'), 125050);
  assert.equal(optionalRate.parse(' 99,99 '), 9999);
  assert.equal(optionalRate.parse('19.99'), 1999);
  assert.equal(optionalRate.parse('-5'), -500);
});

test('optionalRate keeps an explicit zero but drops blanks and garbage', () => {
  assert.equal(optionalRate.parse('0'), 0);
  assert.equal(optionalRate.parse(''), null);
  assert.equal(optionalRate.parse('   '), null);
  assert.equal(optionalRate.parse(null), null);
  assert.equal(optionalRate.parse(undefined), null);
  assert.equal(optionalRate.parse('abc'), null);
  assert.equal(optionalRate.parse('Infinity'), null);
  // A thousands-grouped figure is not an accepted notation.
  assert.equal(optionalRate.parse('1,250.50'), null);
});

test('optionalDate accepts the ISO shape and nothing else', () => {
  assert.equal(optionalDate.parse('2026-09-11'), '2026-09-11');
  assert.equal(optionalDate.parse(' 2026-09-11 '), '2026-09-11');
  assert.equal(optionalDate.parse(''), null);
  assert.equal(optionalDate.parse(null), null);
  assert.equal(optionalDate.parse(undefined), null);
  assert.equal(optionalDate.parse('11/09/2026'), null);
  assert.equal(optionalDate.parse('2026-9-1'), null);
  assert.equal(optionalDate.parse('2026-09-11T00:00:00Z'), null);
});

test('optionalPercent rounds and clamps to 0–100', () => {
  assert.equal(optionalPercent.parse('80'), 80);
  assert.equal(optionalPercent.parse('0'), 0);
  assert.equal(optionalPercent.parse('100'), 100);
  assert.equal(optionalPercent.parse('150'), 100);
  assert.equal(optionalPercent.parse('-5'), 0);
  assert.equal(optionalPercent.parse('33.6'), 34);
  assert.equal(optionalPercent.parse('33,4'), 33);
});

test('optionalPercent is null for blank or unreadable input', () => {
  assert.equal(optionalPercent.parse(''), null);
  assert.equal(optionalPercent.parse(null), null);
  assert.equal(optionalPercent.parse(undefined), null);
  assert.equal(optionalPercent.parse('lots'), null);
});

test('optionalHours converts decimal hours to whole seconds', () => {
  assert.equal(optionalHours.parse('1.5'), 5400);
  assert.equal(optionalHours.parse('1,5'), 5400);
  assert.equal(optionalHours.parse('40'), 144000);
  assert.equal(optionalHours.parse('0'), 0);
  assert.equal(optionalHours.parse('0.0001'), 0);
  assert.equal(optionalHours.parse('0.001'), 4);
});

test('optionalHours is null for blank or unreadable input', () => {
  assert.equal(optionalHours.parse(''), null);
  assert.equal(optionalHours.parse(null), null);
  assert.equal(optionalHours.parse(undefined), null);
  assert.equal(optionalHours.parse('1:30'), null);
});
