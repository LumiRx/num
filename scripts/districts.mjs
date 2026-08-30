// Dubai and Abu Dhabi districts, because neither ingest supplies one.
//
// ── THE GAP ──────────────────────────────────────────────────────────────
//
// `places.area` is meant to hold the neighbourhood. Across all 42,038 Dubai
// rows it holds exactly three values: "دبي", "Dubai" and "الشارقة" — the city
// name, in two scripts. Both ingests are to blame in the same way: the OSM
// path falls through `addr:suburb → addr:district → addr:neighbourhood →
// addr:quarter → addr:city`, and Gulf OSM data rarely carries the first four,
// so almost everything lands on the city. The Overture path takes
// `addresses[1].locality`, which IS the city by definition.
//
// So Num cannot answer "somewhere near the Marina" by name. It can only
// answer it by coordinate proximity, which works for "near me" and fails
// completely for "we're staying in JBR, where should we eat" — a question a
// concierge in Dubai is asked constantly.
//
// ── WHY BOUNDING BOXES AND NOT A GEOCODER ────────────────────────────────
//
// Geoapify would reverse-geocode all 42,038, and that is 42,038 credits to
// learn something that has not moved since the towers went up. Dubai's
// districts are large, well known and stable, and the twenty-five that a
// concierge is ever asked about cover most of the map. A hand-checked box is
// cheaper, is inspectable in a diff, and cannot silently drift when a vendor
// changes their boundaries.
//
// The cost of the approach, stated honestly: boxes are rectangles and
// districts are not, so a place near a boundary can land in its neighbour.
// That is why the list is ordered MOST SPECIFIC FIRST and each row is only
// ever assigned once — a place inside Dubai Marina must not later be
// reassigned to the far larger box that contains it.
//
// Anything that matches no box keeps the city name. An unknown neighbourhood
// is a fine answer; a wrong one sends somebody across town.

/**
 * Ordered most specific first. Each entry is [name, minLat, maxLat, minLng, maxLng].
 * Boxes were read off the coordinate extents of the places already held in
 * each district, then tightened by hand.
 */
export const DUBAI = Object.freeze([
  ['Palm Jumeirah',        25.100, 25.140, 55.110, 55.160],
  ['Dubai Marina',         25.060, 25.095, 55.125, 55.150],
  ['JBR',                  25.068, 25.090, 55.125, 55.142],
  ['Jumeirah Lakes Towers', 25.055, 25.075, 55.135, 55.155],
  ['Bluewaters',           25.077, 25.085, 55.115, 55.128],
  ['Al Sufouh',            25.095, 25.120, 55.150, 55.180],
  ['Dubai Media City',     25.088, 25.105, 55.150, 55.165],
  ['Al Barsha',            25.090, 25.125, 55.180, 55.215],
  ['Dubai Hills',          25.095, 25.130, 55.220, 55.265],
  ['Al Quoz',              25.130, 25.165, 55.220, 55.260],
  ['Downtown Dubai',       25.185, 25.210, 55.265, 55.290],
  ['Business Bay',         25.175, 25.195, 55.255, 55.290],
  ['DIFC',                 25.205, 25.225, 55.270, 55.290],
  ['Jumeirah',             25.190, 25.235, 55.230, 55.270],
  ['Umm Suqeim',           25.130, 25.165, 55.180, 55.225],
  ['City Walk',            25.200, 25.220, 55.255, 55.275],
  ['Satwa',                25.220, 25.240, 55.265, 55.285],
  ['Al Fahidi',            25.258, 25.268, 55.291, 55.303],
  ['Al Karama',            25.240, 25.260, 55.290, 55.310],
  ['Bur Dubai',            25.245, 25.266, 55.280, 55.300],
  ['Deira',                25.265, 25.300, 55.285, 55.340],
  ['Dubai Creek Harbour',  25.190, 25.215, 55.330, 55.360],
  ['Dubai Festival City',  25.215, 25.240, 55.340, 55.365],
  ['Mirdif',               25.210, 25.245, 55.400, 55.440],
  ['Dubai Silicon Oasis',  25.110, 25.145, 55.370, 55.405],
  ['Al Nahda',             25.280, 25.305, 55.360, 55.390],
  ['Jebel Ali',            24.980, 25.030, 55.050, 55.115],
]);

export const ABU_DHABI = Object.freeze([
  ['Al Maryah Island',     24.495, 24.510, 54.380, 54.400],
  ['Saadiyat Island',      24.525, 24.560, 54.390, 54.460],
  ['Yas Island',           24.460, 24.510, 54.590, 54.640],
  ['Al Reem Island',       24.490, 24.520, 54.395, 54.425],
  ['Corniche',             24.465, 24.495, 54.320, 54.365],
  ['Al Khalidiyah',        24.460, 24.485, 54.330, 54.360],
  ['Al Bateen',            24.440, 24.470, 54.310, 54.345],
  ['Tourist Club Area',    24.485, 24.505, 54.365, 54.385],
  ['Masdar City',          24.415, 24.440, 54.600, 54.635],
  ['Khalifa City',         24.400, 24.450, 54.560, 54.620],
  ['Al Mushrif',           24.440, 24.470, 54.370, 54.400],
]);

export const DISTRICTS = Object.freeze({ dubai: DUBAI, 'abu-dhabi': ABU_DHABI });

/**
 * Which district contains this point, or null.
 *
 * First match wins, and the lists are ordered most specific first — so a
 * place inside JBR is JBR, never the Marina box that overlaps it.
 */
export function districtFor(dest, lat, lng) {
  const boxes = DISTRICTS[dest];
  if (!boxes || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  for (const [name, minLat, maxLat, minLng, maxLng] of boxes) {
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) return name;
  }
  return null;
}

/**
 * One UPDATE per district, most specific first.
 *
 * `AND (area IS NULL OR area = ?city)` is what makes the ordering hold: once
 * a row has a real district it is never revisited, so a broad box cannot
 * overwrite the precise one that already claimed it. It also means running
 * this twice is safe, and that a human correction is never clobbered.
 */
export function statements(dest, cityNames) {
  const boxes = DISTRICTS[dest];
  if (!boxes) return [];
  const cityList = cityNames.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
  return boxes.map(([name, minLat, maxLat, minLng, maxLng]) =>
    `UPDATE places SET area = '${name.replace(/'/g, "''")}' ` +
    `WHERE dest = '${dest}' AND (area IS NULL OR area IN (${cityList})) ` +
    `AND lat BETWEEN ${minLat} AND ${maxLat} AND lng BETWEEN ${minLng} AND ${maxLng};`);
}
