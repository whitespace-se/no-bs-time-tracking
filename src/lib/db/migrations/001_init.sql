-- 001_init — the seven v1 entities plus instance-local bookkeeping.
--
-- Rules this file enforces:
--   · harvest_id UNIQUE on every imported table, our own PK kept separate, so import is
--     ON CONFLICT DO UPDATE and therefore idempotent and re-runnable.
--   · Durations are INTEGER seconds. Never a float. A large account's entries summed as
--     floats drift, and drifted hours on an invoice lose a client.
--   · Money is INTEGER minor units (öre) plus a currency column. Never a float.
--   · source_json keeps the raw payload, so the import is provably lossless.
--   · archived_at everywhere. Nothing is ever hard-deleted; entries reference users and
--     projects forever.
--
-- STRICT tables: SQLite refuses type-mismatched writes rather than silently coercing.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id              INTEGER UNIQUE,
  email                   TEXT    NOT NULL UNIQUE,
  first_name              TEXT    NOT NULL DEFAULT '',
  last_name               TEXT    NOT NULL DEFAULT '',
  role                    TEXT    NOT NULL DEFAULT 'member'
                            CHECK (role IN ('admin', 'manager', 'member')),
  is_active               INTEGER NOT NULL DEFAULT 1,
  is_contractor           INTEGER NOT NULL DEFAULT 0,
  timezone                TEXT,
  weekly_capacity_seconds INTEGER,
  default_billable_rate   INTEGER,           -- minor units
  cost_rate               INTEGER,           -- minor units
  avatar_url              TEXT,
  password_hash           TEXT,              -- null until the user sets one
  source_json             TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  archived_at             TEXT
) STRICT;

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,               -- opaque random token
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  user_agent TEXT,
  ip         TEXT
) STRICT;
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  name        TEXT    NOT NULL,
  address     TEXT,
  currency    TEXT    NOT NULL DEFAULT 'SEK',
  is_active   INTEGER NOT NULL DEFAULT 1,
  source_json TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  archived_at TEXT
) STRICT;
CREATE INDEX idx_clients_active ON clients(is_active, name);

CREATE TABLE tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id          INTEGER UNIQUE,
  name                TEXT    NOT NULL,
  billable_by_default INTEGER NOT NULL DEFAULT 1,
  default_hourly_rate INTEGER,               -- minor units
  is_default          INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  source_json         TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  archived_at         TEXT
) STRICT;
CREATE INDEX idx_tasks_active ON tasks(is_active, name);

CREATE TABLE projects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id          INTEGER UNIQUE,
  client_id           INTEGER NOT NULL REFERENCES clients(id),
  name                TEXT    NOT NULL,
  code                TEXT,                  -- frequently null; not every project has one
  is_active           INTEGER NOT NULL DEFAULT 1,
  is_billable         INTEGER NOT NULL DEFAULT 1,
  is_fixed_fee        INTEGER NOT NULL DEFAULT 0,
  bill_by             TEXT,
  hourly_rate         INTEGER,               -- minor units
  budget              INTEGER,
  budget_by           TEXT,
  budget_is_monthly   INTEGER NOT NULL DEFAULT 0,
  fee                 INTEGER,               -- minor units
  cost_budget         INTEGER,
  currency            TEXT,
  notes               TEXT,
  starts_on           TEXT,
  ends_on             TEXT,
  source_json         TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  archived_at         TEXT
) STRICT;
-- A mature account holds thousands of projects, most archived. The picker searches active
-- ones by name and code.
CREATE INDEX idx_projects_active ON projects(is_active, name);
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_code   ON projects(code);

-- Who may log time to a project, and at what rate.
CREATE TABLE user_assignments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id         INTEGER UNIQUE,
  project_id         INTEGER NOT NULL REFERENCES projects(id),
  user_id            INTEGER NOT NULL REFERENCES users(id),
  is_active          INTEGER NOT NULL DEFAULT 1,
  is_project_manager INTEGER NOT NULL DEFAULT 0,
  use_default_rates  INTEGER NOT NULL DEFAULT 1,
  hourly_rate        INTEGER,
  budget             INTEGER,
  source_json        TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  UNIQUE (project_id, user_id)
) STRICT;
CREATE INDEX idx_ua_user ON user_assignments(user_id, is_active);

-- Which tasks exist on a project. Billability lives HERE, not on the task.
CREATE TABLE task_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  billable    INTEGER NOT NULL DEFAULT 1,
  hourly_rate INTEGER,
  budget      INTEGER,
  source_json TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  UNIQUE (project_id, task_id)
) STRICT;
CREATE INDEX idx_ta_project ON task_assignments(project_id, is_active);

CREATE TABLE time_entries (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id           INTEGER UNIQUE,

  -- A plain date, never a timestamp. An entry logged 23:30 CET belongs to that day.
  spent_date           TEXT    NOT NULL,

  user_id              INTEGER NOT NULL REFERENCES users(id),
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  task_id              INTEGER NOT NULL REFERENCES tasks(id),
  client_id            INTEGER          REFERENCES clients(id),

  duration_seconds     INTEGER NOT NULL DEFAULT 0,
  rounded_seconds      INTEGER NOT NULL DEFAULT 0,   -- after the account rounding rule
  source_hours         REAL,                         -- verbatim, for reconciliation

  notes                TEXT,
  billable             INTEGER NOT NULL DEFAULT 0,
  budgeted             INTEGER NOT NULL DEFAULT 0,
  billable_rate        INTEGER,
  cost_rate            INTEGER,

  -- Retained even though invoicing is out of v1, so a later invoice import reconnects.
  is_billed            INTEGER NOT NULL DEFAULT 0,
  invoice_id           INTEGER,

  -- Four real causes: Item Archived · Item Invoiced · Item Invoiced and Archived ·
  -- Item Locked for this Time Period. Most imported entries arrive locked.
  is_locked            INTEGER NOT NULL DEFAULT 0,
  locked_reason        TEXT,
  is_explicitly_locked INTEGER NOT NULL DEFAULT 0,

  approval_status      TEXT    NOT NULL DEFAULT 'unsubmitted'
                         CHECK (approval_status IN ('unsubmitted', 'submitted', 'approved')),

  is_running           INTEGER NOT NULL DEFAULT 0,
  timer_started_at     TEXT,
  started_time         TEXT,                         -- unused in 13 years of real data
  ended_time           TEXT,

  external_ref_json    TEXT,
  source_json          TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_te_user_date    ON time_entries(user_id, spent_date);
CREATE INDEX idx_te_project_date ON time_entries(project_id, spent_date);
CREATE INDEX idx_te_date         ON time_entries(spent_date);
CREATE INDEX idx_te_task         ON time_entries(task_id);

-- One running timer per user, enforced by the database. Timers get started from two tabs
-- and a phone; the invariant belongs where it cannot be raced.
CREATE UNIQUE INDEX idx_te_one_running ON time_entries(user_id) WHERE is_running = 1;

CREATE TABLE import_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source               TEXT    NOT NULL,             -- 'harvest-api' | 'harvest-csv'
  started_at           TEXT    NOT NULL,
  finished_at          TEXT,
  status               TEXT    NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'ok', 'failed')),
  stats_json           TEXT,
  cursor_updated_since TEXT,                         -- for incremental sync
  error                TEXT
) STRICT;
