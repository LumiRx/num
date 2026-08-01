/**
 * NUM · place retrieval — D1-backed and location-aware.
 *
 * Replaces the old inlined `biz.js` array (Phuket-only, no coordinates) with
 * queries against the `places` table, which now holds every destination we
 * have ingested. Distance is computed in SQL (D1's SQLite has the trig
 * functions) after a cheap grid-cell bounding-box prefilter, so a "near me"
 * lookup touches a few hundred rows instead of the whole table.
 */

// ---------------------------------------------------------------- categories

export const CATS = {
  seafood:    ['seafood','ซีฟู้ด','อาหารทะเล','морепродукт','海鲜'],
  breakfast:  ['breakfast','brunch','อาหารเช้า','โจ๊ก','завтрак','早餐','朝食'],
  dessert:    ['dessert','sweets','ice cream','cake','ของหวาน','ไอศกรีม','десерт','сладк','甜品','冰淇淋','デザート'],
  jetski:     ['jet ski','jetski','เจ็ตสกี','гидроцикл','水上摩托','ジェットスキー'],
  watersports:['parasail','banana boat','kayak','canoe','paddle','sup board','surf','windsurf','kitesurf','snorkeling gear','เซิร์ฟ','พายเรือ','серф','каяк','параплан','冲浪','皮划艇','香蕉船'],
  transport:  ['tuk tuk','tuktuk','taxi','transfer','airport pickup','airport transfer','driver for','private driver','shuttle','แท็กซี่','ตุ๊กตุ๊ก','รถรับส่ง','такси','трансфер','аэропорт','打车','接送','的士','包车'],
  restaurant: ['restaurant','eat','food','dinner','lunch','hungry','กิน','อาหาร','ร้านอาหาร','หิว','ресторан','еда','поесть','ужин','吃','餐厅','美食','ご飯','レストラン'],
  cafe:       ['cafe','café','coffee','brunch','กาแฟ','คาเฟ่','кофе','咖啡','カフェ'],
  spa:        ['massage','spa','นวด','สปา','массаж','спа','按摩','マッサージ'],
  bar:        ['bar','pub','drink','beer','cocktail','nightlife','club','party','บาร์','เบียร์','บันเทิง','бар','пиво','клуб','酒吧','夜生活'],
  hotel:      ['hotel','stay','room','resort','hostel','โรงแรม','ที่พัก','отель','номер','酒店','住宿','ホテル'],
  diving:     ['dive','diving','scuba','snorkel','ดำน้ำ','дайвинг','снорк','潜水','浮潜'],
  boat:       ['boat','yacht','charter','island','phi phi','similan','เรือ','เกาะ','лодка','яхта','остров','游艇','出海','离岛'],
  tour:       ['tour','trip','excursion','guide','ทัวร์','ไกด์','тур','экскурс','旅游','跟团','ツアー'],
  gym:        ['gym','muay thai','fitness','boxing','yoga','ยิม','มวยไทย','фитнес','муай','тренаж','健身','泰拳'],
  attraction: ['attraction','see','visit','temple','viewpoint','big buddha','museum','gallery','cathedral','castle','วัด','ที่เที่ยว','จุดชมวิว','достопримеч','храм','музей','景点','寺庙','观景','博物馆'],
  rental:     ['rent','scooter','motorbike','car rental','bike','เช่ารถ','มอเตอร์ไซค์','аренда','байк','租车','租摩托'],
  tailor:     ['tailor','suit','ตัดสูท','ร้านตัดเสื้อ','костюм','пошив','定制','西装'],
  pharmacy:   ['pharmacy','chemist','drugstore','medicine','ร้านขายยา','аптек','药店','薬局'],
  shopping:   ['shopping','mall','shop','boutique','souvenir','ห้าง','ของฝาก','шоппинг','магазин','购物','商场'],
  market:     ['market','night market','bazaar','ตลาด','рынок','市场','夜市'],
  cinema:     ['cinema','movie','โรงหนัง','кино','电影'],
  golf:       ['golf','กอล์ฟ','гольф','高尔夫'],
};

// Category labels in `places` come from OSM/Google tags, so each intent maps to
// a set of LIKE patterns rather than one exact value. LIKE is case-insensitive.
const CATSQL = {
  seafood:    ['%seafood%','%fish%'],
  breakfast:  ['%caf%','%bakery%','%breakfast%','%coffee%','%brunch%','%street food%'],
  dessert:    ['%dessert%','%ice cream%','%bakery%','%caf%'],
  jetski:     ['%water%','%marina%','%boat%','%sports activity%','%tour%'],
  watersports:['%water%','%marina%','%boat%','%diving%','%dive%','%sports activity%','%tour%'],
  transport:  ['%transport%','%taxi%','%shuttle%','%vehicle rental%','%travel agency%','%tour%'],
  restaurant: ['%restaurant%','%street food%','%steak%','%grill%','%dining%','%deli%','%food court%'],
  cafe:       ['%caf%','%coffee%','%bakery%'],
  spa:        ['%spa%','%massage%','%beauty%'],
  bar:        ['%bar%','%pub%','%nightlife%','%night club%','%lounge%','%brewery%'],
  hotel:      ['%hotel%','%hostel%','%guesthouse%','%guest house%','%apartment%','%resort%'],
  diving:     ['%diving%','%dive%','%water%'],
  boat:       ['%boat%','%marina%','%charter%','%tour%'],
  tour:       ['%tour%','%travel%','%attraction%'],
  gym:        ['%gym%','%fitness%','%sport%','%dojo%','%training%'],
  attraction: ['%attraction%','%museum%','%gallery%','%viewpoint%','%zoo%','%aquarium%','%theme park%','%water park%','%theatre%','%place of worship%','%amusement%','%arts centre%'],
  rental:     ['%rental%','%rent%'],
  tailor:     ['%tailor%'],
  pharmacy:   ['%pharmacy%','%drug store%','%chemist%'],
  shopping:   ['%shopping%','%souvenir%','%store%','%boutique%','%clothes%','%market%'],
  market:     ['%market%','%street food%'],
  cinema:     ['%cinema%','%theatre%'],
  golf:       ['%golf%'],
};
// When nothing specific is asked for, show the things a concierge leads with.
const DEFAULT_PATTERNS = ['%restaurant%','%attraction%','%spa%','%massage%','%caf%','%bar%','%museum%'];

export function detectCat(text) {
  const t = (text || '').toLowerCase();
  for (const [k, words] of Object.entries(CATS)) if (words.some(w => t.includes(w))) return k;
  return null;
}

const NEAR_ME = ['near me','nearby','near by','close to me','closest','around here','near here','walking distance','ใกล้ฉัน','ใกล้ ๆ','ใกล้ๆ','แถวนี้','รอบๆ','рядом','поблизости','ближайш','附近','近く','近い','가까운'];
export const asksNearMe = t => { const s = (t || '').toLowerCase(); return NEAR_ME.some(k => s.includes(k)); };

// ---------------------------------------------------------------- geography

const R = 6371;
export function haversine(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const x = Math.sin(aLat * rad) * Math.sin(bLat * rad)
          + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLng - aLng) * rad);
  return R * Math.acos(Math.max(-1, Math.min(1, x)));
}

// Spelling variants guests actually type that don't match a slug or name.
const ALIASES = {
  saigon: 'ho-chi-minh', hcmc: 'ho-chi-minh', 'ho chi minh city': 'ho-chi-minh',
  bkk: 'bangkok', kl: 'kuala-lumpur', hk: 'hong-kong', 'koh samui': 'koh-samui',
  samui: 'koh-samui', 'phi phi': 'phi-phi', 'chiang mai': 'chiang-mai',
  'siem reap': 'siem-reap', 'da nang': 'da-nang', danang: 'da-nang',
  nyc: 'new-york', 'st petersburg': 'saint-petersburg', firenze: 'florence',
  roma: 'rome', lisboa: 'lisbon', wien: 'vienna', praha: 'prague',
  munchen: 'munich', koln: 'cologne', napoli: 'naples', venezia: 'venice',
};

let DEST_CACHE = null, DEST_AT = 0;
export async function liveDestinations(env) {
  if (DEST_CACHE && Date.now() - DEST_AT < 5 * 60 * 1000) return DEST_CACHE;
  const { results } = await env.DB
    .prepare('SELECT slug, name, country, region, lat, lng, tz, place_count FROM destinations WHERE live=1')
    .all();
  DEST_CACHE = results || [];
  DEST_AT = Date.now();
  return DEST_CACHE;
}

/** A destination the guest named outright ("dinner in Lisbon", "bars in Kata"). */
function destNamedIn(text, dests) {
  const t = ' ' + (text || '').toLowerCase().replace(/[.,!?;:()"']/g, ' ') + ' ';
  for (const [alias, slug] of Object.entries(ALIASES))
    if (t.includes(' ' + alias + ' ')) { const d = dests.find(x => x.slug === slug); if (d) return d; }
  let best = null;
  for (const d of dests) {
    for (const label of [d.name.toLowerCase(), d.slug.replace(/-/g, ' ')]) {
      if (label.length >= 4 && t.includes(' ' + label + ' ') && (!best || label.length > best.len))
        best = { dest: d, len: label.length };
    }
  }
  return best?.dest || null;
}

/** Neighbourhood centroid, derived from the data rather than a hardcoded list. */
async function areaCenter(env, destSlug, text) {
  try {
    const { results } = await env.DB
      .prepare(`SELECT area, AVG(lat) AS lat, AVG(lng) AS lng, COUNT(*) AS n FROM places
                WHERE dest=?1 AND area IS NOT NULL AND area<>'' GROUP BY area COLLATE NOCASE
                ORDER BY n DESC LIMIT 150`)
      .bind(destSlug).all();
    const t = ' ' + (text || '').toLowerCase().replace(/[.,!?;:()"']/g, ' ') + ' ';
    let best = null;
    for (const a of results || []) {
      const label = String(a.area).toLowerCase();
      if (label.length >= 4 && t.includes(' ' + label + ' ') && (!best || label.length > best.label.length))
        best = { label, lat: a.lat, lng: a.lng, area: a.area };
    }
    return best;
  } catch (e) { console.log('areaCenter', String(e)); return null; }
}

/* Words that follow "in" without naming a place. Without this guard,
   "I'm in a hurry" and "we're in the mood for Thai" would both be read as
   the guest declaring an unsupported city. */
const NOT_A_PLACE = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'his', 'her', 'their', 'this', 'that',
  'need', 'love', 'search', 'trouble', 'hurry', 'mood', 'fact', 'general',
  'town', 'time', 'order', 'charge', 'case', 'advance', 'total', 'front',
  'back', 'here', 'there', 'bed', 'transit', 'touch', 'person',
  'about', 'between', 'and', 'or', 'it', 'one', 'two', 'three', 'some', 'any',
  'good', 'bad', 'terms', 'return', 'exchange', 'other', 'another',
  // Time expressions — "a table in the evening", "in about an hour".
  'morning', 'afternoon', 'evening', 'night', 'midnight', 'hour', 'hours',
  'minute', 'minutes', 'day', 'days', 'week', 'weeks', 'month', 'months',
  'future', 'meantime', 'moment',
  // Generic spatial/other words that follow "in" without naming anywhere.
  'area', 'city', 'centre', 'center', 'middle', 'room', 'walking', 'driving',
  'range', 'budget', 'cash', 'english', 'thai', 'stock', 'season', 'mind',
]);

/**
 * Short forms guests actually type for places. Two- and three-letter tokens
 * cannot be told from noise by any general rule, so the useful ones are
 * enumerated. This exists because "hookah bar in La tonight" was answered with
 * a Phuket sky bar — "La" was two characters and got discarded as noise.
 *
 * Only places we do NOT cover belong here; covered destinations are matched
 * earlier by destNamedIn/ALIASES.
 */
const SHORT_PLACES = {
  la: 'Los Angeles', 'l.a.': 'Los Angeles', 'l.a': 'Los Angeles',
  nyc: 'New York', ny: 'New York', sf: 'San Francisco', dc: 'Washington DC',
  vegas: 'Las Vegas', philly: 'Philadelphia', atl: 'Atlanta', mia: 'Miami',
  sd: 'San Diego', yyz: 'Toronto', yvr: 'Vancouver', cdmx: 'Mexico City',
  ldn: 'London', edi: 'Edinburgh', gla: 'Glasgow', mcr: 'Manchester',
  dxb: 'Dubai', blr: 'Bengaluru',
};

/** Trailing words that ride along with a captured place name. */
const TRAILING_FILLER =
  /[\s,]+(right|now|today|tonight|tomorrow|currently|please|asap|at|for|until|till|this|next|and|but|so|with|on|the|a|an|area|city|pls)$/i;

/**
 * A place the guest states outright that they are in — covered by us or not.
 *
 * This exists because of a real failure: a guest in Los Angeles was told
 * "you're actually in Phuket" and handed a Phuket restaurant. `destNamedIn`
 * only recognises cities we cover, so an unsupported city looked identical to
 * the guest saying nothing at all, and resolution fell through to the Phuket
 * default. The guest is the only authority on where the guest is, so we have
 * to be able to hear a city we don't serve.
 */
export function statedPlace(text) {
  // Deliberately NOT gated on "I'm in …". The first version required a trigger
  // phrase, and "Give me hookah bar in La tonight" sailed straight past it into
  // the Phuket default — guests name a city far more often than they announce
  // themselves. Any "in <place>" counts; the filters below decide whether it is
  // really a place.
  const re = /\bin\s+([a-z][a-z'’.-]*(?:[ -][a-z][a-z'’.-]*){0,2})/gi;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    // The capture takes up to three words, so trailing filler rides along:
    // "la tonight", "los angeles right now". Strip repeatedly, not once, or
    // multi-word tails survive.
    let raw = m[1].trim(), prev;
    do {
      prev = raw;
      raw = raw.replace(TRAILING_FILLER, '').trim();
    } while (raw !== prev);
    if (!raw) continue;

    const key = raw.toLowerCase();
    if (SHORT_PLACES[key]) return SHORT_PLACES[key];
    if (raw.length < 4) continue;
    if (NOT_A_PLACE.has(key.split(/[ -]/)[0])) continue;
    return raw;
  }
  return null;
}

/** Is this string a neighbourhood we already hold places in? */
async function isKnownArea(env, s) {
  try {
    const r = await env.DB
      .prepare('SELECT 1 FROM places WHERE area LIKE ?1 COLLATE NOCASE LIMIT 1')
      .bind(s).first();
    return !!r;
  } catch (e) { console.log('isKnownArea', String(e)); return false; }
}

/**
 * Where should recommendations be centred?
 * Priority: a place the guest named  >  where they actually are  >  where they
 * were last  >  Phuket (our first market).
 *
 * When the guest states a city we do NOT cover, resolution stops and
 * `unsupported` is set. `dest` still carries a value so timezone and query
 * plumbing downstream keep working, but callers MUST check `unsupported`
 * before offering anything local — that field means "we are not where the
 * guest is."
 */
export async function resolveLocation(env, { text, guest, cf }) {
  const out = { dest: null, lat: null, lng: null, label: null, precise: false, source: 'default' };
  let dests = [];
  try { dests = await liveDestinations(env); } catch (e) { console.log('dests', String(e)); }
  if (!dests.length) return { ...out, dest: { slug: 'phuket', name: 'Phuket', country: 'TH', tz: 'Asia/Bangkok', lat: 7.953, lng: 98.338 } };

  const named = destNamedIn(text, dests);

  // A place the guest stated that we don't cover as a destination. Guarded by
  // an area lookup first: "I'm staying in Patong" names a neighbourhood, not an
  // unsupported city, and areaCenter below handles those properly.
  let stated = named ? null : statedPlace(text);
  if (stated && await isKnownArea(env, stated)) stated = null;

  // Coordinates we trust: a location the guest shared on LINE in the last day,
  // else the coarse city-level position Cloudflare attaches to a web request.
  let coords = null;
  const fresh = guest?.last_loc_at && (Date.now() - Date.parse(guest.last_loc_at + 'Z')) < 24 * 3600 * 1000;
  if (fresh && guest.last_lat != null) coords = { lat: +guest.last_lat, lng: +guest.last_lng, precise: true, source: 'shared_location' };
  else if (cf?.latitude && cf?.longitude) coords = { lat: +cf.latitude, lng: +cf.longitude, precise: false, source: 'ip_location' };

  const nearest = coords
    ? dests.map(d => ({ d, km: haversine(coords.lat, coords.lng, d.lat, d.lng) })).sort((a, b) => a.km - b.km)[0]
    : null;

  if (named) {
    out.dest = named; out.source = 'named';
    // Only keep live coordinates if the guest is actually in the place they named.
    if (coords && nearest && nearest.d.slug === named.slug && nearest.km < 120) {
      out.lat = coords.lat; out.lng = coords.lng; out.precise = coords.precise; out.source = coords.source;
    }
  } else if (nearest && nearest.km < 120) {
    out.dest = nearest.d; out.lat = coords.lat; out.lng = coords.lng;
    out.precise = coords.precise; out.source = coords.source;
  } else if (stated) {
    // The guest named somewhere, and it matched no destination we cover.
    // Believe them and stop here. Falling through to `last_dest` was the bug
    // that made a Phuket guest permanently a Phuket guest: once last_dest was
    // set, every later message resolved back to it no matter what they said.
    out.unsupported = stated;
    out.source = 'unsupported';
    out.dest = dests.find(d => d.slug === guest?.last_dest) || dests.find(d => d.slug === 'phuket') || dests[0];
  } else if (guest?.last_dest) {
    out.dest = dests.find(d => d.slug === guest.last_dest) || null;
    if (out.dest) out.source = 'last_seen';
  }
  if (!out.dest) out.dest = dests.find(d => d.slug === 'phuket') || dests[0];

  // A named neighbourhood beats the city centre, but never beats live coordinates.
  if (!out.lat) {
    const area = await areaCenter(env, out.dest.slug, text);
    if (area) { out.lat = area.lat; out.lng = area.lng; out.label = area.area; out.source = 'named_area'; }
    else { out.lat = out.dest.lat; out.lng = out.dest.lng; out.source = out.source === 'default' ? 'city_centre' : out.source; }
  }
  return out;
}

// ---------------------------------------------------------------- retrieval

const SELECT_COLS = 'name, name_local, category, area, rating, reviews, phone, website, address, hours, cuisine, status';

/**
 * Ranking blends quality and distance rather than sorting on either alone —
 * sorting purely by distance surfaces an unrated snack bar 10m away over a
 * 4.8-star institution two streets down, which is not what a concierge does.
 */
const SCORE = `(
    COALESCE(rating, 3.9)
  + CASE WHEN reviews>=5000 THEN 1.4 WHEN reviews>=1000 THEN 1.1 WHEN reviews>=300 THEN 0.8
         WHEN reviews>=100 THEN 0.55 WHEN reviews>=25 THEN 0.3 WHEN reviews>=5 THEN 0.15 ELSE 0 END
  + CASE WHEN status='claimed' THEN 1.5 ELSE 0 END
  + CASE WHEN website IS NOT NULL AND website<>'' THEN 0.25 ELSE 0 END
  + CASE WHEN phone IS NOT NULL AND phone<>'' THEN 0.2 ELSE 0 END
  - km * ?7
)`;

async function queryRing(env, { lat, lng, dest, patterns, radiusKm, distWeight, limit }) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const cat = patterns && patterns.length
    ? ' AND (' + patterns.map((_, i) => `category LIKE ?${8 + i}`).join(' OR ') + ')'
    : '';
  const sql = `SELECT ${SELECT_COLS}, km FROM (
      SELECT ${SELECT_COLS}, lat, lng,
        ROUND(6371*acos(MAX(-1.0, MIN(1.0,
          cos(radians(?1))*cos(radians(lat))*cos(radians(lng)-radians(?2))
          + sin(radians(?1))*sin(radians(lat))))), 2) AS km
      FROM places
      WHERE cell_lat BETWEEN ?3 AND ?4 AND cell_lng BETWEEN ?5 AND ?6${cat}
    ) WHERE km <= ${Number(radiusKm)} ORDER BY ${SCORE} DESC LIMIT ${Math.max(1, limit | 0)}`;
  const binds = [
    lat, lng,
    Math.floor((lat - dLat) * 10), Math.floor((lat + dLat) * 10),
    Math.floor((lng - dLng) * 10), Math.floor((lng + dLng) * 10),
    distWeight, ...(patterns || []),
  ];
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

/**
 * Verified partners to put in front of the model. Widens the search rather than
 * coming back empty: a guest asking for seafood in a quiet town should get the
 * best nearby restaurants, not an apology.
 */
export async function nearbyPlaces(env, loc, text, limit = 8) {
  const cat = detectCat(text);
  const near = asksNearMe(text);
  const base = near ? 4 : (loc.precise ? 8 : 15);
  const patterns = cat ? CATSQL[cat] : DEFAULT_PATTERNS;
  const rings = [base, base * 3, base * 8];
  let rows = [];
  try {
    for (const radiusKm of rings) {
      const distWeight = (near ? 2.5 : 1.25) / radiusKm;
      rows = await queryRing(env, { ...loc, patterns, radiusKm, distWeight, limit });
      if (rows.length >= Math.min(4, limit)) break;
    }
    // Still thin — the category may simply not exist here. Offer the best of what does.
    if (rows.length < 3 && cat) {
      const wide = await queryRing(env, {
        ...loc, patterns: DEFAULT_PATTERNS, radiusKm: base * 8,
        distWeight: 1.25 / (base * 8), limit,
      });
      const seen = new Set(rows.map(r => r.name));
      rows = rows.concat(wide.filter(r => !seen.has(r.name))).slice(0, limit);
    }
  } catch (e) { console.log('nearbyPlaces', String(e)); }
  return { cat, rows, near };
}

/** Per-destination briefing notes, editable in D1 without a deploy. */
let GUIDE_CACHE = new Map();
export async function destinationGuide(env, slug) {
  const hit = GUIDE_CACHE.get(slug);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.guide;
  let guide = null;
  try {
    const row = await env.DB.prepare('SELECT guide FROM destination_guides WHERE slug=?1').bind(slug).first();
    guide = row?.guide || null;
  } catch (e) { console.log('guide', String(e)); }
  GUIDE_CACHE.set(slug, { guide, at: Date.now() });
  return guide;
}
