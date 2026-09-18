/**
 * NUM · place retrieval — D1-backed and location-aware.
 *
 * Replaces the old inlined `biz.js` array (Phuket-only, no coordinates) with
 * queries against the `places` table, which now holds every destination we
 * have ingested. Distance is computed in SQL (D1's SQLite has the trig
 * functions) after a cheap grid-cell bounding-box prefilter, so a "near me"
 * lookup touches a few hundred rows instead of the whole table.
 */
import { openNow } from '../worker/hours.mjs';
// The one term in the score that NUM learned rather than crawled. Imported
// rather than copied: a rule written out twice is a rule in one file and a
// comment in the other. See worker/learn.mjs for why it is capped, why the
// cap is not symmetric, and why nothing money can reach may ever appear here.
import { SCORE_TERM as NUM_RATING_TERM } from '../worker/learn.mjs';

// ---------------------------------------------------------------- categories

export const CATS = {
  seafood:    ['seafood','ซีฟู้ด','อาหารทะเล','морепродукт','海鲜'],
  breakfast:  ['breakfast','brunch','อาหารเช้า','โจ๊ก','завтрак','早餐','朝食'],
  dessert:    ['dessert','sweets','ice cream','cake','ของหวาน','ไอศกรีม','десерт','сладк','甜品','冰淇淋','デザート'],
  jetski:     ['jet ski','jetski','เจ็ตสกี','гидроцикл','水上摩托','ジェットスキー'],
  watersports:['parasail','banana boat','kayak','canoe','paddle','sup board','surf','windsurf','kitesurf','snorkeling gear','เซิร์ฟ','พายเรือ','серф','каяк','параплан','冲浪','皮划艇','香蕉船'],
  // Grooming sits ABOVE restaurant and spa: "a haircut before dinner" is a
  // haircut ask, and a nail bar is the answer to a nails ask. 'facial' stays
  // with spa.
  grooming:   ['haircut','hair cut','barber','hair salon','hairdresser','hairdressing','blow dry','blow-dry','blowout','lashes','eyelash','lash extension','lash lift','nails','manicure','pedicure','nail salon','nail bar','brows','eyebrow','waxing','ตัดผม','ร้านทำผม','ต่อขนตา','ทำเล็บ','парикмахер','барбер','ресниц','маникюр','理发','美甲','美睫','美容室','ネイル'],
  // EVERYDAY DOORS (18 Sep 2026): dry cleaning, grocery, post, luggage,
  // haircuts and lashes, vets, coworking, kids, stations. Each was answerable
  // only by a brain guessing before; now the ask reaches the places table.
  // Substring matching, so every word here was checked against the ones
  // above and below it: 'vet' alone would match "velvet", 'train' alone
  // matches "training", 'pet' matches "carpet" — hence the longer forms.
  laundry:    ['laundry','launderette','laundromat','dry clean','dry-clean','wash my clothes','ironing','ซักรีด','ซักผ้า','прачечн','химчистк','洗衣','干洗','クリーニング'],
  grocery:    ['grocery','groceries','supermarket','convenience store','7-eleven','7 eleven','minimart','mini mart','buy snacks','buy water','food shop','ซุปเปอร์','ร้านสะดวกซื้อ','เซเว่น','супермаркет','продукт','超市','便利店','スーパー','コンビニ'],
  postoffice: ['post office','send a parcel','send a package','post a parcel','mail a','postage','stamps','ไปรษณีย์','почта','посылк','邮局','寄包裹','郵便局'],
  luggage:    ['luggage','suitcase','left luggage','store my bags','store our bags','bag storage','baggage storage','กระเป๋าเดินทาง','ฝากกระเป๋า','чемодан','багаж','行李','スーツケース'],
  vet:        ['veterinar','animal hospital','pet hospital','pet clinic','a vet','the vet','vet near','vet for','emergency vet','pet groomer','dog groomer','pet sitter','dog sitter','pet boarding','kennel','my dog','my cat','my puppy','สัตวแพทย์','โรงพยาบาลสัตว์','ветеринар','兽医','宠物医院','動物病院'],
  cowork:     ['cowork','co-work','wework','hot desk','day desk','shared office','desk for the day','place to work from','somewhere to work','quiet place to work','โคเวิร์ค','коворкинг','联合办公','コワーキング'],
  // Not bare 'kids' or 'children': "a kid-friendly restaurant" is a restaurant
  // ask, and the patterns under this intent are playgrounds and zoos.
  kids:       ['with kids','with the kids','for the kids','for kids','kids activities','things to do with children','for children','with children','toddler','playground','with my son','with my daughter','family day out','เด็ก','สนามเด็กเล่น','дети','детск','儿童','亲子','子供','キッズ'],
  transport:  ['tuk tuk','tuktuk','taxi','transfer','airport pickup','airport transfer','driver for','private driver','shuttle','แท็กซี่','ตุ๊กตุ๊ก','รถรับส่ง','такси','трансфер','аэропорт','打车','接送','的士','包车'],
  // After transport on purpose: "a taxi to the train station" is a taxi ask.
  transit:    ['train station','metro station','subway','the train','by train','train to','skytrain','bts','mrt','bus station','public transport','public transit','light rail','tram','by metro','by bus','the metro','the subway','รถไฟ','รถไฟฟ้า','สถานี','метро','вокзал','электричк','地铁','火车站','捷运','電車','駅'],
  restaurant: ['restaurant','eat','food','dinner','lunch','hungry','กิน','อาหาร','ร้านอาหาร','หิว','ресторан','еда','поесть','ужин','吃','餐厅','美食','ご飯','レストラン'],
  cafe:       ['cafe','café','coffee','brunch','กาแฟ','คาเฟ่','кофе','咖啡','カフェ'],
  spa:        ['massage','spa','นวด','สปา','массаж','спа','按摩','マッサージ','deep tissue','deep-tissue','swedish','shiatsu','reflexolog','sports massage','thai massage','hot stone','aromatherapy','facial','manicure','pedicure','sauna','hammam','onsen'],
  // NIGHTLIFE (18 Sep 2026). Two intents that used to fall into `bar` or into
  // nothing at all: "nightclub club dancing" matched bar's 'club' and then
  // bar's '%lounge%' pattern, which is how a travel agency called "SN Travel
  // Lounge" ended up on the CLUBS shelf; "live music venue jazz" matched no
  // category and came back as an unrestricted list ordered by "has a
  // website", which is how an occupational-health clinic did. Both sit
  // ABOVE `bar` because detectCat returns the first match.
  nightclub:  ['nightclub','night club','clubbing','dancing','dance floor','disco','dj set',' dj ','ไนท์คลับ','ночной клуб','夜店','クラブ'],
  livemusic:  ['live music','jazz','concert','gig','live band','open mic','ดนตรีสด','живая музыка','现场音乐','ライブ'],
  bar:        ['bar','pub','drink','beer','cocktail','nightlife','club','party','บาร์','เบียร์','บันเทิง','бар','пиво','клуб','酒吧','夜生活'],
  hotel:      ['hotel','stay','room','resort','hostel','โรงแรม','ที่พัก','отель','номер','酒店','住宿','ホテル'],
  // 'sand' is deliberately absent: detectCat matches by substring, and every
  // "sandwich" would have become a beach ask.
  beach:      ['beach','beaches','sunbath','sunset spot','หาด','ชายหาด','пляж','海滩','海灘','ビーチ','浜'],
  diving:     ['dive','diving','scuba','snorkel','ดำน้ำ','дайвинг','снорк','潜水','浮潜'],
  boat:       ['boat','yacht','charter','island','phi phi','similan','เรือ','เกาะ','лодка','яхта','остров','游艇','出海','离岛'],
  tour:       ['tour','trip','excursion','guide','ทัวร์','ไกด์','тур','экскурс','旅游','跟团','ツアー'],
  gym:        ['gym','muay thai','fitness','boxing','yoga','swimming pool','lap pool','go for a swim','ยิม','มวยไทย','фитнес','муай','тренаж','健身','泰拳'],
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
  // Live categories, 18 Sep 2026: Laundry 1,585 · Dry Cleaning 93 ·
  // Supermarket 54,569 · Convenience 72,647 · Post Office 1,671 · Luggage
  // Store 2,397 + Luggage Storage 1,892 · Train Station 5,351 · Metro 831 ·
  // Veterinary 394 + Pet Services 2,627 · Coworking 48 · Playground 2,142 ·
  // Theme park 1,901 · Zoo 628. The near-misses that forced the exact
  // patterns: 'Carpet Store' for %pet%, 'Bagel Shop' for %bag%, 'Boat Rental
  // And Training' for %train%, 'Ev Charging Station' for %station%,
  // 'Childrens Clothing Store' for %children%.
  laundry:    ['%laundry%','%dry clean%','%launderette%','%laundromat%'],
  grocery:    ['%supermarket%','%grocer%','%convenience%','%minimart%','%mini mart%','%hypermarket%'],
  postoffice: ['%post office%','%postal%','%courier%','%parcel%'],
  luggage:    ['%luggage%','%handbag%','bag','bags','%suitcase%'],
  transit:    ['%train station%','trains','%metro%','%subway%','%bus station%','%light rail%','%railway%','tram','%tram stop%','%ferry%'],
  vet:        ['%veterinar%','pet','pets','%pet services%','%pet groom%','%pet store%','%pet shop%','%animal hospital%','%pet clinic%','%pet boarding%','%pet sitting%'],
  cowork:     ['%cowork%','%co-work%','%shared office%','%business center%','%business centre%'],
  kids:       ['%playground%','%childrens museum%','%kids%','%amusement%','%theme park%','%water park%','zoo','%petting zoo%','%aquarium%','%trampoline%','%indoor play%','%family entertainment%','%gymnastics%'],
  grooming:   ['%beauty%','%hair%','%barber%','%nail%','%lash%','%brow%','%salon%'],
  restaurant: ['%restaurant%','%street food%','%steak%','%grill%','%dining%','%deli%','%food court%'],
  cafe:       ['%caf%','%coffee%','%bakery%'],
  spa:        ['%spa%','%massage%','%beauty%'],
  nightclub:  ['%night club%','%nightclub%','%disco%','%dance club%','%nightlife%'],
  livemusic:  ['%music venue%','%live music%','%jazz%','%concert%','%music club%'],
  bar:        ['%bar%','%pub%','%nightlife%','%night club%','%lounge%','%brewery%'],
  hotel:      ['%hotel%','%hostel%','%guesthouse%','%guest house%','%apartment%','%resort%'],
  beach:      ['%beach%'],
  diving:     ['%diving%','%dive%','%water%'],
  boat:       ['%boat%','%marina%','%charter%','%tour%'],
  tour:       ['%tour%','%travel%','%attraction%'],
  gym:        ['%gym%','%fitness%','%sport%','%dojo%','%training%','%swimming%','%yoga%'],
  attraction: ['%attraction%','%museum%','%gallery%','%viewpoint%','%zoo%','%aquarium%','%theme park%','%water park%','%theatre%','%place of worship%','%amusement%','%arts centre%','%beach%','%temple%','%waterfall%','%landmark%'],
  rental:     ['%rental%','%rent%'],
  tailor:     ['%tailor%'],
  pharmacy:   ['%pharmacy%','%drug store%','%chemist%'],
  shopping:   ['%shopping%','%souvenir%','%store%','%boutique%','%clothes%','%market%'],
  market:     ['%market%','%street food%'],
  cinema:     ['%cinema%','%theatre%'],
  golf:       ['%golf%'],
};
/**
 * Names to exclude for a given intent, matched against `name` rather than
 * `category`.
 *
 * This exists because of a real failure: a guest asked for deep-tissue massage
 * in Los Angeles and was offered "Platinum Cuts Barbershop", whose category is
 * "Beauty & spa" — the same label a genuine day spa carries. No category
 * pattern can tell those apart, so `%beauty%` had to stay (dropping it would
 * lose real spas) and the separation moved to the name.
 *
 * Deliberately narrow. Every entry is a place that cuts, paints or removes
 * something, and none of them do bodywork. "salon" is absent on purpose —
 * "massage salon" is a real and common name.
 */
const GROOMING = ['%barber%', '%barbershop%', '%nail%', '%braid%', '%lash%', '%brow%', '%waxing%', '%tattoo%', '%hair salon%', '%haircut%', '%cuts%'];

/**
 * Which exclusions apply depends on the SUB-INTENT, not the category.
 *
 * The first cut keyed this on the category and was wrong in a way its own test
 * caught: it excluded nail bars from every `spa` ask, so somebody asking for a
 * manicure could not be sent to a nail bar. Bodywork and grooming share a
 * category, so the ask itself is the only thing that says which the guest
 * wants.
 *
 * Null means exclude nothing.
 */
const BODYWORK = ['%massage%', '%sauna%', '%onsen%', '%hammam%', '%foot reflex%'];
function exclusionsFor(cat, prefer) {
  // The mirror of the spa rule: a haircut ask shares "Beauty & spa" with every
  // massage parlour in the city, and the parlour is never the answer.
  if (cat === 'grooming') return BODYWORK;
  if (cat !== 'spa') return null;
  // They asked for beauty work — the grooming places ARE the answer.
  if (prefer === '%beauty%') return null;
  // Massage, sauna, or an unspecified spa ask: a barbershop is never it.
  return GROOMING;
}

/**
 * The thing INSIDE the category that the guest actually asked for.
 *
 * A category is a bucket; "deep tissue" is a request. Before this, the
 * specific ask was discarded the moment `detectCat` reduced it to `spa`, so
 * "deep tissue" and "manicure" searched identically. A hit here adds a ranking
 * bonus — it never filters, because a thin result set is worse than an
 * imperfectly ordered one.
 */
const SUBINTENT = {
  spa: [
    [/\b(deep.?tissue|sports massage|swedish|shiatsu|reflexolog|thai massage|hot stone|aromatherap|massage|นวด|массаж|按摩)\b/i, '%massage%'],
    [/\b(facial|manicure|pedicure|nails?)\b/i, '%beauty%'],
    [/\b(sauna|hammam|onsen|steam room)\b/i, '%spa%'],
  ],
  // One pattern per ask, matched against name OR category (queryRing). A
  // barber is usually named "…Barbershop" and a salon "…Hair Studio", so the
  // two asks earn different bonuses rather than one that misses half.
  grooming: [
    [/\bbarber/i, '%barber%'],
    [/\b(lash|lashes|eyelash)/i, '%lash%'],
    [/\b(nails?|manicure|pedicure)\b/i, '%nail%'],
    [/\b(brows?|eyebrow)/i, '%brow%'],
    [/\bwax/i, '%wax%'],
    [/\b(hair|blow.?dry|blowout|trim)/i, '%hair%'],
  ],
  kids: [
    [/\b(playground|park)\b/i, '%playground%'],
    [/\b(zoo|animals?)\b/i, 'zoo'],
    [/\b(aquarium|fish)\b/i, '%aquarium%'],
    [/\b(rides?|theme park|roller ?coaster)\b/i, '%theme park%'],
  ],
  transit: [
    [/\b(metro|subway|underground|tube|bts|mrt|skytrain)\b/i, '%metro%'],
    [/\b(bus)\b/i, '%bus station%'],
    [/\b(ferry|boat)\b/i, '%ferry%'],
  ],
  vet: [
    [/\b(emergency|24|urgent|sick|hurt|injur)/i, '%veterinar%'],
    [/\b(groom|bath|wash)/i, '%pet groom%'],
    [/\b(board|kennel|sit|sitting|daycare)/i, '%pet boarding%'],
  ],
};

/** The one sub-intent pattern this ask earns, or null. */
export function subIntent(cat, text) {
  for (const [re, pattern] of SUBINTENT[cat] ?? []) if (re.test(text || '')) return pattern;
  return null;
}

// When nothing specific is asked for, show the things a concierge leads with.
const DEFAULT_PATTERNS = ['%restaurant%','%attraction%','%spa%','%massage%','%caf%','%bar%','%museum%','%beach%','%viewpoint%','%temple%'];

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
/**
 * Tests only. The destination list is cached for five minutes at module
 * scope, which is right in production and invisible in a test file: the first
 * test to call resolveLocation fixes the destination list for every test after
 * it, so a later case that needs a different city silently resolves against
 * the earlier one. That cost an hour on the Hollywood fix — Los Angeles was in
 * the stub and the resolver kept answering Phuket.
 */
export const __resetDestCache = () => { DEST_CACHE = null; DEST_AT = 0; };
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

/**
 * Neighbourhood centroids, precomputed. `num_dest_areas` (migration 0016)
 * holds one row per (dest, area) with the averaged coordinates — 16,539 rows
 * for the whole directory. Before it existed this ran a GROUP BY over every
 * place in the destination on each ask that arrived without coordinates:
 * Tokyo cost 920 ms and 290K rows read, per request, to learn something
 * that only changes on ingest. Falls back to the live aggregate if the
 * table is missing or empty, so it keeps working before the migration runs.
 */
async function areaRows(env, destSlug) {
  try {
    const { results } = await env.DB
      .prepare('SELECT area, lat, lng, n FROM num_dest_areas WHERE dest=?1 ORDER BY n DESC LIMIT 150')
      .bind(destSlug).all();
    if (results?.length) return results;
  } catch { /* table not there yet — fall through to the live aggregate */ }
  const { results } = await env.DB
    .prepare(`SELECT area, AVG(lat) AS lat, AVG(lng) AS lng, COUNT(*) AS n FROM places
              WHERE dest=?1 AND area IS NOT NULL AND area<>'' GROUP BY area COLLATE NOCASE
              ORDER BY n DESC LIMIT 150`)
    .bind(destSlug).all();
  return results || [];
}

/**
 * Rebuild num_dest_areas from the directory. Idempotent; run after any
 * ingest (the hourly slot in scheduled() is the right home). Whole-directory
 * cost measured 4 Sep 2026: 5.5 s, 4.9M rows read — once.
 */
export async function refreshDestAreas(env) {
  const r = await env.DB.prepare(
    `INSERT OR REPLACE INTO num_dest_areas (dest, area, lat, lng, n, refreshed_at)
     SELECT dest, area, AVG(lat), AVG(lng), COUNT(*), strftime('%s','now')
     FROM places WHERE area IS NOT NULL AND area <> ''
     GROUP BY dest, area COLLATE NOCASE`,
  ).run();
  return { rows: r?.meta?.changes ?? null };
}

/** Neighbourhood centroid, derived from the data rather than a hardcoded list. */
async function areaCenter(env, destSlug, text) {
  try {
    const results = await areaRows(env, destSlug);
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
  // The time words matter as much as the connectives: the strip runs last-word
  // first, so "Tulum next month" only reduces if "month" strips (then "next").
  // Without them, every "in <place> next week/month/weekend" produced a
  // garbage place name that matched nothing and lost the guest's grounding.
  /[\s,]+(right|now|today|tonight|tomorrow|currently|please|asap|at|for|until|till|this|next|and|but|so|with|on|the|a|an|area|city|pls|week|weeks|weekend|weekends|month|months|year|morning|afternoon|evening|night|day|days)$/i;

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

/**
 * The part of a message where the guest states where they ARE.
 *
 * Returns just that clause, so location resolution can read it without the
 * rest of the sentence — where the places they're asking ABOUT live. Returns
 * null when they never said, which is the common case and must stay cheap.
 *
 * Deliberately narrow: only phrasings that clearly mean "this is my current
 * position". "Heading to X" and "thinking about X" are not here-phrases, and
 * treating them as such would be the same bug pointed the other way.
 */
export function herePhrase(text) {
  const m = /\b(?:i['’]m|i am|we['’]re|we are|staying|we're staying|currently|right now)\s+(?:in|at|near)\s+([a-z][a-z'’.\- ]{0,40})/i.exec(text || '');
  if (m) return m[0];
  // "here in Kata" — same claim, different word order.
  const h = /\bhere in\s+([a-z][a-z'’.\- ]{0,40})/i.exec(text || '');
  return h ? h[0] : null;
}

/**
 * Is this string a neighbourhood we already hold places in?
 *
 * Reads the 16.5K-row num_dest_areas table (0016), whose `area` column is
 * COLLATE NOCASE and indexed, so this is an index seek. The previous query —
 * `SELECT 1 FROM places WHERE area LIKE ?1 COLLATE NOCASE LIMIT 1` — had no
 * index to use and scanned all 2.69M rows on a miss: 940 ms, measured. A miss
 * is precisely the case where the guest named somewhere we don't cover, so
 * the honest "I don't cover X" was the slowest thing Num said.
 * Equality, not LIKE: the caller passes a plain place name, never a pattern.
 */
async function isKnownArea(env, s) {
  try {
    const r = await env.DB
      .prepare('SELECT 1 FROM num_dest_areas WHERE area = ?1 LIMIT 1')
      .bind(s).first();
    return !!r;
  } catch (e) {
    // Table not migrated yet: keep the old behaviour rather than mis-classify.
    try {
      const r = await env.DB
        .prepare('SELECT 1 FROM places WHERE area LIKE ?1 COLLATE NOCASE LIMIT 1')
        .bind(s).first();
      return !!r;
    } catch (e2) { console.log('isKnownArea', String(e2)); return false; }
  }
}

/**
 * Where should recommendations be centred?
 * Priority: a place the guest named  >  where they actually are  >  where they
 * were last  >  a fallback centre, flagged as a guess.
 *
 * Two flags matter, and they mean different things:
 *
 * `guessed` — we do NOT know where the guest is. Nothing downstream may state
 * a city, a country or a local time. We are live in 38 countries: telling a
 * guest in London that they are in Phuket is worse than saying we don't know.
 *
 * `unsupported` — we know EXACTLY where the guest is, because they named it,
 * and we don't cover it. Resolution stops; `dest` still carries a value so
 * timezone and query plumbing keep working, but callers MUST check
 * `unsupported` before offering anything local. Don't ask them where they are
 * (they just told us), and never assert a different city.
 */
export async function resolveLocation(env, { text, guest, cf }) {
  const out = { dest: null, lat: null, lng: null, label: null, precise: false, source: 'default', guessed: false, offline: false };
  let dests = [];
  try { dests = await liveDestinations(env); } catch (e) { console.log('dests', String(e)); }
  // D1 is unreachable. Keep a centre so retrieval has something to hold, but this
  // is a guess, not a location.
  if (!dests.length) return { ...out, guessed: true, offline: true, dest: { slug: 'phuket', name: 'Phuket', country: 'TH', tz: 'Asia/Bangkok', lat: 7.953, lng: 98.338 } };

  // WHERE THEY ARE vs WHERE THEY ARE GOING.
  //
  // `destNamedIn` scans the whole message for any city we cover, with no idea
  // which grammatical role the name is playing. So "we are in kata — flights to
  // bangkok on friday?" resolved the guest TO BANGKOK: the destination won
  // because it was the only covered name in the sentence, and Kata — where
  // they were actually standing — never reached the model at all. It then
  // asked which airport "Kata" meant and suggested Katowice, Poland.
  //
  // A phrase like "we are in X" is the guest telling us where they are. That
  // is not a hint to weigh; it is the answer. When one is present it settles
  // the location, and any other city in the sentence is somewhere they are
  // asking ABOUT, not standing in.
  const here = herePhrase(text);
  const named = (here && destNamedIn(here, dests)) || (here ? null : destNamedIn(text, dests));

  // A place the guest stated that we don't cover as a destination. Guarded by
  // an area lookup first: "I'm staying in Patong" names a neighbourhood, not an
  // unsupported city, and areaCenter below handles those properly.
  // When the guest said where they are, only THAT phrase may name a place —
  // otherwise "we are in kata … to bangkok" hands `stated` the destination.
  let stated = named ? null : statedPlace(here ?? text);
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
  } else if (stated) {
    // The guest named somewhere, and it matched no destination we cover.
    // Believe them and stop here. Falling through to `last_dest` was the bug
    // that made a Phuket guest permanently a Phuket guest: once last_dest was
    // set, every later message resolved back to it no matter what they said.
    //
    // THIS BRANCH MUST COME BEFORE COORDINATES. It used to sit after the
    // `nearest` check, so a guest with an IP near a covered city who named
    // somewhere else was answered about the covered city: "let's plan the
    // horse races this weekend in Delmar" came back as Los Angeles
    // restaurants. The comment at the top of this function has always said
    // "a place the guest named > where they actually are" — the order of
    // these branches is where that promise is either kept or broken. A guest
    // planning a trip is usually not standing in the place they're asking
    // about; that is what planning means.
    out.unsupported = stated;
    out.source = 'unsupported';
    out.dest = dests.find(d => d.slug === guest?.last_dest) || dests.find(d => d.slug === 'phuket') || dests[0];
  } else if (nearest && nearest.km < 120) {
    out.dest = nearest.d; out.lat = coords.lat; out.lng = coords.lng;
    out.precise = coords.precise; out.source = coords.source;
  } else if (guest?.last_dest) {
    out.dest = dests.find(d => d.slug === guest.last_dest) || null;
    if (out.dest) out.source = 'last_seen';
  }
  // Nothing named, no usable coordinates, no history: we genuinely do not know.
  // Pick a centre so retrieval still works, and flag it so the prompt asks
  // rather than asserts.
  if (!out.dest) { out.dest = dests.find(d => d.slug === 'phuket') || dests[0]; out.guessed = true; }

  // ── A NAMED NEIGHBOURHOOD BEATS A COARSE GUESS ─────────────────────────
  //
  // THIS BLOCK USED TO READ `if (!out.lat)`, AND THAT ONE CONDITION IS WHY A
  // GUEST WAS TOLD "HOLLYWOOD IS A BLANK FOR ME" WHILE 3,082 HOLLYWOOD PLACES
  // SAT IN THE DIRECTORY, 2,797 OF THEM WITH A PHONE NUMBER.
  //
  // Her phone was in Los Angeles, so Cloudflare's IP geo had already filled
  // out.lat, so this block never ran, so `areaCenter` never read the word
  // "Hollywood" at all. Retrieval then searched rings around wherever the
  // handset happened to be, found nothing that fit a vegetarian standing-room
  // ask, and the model reported an empty directory. The directory was fine.
  // We simply never looked where she pointed.
  //
  // That inverted this function's own promise, stated at the top: "a place the
  // guest named > where they actually are". It was kept for cities and thrown
  // away for neighbourhoods, which is the half that guests actually say out
  // loud — nobody asks for "los-angeles", they ask for Hollywood, Brooklyn,
  // Shoreditch, Shibuya.
  //
  // The new rule, in one line: a neighbourhood the guest NAMED wins, unless
  // they asked for something near THEM and we have a real GPS fix. "Vegetarian
  // in Hollywood" centres on Hollywood even from a phone in Culver City.
  // "Somewhere close by" with a shared location still centres on them, because
  // there the guest's body is the subject of the sentence.
  const area = await areaCenter(env, out.dest.slug, text);
  const bodyWins = out.precise && asksNearMe(text);
  if (area && !bodyWins) {
    out.lat = area.lat;
    out.lng = area.lng;
    out.label = area.area;
    // `precise` must drop: a neighbourhood centroid is a district, not a
    // doorstep, and leaving it true makes retrieval search a 4km ring around
    // an averaged point and call it "walking distance".
    out.precise = false;
    out.source = 'named_area';
  } else if (!out.lat) {
    out.lat = out.dest.lat;
    out.lng = out.dest.lng;
    out.source = out.source === 'default' ? 'city_centre' : out.source;
  }
  return out;
}

// ---------------------------------------------------------------- retrieval

// `id` is first and is NOT rendered into the model prompt — prompt.mjs builds
// the partner block field by field, so this costs zero tokens. It is here so
// that when a place is recommended we can record WHICH place it was, exactly,
// rather than matching on a name later. Names collide across cities ('The
// Bridge' exists in most of them) and a merchant's impression count has to be
// right or it is worse than absent.
const SELECT_COLS = 'id, name, name_local, category, area, rating, reviews, phone, website, address, hours, cuisine, status, photo_url, photo_attr, photo_license, alive, hours_mask, booking_platform, booking_ref, num_rating, num_rating_n';

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
  -- What NUM's own guests said after they went. Everything above this line
  -- was crawled off the open web; this line is the only part of the score
  -- NUM learned, and it is the only part that can move DOWN.
  + ${NUM_RATING_TERM}
  - km * ?7
)`;

async function queryRing(env, { lat, lng, dest, patterns, radiusKm, distWeight, limit, negs = null, prefer = null }) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const cat = patterns && patterns.length
    ? ' AND (' + patterns.map((_, i) => `category LIKE ?${8 + i}`).join(' OR ') + ')'
    : '';
  // Bind slots run: ?1 lat, ?2 lng, ?3-?6 cells, ?7 distWeight, ?8+ patterns,
  // then exclusions, then the single prefer pattern. Computed rather than
  // written down, because a hand-counted offset is how this breaks silently.
  const negAt = 8 + (patterns?.length || 0);
  const neg = negs && negs.length
    ? ' AND NOT (' + negs.map((_, i) => `name LIKE ?${negAt + i}`).join(' OR ') + ')'
    : '';
  const prefAt = negAt + (negs?.length || 0);
  // A bonus, never a filter. 0.6 is about the gap between a 4.2 and a 4.8, so
  // it reorders within a good set without dragging a bad place to the top.
  const prefBonus = prefer ? ` + CASE WHEN name LIKE ?${prefAt} OR category LIKE ?${prefAt} THEN 0.6 ELSE 0 END` : '';
  const sql = `SELECT ${SELECT_COLS}, km FROM (
      SELECT ${SELECT_COLS}, lat, lng,
        ROUND(6371*acos(MAX(-1.0, MIN(1.0,
          cos(radians(?1))*cos(radians(lat))*cos(radians(lng)-radians(?2))
          + sin(radians(?1))*sin(radians(lat))))), 2) AS km
      FROM places
      -- alive = 0 means we FETCHED the venue's own website and found a dead
      -- domain, a 404, or a parked page. That is positive evidence the
      -- business has gone, so it is excluded here rather than merely ranked
      -- down: no amount of star rating makes a shuttered restaurant a good
      -- recommendation. NULL is unknown and stays eligible — most of the
      -- directory has never been checked, and hiding it would empty the map.
      WHERE (alive IS NULL OR alive = 1)
        AND cell_lat BETWEEN ?3 AND ?4 AND cell_lng BETWEEN ?5 AND ?6${cat}${neg}
    ) WHERE km <= ${Number(radiusKm)} ORDER BY ${SCORE}${prefBonus} DESC LIMIT ${Math.max(1, limit | 0)}`;
  const binds = [
    lat, lng,
    Math.floor((lat - dLat) * 10), Math.floor((lat + dLat) * 10),
    Math.floor((lng - dLng) * 10), Math.floor((lng + dLng) * 10),
    distWeight, ...(patterns || []), ...(negs || []), ...(prefer ? [prefer] : []),
  ];
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

/**
 * Verified partners to put in front of the model. Widens the search rather than
 * coming back empty: a guest asking for seafood in a quiet town should get the
 * best nearby restaurants, not an apology.
 */
export async function nearbyPlaces(env, loc, text, limit = 8, topicHint = null, { memberId = null } = {}) {
  // THE TOPIC CAN LIVE IN THE PREVIOUS TURN, AND USUALLY DOES WHEN NUM ASKED.
  //
  // On 14 Sep a guest was asked "full-service spa, quick walk-in, or
  // sports/deep-tissue massage?" and answered "Deep tissue". That answer
  // contains neither "massage" nor "spa", so detectCat returned null, the
  // search fell through to DEFAULT_PATTERNS — which include %spa% — and the
  // best-scoring match was a barbershop.
  //
  // The hint is the recent conversation, and it is used for the CATEGORY ONLY:
  // never for location (a city named three turns ago must not follow the guest
  // around) and never to override a category the current message states
  // outright. It fills a blank; it does not argue.
  const cat = detectCat(text) ?? (topicHint ? detectCat(topicHint) : null);
  const near = asksNearMe(text);
  const base = near ? 4 : (loc.precise ? 8 : 15);
  const patterns = cat ? CATSQL[cat] : DEFAULT_PATTERNS;
  const prefer = cat ? (subIntent(cat, text) ?? (topicHint ? subIntent(cat, topicHint) : null)) : null;
  const negs = exclusionsFor(cat, prefer);
  const rings = [base, base * 3, base * 8];
  let rows = [];
  // True when the rows below came from the whole destination rather than from
  // anywhere near the guest. The prompt MUST say so — see the floor below.
  let widened = false;
  try {
    for (const radiusKm of rings) {
      const distWeight = (near ? 2.5 : 1.25) / radiusKm;
      rows = await queryRing(env, { ...loc, patterns, radiusKm, distWeight, limit, negs, prefer });
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

    // ── THE FLOOR: A COVERED CITY NEVER COMES BACK EMPTY ─────────────────
    //
    // Dre's rule, 15 Sep 2026: "if we don't have a recommendation for an area
    // we should search for one. We should never not give any recommendation."
    //
    // Every ladder above is a RING — it searches outward from a point, and a
    // ring can still return nothing: a sparse neighbourhood centroid, a
    // category that does not exist for 120km, coordinates that landed in the
    // ocean. When that happened the model received an empty partner block and
    // did the only honest thing it could with it, which was apologise. An
    // apology is not a concierge.
    //
    // So: if the rings came back empty and we DO cover this destination, fall
    // back to the best-rated places in the whole destination, ignoring
    // distance entirely. Flagged `widened` so the prompt tells the truth about
    // it — "nothing in Hollywood proper fits, here are three in West
    // Hollywood" — rather than presenting across-town as around-the-corner.
    // Silently passing these off as local would be worse than the empty block.
    if (!rows.length && loc?.dest?.slug) {
      widened = true;
      const { results } = await env.DB.prepare(
        `SELECT ${SELECT_COLS} FROM places
          WHERE dest = ?1 AND alive IS NOT 0
          ORDER BY (rating IS NULL), rating DESC, reviews DESC
          LIMIT ?2`,
      ).bind(loc.dest.slug, limit).all();
      rows = results || [];
    }
  } catch (e) { console.log('nearbyPlaces', String(e)); }

  // ── NOT THE SAME THREE AGAIN ─────────────────────────────────────────
  //
  // 17 Sep 2026: with almost no rating signal the ranking was stable, so a
  // member asking "where should we eat" on Tuesday and Thursday got the
  // identical list, and said so. Two adjustments, both after the query so
  // the SQL stays cacheable:
  //   1. places this member was SHOWN in the last 14 days (num_place_
  //      impressions) drop below the ones they have not seen — they are
  //      still there if nothing else fits, just not first;
  //   2. among rows the score cannot separate (no rating on either), a
  //      quiet daily shuffle keyed on the day and the member, so two
  //      equally-unknown places take turns.
  // A rated place stays ahead of an unrated one either way.
  try {
    if (rows.length > 3) {
      const seen = new Set();
      if (memberId && env?.DB) {
        const { results } = await env.DB.prepare(
          `SELECT DISTINCT place_id FROM num_place_impressions WHERE member_id = ?1 AND ts >= datetime('now', '-14 day')`,
        ).bind(memberId).all();
        for (const r of results ?? []) seen.add(r.place_id);
      }
      const day = Math.floor(Date.now() / 86400000);
      const jitter = (id) => { let h = 0; const k = `${id}|${day}|${memberId ?? ''}`; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0; return (Math.abs(h) % 1000) / 1000; };
      const key = (r) => (r.rating != null ? 2 : 0) + (seen.has(r.id) ? -1 : 0) + (r.rating != null ? 0 : jitter(r.id) * 0.5);
      rows = rows.map((r, i) => ({ r, i, k: key(r) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.r);
    }
  } catch (e) { console.log('nearbyPlaces rotate', String(e)); }
  return { cat, rows: withOpenState(rows, loc?.dest?.tz), near, widened };
}

/**
 * Tag each row open / closed / unknown, and push the definitely-closed to
 * the back.
 *
 * Three states, and the third one is load-bearing. Los Angeles has hours for
 * 3,798 of 90,263 places; if unknown were treated as closed the city would
 * look empty, and if it were treated as open we would send people to locked
 * doors. So unknown keeps its rank and simply says nothing.
 *
 * Only a KNOWN-closed place is demoted, and it is demoted rather than
 * dropped — "Bestia is superb but shut until 5" is a genuinely useful answer,
 * and at 11pm a whole city of closed restaurants is still the honest picture.
 * Dropping them would leave a guest staring at an empty reply.
 */
export function withOpenState(rows, tz) {
  if (!Array.isArray(rows) || !rows.length) return rows ?? [];
  const tagged = rows.map((r) => ({ ...r, open_now: tz ? openNow(r.hours_mask, tz) : null }));
  const closed = tagged.filter((r) => r.open_now === false);
  return closed.length ? [...tagged.filter((r) => r.open_now !== false), ...closed] : tagged;
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
