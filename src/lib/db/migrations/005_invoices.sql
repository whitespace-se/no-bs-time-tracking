-- 005_invoices — invoice history, read from Harvest and shown here, never issued here.
--
-- Invoicing is split in two: *reading* history is a solved problem, *writing* invoices
-- is accounting-law scope (bokföringslagen: sequential numbering, immutability after issue,
-- seven-year retention, moms). This migration is the first half only. Nothing in the app
-- creates, edits or numbers an invoice; these rows arrive from the import and are read.
--
-- Three tables, because Harvest has three shapes: the invoice, the lines on it (embedded in
-- the invoice payload) and the payments against it (a separate endpoint per invoice).
--
-- `time_entries.invoice_id` already holds the *Harvest* id of the invoice an entry was
-- billed on — kept as a raw value since 001 precisely so this could reconnect. It keeps
-- that meaning and joins to `invoices.harvest_id`; renaming it to say so would break an
-- older image writing to it, which safe rolling upgrades forbid. The index makes the join
-- cheap from the invoice side, which is the side that gets asked.

CREATE TABLE invoices (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id                  INTEGER UNIQUE,
  client_id                   INTEGER NOT NULL REFERENCES clients(id),
  number                      TEXT    NOT NULL,
  state                       TEXT    NOT NULL
                                CHECK (state IN ('draft', 'open', 'paid', 'closed')),
  subject                     TEXT,
  purchase_order              TEXT,
  notes                       TEXT,
  currency                    TEXT    NOT NULL,

  -- Money is integer minor units. `amount` is the total including tax and after
  -- discount, as Harvest reports it; `due_amount` is what is still unpaid.
  amount                      INTEGER NOT NULL DEFAULT 0,
  due_amount                  INTEGER NOT NULL DEFAULT 0,
  -- Rates are percentages, not money: 25 means 25 %. Harvest allows fractional rates.
  tax_rate                    REAL,
  tax_amount                  INTEGER NOT NULL DEFAULT 0,
  tax2_rate                   REAL,
  tax2_amount                 INTEGER NOT NULL DEFAULT 0,
  discount_rate               REAL,
  discount_amount             INTEGER NOT NULL DEFAULT 0,

  period_start                TEXT,
  period_end                  TEXT,
  issue_date                  TEXT    NOT NULL,
  due_date                    TEXT,
  payment_term                TEXT,
  sent_at                     TEXT,
  paid_at                     TEXT,
  paid_date                   TEXT,
  closed_at                   TEXT,

  -- Who created it in Harvest. Resolved to a local person when the id matches one; the name
  -- is kept regardless, because 13 years of invoices were made by people who have left.
  creator_user_id             INTEGER          REFERENCES users(id),
  creator_name                TEXT,

  -- Harvest ids of things this app does not model. Kept so nothing is lost.
  estimate_harvest_id         INTEGER,
  retainer_harvest_id         INTEGER,
  recurring_invoice_harvest_id INTEGER,
  client_key                  TEXT,

  source_json                 TEXT,
  created_at                  TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_invoices_client ON invoices(client_id, issue_date);
CREATE INDEX idx_invoices_issue  ON invoices(issue_date);
CREATE INDEX idx_invoices_state  ON invoices(state, issue_date);
CREATE INDEX idx_invoices_number ON invoices(number);

-- The lines on an invoice. They travel inside the invoice payload and are replaced with it:
-- a line removed in Harvest is gone from the invoice, so it goes from here too. The invoice's
-- source_json keeps the payload whole.
CREATE TABLE invoice_line_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id  INTEGER UNIQUE,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  project_id  INTEGER          REFERENCES projects(id),
  position    INTEGER NOT NULL DEFAULT 0,          -- order on the invoice
  kind        TEXT    NOT NULL,                    -- Harvest's item category, verbatim
  description TEXT,
  -- A count on a line — 7.5 hours, 3 licences — that is never summed across lines. The
  -- line's money is `amount`, which Harvest computes and which is an integer here.
  quantity    REAL    NOT NULL DEFAULT 0,
  unit_price  INTEGER NOT NULL DEFAULT 0,          -- minor units
  amount      INTEGER NOT NULL DEFAULT 0,          -- minor units
  taxed       INTEGER NOT NULL DEFAULT 0,
  taxed2      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_ili_invoice ON invoice_line_items(invoice_id, position);
CREATE INDEX idx_ili_project ON invoice_line_items(project_id);

CREATE TABLE invoice_payments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_id            INTEGER UNIQUE,
  invoice_id            INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount                INTEGER NOT NULL DEFAULT 0,  -- minor units
  paid_at               TEXT,
  paid_date             TEXT,
  recorded_by           TEXT,
  recorded_by_email     TEXT,
  notes                 TEXT,
  transaction_reference TEXT,
  payment_gateway       TEXT,
  source_json           TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_ip_invoice ON invoice_payments(invoice_id, paid_date);

CREATE INDEX idx_te_invoice ON time_entries(invoice_id);
