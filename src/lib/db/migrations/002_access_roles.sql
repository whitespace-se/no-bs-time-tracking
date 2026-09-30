-- 002_access_roles — keep Harvest's real role grants alongside our permission level.
--
-- Harvest models access as a set of grants: administrator, manager, project_manager, member,
-- plus granular ones like project_creator, billable_rates_manager, client_and_task_manager,
-- time_and_expenses_manager and managed_projects_invoice_drafter. Accounts can use
-- nine distinct combinations.
--
-- `users.role` stays a three-level permission model (admin / manager / member) because that is
-- what this product enforces. But flattening nine combinations into three and keeping no record
-- of the original loses information a migrating account can see is missing — a project_manager
-- becoming "manager" is not obviously right to the person it happened to.
--
-- So the grants are preserved verbatim and shown in the UI. `role` is derived from them.

ALTER TABLE users ADD COLUMN access_roles TEXT;
