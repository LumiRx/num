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
        OR p.category LIKE '%Historic%' OR p.category LIKE '%Garden%'
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
    , 2) AS score,
    TRIM(
        (CASE WHEN p.rating   IS NOT NULL THEN 'rating ' ELSE '' END)
     || (CASE WHEN p.hygiene  IS NOT NULL THEN 'hygiene ' ELSE '' END)
     || (CASE WHEN p.confidence IS NOT NULL THEN 'confidence ' ELSE '' END)
     || (CASE WHEN p.phone IS NOT NULL AND p.phone<>'' THEN 'phone ' ELSE '' END)
     || (CASE WHEN p.website IS NOT NULL AND p.website<>'' THEN 'web ' ELSE '' END)
     || (CASE WHEN p.hours IS NOT NULL AND p.hours<>'' THEN 'hours ' ELSE '' END)
     || (CASE WHEN p.status='claimed' THEN 'claimed ' ELSE '' END)
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
