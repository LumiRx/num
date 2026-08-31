/**
 * NUM · pure OSM → place normalisation, shared by every ingest path.
 *
 * ingest_global.mjs (one bbox per destination) and ingest_cover.mjs
 * (tiled, country-wide) both import from here, so a category fix lands in
 * both instead of drifting apart in two hand-maintained copies.
 *
 * Nothing in this file touches the network or the database. That is the
 * point: every rule below is unit-testable.
 */
import { createHash } from 'node:crypto';

// ── category normalisation ───────────────────────────────────────────
export const CATMAP = {
  restaurant: 'Restaurant', cafe: 'Café', bar: 'Bar', pub: 'Bar', biergarten: 'Bar', nightclub: 'Nightlife',
  fast_food: 'Street food', food_court: 'Street food', ice_cream: 'Dessert', marketplace: 'Market',
  pharmacy: 'Pharmacy', car_rental: 'Vehicle rental', bicycle_rental: 'Vehicle rental',
  boat_rental: 'Boat charter', casino: 'Nightlife', theatre: 'Theatre', cinema: 'Cinema',
  hotel: 'Hotel', hostel: 'Hostel', guest_house: 'Guesthouse', apartment: 'Apartment',
  resort: 'Resort', attraction: 'Attraction', museum: 'Museum', gallery: 'Gallery',
  theme_park: 'Theme park', zoo: 'Zoo', aquarium: 'Aquarium', viewpoint: 'Viewpoint',
  artwork: 'Attraction', information: 'Attraction',
  massage: 'Massage & spa', beauty: 'Beauty & spa', hairdresser: 'Beauty & spa',
  scuba_diving: 'Diving', motorcycle: 'Vehicle rental', tailor: 'Tailor', gift: 'Souvenirs & gifts',
  bakery: 'Bakery', confectionery: 'Dessert', deli: 'Deli', greengrocer: 'Market',
  wine: 'Wine & spirits', alcohol: 'Wine & spirits', supermarket: 'Supermarket',
  convenience: 'Convenience', clothes: 'Shopping', shoes: 'Shopping', jewelry: 'Shopping',
  books: 'Shopping', department_store: 'Shopping', mall: 'Shopping',
  spa: 'Massage & spa', fitness_centre: 'Gym & fitness', sports_centre: 'Gym & fitness',
  water_park: 'Water park', golf_course: 'Golf', marina: 'Marina & charters',
  beach_resort: 'Beach club', dance: 'Nightlife', travel_agency: 'Tours & travel',
  attraction_yes: 'Attraction',
  beach: 'Beach', waterfall: 'Waterfall', park: 'Park', nature_reserve: 'Nature reserve',
  national_park: 'National park', garden: 'Park',
};

/** A temple is not a "Place Of Worship" to a guest planning a day. */
export const WORSHIP = {
  buddhist: 'Temple', muslim: 'Mosque', christian: 'Church',
  hindu: 'Temple', taoist: 'Temple', shinto: 'Shrine',
};

export const titled = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── what counts as a business ────────────────────────────────────────
/**
 * `amenity` is OSM's junk drawer. A bench, a bin and a bicycle rack all carry
 * it, and a named bench is still a bench. These are excluded not because they
 * are uninteresting but because storing two million of them is the exact cost
 * we are trying not to pay for the ones that matter.
 *
 * Anything a traveller could walk into, spend at, or need — fuel, ATMs,
 * clinics, post offices, temples — stays in.
 */
export const NOT_A_BUSINESS = Object.freeze([
  'bench', 'waste_basket', 'waste_disposal', 'waste_transfer_station', 'recycling',
  'bicycle_parking', 'bicycle_repair_station', 'motorcycle_parking', 'parking',
  'parking_space', 'parking_entrance', 'toilets', 'drinking_water', 'water_point',
  'watering_place', 'shelter', 'shower', 'bbq', 'fountain', 'clock', 'telephone',
  'post_box', 'letter_box', 'grit_bin', 'hunting_stand', 'street_lamp', 'lounger',
  'table', 'smoking_area', 'bicycle_wash', 'device_charging_station', 'give_box',
  'loading_dock', 'trolley_bay', 'vending_machine', 'photo_booth',
]);

/** Same idea for `leisure`: a pitch is not a venue you can book a table at. */
export const NOT_A_VENUE = Object.freeze([
  'pitch', 'playground', 'picnic_table', 'fitness_station', 'slipway', 'bleachers',
  'firepit', 'bird_hide', 'outdoor_seating', 'swimming_area', 'track', 'common',
]);

/**
 * The junk filter runs here, in JavaScript, and not in the Overpass query.
 *
 * A negated regex (`["amenity"!~"^(bench|…)$"]`) makes the server walk every
 * amenity in the tile and test each one, and public mirrors answer a
 * whole-island run of that with 504s. Asking for the tag and rejecting the
 * junk on arrival costs a little more transfer and nothing at all in storage,
 * because the rejected rows were never going to be written either way — and
 * an exclusion list in code can be unit-tested, which one baked into a query
 * string cannot.
 */
export function isBusiness(tags) {
  const t = tags || {};
  if (t.amenity && NOT_A_BUSINESS.includes(t.amenity)) return false;
  if (t.leisure && NOT_A_VENUE.includes(t.leisure)) return false;
  // Signposts and trail maps: tens of thousands of them, not one a place to go.
  if (t.tourism === 'information' && !t.information) return false;
  if (t.tourism === 'information' && t.information !== 'office') return false;
  if (t.shop && ['vacant', 'disused', 'no'].includes(t.shop)) return false;
  // A row with nothing but a name is a label on a map, not a business.
  return Boolean(t.amenity || t.shop || t.office || t.craft || t.healthcare
    || t.tourism || t.leisure || t.historic || t.natural || t.waterway || t.boundary || t.club);
}

/**
 * The narrow historical selector: the things somebody spends money on.
 * Kept identical in meaning to the query that built the first 2.5m rows.
 */
export const CORE_QUERY = (bbox, timeout = 180) => `[out:json][timeout:${timeout}];
(
  nwr["amenity"~"^(restaurant|cafe|bar|pub|biergarten|fast_food|food_court|ice_cream|nightclub|marketplace|pharmacy|car_rental|bicycle_rental|boat_rental|casino|theatre|cinema)$"]["name"](${bbox});
  nwr["tourism"~"^(hotel|hostel|guest_house|apartment|resort|attraction|museum|gallery|theme_park|zoo|aquarium|viewpoint)$"]["name"](${bbox});
  nwr["shop"~"^(massage|beauty|hairdresser|scuba_diving|motorcycle|tailor|gift|bakery|confectionery|deli|greengrocer|wine|alcohol|supermarket|convenience|clothes|shoes|jewelry|books|department_store|mall|travel_agency)$"]["name"](${bbox});
  nwr["leisure"~"^(spa|fitness_centre|sports_centre|water_park|golf_course|marina|beach_resort|dance)$"]["name"](${bbox});
  nwr["office"="travel_agent"]["name"](${bbox});
  nwr["club"="scuba_diving"]["name"](${bbox});
);
out center 20000;`;

/**
 * Every named business, plus the reasons people travel.
 *
 * Whole tag families, no negation — `isBusiness` above throws away what we do
 * not want once it arrives. `shop`, `office`, `craft` and `healthcare` are all
 * somebody's livelihood; `amenity` and `leisure` arrive with their street
 * furniture attached and leave without it.
 */
export const FULL_QUERY = (bbox, timeout = 300) => `[out:json][timeout:${timeout}];
(
  nwr["amenity"]["name"](${bbox});
  nwr["shop"]["name"](${bbox});
  nwr["office"]["name"](${bbox});
  nwr["craft"]["name"](${bbox});
  nwr["healthcare"]["name"](${bbox});
  nwr["tourism"]["name"](${bbox});
  nwr["leisure"]["name"](${bbox});
  nwr["historic"]["name"](${bbox});
  nwr["natural"="beach"]["name"](${bbox});
  nwr["waterway"="waterfall"]["name"](${bbox});
  nwr["boundary"="national_park"]["name"](${bbox});
);
out center 20000;`;

// ── identity ─────────────────────────────────────────────────────────
/**
 * Stable across runs and across ingest paths, so re-running upserts instead of
 * duplicating — and so the same shop found by both a city box and a county
 * tile is one row, not two.
 */
export const pid = (source, name, lat, lng) =>
  createHash('sha1')
    .update(`${source}|${String(name).toLowerCase().trim()}|${(+lat).toFixed(4)}|${(+lng).toFixed(4)}`)
    .digest('hex').slice(0, 20);

// ── geometry ─────────────────────────────────────────────────────────
/** [south, west, north, east] — the order Overpass wants. */
export const inBox = (lat, lng, b) =>
  lat >= b[0] && lat <= b[2] && lng >= b[1] && lng <= b[3];

export const boxArea = (b) => Math.abs((b[2] - b[0]) * (b[3] - b[1]));

/** Cheap equirectangular distance in km. Good to well under a percent at city scale. */
export function distKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const x = ((bLng - aLng) * Math.PI / 180) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  const y = (bLat - aLat) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * R;
}

/**
 * Which destination does this point belong to?
 *
 * A containing box wins, and the SMALLEST containing box wins, so a shop in
 * Tamsui is Tamsui rather than New Taipei — the traveller says the smaller
 * name. With no containing box we fall back to the nearest destination
 * centre, which is what stops a rural township from being dropped on the
 * floor: full coverage means every point gets a home, not that every point
 * sits inside a rectangle somebody drew.
 */
export function assignDest(lat, lng, dests) {
  if (!Array.isArray(dests) || !dests.length) return null;
  let best = null;
  for (const d of dests) {
    if (!Array.isArray(d.bbox) || d.bbox.length !== 4) continue;
    if (!inBox(lat, lng, d.bbox)) continue;
    if (!best || boxArea(d.bbox) < boxArea(best.bbox)) best = d;
  }
  if (best) return best;
  let near = null, nearD = Infinity;
  for (const d of dests) {
    const dLat = d.lat ?? (Array.isArray(d.bbox) ? (d.bbox[0] + d.bbox[2]) / 2 : null);
    const dLng = d.lng ?? (Array.isArray(d.bbox) ? (d.bbox[1] + d.bbox[3]) / 2 : null);
    if (dLat == null || dLng == null) continue;
    const km = distKm(lat, lng, dLat, dLng);
    if (km < nearD) { nearD = km; near = d; }
  }
  return near;
}

/**
 * Split a bbox into a grid of tiles no larger than `step` degrees a side.
 *
 * Overpass caps a single answer at 20,000 elements. Taipei alone holds
 * ninety thousand places, so a one-shot query over a whole country does not
 * return a truncated answer — it returns a silently truncated one, which is
 * worse. Tiles keep every response comfortably under the cap.
 */
export function tiles(bbox, step = 0.25) {
  const [s, w, n, e] = bbox.map(Number);
  if (!(n > s) || !(e > w) || !(step > 0)) return [];
  const out = [];
  for (let lat = s; lat < n; lat += step) {
    for (let lng = w; lng < e; lng += step) {
      out.push([
        +lat.toFixed(4), +lng.toFixed(4),
        +Math.min(lat + step, n).toFixed(4), +Math.min(lng + step, e).toFixed(4),
      ]);
    }
  }
  return out;
}

// ── normalisation ────────────────────────────────────────────────────
/**
 * One OSM element → one place row, or null if it is not one.
 *
 * `pickLocalName` is injected rather than imported so this module stays free
 * of the ingest-time script graph and can be tested on its own.
 */
export function normalise(el, dest, pickLocalName = () => null) {
  const t = el?.tags || {};
  const name = t.name || t['name:en'];
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  if (!dest?.slug) return null;
  if (!isBusiness(t)) return null;

  let raw = t.amenity || t.tourism || t.shop || t.leisure
    || t.natural || t.waterway || t.boundary || t.craft || t.healthcare || t.historic
    || (t.office === 'travel_agent' ? 'travel_agency' : t.office ? titled(t.office) : null)
    || (t.club === 'scuba_diving' ? 'scuba_diving' : 'business');
  if (raw === 'place_of_worship') raw = null;

  const area = t['addr:suburb'] || t['addr:district'] || t['addr:neighbourhood']
    || t['addr:quarter'] || t['addr:city'] || t['addr:town'] || null;

  const address = [t['addr:housenumber'], t['addr:street'], t['addr:postcode'], t['addr:city']]
    .filter(Boolean).join(' ') || null;

  const category = raw == null
    ? (WORSHIP[t.religion] || 'Place of worship')
    : (CATMAP[raw] || titled(raw));

  return {
    id: pid('osm', name, lat, lng),
    name,
    name_local: pickLocalName(t, dest.country, name),
    category,
    lat: +(+lat).toFixed(5),
    lng: +(+lng).toFixed(5),
    cell_lat: Math.floor(lat * 10),
    cell_lng: Math.floor(lng * 10),
    dest: dest.slug,
    area,
    country: dest.country,
    region: dest.region,
    phone: t.phone || t['contact:phone'] || null,
    website: t.website || t['contact:website'] || null,
    email: t.email || t['contact:email'] || null,
    address,
    hours: t.opening_hours || null,
    cuisine: t.cuisine || null,
    rating: null,
    reviews: 0,
    source: 'osm',
    status: 'unclaimed',
  };
}
