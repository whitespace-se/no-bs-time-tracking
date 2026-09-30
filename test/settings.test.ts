import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/lib/db/index.ts';
import { DEFAULT_SETTINGS, readSettings, settingsFromCompany, writeSettings } from '../src/lib/settings.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-settings-'));
  const database = openDb(join(dir, 'test.db'));
  return { database, cleanup: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function stored(database: ReturnType<typeof openDb>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of database.prepare('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: string }[]) {
    out[r.key] = r.value;
  }
  return out;
}

test('an empty settings table reads as the defaults', () => {
  const { database, cleanup } = fixture();
  try {
    assert.deepEqual(readSettings(database), DEFAULT_SETTINGS);
  } finally {
    cleanup();
  }
});

test('writeSettings then readSettings round-trips every key', () => {
  const { database, cleanup } = fixture();
  try {
    writeSettings(database, {
      currency: 'EUR',
      week_start_day: 0,
      round_to_hours: 0.1,
      rounding_style: 'up',
      time_format: 'decimal',
      recent_project_days: 30,
      company_name: 'Example Studio',
      decimal_symbol: ',',
      thousands_separator: ' ',
      fiscal_year_start: 7,
    });
    assert.deepEqual(readSettings(database), {
      currency: 'EUR',
      weekStartDay: 0,
      roundToHours: 0.1,
      roundingStyle: 'up',
      timeFormat: 'decimal',
      recentProjectDays: 30,
      companyName: 'Example Studio',
      decimalSymbol: ',',
      thousandsSeparator: ' ',
      fiscalYearStart: 7,
    });
  } finally {
    cleanup();
  }
});

test('numbers are stored as text and zero survives the trip', () => {
  const { database, cleanup } = fixture();
  try {
    writeSettings(database, { week_start_day: 0, round_to_hours: 0 });
    assert.deepEqual(stored(database), { round_to_hours: '0', week_start_day: '0' });
    const settings = readSettings(database);
    assert.equal(settings.weekStartDay, 0);
    assert.equal(settings.roundToHours, 0);
  } finally {
    cleanup();
  }
});

test('an empty thousands separator is a real choice and is kept', () => {
  const { database, cleanup } = fixture();
  try {
    writeSettings(database, { thousands_separator: '', company_name: '' });
    assert.equal(readSettings(database).thousandsSeparator, '');
    assert.equal(readSettings(database).companyName, '');
  } finally {
    cleanup();
  }
});

test('writeSettings skips undefined and null values and overwrites the rest', () => {
  const { database, cleanup } = fixture();
  try {
    writeSettings(database, { currency: 'EUR', company_name: 'First' });
    writeSettings(database, { currency: undefined, company_name: null as unknown as string, week_start_day: 0 });
    assert.deepEqual(stored(database), { company_name: 'First', currency: 'EUR', week_start_day: '0' });

    writeSettings(database, { company_name: 'Second' });
    assert.equal(readSettings(database).companyName, 'Second');
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'company_name'").get() as { n: number }).n, 1);
  } finally {
    cleanup();
  }
});

test('non-numeric text in a numeric setting falls back to the default', () => {
  const { database, cleanup } = fixture();
  try {
    writeSettings(database, { week_start_day: 'monday', round_to_hours: 'quarter', fiscal_year_start: 'July' });
    const settings = readSettings(database);
    assert.equal(settings.weekStartDay, DEFAULT_SETTINGS.weekStartDay);
    assert.equal(settings.roundToHours, DEFAULT_SETTINGS.roundToHours);
    assert.equal(settings.fiscalYearStart, DEFAULT_SETTINGS.fiscalYearStart);
  } finally {
    cleanup();
  }
});

test('unknown keys are stored but do not leak into the settings object', () => {
  const { database, cleanup } = fixture();
  try {
    writeSettings(database, { harvest_account_id: 12345 });
    assert.equal(stored(database).harvest_account_id, '12345');
    assert.deepEqual(readSettings(database), DEFAULT_SETTINGS);
  } finally {
    cleanup();
  }
});

test('settingsFromCompany maps a Harvest company record onto setting keys', () => {
  assert.deepEqual(
    settingsFromCompany({
      name: 'Example Studio',
      currency: 'EUR',
      week_start_day: 'Monday',
      round_to: 0.25,
      rounding_style: 'up',
      time_format: 'decimal',
      decimal_symbol: ',',
      thousands_separator: ' ',
      unrelated: 'ignored',
    }),
    {
      company_name: 'Example Studio',
      currency: 'EUR',
      week_start_day: 1,
      round_to_hours: 0.25,
      rounding_style: 'up',
      time_format: 'decimal',
      decimal_symbol: ',',
      thousands_separator: ' ',
    },
  );
});

test('settingsFromCompany reads week start as a name, a number or nothing', () => {
  assert.equal(settingsFromCompany({ week_start_day: 'sunday' }).week_start_day, 0);
  assert.equal(settingsFromCompany({ week_start_day: 'SATURDAY' }).week_start_day, 6);
  assert.equal(settingsFromCompany({ week_start_day: 3 }).week_start_day, 3);
  assert.equal(settingsFromCompany({ week_start_day: 'funday' }).week_start_day, 1);
  assert.equal(settingsFromCompany({}).week_start_day, 1);
});

test('settingsFromCompany fills gaps with the defaults', () => {
  assert.deepEqual(settingsFromCompany({}), {
    company_name: '',
    currency: 'SEK',
    week_start_day: 1,
    round_to_hours: 0.25,
    rounding_style: 'round',
    time_format: 'hours_minutes',
    decimal_symbol: '.',
    thousands_separator: ',',
  });
  assert.equal(settingsFromCompany({ round_to: '0.5' }).round_to_hours, 0.5);
  assert.equal(settingsFromCompany({ round_to: null }).round_to_hours, 0.25);
});

test('a company record written through writeSettings reads back as settings', () => {
  const { database, cleanup } = fixture();
  try {
    writeSettings(database, settingsFromCompany({
      name: 'Example Studio',
      currency: 'NOK',
      week_start_day: 'sunday',
      round_to: 0.5,
      rounding_style: 'down',
      time_format: 'hours_minutes',
      decimal_symbol: ',',
      thousands_separator: '',
    }));
    const settings = readSettings(database);
    assert.deepEqual(settings, {
      ...DEFAULT_SETTINGS,
      companyName: 'Example Studio',
      currency: 'NOK',
      weekStartDay: 0,
      roundToHours: 0.5,
      roundingStyle: 'down',
      decimalSymbol: ',',
      thousandsSeparator: '',
    });
  } finally {
    cleanup();
  }
});
