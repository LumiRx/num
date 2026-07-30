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

/** Sensible worldwide default when the country isn't mapped. */
const FALLBACK = { ride: ['uber', 'bolt'], food: ['ubereats'], table: ['opentable', 'thefork'], wellness: ['fresha'] };

const enc = encodeURIComponent;

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
export const ADAPTERS = {};

export const connected = (env, id) => !!ADAPTERS[id]?.ready?.(env);

/** True when ANY provider of this kind can be completed by us end to end. */
export const anyConnected = (env, kind) =>
  Object.entries(ADAPTERS).some(([id, a]) => a.kind === kind && a.ready?.(env) && PROVIDERS[id]);

/**
 * The options Num should offer for a request, best first.
 * Returns `{ mode: 'connected' | 'handoff', options: [{id, name, url, note}] }`.
 */
export function optionsFor(kind, { country, city, to, toLat, toLng, q, covers } = {}, env = {}) {
  const set = (BY_COUNTRY[String(country || '').toUpperCase()] ?? FALLBACK)[kind] ?? FALLBACK[kind] ?? [];
  const ctx = { to, toLat, toLng, q, covers, city };
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
export function servicesBlock(place, env = {}) {
  const country = place?.country_code || place?.country || '';
  const kinds = [
    ['ride', 'a car'],
    ['food', 'delivery'],
    ['table', 'a restaurant table'],
    ['wellness', 'massage & spa'],
  ];
  const lines = kinds.map(([kind, label]) => {
    const { mode, options } = optionsFor(kind, { country, city: place?.name }, env);
    const names = options.map((o) => o.name + (o.note ? ` (${o.note})` : '')).join(', ');
    return `- ${label}: ${mode === 'connected' ? 'CONNECTED — you can complete this' : 'HAND-OFF'} · ${names || 'no local provider mapped'}`;
  });
  return (
    'SERVICES AVAILABLE HERE (ranked by what people actually use in this country):\n' +
    lines.join('\n') +
    '\n\nHAND-OFF rule: Num has no account with these companies yet, so you CANNOT place the order yourself. ' +
    'Do not say "booked", "on its way", or "ordered" for a hand-off. Instead: pick the ONE best provider for this exact ' +
    'request, say why it is the right one here, and emit the matching action (order_ride / order_food) — the app opens it ' +
    'prefilled with the destination so it is a single tap. Then say what you HAVE done: the venue is chosen, the address ' +
    'is ready, the timing works. If the user wants us to handle it end to end, emit a feature_request as well.'
  );
}
