/**
 * Harvest's literal strings, pinned.
 *
 * These are matched against stored data and written into SQL. A typo in any of them silently
 * unlocks billed history or files a budget in the wrong unit, and neither failure announces
 * itself — so each value is asserted verbatim here rather than only being read by the code
 * that depends on it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_STATUS,
  BILL_BY,
  BUDGET_BY,
  HOURS_BUDGETS,
  INVOICE_STATE,
  LOCK_REASON,
  MONEY_BUDGETS,
} from '../src/lib/harvest/constants.ts';

test("the four lock reasons are Harvest's own words, verbatim", () => {
  assert.deepEqual({ ...LOCK_REASON }, {
    archived: 'Item Archived',
    invoiced: 'Item Invoiced',
    invoicedAndArchived: 'Item Invoiced and Archived',
    period: 'Item Locked for this Time Period',
  });
  assert.equal(new Set(Object.values(LOCK_REASON)).size, 4, 'no two causes share a string');
});

test('approval has exactly three states, in the order work moves through them', () => {
  assert.deepEqual([...APPROVAL_STATUS], ['unsubmitted', 'submitted', 'approved']);
});

test('bill_by is capitalised the way Harvest capitalises it', () => {
  assert.deepEqual(Object.keys(BILL_BY), ['none', 'Project', 'Tasks', 'People']);
  assert.equal(BILL_BY.none, 'No billing');
  assert.equal(BILL_BY.People, "Person's hourly rate");
});

test('budget_by is not capitalised, and every mode declares its unit', () => {
  assert.deepEqual(Object.keys(BUDGET_BY), ['none', 'project', 'project_cost', 'task', 'task_fees', 'person']);
  for (const [mode, { label, unit }] of Object.entries(BUDGET_BY)) {
    assert.ok(label.length > 0, mode);
    assert.ok(unit === null || unit === 'hours' || unit === 'money', `${mode} → ${unit}`);
  }
  assert.equal(BUDGET_BY.none.unit, null, 'no budget has no unit');
});

test('the two budget sets are derived from the modes, and cannot overlap', () => {
  assert.deepEqual([...HOURS_BUDGETS].sort(), ['person', 'project', 'task']);
  assert.deepEqual([...MONEY_BUDGETS].sort(), ['project_cost', 'task_fees']);
  for (const mode of HOURS_BUDGETS) assert.ok(!MONEY_BUDGETS.has(mode), mode);
  assert.equal(HOURS_BUDGETS.size + MONEY_BUDGETS.size + 1, Object.keys(BUDGET_BY).length, 'plus "none"');
  assert.equal(HOURS_BUDGETS.has('none'), false);
  assert.equal(MONEY_BUDGETS.has('none'), false);
  // A mode Harvest has not invented yet counts as neither, so its budget is left unset.
  assert.equal(HOURS_BUDGETS.has('something_new'), false);
  assert.equal(MONEY_BUDGETS.has('something_new'), false);
});

test('an invoice has four states, two of them terminal', () => {
  assert.deepEqual({ ...INVOICE_STATE }, {
    draft: 'Draft',
    open: 'Open',
    paid: 'Paid',
    closed: 'Closed',
  });
});
