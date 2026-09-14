/**
 * THE PAPERWORK NOBODY CAN FIGURE OUT.
 *
 * Dre, 14 Sep 2026: "we should research the docs needed to travel to each
 * country and we can help travelers with visa, registrations and anything
 * else needed when traveling. this is one of the hardest for people."
 *
 * He is right that it is the hardest, and it is worth being precise about
 * WHY, because the reason decides the design.
 *
 * ── WHY THIS IS HARD ─────────────────────────────────────────────────────
 *
 * 1. IT IS A MATRIX, NOT A LIST. What you need is a function of your
 *    PASSPORT, your destination, your purpose and your length of stay.
 *    Roughly two hundred passports against two hundred destinations is forty
 *    thousand answers, and each of them changes without notice.
 *
 * 2. THE ANSWERS MOVE. ETIAS has slipped repeatedly. The UK ETA rolled out
 *    nationality by nationality. Thailand replaced a paper card with TDAC in
 *    2025. Any answer frozen into a codebase is wrong by the time it ships.
 *
 * 3. THE INTERNET IS HOSTILE HERE. Search "ETIAS" or "UK ETA" and the first
 *    page is mostly copycats — etiaspro, etiasanswers, etagov.uk — sites
 *    built to be mistaken for the government and to charge three to five
 *    times the real fee for a form the traveller could file free. This is
 *    the single most reliable way a traveller loses money to Num's subject
 *    matter, and it happens to people who were being careful.
 *
 * ── SO THIS FILE STORES WHERE THE TRUTH LIVES, NOT WHAT THE TRUTH IS ─────
 *
 * Every row is an official government URL and the NAME of the document. Not
 * the fee, not the processing time, not whether a given passport needs it.
 * Those are exactly the facts that rot, and a concierge that recites a stale
 * fee is worse than one that says "here is the page that decides".
 *
 * What a government publishes at its own address is true by definition and
 * true on the day the traveller reads it. What Num adds is knowing the
 * document exists, knowing it is needed BEFORE the airport rather than at
 * it, and knowing which link is the real one.
 *
 * ── THE ONE HARD RULE ────────────────────────────────────────────────────
 *
 * OFFICIAL DOMAINS ONLY. `OFFICIAL_HOSTS` is an allowlist and
 * traveldocs.test.mjs fails the build if a row points anywhere else. No
 * affiliate link, no aggregator, no "visa service" ever goes in this file —
 * not because they are all frauds, but because the traveller cannot tell
 * which ones are, and Num's whole claim here is being the link they can
 * trust without checking.
 */

/** Every host a row may point at. Government and intergovernmental only. */
export const OFFICIAL_HOSTS = Object.freeze([
  'travel-europe.europa.eu',
  'www.gov.uk',
  'esta.cbp.dhs.gov',
  'www.canada.ca',
  'immi.homeaffairs.gov.au',
  'nzeta.immigration.govt.nz',
  'www.immigration.govt.nz',
  'www.k-eta.go.kr',
  'www.mofa.go.jp',
  'tdac.immigration.go.th',
  'indianvisaonline.gov.in',
  'evisa.gov.vn',
  'www.ica.gov.sg',
  'travel.state.gov',
  // ── CONSULAR DIRECTORIES, added 14 Sep 2026 ──────────────────────────
  // One allowlist for the whole product rather than a second one in
  // essentials.mjs. Two lists drift, and the day they drift is the day an
  // impostor gets in through whichever one nobody is testing.
  'travel.gc.ca',
  'www.dfat.gov.au',
  'www.mea.gov.in',
  'www.auswaertiges-amt.de',
]);

const HOST_OK = new Set(OFFICIAL_HOSTS);

/** True only for an https URL on the allowlist. Used by the tests and at write time. */
export function isOfficial(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && HOST_OK.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * KIND tells the traveller what SORT of thing this is, because they behave
 * very differently and people conflate them constantly:
 *
 *   authorisation — apply and be approved BEFORE you fly. Airlines check it
 *                   at the gate. Missing it means not boarding. (ESTA, ETA,
 *                   K-ETA, eTA, NZeTA, ETIAS.)
 *   visa          — a full application, sometimes with an appointment, often
 *                   weeks. (India, Vietnam, Japan.)
 *   arrival_card  — a declaration filed in the days before you land. Free,
 *                   fast, and the one people find out about in the queue.
 *                   (Thailand TDAC, Singapore, India e-Arrival.)
 */
export const KIND = Object.freeze({
  AUTHORISATION: 'authorisation',
  VISA: 'visa',
  ARRIVAL_CARD: 'arrival_card',
});

/**
 * Seeded from official sources, verified 14 Sep 2026.
 *
 * `who` is deliberately vague where the rule is a matrix — "many visa-exempt
 * nationalities" is honest, and "you need this" would not be. The official
 * page answers it for the passport in the traveller's hand, which is the
 * only answer that is ever correct.
 */
export const DOCS = Object.freeze({
  // The Schengen area, as one entry — the authorisation is area-wide.
  EU: [{
    kind: KIND.AUTHORISATION,
    name: 'ETIAS',
    full: 'European Travel Information and Authorisation System',
    who: 'visa-exempt nationalities visiting the Schengen area',
    url: 'https://travel-europe.europa.eu/etias',
    // NOT LIVE AS OF 14 SEP 2026 and repeatedly delayed. Num must never tell
    // somebody they need it, nor that they do not — this flag makes the
    // prompt say "check the date on the EU's own page", which stays correct
    // whichever way it lands.
    status: 'announced',
  }],
  GB: [{
    kind: KIND.AUTHORISATION,
    name: 'UK ETA',
    full: 'Electronic Travel Authorisation',
    who: 'visitors who do not need a visa and have no UK immigration status',
    url: 'https://www.gov.uk/guidance/apply-for-an-electronic-travel-authorisation-eta',
    status: 'live',
  }],
  US: [{
    kind: KIND.AUTHORISATION,
    name: 'ESTA',
    full: 'Electronic System for Travel Authorization',
    who: 'Visa Waiver Program nationalities',
    url: 'https://esta.cbp.dhs.gov/',
    status: 'live',
  }],
  CA: [{
    kind: KIND.AUTHORISATION,
    name: 'eTA',
    full: 'Electronic Travel Authorization',
    who: 'visa-exempt nationalities flying to Canada',
    url: 'https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/eta.html',
    status: 'live',
  }],
  AU: [{
    kind: KIND.AUTHORISATION,
    name: 'Australian ETA',
    full: 'Electronic Travel Authority (subclass 601)',
    who: 'eligible passport holders visiting Australia',
    url: 'https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/electronic-travel-authority-601',
    status: 'live',
  }],
  NZ: [{
    kind: KIND.AUTHORISATION,
    name: 'NZeTA',
    full: 'New Zealand Electronic Travel Authority',
    who: 'visa-waiver visitors and cruise passengers',
    url: 'https://nzeta.immigration.govt.nz/',
    status: 'live',
  }],
  KR: [{
    kind: KIND.AUTHORISATION,
    name: 'K-ETA',
    full: 'Korea Electronic Travel Authorization',
    who: 'visa-free nationalities — some are temporarily exempted, and the official site is where that list lives',
    url: 'https://www.k-eta.go.kr/',
    status: 'live',
  }],
  JP: [{
    kind: KIND.VISA,
    name: 'Japan eVISA',
    full: 'Japan electronic visa',
    who: 'nationalities that need a visa for Japan',
    url: 'https://www.mofa.go.jp/j_info/visit/visa/visaonline.html',
    status: 'live',
  }],
  TH: [{
    kind: KIND.ARRIVAL_CARD,
    name: 'TDAC',
    full: 'Thailand Digital Arrival Card',
    who: 'every foreign national arriving in Thailand',
    url: 'https://tdac.immigration.go.th/',
    status: 'live',
    // Their own page title says "No Fees Required", which is worth carrying:
    // the copycats charging for this one are numerous and convincing.
    free: true,
  }],
  IN: [
    {
      kind: KIND.VISA,
      name: 'India e-Visa',
      full: 'Indian electronic visa',
      who: 'most visitors to India',
      url: 'https://indianvisaonline.gov.in/evisa/',
      status: 'live',
    },
    {
      kind: KIND.ARRIVAL_CARD,
      name: 'India e-Arrival Card',
      full: 'Indian electronic arrival card',
      who: 'arriving foreign nationals',
      url: 'https://indianvisaonline.gov.in/earrival/',
      status: 'live',
      free: true,
    },
  ],
  VN: [{
    kind: KIND.VISA,
    name: 'Vietnam e-Visa',
    full: 'Vietnam National Electronic Visa',
    who: 'most visitors to Vietnam',
    url: 'https://evisa.gov.vn/',
    status: 'live',
  }],
  SG: [{
    kind: KIND.ARRIVAL_CARD,
    name: 'SG Arrival Card',
    full: 'Singapore Arrival Card and health declaration',
    who: 'arriving travellers who are not Singapore citizens or residents',
    url: 'https://www.ica.gov.sg/',
    status: 'live',
    free: true,
  }],
});

/** Every Schengen member — an ETIAS row answers for all of them. */
export const SCHENGEN = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IS', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO',
  'SK', 'SI', 'ES', 'SE', 'CH',
]);
const IN_SCHENGEN = new Set(SCHENGEN);

/**
 * What a traveller heading to this country has to deal with.
 * @returns {{country: string, docs: object[], covered: boolean}}
 */
export function docsFor(country) {
  const cc = String(country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return { country: cc, docs: [], covered: false };
  if (IN_SCHENGEN.has(cc)) return { country: cc, docs: DOCS.EU, covered: true };
  const docs = DOCS[cc];
  return { country: cc, docs: docs ?? [], covered: !!docs };
}

/** Countries this file can currently speak to. Honest about its own edges. */
export const COVERED = Object.freeze([...Object.keys(DOCS).filter((k) => k !== 'EU'), ...SCHENGEN].sort());

/**
 * How urgent is this, in the only terms that matter — days left.
 *
 * Not decoration. An arrival card is a five-minute job the night before; a
 * visa can be three weeks and an appointment. Telling somebody about a visa
 * nine days out with no sense of urgency is the same as not telling them.
 */
export function urgency(kind, daysOut) {
  // `Number(null)` is 0, not NaN — so a missing date used to read as
  // "travelling today" and came back `urgent` for everything. A guess that
  // loud is worse than no answer: it teaches people to ignore the warning,
  // and then the real one lands on deaf ears. Caught by this file's own
  // tests, which is the whole reason they assert the null case.
  if (daysOut === null || daysOut === undefined || daysOut === '') return 'unknown';
  const d = Number(daysOut);
  if (!Number.isFinite(d)) return 'unknown';
  if (kind === KIND.VISA) return d < 21 ? 'urgent' : d < 45 ? 'soon' : 'fine';
  if (kind === KIND.AUTHORISATION) return d < 3 ? 'urgent' : d < 10 ? 'soon' : 'fine';
  // An arrival card cannot usually be filed far ahead, so it is never urgent
  // until it is nearly time — and then it genuinely is.
  return d <= 3 ? 'soon' : 'fine';
}

/**
 * The block that rides in the concierge's context.
 *
 * Written to make the model NAME the document and HAND OVER the official
 * link, and to make it refuse to state the rule. The instruction to never
 * quote a fee is not fussiness: fees change, a wrong one is remembered as a
 * promise, and being wrong about money is how a concierge stops being
 * believed about anything else.
 */
export function docsBlock(country, { daysOut = null, place = null } = {}) {
  const { docs, covered } = docsFor(country);
  if (!covered || !docs.length) return null;

  const where = place || country;
  const rows = docs.map((d) => {
    const bits = [`- ${d.name} (${d.full}) — ${d.kind.replace('_', ' ')}`];
    bits.push(`  who it applies to: ${d.who}`);
    bits.push(`  OFFICIAL LINK (the only one you may ever give): ${d.url}`);
    if (d.free) bits.push('  This one is FREE on the official site. Anyone charging for it is not the government.');
    if (d.status === 'announced') {
      bits.push('  NOT IN FORCE YET and the start date has moved more than once. Do NOT say it is required '
        + 'and do NOT say it is not — say the date lives on that page and is the only one worth trusting.');
    }
    if (daysOut !== null) bits.push(`  urgency with ${daysOut} days to go: ${urgency(d.kind, daysOut)}`);
    return bits.join('\n');
  }).join('\n');

  return `ENTRY PAPERWORK FOR ${String(where).toUpperCase()} — RAISE THIS BEFORE THEY ASK:
${rows}

HOW TO HANDLE IT:
· NAME the document and say plainly when it has to be done by. That is the
  whole value — most people find out about an arrival card in the queue.
· GIVE THE OFFICIAL LINK ABOVE, EXACTLY. Never a search result, never an
  agency, never a link you compose yourself. Searching for any of these
  returns page after page of copycat sites built to be mistaken for the
  government and to charge several times the real fee. Being the link
  somebody can trust without checking is the entire point of this block.
· DO NOT STATE THE RULE FOR THEM. What they need depends on their passport,
  their purpose and how long they are staying, and none of that is in your
  context. Say what the document IS, who it generally applies to, and that
  the official page decides for their passport.
· NEVER quote a fee, a processing time or a validity period. Those change,
  and a wrong number about money is remembered as a promise.
· ONE mention, then drop it. This is a useful thing to be told once and a
  nagging thing to be told twice.`;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * GET /api/travel/docs?to=TH[&days=12]
 *
 * Open on purpose: nothing here is personal, it is a directory of government
 * addresses, and a traveller who is not signed in still deserves the right
 * link.
 */
export function handleTravelDocs(request) {
  const url = new URL(request.url);
  const to = url.searchParams.get('to') ?? '';
  const daysRaw = url.searchParams.get('days');
  const days = daysRaw === null || daysRaw === '' ? null : Number(daysRaw);

  if (!/^[A-Za-z]{2}$/.test(to)) {
    return json({ error: 'Pass a two-letter country code, e.g. ?to=TH', covered: COVERED }, 400);
  }
  const { country, docs, covered } = docsFor(to);
  if (!covered) {
    // A country Num has not seeded is answered honestly rather than guessed
    // at. The US State Department page is a real, official starting point
    // for any destination on earth, so the answer is still useful.
    return json({
      country,
      covered: false,
      why: 'Num has not verified the entry documents for this country yet.',
      start_here: 'https://travel.state.gov/content/travel/en/international-travel/International-Travel-Country-Information-Pages.html',
    });
  }
  return json({
    country,
    covered: true,
    docs: docs.map((d) => ({
      kind: d.kind,
      name: d.name,
      full: d.full,
      who: d.who,
      official_url: d.url,
      status: d.status,
      free: !!d.free,
      ...(Number.isFinite(days) ? { urgency: urgency(d.kind, days) } : {}),
    })),
    note: 'These are official government links. What you personally need depends on your passport, '
      + 'your purpose and how long you are staying — the official page decides that, not this list.',
  });
}
