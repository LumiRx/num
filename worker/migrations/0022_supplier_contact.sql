-- 0022 — a supplier needs a phone number, or "just text the photo in" does not work.
--
-- 0019 gave num_suppliers a member_id and nothing else to find them by. That made
-- inbound photo resolution depend entirely on the supplier ALREADY being a NUM
-- member whose verified phone matches the number they texted from. A marina
-- manager in Phuket who preps three boats for a host is not a NUM member and has
-- no reason to become one — and every photo he sent would land in the queue as
-- "unknown sender" forever, which is the feature not working.
--
-- So the phone goes on the supplier. This is not a new privacy position: a host
-- who works with a supplier holds their number already, num_members stores phone
-- numbers in exactly this shape, and this is a business contact rather than a
-- tracking identifier. What we still do NOT store is the sending number on every
-- inbound photo row — see num_inbound_media.from_hash.
--
-- Matching on a column beats matching on a hash here. A hash would have to be
-- computed with the same key in num-growth (which writes it) and num-app (which
-- reads it at inbound time), and a key that is set on one worker and not the
-- other fails by silently recognising nobody. An exact phone match has no shared
-- secret to get wrong.
--
-- EVERY LINE IS ITS OWN ALTER. A column added inside a CREATE TABLE IF NOT EXISTS
-- on a table that already exists is a silent no-op: it reaches a fresh database
-- and no existing one. That is what hid booking_fee_minor for weeks.

ALTER TABLE num_suppliers ADD COLUMN phone TEXT;

ALTER TABLE num_suppliers ADD COLUMN email TEXT;

-- When the host added them, and when the supplier was told. Separate columns
-- because "we created the record" and "a human knows they are on it" are two
-- different facts, and only the second one is consent.
ALTER TABLE num_suppliers ADD COLUMN invited_at TEXT;

ALTER TABLE num_suppliers ADD COLUMN notified_at TEXT;

-- Who added them. A supplier record with no host behind it is one nobody can
-- account for.
ALTER TABLE num_suppliers ADD COLUMN added_by_host TEXT;

-- One supplier per phone per host. Two records for the same person means a photo
-- resolves to whichever row the query happened to order first, and half their
-- fleet goes missing from the other one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_phone_host
  ON num_suppliers(phone, added_by_host) WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_phone ON num_suppliers(phone);
