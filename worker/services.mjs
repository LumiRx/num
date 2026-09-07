// The service layer — how Num actually gets a car ordered, food delivered, a
// table held, a therapist booked.
//
// There are two ways to fulfil a request, and being honest about which one is
// in play is the whole design:
//
//   1. CONNECTED — a real API with credentials. `ADAPTERS` is the seam. Nothing
//      is connected today (no accounts, no keys — that is the operator's call
//      to make, not ours), so `connected()` returns false everywhere and Num
//      never claims a car is on its way when it isn't.
//
//   2. HANDOFF — the easiest path that works RIGHT NOW: a deep link into the
//      app the user already has, prefilled with the destination, opened from
//      their phone. One tap, no account linking, no fake confirmations. For
//      most of the world this is genuinely faster than an integration.
//
// Which providers appear is decided by country, because "get me a car" means
// Uber in Los Angeles, Grab in Bangkok, Careem in Dubai and Bolt in Lisbon.
// Ranking is deliberate: the first entry is the one most people there actually
// use, so "the easiest way" means something.

// issuer.mjs owns the question of who can put a ticket in somebody's hand.
// It does not import this file back — the dependency runs one way on purpose.
import { canIssue } from './issuer.mjs';

/** ISO-3166 alpha-2 → the providers worth naming there, best first. */
const BY_COUNTRY = {
  TH: {
    ride: ['grab', 'bolt', 'indrive', 'uber'],
    food: ['grabfood', 'lineman', 'robinhood', 'foodpanda'],
    table: ['hungryhub', 'chope', 'thefork'],
    wellness: ['fresha', 'gowabi'],
  },
  AE: { ride: ['careem', 'uber', 'yango'], food: ['talabat', 'deliveroo', 'careemfood', 'noon'], table: ['thefork', 'opentable', 'sevenrooms'], wellness: ['fresha', 'treatwell'] },
  SA: { ride: ['uber', 'careem'], food: ['hungerstation', 'talabat', 'jahez'], table: ['thefork'], wellness: ['fresha'] },
  QA: { ride: ['careem', 'uber'], food: ['talabat', 'snoonu'], table: ['thefork'], wellness: ['fresha'] },
  KW: { ride: ['careem', 'uber'], food: ['talabat', 'deliveroo'], table: ['thefork'], wellness: ['fresha'] },
  US: { ride: ['uber', 'lyft'], food: ['doordash', 'ubereats', 'grubhub'], table: ['opentable', 'resy', 'tock'], wellness: ['booksy', 'fresha'] },
  CA: { ride: ['uber', 'lyft'], food: ['ubereats', 'doordash', 'skipthedishes'], table: ['opentable', 'resy'], wellness: ['booksy', 'fresha'] },
  GB: { ride: ['uber', 'bolt', 'freenow'], food: ['deliveroo', 'ubereats', 'justeat'], table: ['opentable', 'thefork', 'resy'], wellness: ['treatwell', 'fresha'] },
  IE: { ride: ['freenow', 'uber', 'bolt'], food: ['deliveroo', 'justeat'], table: ['opentable', 'thefork'], wellness: ['treatwell'] },
  FR: { ride: ['uber', 'bolt', 'freenow'], food: ['ubereats', 'deliveroo'], table: ['thefork', 'opentable'], wellness: ['treatwell', 'fresha'] },
  ES: { ride: ['uber', 'cabify', 'bolt'], food: ['glovo', 'ubereats', 'justeat'], table: ['thefork', 'opentable'], wellness: ['treatwell', 'fresha'] },
  PT: { ride: ['bolt', 'uber'], food: ['ubereats', 'glovo'], table: ['thefork'], wellness: ['treatwell'] },
  IT: { ride: ['freenow', 'uber', 'bolt'], food: ['glovo', 'deliveroo', 'justeat'], table: ['thefork', 'opentable'], wellness: ['treatwell'] },
  DE: { ride: ['uber', 'freenow', 'bolt'], food: ['lieferando', 'ubereats', 'wolt'], table: ['opentable', 'quandoo'], wellness: ['treatwell'] },
  NL: { ride: ['uber', 'bolt'], food: ['thuisbezorgd', 'ubereats'], table: ['thefork', 'opentable'], wellness: ['treatwell'] },
  PL: { ride: ['bolt', 'uber', 'freenow'], food: ['pyszne', 'wolt', 'glovo'], table: ['thefork'], wellness: ['booksy'] },
  SG: { ride: ['grab', 'gojek', 'tada'], food: ['grabfood', 'foodpanda', 'deliveroo'], table: ['chope', 'opentable', 'sevenrooms'], wellness: ['fresha', 'vaniday'] },
  MY: { ride: ['grab', 'indrive'], food: ['grabfood', 'foodpanda'], table: ['chope', 'thefork'], wellness: ['fresha'] },
  ID: { ride: ['gojek', 'grab'], food: ['gofood', 'grabfood'], table: ['chope'], wellness: ['fresha'] },
  VN: { ride: ['grab', 'be', 'xanhsm'], food: ['grabfood', 'shopeefood'], table: ['chope'], wellness: ['fresha'] },
  PH: { ride: ['grab', 'joyride'], food: ['grabfood', 'foodpanda'], table: ['chope'], wellness: ['fresha'] },
  HK: { ride: ['uber', 'hkTaxi'], food: ['foodpanda', 'deliveroo', 'keeta'], table: ['opentable', 'chope', 'sevenrooms'], wellness: ['fresha'] },
  JP: { ride: ['go', 'uber', 'didi'], food: ['ubereats', 'demaecan', 'wolt'], table: ['tabelog', 'opentable'], wellness: ['fresha'] },
  KR: { ride: ['kakaot', 'uber'], food: ['baemin', 'coupangeats'], table: ['catchtable'], wellness: ['fresha'] },
  AU: { ride: ['uber', 'didi', 'ola'], food: ['ubereats', 'doordash', 'menulog'], table: ['opentable', 'thefork'], wellness: ['fresha'] },
  NZ: { ride: ['uber', 'ola'], food: ['ubereats', 'doordash'], table: ['opentable'], wellness: ['fresha'] },
  IN: { ride: ['uber', 'ola', 'rapido'], food: ['swiggy', 'zomato'], table: ['dineout', 'zomato'], wellness: ['urbancompany'] },
  BR: { ride: ['uber', '99'], food: ['ifood', 'rappi'], table: ['thefork', 'opentable'], wellness: ['fresha'] },
  MX: { ride: ['uber', 'didi', 'cabify'], food: ['rappi', 'ubereats', 'didifood'], table: ['opentable'], wellness: ['fresha'] },
  AR: { ride: ['uber', 'cabify', 'didi'], food: ['pedidosya', 'rappi'], table: ['thefork'], wellness: ['fresha'] },
  CO: { ride: ['uber', 'didi', 'cabify'], food: ['rappi', 'didifood'], table: ['opentable'], wellness: ['fresha'] },
  ZA: { ride: ['uber', 'bolt'], food: ['ubereats', 'mrdfood'], table: ['dineplan'], wellness: ['fresha'] },
  NG: { ride: ['bolt', 'uber', 'indrive'], food: ['chowdeck', 'glovo'], table: ['opentable'], wellness: ['fresha'] },
  KE: { ride: ['bolt', 'uber', 'littlecab'], food: ['glovo', 'ubereats'], table: ['opentable'], wellness: ['fresha'] },
  EG: { ride: ['uber', 'careem', 'indrive'], food: ['talabat', 'elmenus'], table: ['opentable'], wellness: ['fresha'] },
  TR: { ride: ['uber', 'bitaksi'], food: ['yemeksepeti', 'getir'], table: ['thefork'], wellness: ['fresha'] },
};

/**
 * Travel is not a per-country market the way a taxi is — the same three
 * metasearch engines cover the planet, and the airline you want is the one you
 * hold status with. So flights and hotels come from one global set, ordered
 * comparison-first: the honest answer to "find me the best price" is to put the
 * same search into the engines that actually compare, not to guess a winner.
 */
const TRAVEL = {
  flight: ['googleflights', 'skyscanner', 'kayak'],
  hotel: ['booking', 'googlehotels', 'agoda', 'expedia'],
  rail: ['trainline', 'omio'],
};

/** Loyalty programmes worth knowing about — used to bias a recommendation. */
export const AIRLINES = {
  delta: { name: 'Delta', url: 'https://www.delta.com/', alliance: 'SkyTeam' },
  united: { name: 'United', url: 'https://www.united.com/', alliance: 'Star Alliance' },
  american: { name: 'American', url: 'https://www.aa.com/', alliance: 'oneworld' },
  emirates: { name: 'Emirates', url: 'https://www.emirates.com/', alliance: null },
  qatar: { name: 'Qatar Airways', url: 'https://www.qatarairways.com/', alliance: 'oneworld' },
  singapore: { name: 'Singapore Airlines', url: 'https://www.singaporeair.com/', alliance: 'Star Alliance' },
  ba: { name: 'British Airways', url: 'https://www.britishairways.com/', alliance: 'oneworld' },
  lufthansa: { name: 'Lufthansa', url: 'https://www.lufthansa.com/', alliance: 'Star Alliance' },
  airfrance: { name: 'Air France', url: 'https://www.airfrance.com/', alliance: 'SkyTeam' },
  klm: { name: 'KLM', url: 'https://www.klm.com/', alliance: 'SkyTeam' },
  etihad: { name: 'Etihad', url: 'https://www.etihad.com/', alliance: null },
  turkish: { name: 'Turkish Airlines', url: 'https://www.turkishairlines.com/', alliance: 'Star Alliance' },
  cathay: { name: 'Cathay Pacific', url: 'https://www.cathaypacific.com/', alliance: 'oneworld' },
  ana: { name: 'ANA', url: 'https://www.ana.co.jp/', alliance: 'Star Alliance' },
  jal: { name: 'JAL', url: 'https://www.jal.co.jp/', alliance: 'oneworld' },
  thai: { name: 'Thai Airways', url: 'https://www.thaiairways.com/', alliance: 'Star Alliance' },
  qantas: { name: 'Qantas', url: 'https://www.qantas.com/', alliance: 'oneworld' },
  jetblue: { name: 'JetBlue', url: 'https://www.jetblue.com/', alliance: null },
  southwest: { name: 'Southwest', url: 'https://www.southwest.com/', alliance: null },
  ryanair: { name: 'Ryanair', url: 'https://www.ryanair.com/', alliance: null },
  easyjet: { name: 'easyJet', url: 'https://www.easyjet.com/', alliance: null },
  airasia: { name: 'AirAsia', url: 'https://www.airasia.com/', alliance: null },
  indigo: { name: 'IndiGo', url: 'https://www.goindigo.in/', alliance: null },
};

export const HOTEL_GROUPS = {
  marriott: { name: 'Marriott Bonvoy', url: 'https://www.marriott.com/' },
  hilton: { name: 'Hilton Honors', url: 'https://www.hilton.com/' },
  hyatt: { name: 'World of Hyatt', url: 'https://www.hyatt.com/' },
  ihg: { name: 'IHG One Rewards', url: 'https://www.ihg.com/' },
  accor: { name: 'ALL — Accor', url: 'https://all.accor.com/' },
  wyndham: { name: 'Wyndham Rewards', url: 'https://www.wyndhamhotels.com/' },
  shangrila: { name: 'Shangri-La Circle', url: 'https://www.shangri-la.com/' },
  fourseasons: { name: 'Four Seasons', url: 'https://www.fourseasons.com/' },
  aman: { name: 'Aman', url: 'https://www.aman.com/' },
  airbnb: { name: 'Airbnb', url: 'https://www.airbnb.com/' },
};

/** Sensible worldwide default when the country isn't mapped. */
const FALLBACK = { ride: ['uber', 'bolt'], food: ['ubereats'], table: ['opentable', 'thefork'], wellness: ['fresha'] };

const enc = encodeURIComponent;
/** Skyscanner wants YYMMDD; everyone else takes ISO. */
const ymd = (iso) => (iso ? String(iso).slice(2).replace(/-/g, '') : '');

/**
 * Every provider Num can name. `link(ctx)` builds the deepest link that works
 * without an account on our side; `note` is the one line Num says about it.
 */
const PROVIDERS = {
  // ── ride ────────────────────────────────────────────────────────────────
  uber: { name: 'Uber', kind: 'ride', link: (c) => `https://m.uber.com/ul/?action=setPickup&pickup=my_location${c.to ? `&dropoff[formatted_address]=${enc(c.to)}` : ''}${c.toLat ? `&dropoff[latitude]=${c.toLat}&dropoff[longitude]=${c.toLng}` : ''}` },
  lyft: { name: 'Lyft', kind: 'ride', link: (c) => `https://ride.lyft.com/ridetype?id=lyft${c.toLat ? `&destination[latitude]=${c.toLat}&destination[longitude]=${c.toLng}` : ''}` },
  bolt: { name: 'Bolt', kind: 'ride', link: (c) => `https://bolt.eu/en/ride/${c.toLat ? `?destination_lat=${c.toLat}&destination_lng=${c.toLng}` : ''}` },
  grab: { name: 'Grab', kind: 'ride', link: () => 'https://www.grab.com/transport/', app: (c) => `grab://open?screenType=BOOKING${c.to ? `&dropOffAddress=${enc(c.to)}` : ''}` },
  careem: { name: 'Careem', kind: 'ride', link: () => 'https://www.careem.com/', app: (c) => `careem://rides${c.toLat ? `?dropoff_latitude=${c.toLat}&dropoff_longitude=${c.toLng}` : ''}` },
  gojek: { name: 'Gojek', kind: 'ride', link: () => 'https://www.gojek.com/' },
  didi: { name: 'DiDi', kind: 'ride', link: () => 'https://web.didiglobal.com/' },
  indrive: { name: 'inDrive', kind: 'ride', link: () => 'https://indrive.com/', note: 'you name the fare' },
  ola: { name: 'Ola', kind: 'ride', link: () => 'https://www.olacabs.com/' },
  cabify: { name: 'Cabify', kind: 'ride', link: () => 'https://cabify.com/' },
  freenow: { name: 'FREE NOW', kind: 'ride', link: () => 'https://www.free-now.com/', note: 'licensed taxis' },
  yango: { name: 'Yango', kind: 'ride', link: () => 'https://yango.com/' },
  '99': { name: '99', kind: 'ride', link: () => 'https://99app.com/' },
  tada: { name: 'TADA', kind: 'ride', link: () => 'https://tada.global/', note: 'zero commission' },
  be: { name: 'Be', kind: 'ride', link: () => 'https://be.com.vn/' },
  xanhsm: { name: 'Xanh SM', kind: 'ride', link: () => 'https://xanhsm.com/', note: 'all-electric' },
  joyride: { name: 'JoyRide', kind: 'ride', link: () => 'https://joyride.com.ph/' },
  rapido: { name: 'Rapido', kind: 'ride', link: () => 'https://rapido.bike/', note: 'bike taxis, fastest in traffic' },
  go: { name: 'GO', kind: 'ride', link: () => 'https://go.mo-t.com/', note: 'Japan’s taxi app' },
  kakaot: { name: 'Kakao T', kind: 'ride', link: () => 'https://kakaomobility.com/' },
  bitaksi: { name: 'BiTaksi', kind: 'ride', link: () => 'https://bitaksi.com/' },
  hkTaxi: { name: 'HKTaxi', kind: 'ride', link: () => 'https://hktaxiapp.com/' },
  littlecab: { name: 'Little', kind: 'ride', link: () => 'https://little.bz/' },

  // ── food ────────────────────────────────────────────────────────────────
  ubereats: { name: 'Uber Eats', kind: 'food', link: (c) => `https://www.ubereats.com/${c.q ? `search?q=${enc(c.q)}` : ''}` },
  doordash: { name: 'DoorDash', kind: 'food', link: (c) => `https://www.doordash.com/${c.q ? `search/store/${enc(c.q)}` : ''}` },
  grubhub: { name: 'Grubhub', kind: 'food', link: () => 'https://www.grubhub.com/' },
  deliveroo: { name: 'Deliveroo', kind: 'food', link: () => 'https://deliveroo.com/' },
  justeat: { name: 'Just Eat', kind: 'food', link: () => 'https://www.just-eat.co.uk/' },
  glovo: { name: 'Glovo', kind: 'food', link: () => 'https://glovoapp.com/' },
  foodpanda: { name: 'foodpanda', kind: 'food', link: () => 'https://www.foodpanda.com/' },
  grabfood: { name: 'GrabFood', kind: 'food', link: () => 'https://food.grab.com/' },
  gofood: { name: 'GoFood', kind: 'food', link: () => 'https://gofood.co.id/' },
  lineman: { name: 'LINE MAN', kind: 'food', link: () => 'https://lineman.line.me/', note: 'widest street-food coverage in Thailand' },
  robinhood: { name: 'Robinhood', kind: 'food', link: () => 'https://robinhood.in.th/' },
  talabat: { name: 'talabat', kind: 'food', link: () => 'https://www.talabat.com/' },
  careemfood: { name: 'Careem Food', kind: 'food', link: () => 'https://www.careem.com/food/' },
  noon: { name: 'noon Food', kind: 'food', link: () => 'https://food.noon.com/' },
  hungerstation: { name: 'HungerStation', kind: 'food', link: () => 'https://hungerstation.com/' },
  jahez: { name: 'Jahez', kind: 'food', link: () => 'https://www.jahez.net/' },
  snoonu: { name: 'Snoonu', kind: 'food', link: () => 'https://snoonu.com/' },
  rappi: { name: 'Rappi', kind: 'food', link: () => 'https://www.rappi.com/' },
  ifood: { name: 'iFood', kind: 'food', link: () => 'https://www.ifood.com.br/' },
  pedidosya: { name: 'PedidosYa', kind: 'food', link: () => 'https://www.pedidosya.com/' },
  didifood: { name: 'DiDi Food', kind: 'food', link: () => 'https://www.didi-food.com/' },
  swiggy: { name: 'Swiggy', kind: 'food', link: () => 'https://www.swiggy.com/' },
  zomato: { name: 'Zomato', kind: 'food', link: () => 'https://www.zomato.com/' },
  wolt: { name: 'Wolt', kind: 'food', link: () => 'https://wolt.com/' },
  lieferando: { name: 'Lieferando', kind: 'food', link: () => 'https://www.lieferando.de/' },
  thuisbezorgd: { name: 'Thuisbezorgd', kind: 'food', link: () => 'https://www.thuisbezorgd.nl/' },
  pyszne: { name: 'Pyszne.pl', kind: 'food', link: () => 'https://www.pyszne.pl/' },
  menulog: { name: 'Menulog', kind: 'food', link: () => 'https://www.menulog.com.au/' },
  skipthedishes: { name: 'SkipTheDishes', kind: 'food', link: () => 'https://www.skipthedishes.com/' },
  demaecan: { name: 'Demae-can', kind: 'food', link: () => 'https://demae-can.com/' },
  baemin: { name: 'Baemin', kind: 'food', link: () => 'https://www.baemin.com/' },
  coupangeats: { name: 'Coupang Eats', kind: 'food', link: () => 'https://www.coupangeats.com/' },
  shopeefood: { name: 'ShopeeFood', kind: 'food', link: () => 'https://shopeefood.vn/' },
  keeta: { name: 'Keeta', kind: 'food', link: () => 'https://www.keeta.com/' },
  chowdeck: { name: 'Chowdeck', kind: 'food', link: () => 'https://chowdeck.com/' },
  mrdfood: { name: 'Mr D Food', kind: 'food', link: () => 'https://www.mrdfood.com/' },
  elmenus: { name: 'elmenus', kind: 'food', link: () => 'https://www.elmenus.com/' },
  yemeksepeti: { name: 'Yemeksepeti', kind: 'food', link: () => 'https://www.yemeksepeti.com/' },
  getir: { name: 'Getir', kind: 'food', link: () => 'https://getir.com/' },

  // ── table ───────────────────────────────────────────────────────────────
  opentable: { name: 'OpenTable', kind: 'table', link: (c) => `https://www.opentable.com/s?term=${enc(c.q ?? '')}${c.covers ? `&covers=${c.covers}` : ''}` },
  resy: { name: 'Resy', kind: 'table', link: (c) => `https://resy.com/${c.q ? `cities?query=${enc(c.q)}` : ''}` },
  tock: { name: 'Tock', kind: 'table', link: () => 'https://www.exploretock.com/' },
  thefork: { name: 'TheFork', kind: 'table', link: (c) => `https://www.thefork.com/search?cityName=${enc(c.city ?? '')}` },
  chope: { name: 'Chope', kind: 'table', link: () => 'https://www.chope.co/' },
  hungryhub: { name: 'Hungry Hub', kind: 'table', link: () => 'https://hungryhub.com/', note: 'fixed-price buffets and set menus' },
  quandoo: { name: 'Quandoo', kind: 'table', link: () => 'https://www.quandoo.de/' },
  sevenrooms: { name: 'SevenRooms', kind: 'table', link: () => 'https://www.sevenrooms.com/' },
  tabelog: { name: 'Tabelog', kind: 'table', link: () => 'https://tabelog.com/en/' },
  catchtable: { name: 'CatchTable', kind: 'table', link: () => 'https://www.catchtable.co.kr/' },
  dineout: { name: 'Dineout', kind: 'table', link: () => 'https://www.dineout.co.in/' },
  dineplan: { name: 'Dineplan', kind: 'table', link: () => 'https://www.dineplan.com/' },

  // ── travel: compare first, then book direct if they hold status ─────────
  googleflights: {
    name: 'Google Flights',
    kind: 'flight',
    note: 'best overall price view',
    link: (c) =>
      `https://www.google.com/travel/flights?q=${enc(
        `Flights from ${c.from ?? ''} to ${c.to ?? ''}${c.depart ? ` on ${c.depart}` : ''}${c.ret ? ` returning ${c.ret}` : ''}`.trim(),
      )}`,
  },
  skyscanner: {
    name: 'Skyscanner',
    kind: 'flight',
    note: 'whole-month view',
    link: (c) =>
      c.fromCode && c.toCode
        ? `https://www.skyscanner.net/transport/flights/${c.fromCode.toLowerCase()}/${c.toCode.toLowerCase()}/${ymd(c.depart)}/${c.ret ? ymd(c.ret) + '/' : ''}`
        : 'https://www.skyscanner.net/',
  },
  kayak: {
    name: 'Kayak',
    kind: 'flight',
    link: (c) =>
      c.fromCode && c.toCode
        ? `https://www.kayak.com/flights/${c.fromCode.toUpperCase()}-${c.toCode.toUpperCase()}/${c.depart ?? ''}${c.ret ? '/' + c.ret : ''}`
        : 'https://www.kayak.com/flights',
  },
  booking: {
    name: 'Booking.com',
    kind: 'hotel',
    note: 'widest inventory',
    link: (c) =>
      `https://www.booking.com/searchresults.html?ss=${enc(c.q ?? c.city ?? '')}${c.checkin ? `&checkin=${c.checkin}` : ''}${c.checkout ? `&checkout=${c.checkout}` : ''}${c.adults ? `&group_adults=${c.adults}` : ''}`,
  },
  googlehotels: { name: 'Google Hotels', kind: 'hotel', note: 'price across every site at once', link: (c) => `https://www.google.com/travel/search?q=${enc((c.q ?? c.city ?? '') + ' hotels')}` },
  agoda: { name: 'Agoda', kind: 'hotel', note: 'strongest in Asia', link: (c) => `https://www.agoda.com/search?q=${enc(c.q ?? c.city ?? '')}` },
  expedia: { name: 'Expedia', kind: 'hotel', link: (c) => `https://www.expedia.com/Hotel-Search?destination=${enc(c.q ?? c.city ?? '')}${c.checkin ? `&startDate=${c.checkin}` : ''}${c.checkout ? `&endDate=${c.checkout}` : ''}` },
  trainline: { name: 'Trainline', kind: 'rail', link: () => 'https://www.thetrainline.com/' },
  omio: { name: 'Omio', kind: 'rail', note: 'train, bus and flight in one search', link: () => 'https://www.omio.com/' },

  // ── wellness ────────────────────────────────────────────────────────────
  fresha: { name: 'Fresha', kind: 'wellness', link: (c) => `https://www.fresha.com/search?q=${enc(c.q ?? 'massage')}` },
  treatwell: { name: 'Treatwell', kind: 'wellness', link: () => 'https://www.treatwell.co.uk/' },
  booksy: { name: 'Booksy', kind: 'wellness', link: () => 'https://booksy.com/' },
  gowabi: { name: 'GoWabi', kind: 'wellness', link: () => 'https://gowabi.com/', note: 'Thailand spa deals' },
  vaniday: { name: 'Vaniday', kind: 'wellness', link: () => 'https://www.vaniday.com.sg/' },
  urbancompany: { name: 'Urban Company', kind: 'wellness', link: () => 'https://www.urbancompany.com/', note: 'comes to you' },
};

/**
 * API adapters. Each entry means "we hold credentials and can complete this
 * end to end". Empty on purpose: signing commercial agreements with Uber,
 * Grab, DoorDash et al is a business decision, and an empty registry is the
 * mechanism that stops Num from claiming a booking it cannot make.
 *
 * To connect one, add `{ id: { kind, ready: (env) => !!env.X_KEY, order: async (env, req) => ({...}) } }`
 * and the same code path starts fulfilling instead of handing off.
 */
export const ADAPTERS = {
  // DoorDash Drive: a courier between two addresses. The first rail that is
  // genuinely connected, so `connected()` finally returns true for something
  // and the prompt's HAND-OFF language stops applying to it.
  doordash_drive: {
    kind: 'courier',
    label: 'DoorDash Drive',
    ready: (env) => !!(env.DOORDASH_DEVELOPER_ID && env.DOORDASH_KEY_ID && env.DOORDASH_SIGNING_SECRET),
    needs: 'DOORDASH_DEVELOPER_ID + DOORDASH_KEY_ID + DOORDASH_SIGNING_SECRET',
  },

  // Sabre: the first real air and stay content Num has had. Note the kinds are
  // 'flight_shop' and 'stay_shop', not 'flight' and 'stay' — Sabre quotes,
  // it does not book, and naming it as though it books is how a prompt ends up
  // promising a ticket nobody holds.
  sabre_air: {
    kind: 'flight_shop',
    label: 'Sabre (flights — quotes only)',
    ready: (env) => !!(env.SABRE_CLIENT_ID && env.SABRE_CLIENT_SECRET),
    needs: 'SABRE_CLIENT_ID + SABRE_CLIENT_SECRET',
  },
  // Duffel: the token has been present for a while and nothing declared it, so
  // `connected()` said no while the code said yes. Registered as a SHOPPING
  // rail deliberately. Duffel is technically capable of issuing — unlike Sabre
  // — but whether Num ever becomes the merchant of record on a ticket is a
  // legal decision (see the §17550 note below), not a consequence of holding
  // an access token. Until that decision is made, this searches.
  duffel: {
    kind: 'flight_shop',
    label: 'Duffel (flights — search; issuing is a separate decision)',
    ready: (env) => !!env.DUFFEL_ACCESS_TOKEN,
    needs: 'DUFFEL_ACCESS_TOKEN',
  },

  // Localrent: local-supplier car hire. A LINK rail, not a search one — they
  // have no API at all (verified from inside a live partner account), so Num
  // sees no prices and no availability. The kind says 'car_link' rather than
  // 'car' so nothing downstream can mistake an attributed URL for a booking.
  localrent: {
    kind: 'car_link',
    label: 'Localrent (car hire — attributed deep link, no prices)',
    ready: (env) => !!env.LOCALRENT_MARKER,
    needs: 'LOCALRENT_MARKER',
  },

  // Geoapify: addresses into coordinates, for the submissions queue. Not a
  // consumer-facing rail at all — it is infrastructure, and the kind says so.
  geoapify: {
    kind: 'geocoder',
    label: 'Geoapify (geocoding — self-submitted places)',
    ready: (env) => !!env.GEOAPIFY_KEY,
    needs: 'GEOAPIFY_KEY',
  },

  // Ticketmaster Discovery: what is on. A SEARCH rail — Discovery reads, it
  // cannot sell. Their Partner API does checkout and their own docs say it is
  // "restricted to companies with whom Ticketmaster has existing, official
  // distribution relationships", which we are not.
  ticketmaster: {
    kind: 'event_shop',
    label: 'Ticketmaster Discovery (events — search only, US/UK/EU)',
    ready: (env) => !!env.TICKETMASTER_API_KEY,
    needs: 'TICKETMASTER_API_KEY',
  },

  // Bounce: luggage storage, an attributed link and nothing more.
  bounce: {
    kind: 'luggage_link',
    label: 'Bounce (luggage storage — attributed link)',
    ready: (env) => !!env.BOUNCE_REF,
    needs: 'BOUNCE_REF',
  },

  // Viator: tours, day trips and the "what is there to do here" question. Like
  // Sabre this is a SHOPPING rail, and the kind says so — 'activity_shop', not
  // 'activity'. Basic Access searches and attributes; the traveller buys on
  // Viator's page. Naming it 'activity' would let anyConnected() tell the
  // prompt we can complete a booking we cannot make.
  viator: {
    kind: 'activity_shop',
    label: 'Viator (tours & activities — search and attributed link)',
    ready: (env) => !!env.VIATOR_API_KEY,
    needs: 'VIATOR_API_KEY',
  },

  sabre_hotel: {
    kind: 'stay_shop',
    label: 'Sabre (hotel rates — quotes only)',
    // Credentials alone are not enough here: the rates endpoint path is not
    // published in the overview docs, so this stays false until it is set.
    ready: (env) => !!(env.SABRE_CLIENT_ID && env.SABRE_CLIENT_SECRET && env.SABRE_HOTEL_RATES_PATH),
    needs: 'SABRE_CLIENT_ID + SABRE_CLIENT_SECRET + SABRE_HOTEL_RATES_PATH',
  },
};

export const connected = (env, id) => !!ADAPTERS[id]?.ready?.(env);

/** True when ANY provider of this kind can be completed by us end to end. */
export const anyConnected = (env, kind) =>
  Object.entries(ADAPTERS).some(([id, a]) => a.kind === kind && a.ready?.(env) && PROVIDERS[id]);

/**
 * The options Num should offer for a request, best first.
 * Returns `{ mode: 'connected' | 'handoff', options: [{id, name, url, note}] }`.
 */
export function optionsFor(kind, ctxIn = {}, env = {}) {
  const { country, city, to, toLat, toLng, q, covers } = ctxIn;
  const set =
    TRAVEL[kind] ?? (BY_COUNTRY[String(country || '').toUpperCase()] ?? FALLBACK)[kind] ?? FALLBACK[kind] ?? [];
  const ctx = { ...ctxIn, to, toLat, toLng, q, covers, city };
  const options = set
    .map((id) => {
      const p = PROVIDERS[id];
      if (!p) return null;
      return {
        id,
        name: p.name,
        url: p.link(ctx),
        app: p.app ? p.app(ctx) : null,
        note: p.note ?? null,
        connected: connected(env, id),
      };
    })
    .filter(Boolean);
  return { mode: anyConnected(env, kind) ? 'connected' : 'handoff', options };
}

/** Compact block for the model: what it may promise, and with which names. */
/**
 * What Num may say about fares, which depends on whether Sabre is wired up.
 *
 * The two states are genuinely different promises and the wording has to move
 * with them. Unconnected, every price is a recollection and must be hedged.
 * Connected, the price is real and hedging it is its own kind of dishonesty —
 * but "I can see the fare" and "I can buy the ticket" are still separate
 * claims, and Sabre's shopping APIs only grant the first. A model told it is
 * connected, without being told where connection stops, will book something
 * that does not exist.
 */
/**
 * Can Num put a ticket in somebody's hand ITSELF?
 *
 * Booking is a separate permission from shopping and is off by default even
 * when the credentials that could do it are present. Sabre shops but does not
 * issue; Duffel could issue but whether Num becomes merchant of record is a
 * legal decision (see the §17550 note below), not a consequence of holding an
 * access token.
 *
 * Exported because the LetsGo2Trip fallback in letsgo2trip.mjs asks the same
 * question, and two places with their own opinion about whether Num can book
 * is how a fallback quietly becomes the primary route — or stops firing on
 * the day Num finally can issue and nobody notices. One definition.
 */
export const canIssueFlight = (env) =>
  (env?.SABRE_BOOKING_ENABLED === 'true' && !!env?.SABRE_BOOKING_PATHS)
  // Or a configured issuer that actually issues. `canIssue` is false for the
  // simulator by construction — see issuer.mjs — so running the full booking
  // pipeline for a demo cannot make the concierge tell a real traveller that
  // Num can book their flight.
  || canIssue(env);

function airBlock(env) {
  const air = connected(env, 'sabre_air');
  const stay = connected(env, 'sabre_hotel');
  const canBook = canIssueFlight(env);
  if (!air && !stay) {
    return (
      '\n\nFLIGHTS & HOTELS: you cannot see live fares, so never state a price as current and never claim a fare is the ' +
      'cheapest. Say the band people actually pay on that route, then put the SAME search into the comparison engines via a ' +
      'service action with kind flight or hotel (fill from/to/fromCode/toCode/depart/ret, or city/checkin/checkout). If the ' +
      'KNOWN FACTS carry an airline status or hotel programme, weigh it openly and say why — status on the route is often ' +
      'worth more than the cheapest fare, and sometimes it plainly is not. '
    );
  }
  return (
    '\n\nFLIGHTS & HOTELS — READ THIS CAREFULLY, IT IS TWO DIFFERENT PERMISSIONS:\n' +
    (air
      ? 'HOW you see them: emit a flight_search ACTION with {fromCode, toCode, depart, ret, adults, cabin}. The app runs the search ' +
        'and shows the fares itself, so do NOT promise to "come back with numbers" and do not write prices in your reply — emit the ' +
        'action and say one short line about what you are pricing. The card appears under your message. Guess sensible IATA codes ' +
        'from city names (Paris CDG, Berlin BER); only ask if the city genuinely has several and it matters.\n' +
        'WHERE THEY ARE FLYING FROM is the place in your context block — NOT a re-reading of their words. 9 Aug: a guest in ' +
        'Kata, Phuket wrote "we are in kata" and was told "you\'re in Kathmandu" — a beach became a country. If what they typed ' +
        'is a neighbourhood, beach or district, the departure airport is the one serving THAT AREA (Kata → Phuket → HKT). ' +
        'Never resolve a place name to a distant city because the spelling is close; if you genuinely cannot tell, ask which ' +
        'airport rather than picking one.\n' +
        'You CAN see real fares. Sabre is connected for flight shopping, so when a fare comes back from a search you may ' +
        'state the price, carrier, times and stops as FACT, with no hedging — hedging a real number reads as evasion. ' +
        'Quote the currency it came back in. Offers expire (usually ~20 minutes): if you are working from a fare that has ' +
        'aged, say so and re-search rather than repeating it.\n'
      : 'Flight fares are NOT connected — treat prices as remembered bands, never as current.\n') +
    (stay
      ? 'You CAN see real hotel rates, and you can confirm one specific rate with the supplier before anyone commits.\n'
      : 'Hotel rates are NOT connected — treat nightly prices as remembered bands, never as current.\n') +
    (air
      ? 'You CAN also revalidate one specific fare against the airline before the traveller commits — that is the flight ' +
        'check. The check returns isSameFare. If it is TRUE you may say "I\u2019ve just re-checked it and that exact fare is ' +
        'still live at that price", which is a real and valuable thing to have done. If it is FALSE the airline gave us a ' +
        'DIFFERENT option — usually the same cabin at another price or booking class — and you must say so plainly and show ' +
        'what changed, rather than presenting it as the fare they were looking at. Quoting a substituted fare as though ' +
        'nothing moved is the exact deception the check exists to prevent. A check also surfaces hidden stops and the ' +
        'airline\u2019s own warnings (card fees, loyalty terms): mention a hidden stop every time, because a traveller finds ' +
        'out about it at the gate otherwise.\n'
      : '') +
    'You still CANNOT book, hold, ticket or pay for any of it. Sabre quotes and revalidates; it does not issue. Never say ' +
    '"booked", "ticketed", "held", "reserved" or "confirmed" for a flight or a room. Be careful with "held" in particular: ' +
    'revalidating a fare does NOT hold a seat and takes nothing out of the airline\u2019s inventory, so the seat can still go to ' +
    'somebody else a minute later. "The price is confirmed" is true; "your seat is confirmed" is not. What you HAVE done is ' +
    'find the real fare, price it, and check it is still live — say that plainly, it is worth a lot, then hand off for the ' +
    'purchase. Claiming a ticket nobody holds is the single worst thing you can do here, and it is worse precisely because ' +
    'everything you said before it was true.\n' +
    'ERRANDS: when somebody needs a THING fetched rather than a service booked — a charger, a forgotten passport, a prescription, ' +
    'a bag from a hotel — emit an errand action {title, detail, where_from, deliver_to, bounty, spend_cap}. Someone nearby goes and ' +
    'gets it. PROPOSE the bounty in your reply and say plainly that posting holds those Stars until it arrives; the app puts the ' +
    'form in front of them pre-filled and THEY tap post. Never speak as though it is already posted.\n' +
    // THE HANDOFF, NOT THE PURCHASE.
    //
    // This block used to read "Num can create bookings and issue tickets …
    // say clearly that you can book it". That is the operative sentence of
    // California B&P §17550.1(a) — "advertises that he or she can or may
    // arrange" — spoken by Num on every travel turn the flag was on. Num does
    // not issue and does not take the money; the registered partner does, and
    // the traveller pays them directly (§17550.20(g)(5)). The safeguard that
    // mattered here — nothing happens without a person tapping — is kept.
    (canBook
      ? 'THE PURCHASE IS NOT YOURS AND IT IS NOT NUM\u2019S. A travel partner issues the ticket and charges the traveller ' +
        'directly; Num does not issue, does not hold a seat, and never takes the money. So your job ends at the edge of it: ' +
        'the exact fare as the search returned it, the exact times, what it includes, and what happens if they change their ' +
        'mind. Then say plainly that the partner can issue it and offer to take them there \u2014 "I don\u2019t issue ' +
        'tickets, they do; here\u2019s the page for this fare" \u2014 and let the app put that handoff in front of them. ' +
        'Nothing moves without a PERSON tapping it: never as a side effect of a conversation, never because the traveller ' +
        'sounded keen, never because you decided it was obviously what they wanted. Until they are on the partner\u2019s ' +
        'own page, nothing exists, and you must not speak as though it does.\n'
      : '') +
    'If the KNOWN FACTS carry an airline status or hotel programme, weigh it openly against the fare and say why — status ' +
    'on the route is often worth more than the cheapest fare, and sometimes it plainly is not.'
  );
}

export function servicesBlock(place, env = {}) {
  const country = place?.country_code || place?.country || '';
  const kinds = [
    ['ride', 'a car'],
    ['food', 'delivery'],
    ['table', 'a restaurant table'],
    ['wellness', 'massage & spa'],
    ['flight', 'flights'],
    ['hotel', 'hotels'],
  ];
  // Shopping and booking are different permissions, and this summary line used
  // to collapse them. With Sabre connected, `flights: HAND-OFF` sat three lines
  // above "You CAN see real fares" — a flat contradiction, and a model reading
  // top-down believed the first one. Caught 9 Aug 2026: the same question got
  // live HKT→BKK fares in one session and "flights aren't something I can pull
  // up or book directly" in the next two, which also filed a feature_request
  // for a feature that already shipped. The summary must not contradict the
  // detail; where we can price but not buy, the line has to say exactly that.
  const canShop = { flight: connected(env, 'sabre_air'), hotel: connected(env, 'sabre_hotel') };
  const lines = kinds.map(([kind, label]) => {
    const { mode, options } = optionsFor(kind, { country, city: place?.name }, env);
    const names = options.map((o) => o.name + (o.note ? ` (${o.note})` : '')).join(', ');
    const status = canShop[kind]
      ? 'LIVE PRICES — you CAN search and quote real fares yourself (see below); only the purchase is a hand-off'
      : mode === 'connected'
        ? 'CONNECTED — you can complete this'
        : 'HAND-OFF';
    return `- ${label}: ${status} · ${names || 'no local provider mapped'}`;
  });
  return (
    'SERVICES AVAILABLE HERE (ranked by what people actually use in this country):\n' +
    lines.join('\n') +
    airBlock(env) +
    '\n\nHAND-OFF rule (applies to the lines marked HAND-OFF, never to LIVE PRICES): Num has no account with these companies yet, so you CANNOT place the order yourself. ' +
    'Do not say "booked", "on its way", or "ordered" for a hand-off. Instead: pick the ONE best provider for this exact ' +
    'request, say why it is the right one here, and emit the matching action (order_ride / order_food) — the app opens it ' +
    'prefilled with the destination so it is a single tap. Then say what you HAVE done: the venue is chosen, the address ' +
    'is ready, the timing works. If the user wants us to handle it end to end, emit a feature_request as well.'
  );
}

/**
 * Every host Num can hand a guest to, and how it reaches them.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Affiliate programmes are applied for one at a time, and the first thing
 * every application form asks is which of their properties you send traffic
 * to and from where. That answer was buried in `BY_COUNTRY`, `TRAVEL`,
 * `AIRLINES` and `HOTEL_GROUPS` — four tables nobody could read at once — so
 * the working answer was "the big ones, probably".
 *
 * This walks the REAL link builders, exactly as `optionsFor()` does, and
 * returns the hosts they actually produce. Not a hand-kept list: a list that
 * cannot drift from the code, because it is the code's own output.
 *
 * Pair it with the click log (`num_affiliate_clicks`) and the two together are
 * the whole picture: this is who we COULD earn on, that is who we actually
 * send. Ranked by the second, worked through in order, is the application
 * queue.
 *
 * @returns {Array<{host, providers: string[], kinds: string[], countries: string[], sample: string}>}
 *          sorted by reach (countries × kinds), widest first.
 */
export function handoffHosts() {
  const ctx = {
    to: 'Kata Beach', toLat: 7.82, toLng: 98.3, q: 'dinner', city: 'Phuket',
    from: 'Phuket', fromCode: 'HKT', toCode: 'BKK', depart: '2026-09-01', ret: '2026-09-08',
    checkin: '2026-09-01', checkout: '2026-09-08', adults: 2,
  };
  const hosts = new Map();
  const add = (host, provider, kind, country, url) => {
    if (!host) return;
    const e = hosts.get(host) ?? { host, providers: new Set(), kinds: new Set(), countries: new Set(), sample: url };
    e.providers.add(provider);
    if (kind) e.kinds.add(kind);
    if (country) e.countries.add(country);
    hosts.set(host, e);
  };
  const hostOf = (url) => {
    try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  };

  const countries = [...Object.keys(BY_COUNTRY), 'XX']; // XX exercises FALLBACK
  for (const country of countries) {
    for (const kind of ['ride', 'food', 'table', 'wellness']) {
      for (const o of optionsFor(kind, { ...ctx, country }, {}).options) {
        add(hostOf(o.url), o.id, kind, country, o.url);
      }
    }
  }
  for (const kind of Object.keys(TRAVEL)) {
    for (const o of optionsFor(kind, ctx, {}).options) add(hostOf(o.url), o.id, kind, '*', o.url);
  }
  // Airline and hotel-group sites are handed out by the prompt when somebody
  // holds status, so they are traffic we send even though optionsFor() never
  // names them. Leaving them out is how a programme with real volume stays
  // invisible.
  for (const [id, a] of Object.entries(AIRLINES)) add(hostOf(a.url), id, 'airline', '*', a.url);
  for (const [id, h] of Object.entries(HOTEL_GROUPS)) add(hostOf(h.url), id, 'stay', '*', h.url);

  return [...hosts.values()]
    .map((e) => ({
      host: e.host,
      providers: [...e.providers].sort(),
      kinds: [...e.kinds].sort(),
      countries: [...e.countries].sort(),
      sample: e.sample,
    }))
    .sort((a, b) => b.countries.length * b.kinds.length - a.countries.length * a.kinds.length || a.host.localeCompare(b.host));
}
