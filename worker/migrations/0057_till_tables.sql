-- 0057 — which table on the till is this table in NUM.
--
-- WHY THIS CANNOT BE GUESSED
-- Lightspeed K-Series keys its open checks by tableNumber. NUM keys its floor
-- by num_resources.name, which is free text a venue chose -- "Table 7", "T7",
-- "Terrace 2", "Bar 3". Parsing digits out of a name gets it right most of the
-- time, and the one time it is wrong a guest is shown somebody else's dinner
-- and invited to pay for it. That is the exact failure the Square and Clover
-- adapters refuse to risk, and it does not become acceptable because a third
-- till happens to expose the field.
--
-- So the mapping is STORED, and a venue confirms it. The console offers the
-- parsed digits as a suggestion beside each table and a person saves it. Until
-- somebody has, that table simply has no till mapping and falls back to staff
-- typing the figure, exactly as Square and Clover venues do today.
--
-- NULL means unmapped, which is the honest default for every existing row.

ALTER TABLE num_resources ADD COLUMN pos_table TEXT;

CREATE INDEX IF NOT EXISTS idx_resources_pos_table ON num_resources(business_id, pos_table);
