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
  // railway/aeroway are here for the essentials selector only: a station and
  // an aerodrome are not businesses, but they are the two places a traveller
  // asks for by name more than any shop in this file.
  return Boolean(t.amenity || t.shop || t.office || t.craft || t.healthcare
    || t.tourism || t.leisure || t.historic || t.natural || t.waterway || t.boundary || t.club
    || t.railway === 'station' || t.aeroway === 'aerodrome');
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
 * The things somebody needs rather than wants — and the one query that brings
 * opening hours with them.
 *
 * ── WHY THIS EXISTS AS ITS OWN SELECTOR ──────────────────────────────────
 *
 * The directory holds 22,026 hospitals with opening hours on 20 of them, and
 * 37,301 pharmacies with hours on 4,978. That looked like a coverage problem
 * for months. It is not. It is two problems and neither is about coverage:
 *
 *   1. CORE_QUERY never asks Overpass for a hospital, a clinic, a doctor, a
 *      police station, a bank, an ATM, a post office or a fuel stop. Those
 *      rows arrived from Overture instead, and the 452 OSM hospitals we do
 *      hold came in on the handful of tiles FULL_QUERY has ever run over.
 *
 *   2. Overture is 1,963,567 of our rows and publishes opening hours on 213
 *      of them. It is an excellent gazetteer and it is not an hours source.
 *      OSM pharmacies carry hours 30% of the time; Overture's carry them
 *      0.005% of the time. Blending the two is what produced "13%".
 *
 * So the fix is not to buy hours. It is to ask OSM for the categories we
 * never asked it for. This selector is deliberately narrow — narrow means a
 * public Overpass mirror answers a country-sized tile instead of timing out,
 * which is the only reason a worldwide run of it is affordable at all.
 *
 * ── WHY NOT JUST RUN FULL_QUERY EVERYWHERE ───────────────────────────────
 *
 * FULL_QUERY asks for every named amenity, shop, office, craft, healthcare,
 * tourism, leisure and historic object on earth. It is the right tool for a
 * city and it 504s on a country. Somebody who needs a chemist tonight should
 * not be waiting on a re-ingest of every hairdresser in Thailand.
 *
 * ── NO `["name"]` FILTER, DELIBERATELY ───────────────────────────────────
 *
 * Every other selector here requires a name, because an unnamed restaurant is
 * noise. An unnamed pharmacy is still a pharmacy, and an unnamed 24-hour
 * clinic at the end of the street is exactly what somebody ill needs. Named
 * is better and `normalise` will fall back to the category as the name, but
 * the absence of a name is not a reason to withhold a hospital.
 */
export const ESSENTIALS_QUERY = (bbox, timeout = 300) => `[out:json][timeout:${timeout}];
(
  nwr["amenity"~"^(hospital|clinic|doctors|dentist|pharmacy|veterinary|police|fire_station|bank|atm|bureau_de_change|post_office|fuel|charging_station|library|townhall|embassy|car_rental|bicycle_rental|taxi|bus_station|ferry_terminal|childcare|laundry|internet_cafe)$"](${bbox});
  nwr["healthcare"~"^(hospital|clinic|doctor|pharmacy|dentist|centre|emergency|midwife|physiotherapist|laboratory)$"](${bbox});
  nwr["shop"~"^(chemist|optician|medical_supply|hearing_aids|mobile_phone|laundry|dry_cleaning|locksmith|hairdresser)$"](${bbox});
  nwr["office"~"^(diplomatic|government|insurance|lawyer|telecommunication)$"](${bbox});
  nwr["amenity"="left_luggage"](${bbox});
  nwr["railway"="station"]["name"](${bbox});
  nwr["aeroway"="aerodrome"]["name"](${bbox});
);
out center 20000;`;

/**
 * The categories this selector brings back, named the way a traveller would
 * ask for them.
 *
 * `Doctor` was in the directory twice. `Police` and `Bank` arrived only as
 * `titled(raw)` fallbacks, which is why they are inconsistent today. Mapping
 * them explicitly is what stops the next ingest inventing a third spelling.
 */
export const ESSENTIAL_CATMAP = Object.freeze({
  hospital: 'Hospital', clinic: 'Clinic', doctors: 'Doctor', doctor: 'Doctor',
  centre: 'Clinic', emergency: 'Hospital', midwife: 'Clinic',
  physiotherapist: 'Clinic', laboratory: 'Medical lab',
  dentist: 'Dentist', pharmacy: 'Pharmacy', chemist: 'Pharmacy',
  veterinary: 'Veterinary', optician: 'Optician',
  medical_supply: 'Medical supplies', hearing_aids: 'Medical supplies',
  police: 'Police', fire_station: 'Fire station',
  bank: 'Bank', atm: 'ATM', bureau_de_change: 'Currency exchange',
  post_office: 'Post office', fuel: 'Fuel', charging_station: 'EV charging',
  library: 'Library', townhall: 'Government office',
  embassy: 'Embassy or consulate', diplomatic: 'Embassy or consulate',
  government: 'Government office', insurance: 'Insurance',
  lawyer: 'Lawyer', telecommunication: 'Mobile & SIM',
  mobile_phone: 'Mobile & SIM', internet_cafe: 'Internet cafe',
  laundry: 'Laundry', dry_cleaning: 'Laundry', locksmith: 'Locksmith',
  left_luggage: 'Left luggage', childcare: 'Childcare',
  bus_station: 'Transport', ferry_terminal: 'Transport',
  station: 'Transport', aerodrome: 'Airport',
});

/**
 * The categories somebody reaches for when something has gone wrong.
 *
 * Named here rather than inferred, because `essentialsBlock` in the Worker
 * has to know which of these it is allowed to say "open now" about, and that
 * decision must not drift away from what the ingest actually collects.
 */
export const LIFE_CRITICAL = Object.freeze([
  'Hospital', 'Clinic', 'Doctor', 'Pharmacy', 'Police', 'Fire station',
]);

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
export function assignDest(lat, lng, dests, { maxKm = null } = {}) {
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
  // A country walk is a BOX, not a border. The Thailand box takes in a corner
  // of Laos, Cambodia and Myanmar; the Spain box takes in Portugal. Without a
  // cap, every one of those rows is filed under the nearest Thai or Spanish
  // destination — a hospital in Laos becomes a hospital "in" Chiang Mai. For
  // a restaurant that is untidy. For the essentials selector it is somebody
  // ill being sent towards a border.
  //
  // Default stays null so the historical callers behave exactly as before.
  if (maxKm != null && nearD > maxKm) return null;
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
 * Which tag on this element is the essential thing about it.
 *
 * Order matters: `healthcare=pharmacy` on a shop tagged `shop=chemist` should
 * read as a pharmacy either way, but an element carrying both `amenity` and
 * `office` is described by its amenity. Same precedence normalise itself uses,
 * kept in one place so the name fallback and the category can never disagree.
 */
export function essentialRaw(tags) {
  const t = tags || {};
  for (const v of [t.amenity, t.healthcare, t.shop, t.office, t.railway, t.aeroway]) {
    if (v && Object.prototype.hasOwnProperty.call(ESSENTIAL_CATMAP, v)) return v;
  }
  return null;
}

/**
 * One OSM element → one place row, or null if it is not one.
 *
 * `pickLocalName` is injected rather than imported so this module stays free
 * of the ingest-time script graph and can be tested on its own.
 */
export function normalise(el, dest, pickLocalName = () => null, { essentials = false } = {}) {
  const t = el?.tags || {};
  // An unnamed restaurant is noise and is thrown away everywhere else in this
  // file. An unnamed 24-hour clinic at the end of the street is the thing
  // somebody ill is looking for, so on the essentials pass a missing name is
  // filled in from the category instead of being a reason to drop the row.
  const name = t.name || t['name:en']
    || (essentials ? (ESSENTIAL_CATMAP[essentialRaw(t)] || null) : null);
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  if (!dest?.slug) return null;
  if (!isBusiness(t)) return null;

  let raw = t.amenity || t.tourism || t.shop || t.leisure
    || t.natural || t.waterway || t.boundary || t.craft || t.healthcare || t.historic
    // `titled(t.office)` turned office=diplomatic into the string 'Diplomatic',
    // which then matched nothing in either map and shipped an embassy to the
    // directory under a category nobody picked. Essentials are passed through
    // raw so ESSENTIAL_CATMAP can name them.
    || (t.office === 'travel_agent' ? 'travel_agency'
      : t.office && Object.prototype.hasOwnProperty.call(ESSENTIAL_CATMAP, t.office) ? t.office
        : t.office ? titled(t.office) : null)
    // A station tagged only `railway=station` matched nothing above and fell
    // through to the literal string 'business'. It is a station.
    || (t.railway === 'station' ? 'station' : null)
    || (t.aeroway === 'aerodrome' ? 'aerodrome' : null)
    || (t.club === 'scuba_diving' ? 'scuba_diving' : 'business');
  if (raw === 'place_of_worship') raw = null;

  const area = t['addr:suburb'] || t['addr:district'] || t['addr:neighbourhood']
    || t['addr:quarter'] || t['addr:city'] || t['addr:town'] || null;

  const address = [t['addr:housenumber'], t['addr:street'], t['addr:postcode'], t['addr:city']]
    .filter(Boolean).join(' ') || null;

  // ESSENTIAL_CATMAP is consulted first and unconditionally. A hospital is a
  // Hospital on every ingest path, not only the essentials one — the old
  // `titled(raw)` fallback is exactly how 'Police' and 'Bank' ended up in the
  // directory as unmapped strings nobody chose.
  const category = raw == null
    ? (WORSHIP[t.religion] || 'Place of worship')
    : (ESSENTIAL_CATMAP[raw] || CATMAP[raw] || titled(raw));

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
