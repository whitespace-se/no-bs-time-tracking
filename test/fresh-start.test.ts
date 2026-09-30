import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyPassword } from '../src/lib/auth/password.ts';
import { openDb } from '../src/lib/db/index.ts';
import { createFreshAdmin } from '../src/lib/fresh-start.ts';
import { readSettings } from '../src/lib/settings.ts';
import { hasImportedData, needsSetup } from '../src/lib/setup.ts';

test('starts a fully local instance without an import or external API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-bs-time-tracking-fresh-'));
  const database = openDb(join(dir, 'test.db'));
  try {
    assert.equal(needsSetup(database), true);
    assert.equal(hasImportedData(database), false);

    const id = await createFreshAdmin(database, {
      companyName: 'Example Studio',
      email: 'Owner@Example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: 'correct horse battery staple',
    });

    const user = database.prepare(
      'SELECT email, first_name, last_name, role, password_hash FROM users WHERE id = ?',
    ).get(id) as { email: string; first_name: string; last_name: string; role: string; password_hash: string };
    assert.deepEqual(
      { email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role },
      { email: 'owner@example.test', firstName: 'Ada', lastName: 'Lovelace', role: 'admin' },
    );
    assert.equal(await verifyPassword('correct horse battery staple', user.password_hash), true);
    assert.equal(readSettings(database).companyName, 'Example Studio');
    assert.equal(needsSetup(database), false);
    await assert.rejects(() => createFreshAdmin(database, {
      companyName: 'Other', email: 'other@example.test', firstName: 'Other', lastName: '', password: 'another password',
    }), /already contains accounts/);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
