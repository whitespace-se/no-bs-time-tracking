-- Stable identifiers for records imported from files that do not contain vendor IDs.
-- API imports continue to use harvest_id; CSV imports use a content-derived source key.

ALTER TABLE time_entries ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX idx_te_source_key ON time_entries(source_key) WHERE source_key IS NOT NULL;
