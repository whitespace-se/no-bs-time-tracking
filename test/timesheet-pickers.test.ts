import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, todayIso } from '../src/lib/format.ts';
import { writeSettings } from '../src/lib/settings.ts';
import { projectOptions, taskOptions, tasksByProject } from '../src/lib/timesheet/pickers.ts';
import { addEntry, plain, seedBasics, tempDb, STAMP } from './fixture.ts';

const today = todayIso();

function seeded() {
  const fixture = tempDb();
  const { db } = fixture;
  seedBasics(db);
  db.exec(`
    INSERT INTO projects (id, client_id, name, code, is_active, is_billable, created_at, updated_at)
    VALUES (102, 10, 'Old Sprint', 'OLD', 0, 1, '${STAMP}', '${STAMP}'),
           (103, 10, 'Ancient', NULL, 0, 1, '${STAMP}', '${STAMP}'),
           (104, 11, 'Someone Elses', NULL, 0, 1, '${STAMP}', '${STAMP}');
    INSERT INTO tasks (id, name, billable_by_default, is_active, created_at, updated_at)
    VALUES (202, 'Retired Task', 1, 0, '${STAMP}', '${STAMP}');
    INSERT INTO task_assignments (id, project_id, task_id, is_active, billable, created_at, updated_at)
    VALUES (303, 101, 202, 1, 1, '${STAMP}', '${STAMP}'),
           (304, 101, 201, 0, 1, '${STAMP}', '${STAMP}');
  `);
  // Ada touched the archived sprint last week, the ancient one long ago; Bob touched project 104.
  addEntry(db, { id: 1, date: addDays(today, -7), user: 1, project: 102, task: 200, seconds: 3600 });
  addEntry(db, { id: 2, date: addDays(today, -400), user: 1, project: 103, task: 200, seconds: 3600 });
  addEntry(db, { id: 3, date: addDays(today, -1), user: 2, project: 104, task: 200, seconds: 3600 });
  // Ada uses Retainer three times and Website once, so Retainer ranks first among active projects.
  addEntry(db, { id: 4, date: addDays(today, -2), user: 1, project: 101, task: 201, seconds: 600 });
  addEntry(db, { id: 5, date: addDays(today, -3), user: 1, project: 101, task: 201, seconds: 600 });
  addEntry(db, { id: 6, date: addDays(today, -4), user: 1, project: 101, task: 200, seconds: 600 });
  addEntry(db, { id: 7, date: addDays(today, -5), user: 1, project: 100, task: 200, seconds: 600 });
  return fixture;
}

test('projectOptions offers active projects plus recently used archived ones, ranked by use', () => {
  const { db, cleanup } = seeded();
  try {
    const options = projectOptions(db, 1);
    assert.deepEqual(options.map((o) => [o.id, o.label, o.client_name, o.is_active, o.uses]), [
      [101, 'Retainer', 'Beta Client', 1, 3],
      [100, '[WEB] Website', 'Alpha Client', 1, 1],
      [102, '[OLD] Old Sprint', 'Alpha Client', 0, 1],
    ]);
    // Bob sees the archived project he touched, not Ada's.
    assert.deepEqual(projectOptions(db, 2).map((o) => o.id), [100, 101, 104]);
  } finally {
    cleanup();
  }
});

test('projectOptions honours the recent_project_days setting', () => {
  const { db, cleanup } = seeded();
  try {
    writeSettings(db, { recent_project_days: 3 });
    assert.deepEqual(projectOptions(db, 1).map((o) => o.id), [101, 100]);
    writeSettings(db, { recent_project_days: 500 });
    // 102 and 103 tie on is_active and uses, so they fall through to client then project
    // name: 'Ancient' before 'Old Sprint'.
    assert.deepEqual(projectOptions(db, 1).map((o) => o.id), [101, 100, 103, 102]);
  } finally {
    cleanup();
  }
});

test('taskOptions lists active tasks ordered by this person’s use, then name', () => {
  const { db, cleanup } = seeded();
  try {
    assert.deepEqual(taskOptions(db, 1).map(plain), [
      { id: 200, name: 'Development', uses: 4 },
      { id: 201, name: 'Meeting', uses: 2 },
    ]);
    assert.deepEqual(taskOptions(db, 2).map(plain), [
      { id: 200, name: 'Development', uses: 1 },
      { id: 201, name: 'Meeting', uses: 0 },
    ]);
  } finally {
    cleanup();
  }
});

test('tasksByProject includes only active assignments of active tasks', () => {
  const { db, cleanup } = seeded();
  try {
    const map = tasksByProject(db);
    assert.deepEqual(map[100]?.sort(), [200, 201]);
    // 202 is a retired task and 304 an inactive assignment — neither offered.
    assert.deepEqual(map[101], [200]);
    assert.equal(map[102], undefined);
  } finally {
    cleanup();
  }
});
