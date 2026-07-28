/**
 * NUM — invite generator
 * ----------------------
 * Turns one `leads` row into a finished, personalised invite a marketing agent
 * can read, tweak and send. No blank pages.
 *
 * Pure module: no network, no filesystem, no D1. Import it from the sender,
 * from a Worker endpoint, or from a test — it behaves identically everywhere.
 *
 *   import { generateInvite } from './invite_gen.mjs';
 *   const draft = generateInvite(lead, { template, claimBase, token });
 *
 * Returns { subject, preheader, personal_open, traveller_ask, num_reply,
 *           sign_off, html, text, fields, risk }
 *
 * Every variant choice is DETERMINISTIC on lead.id — regenerating a draft
 * gives the agent the same words they approved yesterday.
 */

/* ── deterministic pick ─────────────────────────────────────────────────── */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}
const pick = (arr, seed, salt = 0) => arr[(hash(seed) + salt * 7919) % arr.length];

/* ── category intelligence ──────────────────────────────────────────────── */
/* what a traveller actually types, and what NUM says back. `book` is the noun
   used in the sign-off ("a table", "a room"). `soon` is the urgency phrase. */

const CATS = {
  'Restaurant':       { noun:'somewhere to eat',        book:'a table',        asks:['where should we eat tonight? somewhere real, not a tourist trap','best place for dinner near us right now?','we want proper local food — where do we go?'] },
  'Café':             { noun:'a good coffee',           book:'a table',        asks:['where can I get a proper coffee around here?','somewhere quiet to work with good coffee?','best breakfast spot near us?'] },
  'Cafe':             { noun:'a good coffee',           book:'a table',        asks:['where can I get a proper coffee around here?','somewhere quiet to work with good coffee?','best breakfast spot near us?'] },
  'Bar':              { noun:'somewhere for a drink',   book:'a table',        asks:['where do locals actually drink around here?','good bar near us, not too loud?','somewhere for a drink before dinner?'] },
  // 'an order', not 'a table' — a takeaway has no tables, and offering to hold
  // one is the tell that an email was merged by someone who never looked at it.
  'Street food':      { noun:'real street food',        book:'an order',       asks:['where is the street food actually good here?','cheap local food that locals eat — where?','best late night food near us?'] },
  'Bakery':           { noun:'fresh bread & pastries',  book:'an order',       asks:['best bakery near us?','where do I get fresh pastries in the morning?'] },
  'Dessert':          { noun:'dessert',                 book:'a table',        asks:['where do we go for dessert around here?','best ice cream near us?'] },
  'Deli':             { noun:'good local produce',      book:'an order',       asks:['where can I buy proper local food to take home?','best deli around here?'] },
  'Hotel':            { noun:'somewhere to stay',       book:'a room',         asks:['we need a room for two nights — somewhere good, not a chain','where should we stay here that is actually nice?','last minute room for tonight?'] },
  'Guesthouse':       { noun:'somewhere to stay',       book:'a room',         asks:['somewhere small and friendly to stay for a few nights?','a guesthouse near the centre — any good ones?'] },
  'Hostel':           { noun:'a bed for the night',     book:'a bed',          asks:['cheap clean place to stay tonight?','good hostel around here?'] },
  'Apartment':        { noun:'a place to stay',         book:'a booking',      asks:['we want an apartment for the week, not a hotel','somewhere with a kitchen for a few nights?'] },
  'Transport':        { noun:'a ride',                  book:'a car',          asks:['how do we get to the airport from here?','can someone pick us up in the morning?','is there a taxi we can actually book here?'] },
  // Deliberately neutral: this category holds barbers, nail bars, hairdressers
  // and massage rooms alike. Anything named specifically is caught by NAME_HINTS
  // below; what falls through to here must read right for all four.
  'Beauty & spa':     { noun:'somewhere to get looked after', book:'an appointment', asks:['somewhere good near us for an appointment today?','anywhere decent nearby that could fit us in this afternoon?'] },
  'Massage & spa':    { noun:'a massage',               book:'an appointment', asks:['where can I get a proper massage today?','somewhere for a massage near us, open now?'] },
  'Gym & fitness':    { noun:'a gym',                   book:'a session',      asks:['is there a gym near here I can use for a few days?','somewhere to train while we are here?'] },
  'Shopping':         { noun:'somewhere to shop',       book:'a visit',        asks:['where do we shop here that is not the same chains?','something nice to bring home — where do we look?'] },
  'Souvenirs & gifts':{ noun:'something to bring home', book:'a visit',        asks:['where do we buy gifts that are not tourist junk?','something local to bring home — where?'] },
  'Market':           { noun:'a local market',          book:'a visit',        asks:['is there a good market on today?','where is the local market around here?'] },
  'Supermarket':      { noun:'a supermarket',           book:'a visit',        asks:['where is the nearest decent supermarket?'] },
  'Convenience':      { noun:'a shop nearby',           book:'a visit',        asks:['anywhere near us open right now for basics?'] },
  'Pharmacy':         { noun:'a pharmacy',              book:'a visit',        asks:['I need a pharmacy — is anything open near me?','where is the closest pharmacy right now?'] },
  'Museum':           { noun:'something worth seeing',  book:'a visit',        asks:['what is actually worth seeing here in one day?','a museum near us worth the time?'] },
  'Gallery':          { noun:'art worth seeing',        book:'a visit',        asks:['any good galleries around here?','where do we see local art?'] },
  'Theatre':          { noun:'something on tonight',    book:'seats',          asks:['what is on tonight around here?','anywhere doing live performance this week?'] },
  'Cinema':           { noun:'a film tonight',          book:'seats',          asks:['is anything playing in English near us?'] },
  'Nightlife':        { noun:'somewhere out tonight',   book:'a table',        asks:['where do we go out tonight around here?','somewhere good and busy tonight?'] },
  'Wine & spirits':   { noun:'good local wine',         book:'an order',       asks:['where do we buy proper local wine?','somewhere to taste local wine near us?'] },
  'Bike rental':      { noun:'bikes for the day',       book:'a bike',         asks:['where can we hire bikes around here?','somewhere to rent bikes for the day?','can we get bikes for tomorrow morning?'] },
  'Vehicle rental':   { noun:'a car or scooter',        book:'a booking',      asks:['where do we rent a car here without getting stung?','can we rent a scooter near us today?'] },
  'Tours & travel':   { noun:'a trip worth taking',     book:'a booking',      asks:['what is worth doing here for a day?','any good tours from here tomorrow?','something to get us out of town for a day?'] },
  'Attraction':       { noun:'something to do',         book:'a visit',        asks:['what should we actually do here?'] },
  'Tailor':           { noun:'a tailor',                book:'a fitting',      asks:['can I get something made here in a few days?','good tailor around here?'] },
};
const DEFAULT_CAT = { noun:'somewhere good nearby', book:'a booking', asks:['what is good around here that locals actually use?'] };

/* The source categories are coarse: "Beauty & spa" holds barbers, nail bars,
   hairdressers and massage rooms alike, and a hairdresser invited with "where
   can I get a massage" reads like a mailmerge accident. Where the business
   NAME carries a stronger signal than the category, the name wins. */

/* A hint may only REFINE inside its own family, never jump families. Without
   `only`, "Grand Hotel & Spa" would be invited about massages instead of rooms,
   which is worse than the coarse category we started with. An unrecognised
   category has nothing to protect, so every hint is allowed to claim it. */

const BEAUTY = ['Beauty & spa', 'Massage & spa'];
const FOOD   = ['Restaurant', 'Café', 'Cafe', 'Street food', 'Bakery', 'Dessert', 'Deli'];
const DRINK  = ['Bar', 'Nightlife', 'Restaurant', 'Café', 'Cafe'];
const STAY   = ['Hotel', 'Guesthouse', 'Apartment', 'Hostel'];

const NAME_HINTS = [
  { only: BEAUTY,
    re: /\b(?:hairdress\w*|haircut\w*|hairstyl\w*|hairs|hair|barber\w*|coiffeur|coiffure|friseur|fris[öo]r|parrucchier\w*|peluquer\w*|kapper|kapsalon)\b/i,
    cat: { noun:'a haircut', book:'an appointment', asks:['can I get a haircut somewhere decent today?','any good barbers near us that take walk-ins?','somewhere for a cut and blow-dry this afternoon?'] } },

  { only: BEAUTY,
    re: /\b(?:nails?|manicure|pedicure|nagel\w*)\b/i,
    cat: { noun:'a manicure', book:'an appointment', asks:['somewhere good for nails near us today?','can I get a manicure around here this afternoon?'] } },

  { only: BEAUTY,
    re: /\b(?:tattoo|piercing|ink)\b/i,
    cat: { noun:'a tattoo', book:'an appointment', asks:['any good tattoo studios near us that take walk-ins?','somewhere reputable near here for a small tattoo this week?'] } },

  // "spa" is safe here only because `only` fences it to the beauty family —
  // without that guard it would swallow every "Grand Hotel & Spa" on the list.
  { only: BEAUTY,
    re: /\b(?:massage|masaj|onsen|hammam|sauna|thermal|wellness|spa)\b/i,
    cat: { noun:'a massage', book:'an appointment', asks:['where can I get a proper massage today?','somewhere for a massage near us, open now?'] } },

  { only: [...BEAUTY, 'Pharmacy'],
    re: /\b(?:dental|dentist\w*|zahnarzt|dentista|clinic|clinica|klinik|medical|doctor)\b/i,
    cat: { noun:'a clinic', book:'an appointment', asks:['I need a dentist while we are here — anywhere good?','is there an English-speaking clinic near us?'] } },

  { only: FOOD,
    re: /\b(?:pizza|pizzeria)\b/i,
    cat: { noun:'pizza', book:'a table', asks:['where is the pizza actually good around here?','best pizza near us tonight?'] } },

  { only: FOOD,
    re: /\b(?:sushi|ramen|izakaya|yakitori)\b/i,
    cat: { noun:'Japanese food', book:'a table', asks:['any good sushi near us?','where do we go for proper ramen around here?'] } },

  { only: FOOD,
    re: /\b(?:coffee|espresso|roaster\w*|kaffe\w*|caff[èe]|kavárna)\b/i,
    cat: { noun:'a good coffee', book:'a table', asks:['where can I get a proper coffee around here?','best coffee near us right now?'] } },

  { only: FOOD,
    re: /\b(?:bakery|baker\w*|b[äa]ckerei|boulangerie|panader\w*|panificio|forno|pekárna)\b/i,
    cat: { noun:'fresh bread & pastries', book:'an order', asks:['best bakery near us?','where do I get fresh pastries in the morning?'] } },

  { only: DRINK,
    re: /\b(?:pub|tavern|taverna|brewery|brewhouse|brewing|bierhaus|bräu)\b/i,
    cat: { noun:'a proper pub', book:'a table', asks:['where is a proper pub around here, not a chain?','somewhere near us for a decent pint?'] } },

  { only: STAY,
    re: /\b(?:hostel|backpackers?)\b/i,
    cat: { noun:'a bed for the night', book:'a bed', asks:['cheap clean place to stay tonight?','good hostel around here?'] } },
];

/* ── the long tail ──────────────────────────────────────────────────────── */
/* The 30 keys above cover the bulk of the list, but D1 also holds several
   hundred Foursquare-style categories — "Italian Restaurant", "Gastropub",
   "Sushi Restaurant", "Aparthotel". Left alone those fall to DEFAULT_CAT and
   a perfectly good trattoria gets invited with "somewhere good nearby", which
   is exactly the mail-merge smell the personalisation exists to avoid. */

const NORMALISE = [
  [/place of worship|church|chapel|cathedral|mosque|synagogue|temple/i, null],  // handled by EXCLUDE
  [/hostel|backpacker|campground/i,                                   'Hostel'],
  [/aparthotel|service apartment|apartment|cottage|villa/i,            'Apartment'],
  [/hotel|resort|\binn\b|bed and breakfast|b&b/i,                      'Hotel'],
  [/guest ?house|pension/i,                                            'Guesthouse'],
  [/caf[ée]|coffee|tea room|smoothie|juice bar/i,                      'Café'],
  [/ice cream|gelat|dessert|chocolatier|candy store|patisserie/i,      'Dessert'],
  [/gastropub|\bpub\b|tavern|brewery|brewpub|bar\b|nightclub|gay bar/i,'Bar'],
  [/winery|wine cellar|distillery|liquor store/i,                      'Wine & spirits'],
  [/bakery|baker/i,                                                    'Bakery'],
  [/delicatessen|\bdeli\b|butcher|fishmonger|cheese shop/i,            'Deli'],
  [/restaurant|steakhouse|bistro|brasserie|eatery|trattoria|pizzeria|barbecue|grill\b/i, 'Restaurant'],
  [/street food|food truck|takeaway|fish and chips/i,                  'Street food'],
  [/spa|massage|salon|beauty|nail|hair|barber|waxing|skin care|makeup|tattoo|piercing|groom/i, 'Beauty & spa'],
  [/gym|fitness|yoga|pilates|boxing|martial arts|dojo|climbing|boot camp|dance|swimming|tennis|badminton|gymnastics|cycling class/i, 'Gym & fitness'],
  [/museum|planetarium|camera obscura/i,                               'Museum'],
  /* Craft RETAIL, before the gallery rule can claim it. "Arts And Crafts" on a
     yarn shop means it sells wool, not that a traveller should come and look at
     art — and "where do we see local art?" landing in a haberdasher's inbox is
     the tell that nobody read the email before it went. */
  [/arts and crafts|craft (?:store|shop|suppl)|haberdash|\byarn\b|wool shop|knitting|sewing|fabric store|bead shop|hobby (?:store|shop)/i, 'Shopping'],
  [/galler|arts centre|art center|art museum|exhibition space/i,        'Gallery'],
  [/theatre|theater|concert|music venue|comedy|performing arts|opera/i,'Theatre'],
  [/cinema|movie/i,                                                    'Cinema'],
  [/airport shuttle|shuttle|private hire|minicab|\btaxi\b|chauffeur|limousine|transfer service|car service/i, 'Transport'],
  [/tour|sightseeing|travel agent|diving|sailing|kayak|canoe|balloon|equestrian|charter|boat rental|marina/i, 'Tours & travel'],
  [/arts and entertainment|opera|philharmonic|orchestra|symphony/i,   'Theatre'],
  [/bike (?:rental|hire|park|shop|tour)|bicycle|cycle hire|cycle rental|e-?bike|mountain bike/i, 'Bike rental'],
  [/car rental|scooter|moped|motorbike rental|vehicle|rent a car/i,     'Vehicle rental'],
  [/flea market|\bmarket\b/i,                                          'Market'],
  [/supermarket|grocer|convenience/i,                                  'Supermarket'],
  [/pharmac|chemist/i,                                                 'Pharmacy'],
  [/tailor|bridal|dressmaker/i,                                        'Tailor'],
  [/souvenir|gift shop/i,                                              'Souvenirs & gifts'],
  [/zoo|aquarium|theme park|water park|arcade|escape room|bowling|viewpoint|beach club|golf|ice skating|stadium|arena|attraction|landmark|monument|castle|palace|historic|botanic|nature reserve|public garden|\bpark\b/i, 'Attraction'],
  [/public bath|bath ?house|\bonsen\b|hammam|thermal (?:bath|spa)|banya|sauna/i, 'Beauty & spa'],
  [/events? venue|concert hall|live music venue|performing arts/i,     'Theatre'],
  [/sports and recreation|sports? (?:activity|venue|centre|center)|recreation/i, 'Attraction'],
  [/food delivery|takeaway service|meal delivery/i,                    'Street food'],
  [/fruits? and vegetables?|greengrocer|produce market|farm shop/i,    'Market'],
  [/store|shopping|\bmall\b|\bshop\b|boutique|retail|fashion|clothing|jewel|antique|bookstore|eyewear|optician|perfume|outdoor gear|sporting goods|home and garden|party suppl|gift shop/i, 'Shopping'],
];

/* Not every listed business should be invited. NUM's pitch is bookings and
   commission; a church, a hospital or a town hall receiving it is a wasted
   send at best. At the start of a cold programme the complaint rate is the
   thing that kills a sending domain, so the wrong audience is not a rounding
   error — it is the risk. Anything matching here is dropped, not softened. */

/* `cat: true` means the rule reads the CATEGORY only, never the name. Britain
   names its businesses after the landmark on the corner: Abbey Taxis, The Abbey
   Hotel, Church Street Tavern, The Old Bank Restaurant, Temple Bar. Matching
   those words in a name drops paying customers, so the rules built out of
   landmark and institution words are fenced to the taxonomy field, which is the
   one place the word means what it says. */

const EXCLUDE = [
  { why: 'worship', cat: true,
    re: /place of worship|church|chapel|cathedral|mosque|synagogue|temple|parish|convent|abbey|minster|monastery|shrine/i },

  /* Amateur and community sport looks like a venue in the data and is nothing
     of the sort. A youth football club and a children's rugby team both came
     through the sampler holding an invitation to take bookings and pay 10%
     commission. There is no version of that email that reads acceptably. */
  { why: 'amateur sport',
    re: /amateur sports?|sports? (?:league|team|club|society)|\b(?:football|rugby|cricket|bowls|badminton|netball|hockey|squash|rowing|athletics?|swimming|volleyball|basketball|handball|lacrosse|croquet|petanque|darts|snooker|archery|fencing|triathlon|orienteering|harriers|ramblers?)\s+(?:club|team|society|association|union)\b|rugby (?:union|football)|athletic (?:club|association)|youth club|scout group|angling|allotment|residents.? association|social club|working men|charitable|non-?profit|\bcharity\b/i },

  { why: 'medical',
    re: /hospital|clinic|doctor|dentist|dental|medical|surgery|physio|hearing aid|optometr|weight loss|nutritionist|vitamins|supplement|laser hair removal|hair replacement/i },

  { why: 'civic', cat: true,
    re: /town ?hall|library|universit|college|school|police|fire station|embassy|passport|visa services|post partner|community centre|community center|council/i },

  { why: 'animal',
    re: /animal shelter|animal rescue|pet sitting|pet boarding|pet groomer|pet services|dog walker|dog trainer|dog park|veterinar|kennel/i },

  { why: 'finance', cat: true,
    re: /\bbank\b|\batm\b|insurance|pawn shop|auction house|estate agent|mortgage|accountant/i },

  { why: 'automotive',
    re: /car dealer|automotive|tire dealer|tyre|car repair|used car|fuel\b|petrol|ev charging|car wash|car park|parking (?:lot|garage|facility)/i },

  { why: 'regulated', cat: true,
    re: /tobacco|e ?cigarette|vape|cannabis|casino|betting|gambling|adult|firearm|gun shop/i },

  { why: 'trade', cat: true,
    re: /wholesale|office equipment|appliance store|paint store|home improvement|building suppl|plumb|electrician|carpet store|mattress|linen|nursery and gardening|photography store/i },

  { why: 'services', cat: true,
    re: /life coach|astrologer|meditation cent|food consultant|language school|music school|driving school|recruit|staffing|marketing agency|law firm|solicitor/i },
];

/** Should this lead be invited at all? Returns null to invite, or a reason. */
function excludeReason(lead) {
  const category = String(lead && lead.category || '');
  const both     = `${category} ${lead && lead.name || ''}`;
  for (const e of EXCLUDE) if (e.re.test(e.cat ? category : both)) return e.why;
  return null;
}

/** Map a raw D1 category onto one of the CATS keys where we can. */
function normaliseCategory(category) {
  const c = String(category || '').trim();
  if (Object.prototype.hasOwnProperty.call(CATS, c)) return c;
  for (const [re, key] of NORMALISE) if (re.test(c)) return key;
  return null;
}

function catOf(category, name) {
  const raw   = String(category || '').trim();
  const key   = normaliseCategory(raw);
  const known = key !== null;

  /* A long-tail label like "Sushi Restaurant" or "Health Spa" carries signal the
     canonical key has already thrown away, so let the hints read it. The
     canonical keys themselves must stay out: "Beauty & spa" literally contains
     "spa", and feeding it in would turn every barber into a massage parlour. */
  const isCanonical = Object.prototype.hasOwnProperty.call(CATS, raw);
  const hay = `${name || ''}${isCanonical ? '' : ' ' + raw}`.trim();

  if (hay) {
    for (const h of NAME_HINTS) {
      if (known && !h.only.includes(key)) continue;
      if (h.re.test(hay)) return h.cat;
    }
  }
  return (known && CATS[key]) || DEFAULT_CAT;
}

/* ── EU/UK jurisdiction tiering ─────────────────────────────────────────── */
/* Cold B2B email is not equally lawful everywhere. This is not legal advice —
   it is a routing signal so the highest-exposure markets are not first in the
   queue and are held until counsel signs the copy off. */

const RISK = {
  DE:'hold', AT:'hold', IT:'hold',                      // strictest opt-in regimes for B2B
  ES:'care', FR:'care', GR:'care', HU:'care', PT:'care', CZ:'care', HR:'care',
  GB:'ok', IE:'ok', NL:'ok', SE:'ok', DK:'ok', CH:'ok', IS:'ok', TH:'ok',
};
const riskOf = c => RISK[String(c || '').toUpperCase()] || 'care';

/* ── helpers ────────────────────────────────────────────────────────────── */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/** "Bang Tao Seafood Restaurant & Grill" → "Bang Tao Seafood" (for buttons) */
function shortName(name) {
  let n = String(name || '').replace(/\s*[|·—–-]\s*.*$/, '').trim();
  const words = n.split(/\s+/);
  if (words.length > 3) n = words.slice(0, 3).join(' ');
  if (n.length > 26) n = words.slice(0, 2).join(' ');
  /* Never end on a hanging connector. "Camera Obscura & World of Illusions"
     cut to three words is "Camera Obscura &", and the subject line then reads
     "Claim Camera Obscura &'s AI text-message profile" — which is the exact
     kind of seam that tells a recipient no human saw this before it sent. */
  /* The leading \\s+ is load-bearing: without it the alternation anchors
     mid-word and "1 The Paragon" comes back as "1 The Parag". */
  n = n.replace(/\s+[,&+]?\s*(?:&|\+|and|of|the|at|in|on|for|by|with)$/i, '').trim();
  return n || String(name || '').trim();
}

const titleish = s => String(s || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, m => m.toUpperCase())
  .trim();

/** "Bang Tao, Phuket" — falls back gracefully when `area` is missing (32% are). */
function placeLine(lead) {
  const dest = titleish(lead.dest);
  const area = (lead.area || '').trim();
  if (area && dest && area.toLowerCase() !== dest.toLowerCase()) return `${area}, ${dest}`;
  return dest || area || 'your area';
}

/* ── the four generated sentences ───────────────────────────────────────── */

function personalOpen(lead, place, cat) {
  const name = lead.name;
  const V = [
    `Travellers using NUM are already asking for ${cat.noun} in ${place}. When they do, we answer from the profiles we hold — and ${name} has one sitting there unclaimed.`,
    `We're building the concierge travellers text when they want ${cat.noun} in ${place}, in whatever language they speak. ${name} is already on the map. It just isn't yours yet.`,
    `${name} is listed in NUM as one of the places we can point travellers to for ${cat.noun} in ${place}. Claiming it takes two minutes and costs nothing — and it changes how often we can recommend you.`,
  ];
  return pick(V, lead.id, 0);
}

/* A museum, a market and a pharmacy have nothing to reserve, so the booking
   phrasings collapse into nonsense on them — "I can hold a visit for you now".
   Those categories get a walk-in set instead: same warmth, same offer to send
   the traveller over, no promise of a reservation that does not exist. */
function numReply(lead, place, cat) {
  const name  = lead.name;
  const short = shortName(name);
  const V = cat.book === 'a visit' ? [
    `${name} — 6 minutes from you in ${place}, open now. Want me to send you over?`,
    `Try ${name}. It's close, it's open, and it's one people come back to. Want directions?`,
    `${short} is your best bet nearby — ${cat.noun} without the tourist crowd. Shall I point you to it?`,
  ] : [
    `${name} — 6 minutes from you in ${place}. I can hold ${cat.book} for you now. Want me to?`,
    `Try ${name}. It's close, it's open, and it's one people come back to. Shall I sort ${cat.book}?`,
    `${short} is your best bet nearby — ${cat.noun} without the tourist mark-up. Want me to arrange ${cat.book}?`,
  ];
  return pick(V, lead.id, 1);
}

function signOff(lead, cat) {
  const V = [
    `If it's useful, claim it. If it isn't, one click below removes you and we won't write again.`,
    `Claim it and you're in the answers. Ignore this and nothing happens — we won't email you twice.`,
    cat.book === 'a visit'
      ? `No catch, no card, no contract. Just travellers arriving at your door because we sent them.`
      : `No catch, no card, no contract. Just bookings arriving on your phone when a traveller nearby asks for you.`,
  ];
  return pick(V, lead.id, 2);
}

/* Bill's, Sally's, Browns — a hospitality list is full of names that are already
   possessive or already end in s, and "Claim Bill's's profile" is unsendable. */
function possessive(n) {
  return /['’]s$/i.test(n) ? n : /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

function subjectLine(lead, place, cat) {
  const short = shortName(lead.name);
  const V = [
    `${short} — your AI profile on NUM is ready to claim (free)`,
    `Travellers are asking for ${cat.noun} in ${place}. ${short} can be the answer.`,
    `Claim ${possessive(short)} AI text-message profile — free, 2 minutes`,
  ];
  return pick(V, lead.id, 3);
}

/* ── main ───────────────────────────────────────────────────────────────── */

/**
 * @param {object} lead  a `leads` row (needs at minimum: id, name, email)
 * @param {object} opts
 *   template  {string} the invite HTML with {{placeholders}}
 *   token     {string} per-recipient token (claim + unsubscribe + open pixel)
 *   base      {string} site origin, default https://itsnum.com
 */
export function generateInvite(lead, opts = {}) {
  if (!lead || !lead.id || !lead.name) throw new Error('generateInvite: lead needs id and name');

  const base  = (opts.base || 'https://itsnum.com').replace(/\/$/, '');
  const token = opts.token || '';
  const cat   = catOf(lead.category, lead.name);
  const place = placeLine(lead);
  const short = shortName(lead.name);

  const fields = {
    business_name:       lead.name,
    business_name_short: short,
    place_line:          place,
    personal_open:       personalOpen(lead, place, cat),
    traveller_ask:       pick(cat.asks, lead.id, 4),
    num_reply:           numReply(lead, place, cat),
    sign_off:            signOff(lead, cat),
    preheader:           `Free to claim. Travellers asking for ${cat.noun} in ${place} can be sent to you.`,
    // Routed through the accounts Worker so the click is recorded, then 302'd
    // to /claim. Rides the already-live /api/accounts* route — no new route.
    claim_url:           `${base}/api/accounts/claim?t=${encodeURIComponent(token)}`,
    unsub_url:           `${base}/api/accounts/unsubscribe?t=${encodeURIComponent(token)}`,
    pixel_url:           `${base}/api/accounts/i.gif?t=${encodeURIComponent(token)}`,
    line_url:            'https://line.me/R/ti/p/@799pyrus',
  };

  let html = String(opts.template || '');
  for (const [k, v] of Object.entries(fields)) {
    // URLs are already encoded; visible copy gets HTML-escaped.
    const safe = /_url$/.test(k) ? v : esc(v);
    html = html.split(`{{${k}}}`).join(safe);
  }

  const text = [
    `${fields.business_name} already has a profile on NUM. Claim it — free.`,
    ``,
    fields.personal_open,
    ``,
    `WHAT A PROFILE DOES`,
    `Traveller: "${fields.traveller_ask}"`,
    `NUM: "${fields.num_reply}"`,
    `That answer comes from your profile. Claimed profiles get recommended.`,
    ``,
    `- Free to claim, free to stay listed. No signup fee, no card.`,
    `- Travellers find you in their own language.`,
    `- Bookings arrive on your phone. Guests pay you directly.`,
    `- 10% only when a booking actually happens.`,
    `- Real reviews only, from verified completed bookings.`,
    ``,
    `Claim ${short} — free: ${fields.claim_url}`,
    `Prefer LINE? Add @799pyrus and send: CLAIM ${short}`,
    ``,
    fields.sign_off,
    ``,
    `The NUM team — 5arz`,
    `itsnum.com · info@5arz.com`,
    ``,
    `You're receiving this one-time invitation because ${fields.business_name} is publicly listed as a business in ${place}.`,
    `Unsubscribe and remove our listing: ${fields.unsub_url}`,
  ].join('\n');

  return {
    subject:       subjectLine(lead, place, cat),
    preheader:     fields.preheader,
    personal_open: fields.personal_open,
    traveller_ask: fields.traveller_ask,
    num_reply:     fields.num_reply,
    sign_off:      fields.sign_off,
    html, text, fields,
    risk: riskOf(lead.country),
  };
}

export { catOf, riskOf, shortName, placeLine, hash, excludeReason, normaliseCategory };
