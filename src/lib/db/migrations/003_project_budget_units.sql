-- 003_project_budget_units — a budget is either hours or money, never "a number".
--
-- Harvest's project object has one `budget` field whose *unit depends on `budget_by`*:
--
--     budget_by = project | task | person   → budget is HOURS
--     budget_by = project_cost | task_fees  → budget is MONEY
--
-- The first import stored all of them through toMinorUnits(), so a 50-hour budget landed as
-- 5000 and a 65 000 SEK fee landed as 6 500 000 — the same column holding two units, with the
-- reader expected to remember which. That is how a budget bar ends up 100× wrong.
--
-- Durations are integer seconds and money is integer minor units, so
-- the field splits in two and the unit is carried by the column name. The backfill is exact:
-- an hours budget was stored as hours × 100, so seconds = value × 36.
--
-- The five over-budget notification settings arrive in the same payload and were only living
-- in source_json; they are ordinary project configuration, so they get columns too.

ALTER TABLE projects ADD COLUMN budget_seconds INTEGER;
ALTER TABLE projects ADD COLUMN budget_amount INTEGER;

UPDATE projects
   SET budget_seconds = CASE WHEN budget_by IN ('project', 'task', 'person')
                             THEN budget * 36 END,
       budget_amount  = CASE WHEN budget_by IN ('project_cost', 'task_fees')
                             THEN budget END
 WHERE budget IS NOT NULL;

ALTER TABLE projects DROP COLUMN budget;

ALTER TABLE projects ADD COLUMN cost_budget_include_expenses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN notify_when_over_budget INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN over_budget_notification_percentage INTEGER;
ALTER TABLE projects ADD COLUMN over_budget_notification_date TEXT;
ALTER TABLE projects ADD COLUMN show_budget_to_all INTEGER NOT NULL DEFAULT 0;

UPDATE projects
   SET cost_budget_include_expenses =
         CASE WHEN json_extract(source_json, '$.cost_budget_include_expenses') IN (1, 'true') THEN 1 ELSE 0 END,
       notify_when_over_budget =
         CASE WHEN json_extract(source_json, '$.notify_when_over_budget') IN (1, 'true') THEN 1 ELSE 0 END,
       over_budget_notification_percentage =
         json_extract(source_json, '$.over_budget_notification_percentage'),
       over_budget_notification_date =
         json_extract(source_json, '$.over_budget_notification_date'),
       show_budget_to_all =
         CASE WHEN json_extract(source_json, '$.show_budget_to_all') IN (1, 'true') THEN 1 ELSE 0 END
 WHERE source_json IS NOT NULL;
