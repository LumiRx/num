// Localrent — a car, from a local supplier, in the places Localrent actually is.
//
// ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
//
// Verified 30 Aug 2026, from inside a live partner account: Localrent's Tools
// tab offers an affiliate link, a link generator, a search widget and a white
// label. There is NO API. Their partners page lists "API Integration" as a
// tool and says nothing further about it anywhere; /en/api/ and /en/affiliate/
// both 404, and api.localrent.com serves the booking app rather than docs.
//
// So this is a deep-link rail and it is filed as one. Num picks the city,
// the dates and the filters, hands over an attributed URL, and the traveller
// books on Localrent. Num never says "booked".
//
// That is still worth building properly rather than pasting a bare homepage
// link, because the useful part is the FILTERS. Their white-label panel
// documents the search parameters — `gearbox[0]=automatic`, `multi_tabs[0]=suv`,
// `city_delivery=true` — which is the difference between "here's a car site"
// and "here's an automatic SUV delivered to your hotel in Phuket on the 4th".
// One of those is a concierge and the other is a banner ad.
//
// ── THE COVERAGE MAP IS THE POINT ────────────────────────────────────────
//
// Taken from their own sitemap: 38 countries, 434 city pages. Read the list
// and one thing jumps out —
//
//   THERE IS NO UNITED STATES, NO UNITED KINGDOM, AND NO INDONESIA.
//
// Num's traffic comes from Phuket, Bangkok, Los Angeles and Edinburgh. This
// rail serves the first two and is useless for the other two. That is not a
// disappointment to work around, it is the reason `carLink` returns null
// instead of guessing: a Localrent link for a traveller in Santa Monica is a
// dead end with our affiliate marker on it, which is worse than no link.
//
// Europe, the Caucasus, the Gulf, North Africa and a thin slice of SE Asia.
// Where Num is not in one of those, this rail must stay silent.

/** country slug → space-separated city slugs, exactly as their sitemap has them. */
const COVERAGE_RAW = Object.freeze({
  albania: 'durres rinas saranda tirana vlore',
  argentina: 'bariloche buenos-aires el-calafate mendoza ushuaia',
  armenia: 'gyumri yerevan',
  austria: 'salzburg vienna',
  azerbaijan: 'baku',
  bulgaria: 'ahtopol albena aytos balchik banevo bansko bjala blagoevgrad borovets burgas chernomorets dobrich dobrinishte duni elenite general-toshevo golden-sands kableshkovo kavarna kiten kosharitsa kranevo lozenets nesebar obzor pamporovo pazardzhik plovdiv pomorie primorsko ravda ruse sandanski sarafovo shumen sofia sozopol stara-zagora sunny-beach sveti-vlas tsarevo varna velingrad',
  chile: 'calama puerto-montt santiago',
  croatia: 'dubrovnik pula rijeka split zadar zagreb',
  cyprus: 'agios-theodoros agros alaminos anogyra apsiou argaka ayia-napa chloraka choirokoitia coral-bay dali dhekelia dhrousha episkopi erimi gourri kakopetria kalavasos kapparis kissonerga kouklia larnaca lasa latchi limassol mandria marki maroni mazotos nicosia nikitari ora pafos pano-lefkara paralimni peristerona perivolia pernera peyia pissouri platres polis pomos potamitissa protaras psematismenos pyla pyrgos skarinou sotira tala tersefanou tochni troulloi vavla yermasoyia yeroskipou',
  czech: 'beroun brno ceske-budejovice cesky-krumlov chomutov frantiskovy-lazne jachymov janske-lazne jindrichuv-hradec karlovy-vary kladno konstantinovy-lazne liberec marianske-lazne olomouc ostrava pardubice plzen podebrady prague spindleruv-mlyn tabor zlin znojmo',
  france: 'bordeaux lyon marseille nice',
  georgia: 'batumi borjomi kobuleti kutaisi poti senaki stepantsminda tbilisi telavi zestafoni zugdidi',
  germany: 'cologne dusseldorf frankfurt hamburg',
  greece: 'acharavi afantou afitos agia-fotia agia-marina agia-paraskevi agia-triada agios-ioannis agios-nikolaos agria akrotiri alimos analipsi anogeia archangelos argassi arkadi athens bali chalkidiki chania corfu crete elounda faliraki flogita gazi gazion gialova glyfada gouvia heraklion hersonissos ialysos ierapetra ierissos ipsos istro kalamata kardamili karlovasi kassandra katerini kerveli khanion-tou-kokkini kilkis kissamos kokkari kokkini-hani koropi kos kozani lindos litochoro makrygialos maleme malia messini metamorfosi milos mykonos naousa naxos nea-alikarnassos nea-kallikratia nea-potidea neapoli neos-marmaras nikos-kazantzakis oraiokastro ormylia panorama panormos paros perea petalidi piraeus plagiari plakias polygyros rafina rethymno rhodes salonica samos santorini sarti sidari sitia skala-fourkas skiathos souda stalis stavros stoupa thermi vamos vathi voula zakynthos',
  hungary: 'budapest',
  iceland: 'reykjavik',
  italy: 'bari bergamo brindisi catania milan naples olbia palermo pisa rome trapani',
  jordan: 'amman aqaba',
  korea: 'jeju',
  macedonia: 'skopje',
  malaysia: 'kuala-lumpur',
  montenegro: 'bar becici budva buljarica cetinje djenovici dobre-vode herceg-novi igalo kolasin kotor krasici niksic orahovac perast petrovac podgorica prcanj przno radovici rafailovici rezevici risan rose sutomore sveti-stefan tivat ulcinj zabljak',
  morocco: 'agadir casablanca essaouira fez marrakech oujda rabat tangier',
  oman: 'muscat',
  poland: 'gdansk krakow warsaw',
  portugal: 'albufeira algarve cascais faro funchal lagos lisbon madeira ponta-delgada portimao porto',
  qatar: 'doha',
  romania: 'bucharest',
  serbia: 'belgrade',
  seychelles: 'mahe praslin',
  slovenia: 'ljubljana',
  spain: 'alcudia alicante almeria barselona benalmadena benidorm bilbao cadiz cambrils canaries estepona formentera fuengirola fuerteventura girona gran-canaria granada ibiza la-gomera la-linea-de-la-concepcion lanzarote las-palmas lloret-de-mar madrid majorca malaga marbella menorca murcia nerja puerto-de-la-cruz reus salou santa-cruz-de-tenerife seville tarragona tenerife torremolinos valencia',
  tanzania: 'zanzibar',
  // surat-thani is NOT in their sitemap and is nonetheless a real page —
  // verified 200 with a proper title, while a nonsense slug 404s. So the
  // sitemap is a subset, not the whole map, which is exactly why an unlisted
  // city falls back to the country page rather than to nothing. Surat Thani
  // earns its manual entry: it is the mainland side of the Koh Phangan ferry,
  // where somebody who cannot take a hire car on the boat picks one up.
  thailand: 'bangkok chiang-rai chiangmai krabi pattaya phuket samui surat-thani',
  turkey: 'adana afyonkarahisar alanya ankara antakya antalya belek bodrum dalaman denizli didim erzurum fethiye gaziantep istanbul izmir kalkan kayseri kemer konya kusadasi malatya marmaris side trabzon tuzla',
  // All seven emirates, each fetched and confirmed a real page on 30 Aug 2026
  // — Ajman, Fujairah and Al Ain are absent from their sitemap and serve
  // proper pages anyway, the same subset problem Surat Thani exposed. They
  // matter because these are exactly NUM's seven live UAE destinations.
  uae: 'abu-dhabi ajman al-ain dubai fujairah ras-al-khaimah sharjah',
  vietnam: 'hanoi nha-trang',
});

export const COVERAGE = Object.freeze(
  Object.fromEntries(Object.entries(COVERAGE_RAW).map(([c, s]) => [c, Object.freeze(s.split(' '))])),
);

/**
 * ISO-3166 alpha-2 → Localrent's own country slug.
 *
 * Only the countries they actually serve appear here. A code that is missing
 * is missing on purpose: US, GB and ID are the loud ones, and Num has real
 * traffic in all three.
 */
export const COUNTRY_SLUG = Object.freeze({
  AL: 'albania', AR: 'argentina', AM: 'armenia', AT: 'austria', AZ: 'azerbaijan',
  BG: 'bulgaria', CL: 'chile', HR: 'croatia', CY: 'cyprus', CZ: 'czech',
  FR: 'france', GE: 'georgia', DE: 'germany', GR: 'greece', HU: 'hungary',
  IS: 'iceland', IT: 'italy', JO: 'jordan', KR: 'korea', MK: 'macedonia',
  MY: 'malaysia', ME: 'montenegro', MA: 'morocco', OM: 'oman', PL: 'poland',
  PT: 'portugal', QA: 'qatar', RO: 'romania', RS: 'serbia', SC: 'seychelles',
  SI: 'slovenia', ES: 'spain', TZ: 'tanzania', TH: 'thailand', TR: 'turkey',
  AE: 'uae', VN: 'vietnam',
});

/**
 * Their affiliate marker travels as `?marker=`, the Travelpayouts convention
 * Localrent bills through. Isolated here as a named constant with its own test
 * so that if their link generator turns out to use another parameter, exactly
 * one line changes and nothing silently stops paying.
 */
export const MARKER_PARAM = 'marker';

const BASE = 'https://www.localrent.com/en';

export const localrentReady = (env) => !!env?.LOCALRENT_MARKER;

/** Place names → their slugs, for the handful that do not transliterate cleanly. */
const ALIAS = Object.freeze({
  'chiang mai': 'chiangmai',
  'koh samui': 'samui',
  'ko samui': 'samui',
  'barcelona': 'barselona',
  'thessaloniki': 'salonica',
  'palma': 'majorca',
  'mallorca': 'majorca',
  'saint petersburg': null,
});

export function citySlug(name) {
  const raw = String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(ALIAS, raw)) return ALIAS[raw];
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
}

/**
 * Where on Localrent does this place live?
 *
 * Returns `{country, city}` — where `city` may be null, meaning "they are in
 * this country but we do not have a verified page for this town". That third
 * state exists because their sitemap turned out to be a SUBSET of their real
 * pages: /en/thailand/surat-thani/ is absent from it and serves a proper page
 * anyway, while a nonsense slug correctly 404s. Guessing an unlisted slug
 * would sometimes 404 with our marker attached; refusing outright would throw
 * away a country we genuinely cover. So an unknown city degrades to the
 * country page, which always exists and still lets the traveller pick.
 *
 * null means the country itself is not served, and that must stay null: a
 * Localrent link for somebody in Los Angeles is a dead end with our marker on
 * it, which is worse than no link at all.
 */
export function locate(place) {
  const code = String(place?.country_code || '').toUpperCase();
  const country = COUNTRY_SLUG[code] || (COVERAGE[citySlug(place?.country)] ? citySlug(place.country) : null);
  if (!country) return null;

  const cities = COVERAGE[country];
  const want = citySlug(place?.name);
  if (want && cities.includes(want)) return { country, city: want };

  // A neighbourhood or beach ("Kata", "Patong") is not its own Localrent page,
  // but the island it sits on is. If the place carries a parent, try it.
  const parent = citySlug(place?.city || place?.region || place?.parent);
  if (parent && cities.includes(parent)) return { country, city: parent };

  return { country, city: null };
}

const pad = (n) => String(n).padStart(2, '0');
/** Their search takes plain calendar dates; anything else is our bug, not theirs. */
export function isoDate(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * The link.
 *
 * @param {object} env
 * @param {object} place        Num's place — needs country_code and name
 * @param {object} [opts]
 * @param {string|Date} [opts.from]      pick-up
 * @param {string|Date} [opts.to]        drop-off
 * @param {boolean} [opts.automatic]     most Thai supply is manual; asking matters
 * @param {boolean} [opts.suv]           the 4WD case
 * @param {boolean} [opts.delivery]      brought to the hotel rather than collected
 * @returns {string|null} an attributed URL, or null when Localrent is not there
 */
export function carLink(env, place, opts = {}) {
  if (!localrentReady(env)) return null;
  const at = locate(place);
  if (!at) return null;

  const u = new URL(at.city ? `${BASE}/${at.country}/${at.city}/` : `${BASE}/${at.country}/`);
  const from = isoDate(opts.from);
  const to = isoDate(opts.to);
  if (from) u.searchParams.set('date_from', from);
  if (to) u.searchParams.set('date_to', to);
  // Documented in their white-label panel: filters ride as URL parameters and
  // the traveller can change them, which is exactly the right shape for a
  // concierge suggestion — an opinion, not a cage.
  if (opts.automatic) u.searchParams.set('gearbox[0]', 'automatic');
  if (opts.suv) u.searchParams.set('multi_tabs[0]', 'suv');
  if (opts.delivery) u.searchParams.set('city_delivery', 'true');
  u.searchParams.set(MARKER_PARAM, String(env.LOCALRENT_MARKER));
  return u.toString();
}

/**
 * The prompt block.
 *
 * Short on purpose. This rail is a link, not a search — Num has no prices and
 * no availability from it, and a block that implied otherwise would produce
 * invented daily rates, which is the exact failure the whole services layer
 * exists to prevent.
 */
export function carBlock(url, place) {
  if (!url) return '';
  return (
    `\n\nCAR HIRE HERE: Localrent covers ${place?.name || 'this city'} with LOCAL suppliers rather than the ` +
    'international chains, which is usually cheaper and is where the 4WDs and the automatics actually are. ' +
    `The link is ${url} — it opens a real search, prefilled.\n` +
    'You CANNOT see prices or availability through this and you cannot book it. Never quote a daily rate as ' +
    'though you had looked it up; if they want a number, give the honest local band and say the link has the ' +
    'live ones. Say what you HAVE done: chosen the city, set the dates, filtered to what they asked for. ' +
    'Mention the two things that catch people out here — most Thai supply is manual unless you filter for ' +
    'automatic, and many local suppliers will deliver the car to the hotel if you ask.'
  );
}
