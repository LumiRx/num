-- NUM · two rows that named an award something it is not called.
--
-- `sayIt()` in worker/editorial.mjs speaks a row's `source` to the guest:
-- "No. 68, North America's 50 Best Bars 2026 (51-100), 2026 (<source>)".
-- So the source string is not a filing label, it is a sentence NUM says out
-- loud, and it has to be the award's actual name.
--
-- Two rows in the first editorial seed carried "50 Best Bars North America".
-- No such award exists. It is called North America's 50 Best Bars. Both rows are
-- duplicates of correctly-named rows the same two venues already hold, from
-- the later categories seed, with the right name, the right date (the list
-- was published 31 Mar 2026, not 1 Apr) and a citable URL:
--
--   Vandell      No. 68  -> already held, correctly named and cited
--   Thunderbolt  No. 92  -> already held, correctly named and cited
--
-- Their score was never wrong: scoreFor takes the strongest live positive and
-- does not stack, and both copies are worth 20. What was wrong is that a tie
-- is broken by load order, so whether a guest heard the award's real name was
-- decided by which row the loop reached first.
--
-- The ids are the loader's natural key -- sha256 of
-- (dest, name, source, awarded_on, accolade), first 32 hex -- so deleting by
-- id removes exactly these two rows and nothing that shares a venue with them.
-- scripts/load_editorial.mjs is INSERT OR IGNORE, so removing them from the
-- seed alone would have left them in the database for ever.
DELETE FROM num_editorial WHERE id IN (
  '23f63f9ee733f434c297a65768824a0b',  -- Vandell, "50 Best Bars North America"
  'f4a0a48fa1296e724481041048d88538'   -- Thunderbolt, "50 Best Bars North America"
);
