-- 004_assignment_budget_units — the same split as 003, for the two assignment tables.
--
-- Harvest puts a `budget` on a task assignment and on a user assignment too, and its unit is
-- decided by the *project's* budget_by in exactly the same way:
--
--     budget_by = task        → task_assignments.budget is HOURS
--     budget_by = task_fees   → task_assignments.budget is MONEY
--     budget_by = person      → user_assignments.budget is HOURS
--
-- Only 8 rows in the whole account carry one, all of them hours (a 50-hour task budget stored
-- as 5000). That is precisely why it is worth fixing now: nothing reads these yet, so the
-- correction is free, and a per-task budget bar built later would have been 100× wrong with
-- nothing on screen to make that obvious.

ALTER TABLE task_assignments ADD COLUMN budget_seconds INTEGER;
ALTER TABLE task_assignments ADD COLUMN budget_amount INTEGER;

UPDATE task_assignments
   SET budget_seconds = CASE WHEN (SELECT budget_by FROM projects WHERE id = project_id) = 'task'
                             THEN budget * 36 END,
       budget_amount  = CASE WHEN (SELECT budget_by FROM projects WHERE id = project_id) = 'task_fees'
                             THEN budget END
 WHERE budget IS NOT NULL;

ALTER TABLE task_assignments DROP COLUMN budget;

ALTER TABLE user_assignments ADD COLUMN budget_seconds INTEGER;
ALTER TABLE user_assignments ADD COLUMN budget_amount INTEGER;

UPDATE user_assignments
   SET budget_seconds = CASE WHEN (SELECT budget_by FROM projects WHERE id = project_id) = 'person'
                             THEN budget * 36 END,
       budget_amount  = CASE WHEN (SELECT budget_by FROM projects WHERE id = project_id) NOT IN ('person')
                             THEN budget END
 WHERE budget IS NOT NULL;

ALTER TABLE user_assignments DROP COLUMN budget;
