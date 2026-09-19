-- NUM · top-places builder
--
-- Collapses the raw listings into a small, pre-ranked recommendation set:
-- the best N in each of ten buckets, for every destination. This is the table
-- the concierge reads first, and it is deliberately tiny — a few thousand rows,
-- instead of scanning the full places table on every guest message.
--
-- Scoring is built only from signals we actually hold. Nothing is invented:
--   rating    (0-40)  customer stars, discounted when the review count is thin
--   hygiene   (0-22)  UK council food-hygiene score — government issued
--   confidence(0-12)  Overture's own confidence in the record
--   contact   (0-20)  phone/website/email/address/hours present
--   claimed   (0-12)  the owner has claimed the page, so someone stands behind it
--   editorial (-100..45) what a critic said, decayed by age and REVOCABLE.
--                     The only term that is a judgement about the place rather
--                     than a fact about the record. See worker/editorial.mjs.
--
-- Re-run after every ingest. It is a full rebuild, not an increment.

DELETE FROM top_places;

INSERT INTO top_places
  (dest, bucket, rank, place_id, name, name_local, category, area,
   lat, lng, cell_lat, cell_lng, rating, reviews, hygiene, phone, website,
   score, signals, built_at)
WITH scored AS (
  SELECT
    p.dest, p.id, p.name, p.name_local, p.category, p.area,
    p.lat, p.lng, p.cell_lat, p.cell_lng,
    p.rating, p.reviews, p.hygiene, p.phone, p.website,
    CASE
      WHEN p.category IN ('Restaurant','Street food','Deli','Butcher Shop') THEN 'eat'
      WHEN p.category IN ('Café','Bakery','Dessert') THEN 'cafe'
      WHEN p.category IN ('Bar','Nightlife','Wine & spirits','Pub') THEN 'drink'
      WHEN p.category IN ('Hotel','Guesthouse','Hostel','Apartment','Resort') THEN 'stay'
      WHEN p.category IN ('Beauty & spa','Massage & spa','Tattoo & piercing') THEN 'spa'
      -- ── OUTDOOR ─────────────────────────────────────────────────────
      --
      -- These categories were in the directory all along and NONE of them
      -- reached a guest. 'Hiking Trail', 'National Park', 'Swimming Pool',
      -- 'Tennis Court', 'Basketball Court', 'Skate Park', 'Dog Park',
      -- 'Surfing', 'Watersports' and 'Mountain Bike Trails' matched no arm of
      -- this CASE, fell to 'other', and 'other' is excluded from the shelf.
      -- Bangkok, New York and LA hold 2,449 parks, 117 hiking trails, 73
      -- national parks and 219 pools between them; the shelf showed zero.
      --
      -- Outdoor is its own bucket rather than part of 'see' or 'do' because
      -- it answers a different question. 'see' is a museum in the rain and
      -- 'do' is a booked activity; this is where somebody goes to be outside
      -- and move, which is the whole point of surfacing it.
      -- A SOURCED DESIGNATION BEATS A SCRAPED CATEGORY.
      --
      -- The directory files Lumphini Park -- Bangkok's flagship, gates at
      -- 04.30, the one every guest means -- under "Attractions And
      -- Activities". So does Benjakitti. Saranrom and Rommaneenart are
      -- filed as plain "Attraction". None of those strings says "park", so
      -- the patterns below threw all four out of the outdoor shelf while
      -- the BMA's own register, fetched and dated, said plainly that they
      -- are public parks.
      --
      -- The category came off a crawl. The editorial row came off the city's
      -- own page with a URL attached. When they disagree the sourced one is
      -- right, so it goes FIRST and the patterns become the fallback for
      -- everywhere nobody has researched yet.
      WHEN EXISTS (SELECT 1 FROM num_editorial e
                    WHERE e.place_id = p.id AND e.bucket = 'outdoor'
                      AND e.source IS NOT NULL AND e.source <> '') THEN 'outdoor'
      WHEN p.category IN ('National Park','Hiking Trail','Mountain Bike Trails','Skate Park',
                          'Dog Park','Rock Climbing Spot','Surfing','Watersports',
                          'Canoe And Kayak Hire Service','Rv Park','Beach') THEN 'outdoor'
      --
      -- WHOLE PHRASES, AND A GUARD ON THIS ARM ONLY. The first draft used
      -- '%Trail%' and swept in 'Trailer Dealer' and 'Trailer Repair' -- a
      -- caravan showroom offered as a hike. '%Surf%' alone takes 'Surfboard
      -- Rental', which is a shop; '%Rock Climbing%' alone takes 'Rock
      -- Climbing Gym', which is indoors. The NOT clause is scoped to this
      -- arm rather than made its own branch, so nothing already bucketed
      -- correctly further down gets re-routed on the way past.
      WHEN (p.category LIKE '%Hiking Trail%' OR p.category LIKE '%Nature Trail%'
        OR p.category LIKE '%Walking Trail%' OR p.category LIKE '%Bike Trail%'
        OR p.category LIKE '%Trailhead%'
        OR p.category LIKE '%Beach%' OR p.category LIKE '%National Park%'
        OR p.category LIKE '%State Park%' OR p.category LIKE '%Nature Reserve%'
        OR p.category LIKE '%Nature Preserve%' OR p.category LIKE '%Botanical%'
        OR p.category LIKE '%Campground%' OR p.category LIKE '%Camp Site%'
        OR p.category LIKE '%Lookout%' OR p.category LIKE '%Waterfall%'
        OR p.category LIKE '%Surfing%' OR p.category LIKE '%Kayak%'
        OR p.category LIKE '%Canoe%' OR p.category LIKE '%Paddleboard%'
        OR p.category LIKE '%Rock Climbing%' OR p.category LIKE '%Bouldering%'
        OR p.category LIKE '%Dog Park%' OR p.category LIKE '%Skate Park%'
        OR p.category = 'Attraction · park' OR p.category LIKE '%Public Park%')
        AND NOT (p.category LIKE '%Gym%' OR p.category LIKE '%Rental%'
              OR p.category LIKE '%Dealer%' OR p.category LIKE '%Repair%'
              OR p.category LIKE '%Shop%' OR p.category LIKE '%Store%'
              OR p.category LIKE '%Wear%' OR p.category LIKE '%Trailer%') THEN 'outdoor'
      -- ── MOVE (into 'do') ────────────────────────────────────────────
      -- The same silence, for the indoor half of active. 'Pilates Studio'
      -- (699 rows), 'Swimming Pool' (219), 'Tennis Court' (159) and
      -- 'Basketball Court' (95) all fell through to 'other' as well, while
      -- 'Gym & fitness' and 'Martial Arts Club' happened to be listed. The
      -- MOVE widget has existed since before this and had almost nothing
      -- under it.
      WHEN p.category IN ('Swimming Pool','Tennis Court','Basketball Court','Pilates Studio',
                          'Boxing Gym','Gymnastics Center','Cycling Classes','Fitness Trainer',
                          'Swimming Instructor','Sports And Fitness Instruction',
                          'Sports And Recreation Venue') THEN 'do'
      -- '%Court%' was here for one draft and would have swept every
      -- 'Courtyard by Marriott' out of the hotels and into the gyms. Whole
      -- phrases only, in this file and in discover.mjs, for exactly this
      -- reason -- a bare word matches the word inside another word.
      WHEN p.category LIKE '%Pilates%' OR p.category LIKE '%Swimming%'
        OR p.category LIKE '%Tennis Court%' OR p.category LIKE '%Basketball Court%'
        OR p.category LIKE '%Squash Court%' OR p.category LIKE '%Boxing%'
        OR p.category LIKE '%Crossfit%' OR p.category LIKE '%Cross Fit%'
        OR p.category LIKE '%Muay%' OR p.category LIKE '%Martial%'
        OR (p.category LIKE '%Studio%' AND p.category LIKE '%Fitness%') THEN 'do'
      WHEN p.category IN ('Museum','Gallery','Theatre','Viewpoint','Zoo','Aquarium',
                          'Place Of Worship','Theme park','Water park','Arts Centre',
                          'Cinema','Playground') THEN 'see'
      WHEN p.category IN ('Market','Souvenirs & gifts','Supermarket','Convenience',
                          'Tailor','Retail','Florist') THEN 'shop'
      WHEN p.category IN ('Tours & travel','Diving','Boat charter','Marina & charters',
                          'Golf','Gym & fitness','Dojo','Martial Arts Club',
                          'Sports Club And League','Tour Agency','Travel Agency',
                          'Travel Agents','Sports activity','Dance School') THEN 'do'
      WHEN p.category IN ('Pharmacy','Hospital','Dentist','Vehicle rental','Fuel',
                          'Transport','Clinic','Train Station') THEN 'essentials'
      WHEN p.category LIKE '%Restaurant%' OR p.category LIKE '%Pizzeria%'
        OR p.category LIKE '%Steakhouse%' OR p.category LIKE '%Diner%' THEN 'eat'
      WHEN p.category LIKE '%Coffee%' OR p.category LIKE '%Tea House%'
        OR p.category LIKE '%Patisserie%' THEN 'cafe'
      WHEN p.category LIKE '%Brewery%' OR p.category LIKE '%Winery%'
        OR p.category LIKE '%Liquor%' OR p.category LIKE '%Cocktail%'
        OR p.category LIKE '%Pub%' THEN 'drink'
      WHEN p.category LIKE '%Hotel%' OR p.category LIKE '%Hostel%'
        OR p.category LIKE '%Bed And Breakfast%' OR p.category LIKE '%Lodging%' THEN 'stay'
      WHEN p.category LIKE '%Spa%' OR p.category LIKE '%Salon%'
        OR p.category LIKE '%Barber%' OR p.category LIKE '%Nail%'
        OR p.category LIKE '%Massage%' THEN 'spa'
      WHEN p.category LIKE 'Attraction%' OR p.category LIKE '%Church%'
        OR p.category LIKE '%Cathedral%' OR p.category LIKE '%Temple%'
        OR p.category LIKE '%Mosque%' OR p.category LIKE '%Synagogue%'
        OR p.category LIKE '%Venue%' OR p.category LIKE '%Concert%'
        OR p.category LIKE '%Music%' OR p.category LIKE '%Monument%'
        OR p.category LIKE '%Historic%'
        OR p.category LIKE 'Arts And Entertainment' THEN 'see'
      WHEN p.category LIKE 'Shopping%' OR p.category LIKE '%Store%'
        OR p.category LIKE '%Shop%' OR p.category LIKE '%Boutique%'
        OR p.category LIKE '%Market%' OR p.category LIKE '%Arts And Crafts%' THEN 'shop'
      WHEN p.category LIKE '%Sport%' OR p.category LIKE '%Gym%'
        OR p.category LIKE '%Yoga%' OR p.category LIKE '%Tour%'
        OR p.category LIKE '%Recreation%' OR p.category LIKE '%Golf%'
        OR p.category LIKE '%Climb%' OR p.category LIKE '%Cruise%' THEN 'do'
      WHEN p.category LIKE '%Pharmac%' OR p.category LIKE '%Clinic%'
        OR p.category LIKE '%Doctor%' OR p.category LIKE '%Hospital%'
        OR p.category LIKE '%Dentist%' OR p.category LIKE '%Rental%'
        OR p.category LIKE '%Station%' THEN 'essentials'
      ELSE 'other'
    END AS bucket,
    ROUND(
        COALESCE(p.rating,0)/5.0*40.0
          * (CASE WHEN p.reviews>=100 THEN 1.0 WHEN p.reviews>=25 THEN 0.85
                  WHEN p.reviews>=5 THEN 0.7 WHEN p.reviews>0 THEN 0.55 ELSE 0.45 END)
      + COALESCE(p.hygiene,0)/5.0*22.0
      + COALESCE(p.confidence,0)*12.0
      + (CASE WHEN p.phone   IS NOT NULL AND p.phone   <>'' THEN 5 ELSE 0 END)
      + (CASE WHEN p.website IS NOT NULL AND p.website <>'' THEN 5 ELSE 0 END)
      + (CASE WHEN p.email   IS NOT NULL AND p.email   <>'' THEN 3 ELSE 0 END)
      + (CASE WHEN p.address IS NOT NULL AND p.address <>'' THEN 3 ELSE 0 END)
      + (CASE WHEN p.hours   IS NOT NULL AND p.hours   <>'' THEN 4 ELSE 0 END)
      + (CASE WHEN p.status='claimed' THEN 12 ELSE 0 END)
      -- ── EDITORIAL (-100 .. +45) ──────────────────────────────────────
      --
      -- What a critic actually said. Every other term above is a fact about
      -- the RECORD; this is the only judgement about the PLACE. Without it a
      -- 4.5-star chain hotel outranks the best room in the city, because more
      -- people stayed there and left a review.
      --
      -- Mirrors scoreFor() in worker/editorial.mjs EXACTLY: the strongest
      -- live positive, plus every live loss. Positives do not stack — five
      -- write-ups of one award must not bury a better venue with one quiet
      -- mention, and agreement is already priced into the weights.
      --
      -- Decay: full weight to 18 months (548d), straight line to nothing at
      -- 48 (1461d). This is what stops Masa being three-star for ever. It
      -- applies to losses too, so a 2019 revocation is not still punishing a
      -- kitchen that has since recovered.
      --
      -- Losses are why this can go NEGATIVE. The 2026 California guide
      -- stripped stars from 715, Camphor and Morihiro; a guest holding last
      -- year's guidebook still thinks they are starred. Being un-boosted is
      -- not enough — they have been judged and found wanting, and must fall
      -- below a venue nobody has judged at all.
      --
      -- Unsourced rows are excluded here as they are in editorial.mjs: a
      -- claim NUM cannot attribute is a claim it must not make.
      + COALESCE((
          SELECT MAX(e.weight * MIN(1.0,
                   (1461.0 - (julianday('now') - julianday(e.awarded_on))) / 913.0))
            FROM num_editorial e
           WHERE e.place_id = p.id AND e.weight > 0
             AND e.source IS NOT NULL AND e.source <> ''
             AND julianday('now') - julianday(e.awarded_on) < 1461.0
        ), 0)
      --
      -- A CLOSURE DOES NOT FADE. -100 is exempt from both the decay factor
      -- and the 1461-day cutoff: a hotel that shut in 2020 is still shut, and
      -- under the uniform curve its penalty aged out to zero, leaving it free
      -- to be recommended again. Mirrors isPermanent() in editorial.mjs.
      + COALESCE((
          SELECT SUM(CASE WHEN e.weight = -100 THEN e.weight
                          ELSE e.weight * MIN(1.0,
                   (1461.0 - (julianday('now') - julianday(e.awarded_on))) / 913.0) END)
            FROM num_editorial e
           WHERE e.place_id = p.id AND e.weight < 0
             AND e.source IS NOT NULL AND e.source <> ''
             AND (e.weight = -100
                  OR julianday('now') - julianday(e.awarded_on) < 1461.0)
        ), 0)
    , 2) AS score,
    TRIM(
        (CASE WHEN p.rating   IS NOT NULL THEN 'rating ' ELSE '' END)
     || (CASE WHEN p.hygiene  IS NOT NULL THEN 'hygiene ' ELSE '' END)
     || (CASE WHEN p.confidence IS NOT NULL THEN 'confidence ' ELSE '' END)
     || (CASE WHEN p.phone IS NOT NULL AND p.phone<>'' THEN 'phone ' ELSE '' END)
     || (CASE WHEN p.website IS NOT NULL AND p.website<>'' THEN 'web ' ELSE '' END)
     || (CASE WHEN p.hours IS NOT NULL AND p.hours<>'' THEN 'hours ' ELSE '' END)
     || (CASE WHEN p.status='claimed' THEN 'claimed ' ELSE '' END)
     -- So an operator reading a row can see WHY it ranks where it does, and
     -- so a demoted venue is visibly demoted rather than mysteriously low.
     || (CASE WHEN EXISTS (SELECT 1 FROM num_editorial e
                            WHERE e.place_id = p.id AND e.weight > 0
                              AND julianday('now') - julianday(e.awarded_on) < 1461.0)
              THEN 'editorial ' ELSE '' END)
     || (CASE WHEN EXISTS (SELECT 1 FROM num_editorial e
                            WHERE e.place_id = p.id AND e.weight < 0
                              AND (e.weight = -100
                                   OR julianday('now') - julianday(e.awarded_on) < 1461.0))
              THEN 'revoked ' ELSE '' END)
    ) AS signals
  FROM places p
  WHERE p.name IS NOT NULL AND p.name <> ''
    AND p.lat IS NOT NULL AND p.lng IS NOT NULL
),
ranked AS (
  -- The tie-break matters more than it looks. Outside Thailand we hold no
  -- customer ratings at all, so thousands of UK restaurants score identically
  -- on hygiene plus contact completeness. Breaking those ties on name would
  -- hand the top of every list to businesses beginning with "A" — an
  -- alphabetical accident presented to the guest as a recommendation.
  -- substr(id,-4) over a 20-char hex id is a stable scramble: arbitrary, but
  -- honestly arbitrary, and identical on every rebuild.
  SELECT *, ROW_NUMBER() OVER (
           PARTITION BY dest, bucket
           ORDER BY score DESC, substr(id,-4) ASC) AS rank
  FROM scored
  WHERE bucket <> 'other'
)
SELECT dest, bucket, rank, id, name, name_local, category, area,
       lat, lng, cell_lat, cell_lng, rating, reviews, hygiene, phone, website,
       score, signals, datetime('now')
FROM ranked
WHERE rank <= 30;
