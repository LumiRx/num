-- iOS shows three lines on a lock screen, not two: title, subtitle, body.
-- The subtitle is where the WHEN and WHERE belong, which is the half of a
-- notification that decides whether somebody acts on it. Until now there was
-- nowhere to store it, so every notification spent its title carrying a time.
--
-- ALTER, not a CREATE TABLE edit: num_notifications already exists in
-- production, so a column added inside its CREATE TABLE IF NOT EXISTS would be
-- a silent no-op on the only database that matters. (See APPLIED.json.)
ALTER TABLE num_notifications ADD COLUMN subtitle TEXT;
