-- 006_harvest_ids — an imported row's id *is* its Harvest id.
--
-- The initial schema kept our own autoincrement key beside `harvest_id`. That was later
-- reversed: an organization moving off Harvest has years of links, bookmarks and
-- references in other systems that name projects, people and invoices by Harvest's ids, and
-- an instance that answers to the same ids keeps every one of them working. So every row
-- that came from Harvest takes its Harvest id as its primary key, and every foreign key
-- follows it. `harvest_id` stays, because it is what the upsert keys on and what says a row
-- was imported at all.
--
-- Rows made here rather than in Harvest — a person created from the Team page, a project
-- added after the switch, every time entry logged in this app — get ids from 10^12 upward,
-- in tables that hold Harvest rows. Harvest's ids are global across all its accounts and
-- climb by the second, so a local row at max+1 would sit in a range Harvest is handing out
-- right now, and a sync run while both systems are live could bring back a record wearing
-- the same id. Ten to the twelfth is beyond any id Harvest will issue for centuries, so the
-- two spaces cannot meet. A table with no Harvest rows is left alone: an instance that never
-- imported keeps its small ids, and gains the high range the day it does import.
--
-- Two mechanics worth knowing. Keys are moved to their negatives first, so that a row's new
-- id can never collide with another row's old one mid-statement. And foreign-key checks are
-- deferred to the commit, so parents and children can move in any order; the constraint is
-- still enforced, at the end, on the whole result.

PRAGMA defer_foreign_keys = ON;

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE map_users AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM users WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM users;
CREATE INDEX temp.map_users_old ON map_users(old_id);
UPDATE users SET id = -id;
UPDATE users SET id = (SELECT new_id FROM map_users WHERE old_id = -users.id);
UPDATE sessions SET user_id = (SELECT new_id FROM map_users WHERE old_id = sessions.user_id);

-- ── clients ──────────────────────────────────────────────────────────────────
CREATE TEMP TABLE map_clients AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM clients WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM clients;
CREATE INDEX temp.map_clients_old ON map_clients(old_id);
UPDATE clients SET id = -id;
UPDATE clients SET id = (SELECT new_id FROM map_clients WHERE old_id = -clients.id);
UPDATE projects SET client_id = (SELECT new_id FROM map_clients WHERE old_id = projects.client_id);
UPDATE time_entries SET client_id = (SELECT new_id FROM map_clients WHERE old_id = time_entries.client_id)
 WHERE client_id IS NOT NULL;
UPDATE invoices SET client_id = (SELECT new_id FROM map_clients WHERE old_id = invoices.client_id);

-- ── tasks ────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE map_tasks AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM tasks WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM tasks;
CREATE INDEX temp.map_tasks_old ON map_tasks(old_id);
UPDATE tasks SET id = -id;
UPDATE tasks SET id = (SELECT new_id FROM map_tasks WHERE old_id = -tasks.id);
UPDATE task_assignments SET task_id = (SELECT new_id FROM map_tasks WHERE old_id = task_assignments.task_id);
UPDATE time_entries SET task_id = (SELECT new_id FROM map_tasks WHERE old_id = time_entries.task_id);

-- ── projects ─────────────────────────────────────────────────────────────────
CREATE TEMP TABLE map_projects AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM projects WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM projects;
CREATE INDEX temp.map_projects_old ON map_projects(old_id);
UPDATE projects SET id = -id;
UPDATE projects SET id = (SELECT new_id FROM map_projects WHERE old_id = -projects.id);
UPDATE user_assignments SET project_id = (SELECT new_id FROM map_projects WHERE old_id = user_assignments.project_id);
UPDATE task_assignments SET project_id = (SELECT new_id FROM map_projects WHERE old_id = task_assignments.project_id);
UPDATE time_entries SET project_id = (SELECT new_id FROM map_projects WHERE old_id = time_entries.project_id);
UPDATE invoice_line_items SET project_id = (SELECT new_id FROM map_projects WHERE old_id = invoice_line_items.project_id)
 WHERE project_id IS NOT NULL;

-- users again, for the columns that point at them from tables handled after the first block
UPDATE user_assignments SET user_id = (SELECT new_id FROM map_users WHERE old_id = user_assignments.user_id);
UPDATE time_entries SET user_id = (SELECT new_id FROM map_users WHERE old_id = time_entries.user_id);
UPDATE invoices SET creator_user_id = (SELECT new_id FROM map_users WHERE old_id = invoices.creator_user_id)
 WHERE creator_user_id IS NOT NULL;

-- ── assignments, time entries, invoices, lines, payments ─────────────────────
-- Nothing points at these except the two invoice children, so each is its own key only.
CREATE TEMP TABLE map_ua AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM user_assignments WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM user_assignments;
CREATE INDEX temp.map_ua_old ON map_ua(old_id);
UPDATE user_assignments SET id = -id;
UPDATE user_assignments SET id = (SELECT new_id FROM map_ua WHERE old_id = -user_assignments.id);

CREATE TEMP TABLE map_ta AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM task_assignments WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM task_assignments;
CREATE INDEX temp.map_ta_old ON map_ta(old_id);
UPDATE task_assignments SET id = -id;
UPDATE task_assignments SET id = (SELECT new_id FROM map_ta WHERE old_id = -task_assignments.id);

CREATE TEMP TABLE map_te AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM time_entries WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM time_entries;
CREATE INDEX temp.map_te_old ON map_te(old_id);
UPDATE time_entries SET id = -id;
UPDATE time_entries SET id = (SELECT new_id FROM map_te WHERE old_id = -time_entries.id);

CREATE TEMP TABLE map_invoices AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM invoices WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM invoices;
CREATE INDEX temp.map_invoices_old ON map_invoices(old_id);
UPDATE invoices SET id = -id;
UPDATE invoices SET id = (SELECT new_id FROM map_invoices WHERE old_id = -invoices.id);
UPDATE invoice_line_items SET invoice_id = (SELECT new_id FROM map_invoices WHERE old_id = invoice_line_items.invoice_id);
UPDATE invoice_payments SET invoice_id = (SELECT new_id FROM map_invoices WHERE old_id = invoice_payments.invoice_id);

CREATE TEMP TABLE map_lines AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM invoice_line_items WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM invoice_line_items;
CREATE INDEX temp.map_lines_old ON map_lines(old_id);
UPDATE invoice_line_items SET id = -id;
UPDATE invoice_line_items SET id = (SELECT new_id FROM map_lines WHERE old_id = -invoice_line_items.id);

CREATE TEMP TABLE map_payments AS
  SELECT id AS old_id,
         COALESCE(harvest_id,
                  CASE WHEN EXISTS (SELECT 1 FROM invoice_payments WHERE harvest_id IS NOT NULL)
                       THEN 1000000000000 + id ELSE id END) AS new_id
    FROM invoice_payments;
CREATE INDEX temp.map_payments_old ON map_payments(old_id);
UPDATE invoice_payments SET id = -id;
UPDATE invoice_payments SET id = (SELECT new_id FROM map_payments WHERE old_id = -invoice_payments.id);

-- ── where autoincrement continues from ───────────────────────────────────────
-- AUTOINCREMENT hands out max(sequence, largest rowid) + 1. For a table holding Harvest rows
-- the sequence is parked at 10^12 plus the largest local id it had, so the next local row
-- lands above every id either side will ever use. A table with no Harvest rows keeps
-- counting where it was.
DELETE FROM sqlite_sequence
 WHERE name IN ('users', 'clients', 'tasks', 'projects', 'user_assignments', 'task_assignments',
                'time_entries', 'invoices', 'invoice_line_items', 'invoice_payments');
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'users', MAX(new_id) FROM map_users WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM users WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'clients', MAX(new_id) FROM map_clients WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM clients WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'tasks', MAX(new_id) FROM map_tasks WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM tasks WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'projects', MAX(new_id) FROM map_projects WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM projects WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'user_assignments', MAX(new_id) FROM map_ua WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM user_assignments WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'task_assignments', MAX(new_id) FROM map_ta WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM task_assignments WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'time_entries', MAX(new_id) FROM map_te WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM time_entries WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'invoices', MAX(new_id) FROM map_invoices WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM invoices WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'invoice_line_items', MAX(new_id) FROM map_lines WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM invoice_line_items WHERE harvest_id IS NOT NULL)
  UNION ALL SELECT 'invoice_payments', MAX(new_id) FROM map_payments WHERE new_id >= 1000000000000 OR NOT EXISTS (SELECT 1 FROM invoice_payments WHERE harvest_id IS NOT NULL);
-- A table with Harvest rows and no local ones has no row above 10^12 yet; park it there.
UPDATE sqlite_sequence SET seq = 1000000000000
 WHERE seq IS NULL
   AND name IN (SELECT 'users' WHERE EXISTS (SELECT 1 FROM users WHERE harvest_id IS NOT NULL)
                UNION SELECT 'clients' WHERE EXISTS (SELECT 1 FROM clients WHERE harvest_id IS NOT NULL)
                UNION SELECT 'tasks' WHERE EXISTS (SELECT 1 FROM tasks WHERE harvest_id IS NOT NULL)
                UNION SELECT 'projects' WHERE EXISTS (SELECT 1 FROM projects WHERE harvest_id IS NOT NULL)
                UNION SELECT 'user_assignments' WHERE EXISTS (SELECT 1 FROM user_assignments WHERE harvest_id IS NOT NULL)
                UNION SELECT 'task_assignments' WHERE EXISTS (SELECT 1 FROM task_assignments WHERE harvest_id IS NOT NULL)
                UNION SELECT 'time_entries' WHERE EXISTS (SELECT 1 FROM time_entries WHERE harvest_id IS NOT NULL)
                UNION SELECT 'invoices' WHERE EXISTS (SELECT 1 FROM invoices WHERE harvest_id IS NOT NULL)
                UNION SELECT 'invoice_line_items' WHERE EXISTS (SELECT 1 FROM invoice_line_items WHERE harvest_id IS NOT NULL)
                UNION SELECT 'invoice_payments' WHERE EXISTS (SELECT 1 FROM invoice_payments WHERE harvest_id IS NOT NULL));
DELETE FROM sqlite_sequence WHERE seq IS NULL;

DROP TABLE map_users; DROP TABLE map_clients; DROP TABLE map_tasks; DROP TABLE map_projects;
DROP TABLE map_ua; DROP TABLE map_ta; DROP TABLE map_te; DROP TABLE map_invoices;
DROP TABLE map_lines; DROP TABLE map_payments;
