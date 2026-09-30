-- Invoices imported from a CSV export, which carries an invoice number but no Harvest id.
-- API imports keep using harvest_id; CSV imports key on the number through source_key.

ALTER TABLE invoices ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX idx_invoices_source_key ON invoices(source_key) WHERE source_key IS NOT NULL;
