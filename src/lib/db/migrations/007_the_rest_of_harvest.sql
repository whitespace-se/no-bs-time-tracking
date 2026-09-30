-- 007_the_rest_of_harvest — everything Harvest's API exposes that was not yet here.
--
-- Decided 2026-09-04: the import is a complete copy of the account short of the Reports
-- API, which is derived from what we already hold. That adds, in one go: client contacts,
-- Harvest's roles (its teams — "Developer", "Management"), expenses with their categories
-- and receipt files, estimates with their lines and send history, the send history of
-- invoices, the two item-category lists, each person's billable and cost rate history, and
-- which people a manager may see. Read-only, all of it, as with invoices (005).
--
-- Every table follows 006: an imported row's id is its Harvest id, `harvest_id` says it was
-- imported, and rows made here would start at 10^12. Money is integer minor units, dates are
-- plain dates, raw payloads are kept in source_json.

CREATE TABLE contacts (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id               INTEGER UNIQUE,
  client_id                INTEGER NOT NULL REFERENCES clients(id),
  title                    TEXT,
  first_name               TEXT    NOT NULL DEFAULT '',
  last_name                TEXT    NOT NULL DEFAULT '',
  email                    TEXT,
  phone_office             TEXT,
  phone_mobile             TEXT,
  fax                      TEXT,
  -- Harvest: none · primary · cc — whether this person gets the client's invoices.
  invoice_recipient_status TEXT    NOT NULL DEFAULT 'none',
  source_json              TEXT,
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_contacts_client ON contacts(client_id, last_name, first_name);

-- Harvest's "roles" are teams, not permissions: a name and the people in it. Permissions
-- are `users.access_roles` (002). Kept apart so the two never get confused.
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  name        TEXT    NOT NULL,
  source_json TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
) STRICT;
CREATE TABLE role_members (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (role_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_role_members_user ON role_members(user_id);

CREATE TABLE expense_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  name        TEXT    NOT NULL,
  unit_name   TEXT,                            -- "km", "timme": priced per unit when set
  unit_price  INTEGER,                         -- minor units
  is_active   INTEGER NOT NULL DEFAULT 1,
  source_json TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  archived_at TEXT
) STRICT;

CREATE TABLE expenses (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id           INTEGER UNIQUE,
  spent_date           TEXT    NOT NULL,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  client_id            INTEGER          REFERENCES clients(id),
  expense_category_id  INTEGER          REFERENCES expense_categories(id),
  notes                TEXT,
  -- Units of the category's unit (kilometres, hours); a plain count, never summed.
  units                REAL    NOT NULL DEFAULT 1,
  total_cost           INTEGER NOT NULL DEFAULT 0,   -- minor units
  billable             INTEGER NOT NULL DEFAULT 0,
  reimbursement        INTEGER NOT NULL DEFAULT 0,
  approval_status      TEXT    NOT NULL DEFAULT 'unsubmitted',
  is_closed            INTEGER NOT NULL DEFAULT 0,
  is_locked            INTEGER NOT NULL DEFAULT 0,
  is_explicitly_locked INTEGER NOT NULL DEFAULT 0,
  locked_reason        TEXT,
  is_billed            INTEGER NOT NULL DEFAULT 0,
  -- The Harvest invoice id, which is `invoices.id` (006). Not a foreign key, for the same
  -- reason as on time_entries: an expense billed on an invoice that has not arrived yet must
  -- still import.
  invoice_id           INTEGER,
  -- The receipt as Harvest describes it, and where its file is in the instance folder once
  -- downloaded — a name under receipts/, never an absolute path, so the folder stays movable.
  receipt_file_name    TEXT,
  receipt_file_size    INTEGER,
  receipt_content_type TEXT,
  receipt_url          TEXT,
  receipt_path         TEXT,
  source_json          TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_expenses_date    ON expenses(spent_date);
CREATE INDEX idx_expenses_user    ON expenses(user_id, spent_date);
CREATE INDEX idx_expenses_project ON expenses(project_id, spent_date);
CREATE INDEX idx_expenses_invoice ON expenses(invoice_id);

CREATE TABLE estimates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id      INTEGER UNIQUE,
  client_id       INTEGER NOT NULL REFERENCES clients(id),
  number          TEXT    NOT NULL,
  state           TEXT    NOT NULL
                    CHECK (state IN ('draft', 'sent', 'accepted', 'declined')),
  subject         TEXT,
  purchase_order  TEXT,
  notes           TEXT,
  currency        TEXT    NOT NULL,
  amount          INTEGER NOT NULL DEFAULT 0,
  tax_rate        REAL,
  tax_amount      INTEGER NOT NULL DEFAULT 0,
  tax2_rate       REAL,
  tax2_amount     INTEGER NOT NULL DEFAULT 0,
  discount_rate   REAL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  issue_date      TEXT    NOT NULL,
  sent_at         TEXT,
  accepted_at     TEXT,
  declined_at     TEXT,
  creator_user_id INTEGER          REFERENCES users(id),
  creator_name    TEXT,
  client_key      TEXT,
  source_json     TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_estimates_client ON estimates(client_id, issue_date);
CREATE INDEX idx_estimates_issue  ON estimates(issue_date);

CREATE TABLE estimate_line_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  kind        TEXT    NOT NULL,
  description TEXT,
  quantity    REAL    NOT NULL DEFAULT 0,
  unit_price  INTEGER NOT NULL DEFAULT 0,
  amount      INTEGER NOT NULL DEFAULT 0,
  taxed       INTEGER NOT NULL DEFAULT 0,
  taxed2      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_eli_estimate ON estimate_line_items(estimate_id, position);

-- What Harvest sent, and to whom. A "send" with no recipients is the invoice being marked
-- as sent by hand, which is what this account does — the paper goes out from the accounting
-- system. Recipients are kept as JSON: a list of name and address pairs nothing joins on.
CREATE TABLE invoice_messages (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id                    INTEGER UNIQUE,
  invoice_id                    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  event_type                    TEXT,        -- send · close · draft · re-open · view
  sent_by                       TEXT,
  sent_by_email                 TEXT,
  sent_from                     TEXT,
  sent_from_email               TEXT,
  recipients_json               TEXT,
  subject                       TEXT,
  body                          TEXT,
  include_link_to_client_invoice INTEGER NOT NULL DEFAULT 0,
  attach_pdf                    INTEGER NOT NULL DEFAULT 0,
  send_me_a_copy                INTEGER NOT NULL DEFAULT 0,
  thank_you                     INTEGER NOT NULL DEFAULT 0,
  reminder                      INTEGER NOT NULL DEFAULT 0,
  send_reminder_on              TEXT,
  source_json                   TEXT,
  created_at                    TEXT    NOT NULL,
  updated_at                    TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_invoice_messages_invoice ON invoice_messages(invoice_id, created_at);

CREATE TABLE estimate_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id      INTEGER UNIQUE,
  estimate_id     INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  event_type      TEXT,
  sent_by         TEXT,
  sent_by_email   TEXT,
  sent_from       TEXT,
  sent_from_email TEXT,
  recipients_json TEXT,
  subject         TEXT,
  body            TEXT,
  send_me_a_copy  INTEGER NOT NULL DEFAULT 0,
  source_json     TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_estimate_messages_estimate ON estimate_messages(estimate_id, created_at);

-- The two pick-lists behind a line's `kind`. Lines keep the name as text (005), because a
-- category renamed or deleted in Harvest must not rewrite years of past invoices.
CREATE TABLE invoice_item_categories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id     INTEGER UNIQUE,
  name           TEXT    NOT NULL,
  use_as_service INTEGER NOT NULL DEFAULT 0,
  use_as_expense INTEGER NOT NULL DEFAULT 0,
  source_json    TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;
CREATE TABLE estimate_item_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  name        TEXT    NOT NULL,
  source_json TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
) STRICT;

-- A person's rate over time. `users.default_billable_rate` and `users.cost_rate` are the
-- current values; these are the dated history Harvest keeps behind them. An open-ended row
-- has null at one or both ends.
CREATE TABLE user_billable_rates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL DEFAULT 0,       -- minor units
  start_date  TEXT,
  end_date    TEXT,
  source_json TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_ubr_user ON user_billable_rates(user_id, start_date);
CREATE TABLE user_cost_rates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL DEFAULT 0,
  start_date  TEXT,
  end_date    TEXT,
  source_json TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_ucr_user ON user_cost_rates(user_id, start_date);

-- Which people a Harvest manager may see. Managers here see everyone; this is the
-- narrower scope Harvest recorded, kept so it is not lost if that ever changes.
CREATE TABLE user_teammates (
  manager_user_id INTEGER NOT NULL REFERENCES users(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (manager_user_id, user_id)
) STRICT, WITHOUT ROWID;
