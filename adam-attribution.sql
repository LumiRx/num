-- =====================================================================
-- Adam — Edinburgh hotel sheet: attribution + direct booking
-- 1 Sep 2026.  Supersedes the earlier draft.
--
--   cd ~/num-worktrees/app-main
--   npx wrangler d1 execute num-db --remote --file ./adam-attribution.sql
--
-- 13 hotels.  23 rows in `places`, because the directory lists most of
-- them more than once.  Every duplicate was resolved BY ADDRESS AND
-- POSTCODE, not by name — see the notes at the bottom for the two
-- name-matches that would have been wrong.
--
-- Read STEP 0 before running.  Two values are blank on purpose.
-- =====================================================================


-- ── STEP 0 · Adam ────────────────────────────────────────────────────
--
-- Rates are LOCKED AT SIGN-UP and copied onto every hotel below, so these
-- numbers become a debt to a real person the moment this row lands. They
-- are the published scout structure, unchanged:
--
--   finder_cents      500   $5.00 per business
--   finder_gate_minor 500   released once that business produces $5 to NUM
--   share_bps        2000   20% of NUM's commission
--   sub_share_bps    2000   20% of subscription revenue
--   term_months        24
--
-- FILL IN TWO THINGS. Neither is guessed.
--   <<ADAM_EMAIL>>    his email. email_lc is UNIQUE, so it is his identity.
--   <<AGREED_DATE>>   the date he actually agreed, YYYY-MM-DD.
--
-- On terms_version: no scout terms have been published yet. Writing 'v1'
-- would put in a money ledger that Adam agreed to a document that does not
-- exist. 'pre-terms-2026-09-01' says what is true.

INSERT INTO num_scouts
  (id, name, email, email_lc, code, status, terms_version, agreed_at,
   finder_cents, finder_gate_minor, share_bps, sub_share_bps, term_months, notes)
VALUES
  ('sc_adam', 'Adam', '<<ADAM_EMAIL>>', lower('<<ADAM_EMAIL>>'), 'ADAM', 'active',
   'pre-terms-2026-09-01', '<<AGREED_DATE>>',
   500, 500, 2000, 2000, 24,
   'Edinburgh hotel sheet, Sep 2026. Sourced jointly with Sean; credited to Adam per decision 1 Sep 2026. Recorded before scout terms were published.');


-- ── STEP 1 · make the nine chain hotels bookable ─────────────────────
--
-- Until this deploy NUM had no idea a Hilton, Marriott or IHG property was
-- bookable at all, so /api/book/link answered bookable:false for every one
-- of them. No link was ever handed out, so no attribution could ever have
-- fired. Fixing the tracking without this would have tracked nothing.
--
-- EVERY CODE BELOW IS READ OUT OF the website already stored on that row —
-- not matched by name. Both directions agree: NUM rebuilds the deep link
-- from the stored page and lands on the exact URL in Adam's PDF.

UPDATE places SET booking_platform='hilton',   booking_ref='ednchqq' WHERE id='5f3713f92a7ea5ef90f3'; -- Caledonian, Curio Collection
UPDATE places SET booking_platform='hilton',   booking_ref='edicahi' WHERE id='bdddaa30dd63366706d4'; -- Hilton Edinburgh Carlton
UPDATE places SET booking_platform='hilton',   booking_ref='ediccdi' WHERE id='68503ea7be70140a82d5'; -- DoubleTree City Centre
UPDATE places SET booking_platform='marriott', booking_ref='edilg'   WHERE id='bef757c0dc204dece336'; -- The Edinburgh Grand
UPDATE places SET booking_platform='marriott', booking_ref='ediwh'   WHERE id='3aba93ac539fdf75f8e0'; -- W Edinburgh
UPDATE places SET booking_platform='marriott', booking_ref='edisi'   WHERE id='624ee133577cba9c23c6'; -- Sheraton Grand
UPDATE places SET booking_platform='marriott', booking_ref='ediak'   WHERE id='99bde69d13eec429db40'; -- Glasshouse, Autograph
UPDATE places SET booking_platform='ihg',      booking_ref='edigs'   WHERE id='a7a20729e5bf35469e53'; -- InterContinental The George
UPDATE places SET booking_platform='ihg',      booking_ref='edics'   WHERE id='b511cc7cecae87d31644'; -- Kimpton Charlotte Square

-- The DUPLICATE rows get the same codes, so a guest handed the other row
-- still gets a working booking link and still credits Adam.
UPDATE places SET booking_platform='hilton',   booking_ref='ednchqq' WHERE id='c0dde95cb98fc62f5dc7';
UPDATE places SET booking_platform='hilton',   booking_ref='edicahi' WHERE id='61d5feba0213f2cadbaa';
UPDATE places SET booking_platform='hilton',   booking_ref='ediccdi' WHERE id='1903d3cf786082949d0e';
UPDATE places SET booking_platform='marriott', booking_ref='edisi'   WHERE id='194f4a924c384832f0ac';
UPDATE places SET booking_platform='marriott', booking_ref='ediak'   WHERE id='1cb55fdd812ba0079271';
UPDATE places SET booking_platform='ihg',      booking_ref='edics'   WHERE id='99f05489e326157a460c';

-- The four independents get nothing here, deliberately. The sheet itself
-- says they have no fixed deep-link pattern, and inventing one produces a
-- dead booking button — worse than the phone number NUM already shows.
-- (The Fingal DOES run SynXis on book.fingal.co.uk, which booking.mjs can
-- already read. It needs the hotel/chain id pair, which is one page fetch
-- away — say the word and I will get it.)


-- ── STEP 2 · all 23 rows, under Adam ─────────────────────────────────
--
-- UNIQUE(place_id) enforces one business / one scout in the database rather
-- than in code that might forget. It does NOT stop one scout holding many
-- places — so where the directory lists a hotel twice, BOTH rows are
-- credited. Crediting one would lose the attribution roughly half the time,
-- depending on which row a guest happened to be handed.
--
-- Said out loud: the finder's fee is per ROW, so two live rows for one hotel
-- could pay $5 twice. The gate makes that unlikely — a row pays nothing
-- until it has produced $5 of real revenue, and an unused duplicate never
-- will. The clean fix is a dedupe pass on `places`, noted at the bottom.

INSERT INTO num_scout_places (id, scout_id, place_id, biz_name, dest, country, state, finder_cents, finder_gate_minor, share_bps, sub_share_bps) VALUES
 -- 1 · The Caledonian, Curio Collection by Hilton — EH1 2AB
 ('sp_cal_a','sc_adam','5f3713f92a7ea5ef90f3','The Caledonian Edinburgh, Curio Collection by Hilton','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_cal_b','sc_adam','c0dde95cb98fc62f5dc7','The Caledonian Edinburgh (2nd listing, EH1 2AB)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 2 · Hilton Edinburgh Carlton — 19 North Bridge EH1 1SD
 ('sp_car_a','sc_adam','bdddaa30dd63366706d4','Hilton Edinburgh Carlton','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_car_b','sc_adam','61d5feba0213f2cadbaa','The Hilton Carlton Edinburgh (2nd listing)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 3 · DoubleTree by Hilton City Centre — 34 Bread Street EH3 9AF
 ('sp_dt_a','sc_adam','68503ea7be70140a82d5','DoubleTree by Hilton Hotel Edinburgh City Centre','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_dt_b','sc_adam','1903d3cf786082949d0e','DoubleTree by Hilton Edinburgh City Centre (2nd listing)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 4 · The Edinburgh Grand — 42 St Andrew Square EH2 2AD (one row only)
 ('sp_grand','sc_adam','bef757c0dc204dece336','The Edinburgh Grand, a Luxury Collection Hotel','edinburgh','GB','introduced',500,500,2000,2000),
 -- 5 · W Edinburgh — 1 St James Place (one row only)
 ('sp_w','sc_adam','3aba93ac539fdf75f8e0','W Edinburgh','edinburgh','GB','introduced',500,500,2000,2000),
 -- 6 · Sheraton Grand — 1 Festival Square EH3 9SR
 ('sp_sher_a','sc_adam','624ee133577cba9c23c6','Sheraton Grand Hotel & Spa, Edinburgh','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_sher_b','sc_adam','194f4a924c384832f0ac','Sheraton Hotel (2nd listing, EH3 9SR)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 7 · The Glasshouse, Autograph Collection — EH1 3AA
 ('sp_glass_a','sc_adam','99bde69d13eec429db40','The Glasshouse, Autograph Collection','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_glass_b','sc_adam','1cb55fdd812ba0079271','The Glasshouse (2nd listing, EH1 3AA)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 8 · InterContinental The George — 19-21 George Street EH2 2PB (one row)
 ('sp_george','sc_adam','a7a20729e5bf35469e53','InterContinental Edinburgh The George','edinburgh','GB','introduced',500,500,2000,2000),
 -- 9 · Kimpton Charlotte Square — the code-bearing row is misspelled "Kinston"
 ('sp_kimp_a','sc_adam','b511cc7cecae87d31644','Kimpton Charlotte Square Hotel (listed as Kinston)','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_kimp_b','sc_adam','99f05489e326157a460c','Kimpton Charlotte Square Hotel (2nd listing)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 10 · The Fingal — all four rows, Alexandra Dock EH6 7DX. "MV Fingal" is
 --      the vessel's own name: Fingal is a converted lighthouse tender, so
 --      all four are the same floating hotel at the same dock.
 ('sp_fing_a','sc_adam','4215fb8c262ed4517ba6','The Fingal','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_fing_b','sc_adam','4faf31ef419a538ed13f','Fingal (2nd listing, 1 Alexandra Dock)','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_fing_c','sc_adam','9551de1d47c1e0ac0379','Fingal Hotel (3rd listing, Dock Pl)','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_fing_d','sc_adam','94d131ab7b95634d0236','MV Fingal (4th listing, the vessel)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 11 · The Balmoral — 1 Princes Street EH2 2EQ (one row only; see notes)
 ('sp_balm','sc_adam','0ec3a0439239dc0d806e','The Balmoral, a Rocco Forte hotel','edinburgh','GB','introduced',500,500,2000,2000),
 -- 12 · Tigerlily — 125 George Street EH2 4JN, listed as hotel and restaurant
 ('sp_tiger_a','sc_adam','60006dce7a955ad1d983','Tigerlily','edinburgh','GB','introduced',500,500,2000,2000),
 ('sp_tiger_b','sc_adam','b636c826269191be82dd','Tigerlily (restaurant listing, same address)','edinburgh','GB','introduced',500,500,2000,2000),
 -- 13 · The Witchery by the Castle — 352 Castlehill EH1 2NF (one row only)
 ('sp_witch','sc_adam','50d18330782703df7da8','The Witchery by the Castle','edinburgh','GB','introduced',500,500,2000,2000);


-- ── AFTERWARDS · check it landed ─────────────────────────────────────
--
--   SELECT s.name, s.code, COUNT(*) AS places
--     FROM num_scout_places sp JOIN num_scouts s ON s.id = sp.scout_id
--    GROUP BY sp.scout_id;                       -- expect Adam / ADAM / 23
--
--   SELECT booking_platform, COUNT(*) FROM places
--    WHERE dest='edinburgh' AND booking_platform IS NOT NULL
--    GROUP BY booking_platform;                  -- expect hilton 6, marriott 5, ihg 3
--
-- Then, for usage, do NOT write SQL. There is an endpoint:
--
--   GET /api/admin/scout-usage?code=ADAM&days=30
--
--
-- ═════════════════════════════════════════════════════════════════════
-- HOW THE DUPLICATES WERE RESOLVED, AND THE TWO TRAPS AVOIDED
-- ═════════════════════════════════════════════════════════════════════
--
-- Matching was done on ADDRESS AND POSTCODE, then confirmed against the
-- property code in the stored website. Two hotels would have been credited
-- to Adam by a name match and are NOT his:
--
--   Four Points by Sheraton (90 Haymarket Terrace, edifp) and
--   Four Points Flex by Sheraton (Shandwick Place)
--     — different Marriott properties, not on the sheet. A LIKE '%Sheraton%'
--       would have swept both in.
--
--   Balmoral Guest House x2 + "Balmoral" (32 Pilrig Street, EH6 5AL)
--     — an unrelated Leith guesthouse. Adam's Balmoral is Rocco Forte's,
--       1 Princes Street, EH2 2EQ.
--
-- ONE ROW LEFT OUT, ON PURPOSE — your call:
--
--   4297b762c6ad9fd77ac5  "Point Hotel"  34 Bread St, EH3 9AF
--     Same address as the DoubleTree. The Point Hotel is what that building
--     traded as before it became a DoubleTree, so this is very likely a
--     third stale listing for the same hotel — but "very likely" is not the
--     standard for a row that permanently blocks a place_id. Say the word
--     and I will add it.
--
-- DIRECTORY HYGIENE, a separate job: ten of these 23 rows are duplicates.
-- That is not caused by any of this and does not block it, but it splits
-- every number NUM reports about those hotels — ratings, impressions,
-- handoffs — across two rows.
