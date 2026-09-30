/**
 * Harvest's access grants → this instance's three permission levels.
 *
 * The mapping is declared rather than inferred, so the cases below are about the two rules
 * that make it safe: the highest grant a person holds wins, and a grant nobody has declared
 * is reported instead of quietly being treated as one we know.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { GRANT_LEVEL, mapAccessRoles } from '../src/lib/harvest/roles.ts';
import type { Level } from '../src/lib/harvest/roles.ts';

function level(grants: readonly string[] | null | undefined): Level {
  return mapAccessRoles(grants).level;
}

test('the declared grants are the ones Harvest actually issues, each at one level', () => {
  assert.deepEqual(Object.keys(GRANT_LEVEL).sort(), [
    'administrator',
    'billable_rates_manager',
    'client_and_task_manager',
    'managed_projects_invoice_drafter',
    'manager',
    'member',
    'project_creator',
    'project_manager',
    'time_and_expenses_manager',
  ]);
  for (const [grant, mapped] of Object.entries(GRANT_LEVEL)) {
    assert.ok(['admin', 'manager', 'member'].includes(mapped), `${grant} → ${mapped}`);
  }
  assert.equal(GRANT_LEVEL.administrator, 'admin');
  assert.equal(GRANT_LEVEL.member, 'member');
});

test('nobody is anything until Harvest says so', () => {
  assert.equal(level([]), 'member');
  assert.equal(level(null), 'member');
  assert.equal(level(undefined), 'member');
  assert.deepEqual(mapAccessRoles([]), { level: 'member', unknown: [] });
});

test('the highest grant a person holds decides their level', () => {
  assert.equal(level(['member', 'administrator']), 'admin');
  assert.equal(level(['administrator', 'member']), 'admin', 'order does not matter');
  assert.equal(level(['member', 'project_manager']), 'manager');
  assert.equal(level(['project_manager', 'administrator']), 'admin');
  assert.equal(level(['member']), 'member');
});

test('every manager-level grant reaches manager and no further', () => {
  for (const grant of Object.keys(GRANT_LEVEL).filter((g) => GRANT_LEVEL[g] === 'manager')) {
    assert.equal(level([grant]), 'manager', grant);
  }
  assert.equal(level(['billable_rates_manager']), 'manager', 'a rates manager is a manager, by decision');
});

test('a grant is read case- and whitespace-insensitively', () => {
  assert.equal(level(['  ADMINISTRATOR  ']), 'admin');
  assert.equal(level(['Project_Manager']), 'manager');
  assert.deepEqual(mapAccessRoles(['  ', '']), { level: 'member', unknown: [] }, 'blanks are not grants');
});

test('a grant nobody declared is reported, lowercased, and never guessed at', () => {
  const mapped = mapAccessRoles(['Time_Lord', 'administrator']);
  assert.equal(mapped.level, 'admin', 'the grants we do know still count');
  assert.deepEqual(mapped.unknown, ['time_lord']);

  // Substring matching would make this a manager by accident of spelling.
  const lookalike = mapAccessRoles(['super_manager_of_things']);
  assert.equal(lookalike.level, 'member');
  assert.deepEqual(lookalike.unknown, ['super_manager_of_things']);
});

test('an unknown grant on its own leaves a person at member, not in limbo', () => {
  assert.deepEqual(mapAccessRoles(['brand_new_harvest_grant']), {
    level: 'member',
    unknown: ['brand_new_harvest_grant'],
  });
});

test('a grant repeated twice is reported twice, so a count means something', () => {
  assert.deepEqual(mapAccessRoles(['nope', 'nope']).unknown, ['nope', 'nope']);
});
