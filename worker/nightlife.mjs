/**
 * NIGHTLIFE — which night is it, and is it the one you came out for.
 *
 * Dre, 20 Sep 2026: "a lot of people are looking for events to do at night,
 * and especially in the major areas and major tourist areas, it's hard to find
 * what DJs are playing, what concerts are playing, and where, especially
 * differentiating from hip hop and EDM and techno, being able to find all of
 * the top events every weekend."
 *
 * ── WHAT WAS ALREADY THERE, AND WHAT WAS NOT ─────────────────────────────
 *
 * `/api/discover?mode=nightlife` already finds the ROOMS — clubs, late bars
 * and live-music venues, nearest first, with a hard-won list of things that
 * are never a night out (a betting shop is tagged "gambling club"; an airport
 * lounge is a "lounge"). That part works and this file does not touch it.
 *
 * What was missing is WHAT IS ON IN THEM. The Ticketmaster rail returned one
 * flat list filtered by a single regex over `genre`, and `genre` is the middle
 * tier of Ticketmaster's three: every techno night, every house night and
 * every trance night arrives as the same string, "Dance/Electronic". So the
 * one distinction Dre asked for was the one the data could not make.
 *
 * ── MEASURED, 20 SEP 2026, AGAINST PRODUCTION ────────────────────────────
 *
 * Amsterdam returned `Cheeky Monday: ANAÏS! · Dance/Electronic · Melkweg` and
 * `Pi'erre Bourne · Hip-Hop/Rap · Melkweg` — real clubs, and the hip-hop /
 * electronic split already clean.
 *
 * London returned the Paddington Bear Experience, Sea Life, the London Eye,
 * the London Dungeon and Twist Museum. Genre `Family`. Not one music event in
 * the whole rail. That is not Ticketmaster being thin — London has hundreds of
 * music events on any night — it is `sort=date,asc` over an unfiltered query:
 * an attraction opens at 10:00 every single day, so attractions win a date
 * sort forever. `isNight()` below is the floor, but the real fix is asking
 * Ticketmaster for the Music segment in the first place, which is why
 * `search()` now takes a classification.
 *
 * Tokyo and Bangkok returned `[]` — cached, live, empty. Ticketmaster has no
 * inventory in either. Nothing in this file can invent it, and nothing in this
 * file pretends to: `whyEmpty()` exists so the screen says which of "we cannot
 * see this city" and "nothing is on" it actually is.
 *
 * ── THE ONE THING STILL UNVERIFIED ───────────────────────────────────────
 *
 * `subGenre` is documented (and `subGenreId` is a filter), but its values
 * could not be read from outside: the event cache stores the shaped row, which
 * never carried the field, and the key is a secret on num-app. So the mapping
 * below reads subGenre FIRST where it exists and degrades to the event title
 * and the billed acts where it does not — and `genresSeen()` reports the real
 * (genre, subGenre) pairs coming back, so the table gets corrected from data
 * rather than from anybody's assumption about a taxonomy. Until a probe says
 * otherwise, treat techno-vs-house as keyword-derived, not source-derived.
 */

/* ── THE BUCKETS ───────────────────────────────────────────────────────────
 *
 * Five, chosen by Dre on 20 Sep 2026, plus `other`.
 *
 * `house` is labelled "House & EDM" and not "House" on purpose. Everything
 * Ticketmaster files as Dance/Electronic with no finer signal lands there, and
 * calling that bucket "House" would put a trance night under a label that is
 * plainly wrong. "EDM" is the honest superset, and it is the word Dre used.
 * `techno` is only ever entered when the source or the billing SAYS techno —
 * it is the narrower claim, so it needs the louder evidence.
 */
export const BUCKETS = Object.freeze([
  Object.freeze({ id: 'hiphop', label: 'Hip-hop & R&B' }),
  Object.freeze({ id: 'house', label: 'House & EDM' }),
  Object.freeze({ id: 'techno', label: 'Techno' }),
  Object.freeze({ id: 'live', label: 'Live music' }),
  Object.freeze({ id: 'latin', label: 'Latin' }),
]);

export const OTHER = Object.freeze({ id: 'other', label: 'Also on' });

export const BUCKET_IDS = Object.freeze(BUCKETS.map((b) => b.id).concat(OTHER.id));

export const labelOf = (id) =>
  (BUCKETS.find((b) => b.id === id) ?? (id === OTHER.id ? OTHER : null))?.label ?? null;

/* ── WHAT IS NEVER A NIGHT OUT ─────────────────────────────────────────────
 *
 * The London rail, verbatim. These are Ticketmaster's own segment and genre
 * names for the things that filled it, plus the title shapes attractions use.
 * A daytime attraction that sells a timed ticket every day is not a night, and
 * no amount of genre mapping downstream can rescue a rail full of them.
 */
const NOT_NIGHT_GENRE = /^(family|miscellaneous|undefined)$/i;
const NOT_NIGHT_SEGMENT = /sports|arts ?& ?theatre|film|attraction/i;
/* WHOLE PHRASES, NEVER A BARE WORD — and this file broke its own rule on the
 * first run. `\btour\b` was in here to catch a sightseeing tour, and the test
 * caught it refusing `overpass - Elsewhere, Always Album Tour Europe`, a real
 * Berlin rock gig. Half the gig titles on Ticketmaster contain the word "tour".
 * Same for `eye`: the London Eye is caught by "standard experience" anyway, and
 * a bare `eye` would take "Eye of the Tiger" with it. */
const NOT_NIGHT_NAME = new RegExp([
  'standard entry', 'standard experience', 'standard admission', 'general admission ticket',
  'sea ?life', 'madame tussauds', 'dungeon', 'museum', 'aquarium', '\\bzoo\\b',
  'observation deck', 'observation wheel', 'sightseeing', 'walking tour', 'bus tour',
  'guided tour', 'boat tour', 'city tour', 'hop[- ]on hop[- ]off',
  'parking', 'premium package', 'vip package', 'matinee', 'exhibition',
  /* `Old School R&B Brunch Live` at Melkweg reached the nightlife shelf on the
   * staged build — a real listing, a real venue, the right genre, and a
   * daytime meal. A brunch is not a night out whatever is playing at it. */
  'brunch', 'afternoon tea', 'day party',
  /* NOT a bare "experience": The Jimi Hendrix Experience is a band, and the
   * attractions that use the word are all refused by their genre anyway — every
   * one of the six London rows came back Family or Miscellaneous. This list is
   * only the belt for an attraction that somehow arrives under Music. */
  'bear experience', 'illusions', 'home of illusion',
].join('|'), 'i');

/* Kept out of the acts list and out of the title keyword pass: a "Parking
 * permit Evanescence" row is a real Ticketmaster listing and not a gig. */
const NOT_AN_ACT = /^(parking|premium|vip package|hospitality)\b/i;

/* ── THE KEYWORD PASS ──────────────────────────────────────────────────────
 *
 * Only reached when the source's own classification does not settle it. Whole
 * words, because the failure mode here is the same one the venue shelves
 * already learned: "housewarming" is not house, "technology" is not techno,
 * and a "Latin Mass" is not reggaeton.
 */
const WORDS = Object.freeze([
  ['techno', /\b(techno|tech[ -]?house|minimal|industrial techno|hard ?techno|acid techno|warehouse rave)\b/i],
  ['house', /\b(house|deep ?house|afro ?house|amapiano|disco|garage|ukg|dnb|drum ?& ?bass|drum ?and ?bass|jungle|dubstep|trance|edm|rave|electro|dance music|bass music)\b/i],
  ['hiphop', /\b(hip ?hop|rap|r&b|rnb|trap|grime|drill|afrobeats?|dancehall|reggaeton?)\b/i],
  ['latin', /\b(latin|reggaeton|salsa|bachata|cumbia|merengue|banda|regional mexican)\b/i],
  ['live', /\b(live|band|acoustic|tour|album|jazz|blues|soul|funk|rock|metal|punk|indie|orchestra|choir)\b/i],
]);

/* Ticketmaster's genre tier, mapped. Anything not here falls through to the
 * keyword pass and then to `other`. */
const GENRE = Object.freeze([
  ['hiphop', /hip.?hop|rap|r&b|rhythm ?& ?blues/i],
  ['latin', /latin|regional mexican|reggaeton/i],
  ['house', /dance|electronic|electronica|edm/i],
  ['live', /rock|pop|metal|alternative|folk|country|jazz|blues|soul|funk|reggae|world|classical|indie/i],
]);

/* subGenre, the tier that can actually separate techno from house. Tried
 * first, and the only place `techno` is reached from the source itself. */
/* ── WHAT TICKETMASTER'S SUB-GENRE ACTUALLY CONTAINS ──────────────────────
 *
 * Measured against the staged build on 20 Sep 2026, before any traffic moved,
 * with `genresSeen()` over London, Amsterdam and Berlin. The whole observed
 * vocabulary was:
 *
 *   Music / Rock / Pop                       Music / Hip-Hop/Rap / Hip-Hop/Rap
 *   Music / Jazz / Jazz                      Music / Latin / Latin
 *   Music / Pop / Electro Pop                Music / Dance/Electronic / Club Dance
 *   Music / Rock / Alternative Rock          Music / Dance/Electronic / Dance/Electronic
 *   Music / Pop / Pop                        Miscellaneous / Family / Other
 *
 * NOT ONE Techno, House, Trance, Drum & Bass or Dubstep. Their electronic tier
 * stops at "Club Dance". So the honest position, recorded here rather than
 * left as a surprise: sub-genre separates hip-hop, Latin and electronic
 * cleanly, and CANNOT separate techno from house. Techno therefore only ever
 * comes from the title or the billing — which on a club listing is usually
 * where it is stated anyway ("Hard Techno All Night", "Bassiani presents").
 *
 * `electro` was in this table on the first run and matched "Electro Pop",
 * putting three London pop acts in the House & EDM bucket. Alyssa Grace at 26
 * Leake Street is electro-pop, not EDM. Removed: the genre tier already says
 * Dance/Electronic when it means it, and a pattern one word too greedy is the
 * same mistake as the bare `tour` above.
 */
const SUB = Object.freeze([
  ['techno', /\btechno\b|minimal techno|industrial techno/i],
  ['house', /\bhouse\b|club dance|dance\/electronic|electronica|garage|nu.?disco|trance|drum ?& ?bass|dubstep|breakbeat|jungle|hardstyle|amapiano/i],
  ['hiphop', /hip.?hop|\brap\b|trap|grime|drill|r&b|rhythm ?& ?blues|dancehall/i],
  ['latin', /latin|reggaeton|salsa|bachata|cumbia|banda|norte/i],
]);

const first = (table, value) => {
  const s = String(value ?? '').trim();
  if (!s) return null;
  for (const [id, re] of table) if (re.test(s)) return id;
  return null;
};

/** The billed acts, cleaned. This is the answer to "what DJs are playing". */
export function actsOf(e) {
  const raw = Array.isArray(e?.acts) ? e.acts : [];
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    const name = String(a ?? '').trim();
    if (!name || NOT_AN_ACT.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Is this a night out at all?
 *
 * Deliberately strict on the exclusions and generous on everything else: a
 * night we cannot classify still belongs on the screen under "Also on", but a
 * museum does not belong on it at any price.
 */
export function isNight(e) {
  if (!e || !e.name) return false;
  if (NOT_NIGHT_NAME.test(String(e.name))) return false;
  if (NOT_NIGHT_GENRE.test(String(e.genre ?? ''))) return false;
  if (NOT_NIGHT_SEGMENT.test(String(e.segment ?? ''))) return false;
  if (NOT_NIGHT_SEGMENT.test(String(e.genre ?? ''))) return false;
  return true;
}

/**
 * Which bucket, and how we know.
 *
 * Returns { id, from } where `from` is 'subgenre' | 'genre' | 'words' | null.
 * The provenance is not decoration: it is what lets the screen show a techno
 * chip with confidence when Ticketmaster said techno, and lets `genresSeen()`
 * show how often we are guessing from a title instead.
 */
export function bucketOf(e) {
  if (!isNight(e)) return { id: null, from: null };

  /* TECHNO IS CHECKED FIRST, and the measurement is why.
   *
   * The obvious order — sub-genre, then genre, then words — was the first
   * version, and it made `techno` unreachable. Ticketmaster's only electronic
   * sub-genres are "Club Dance" and "Dance/Electronic" (see the table above:
   * measured, three cities, no Techno anywhere), so a listing titled "Hard
   * Techno All Night" arrived with sub-genre "Club Dance", matched the house
   * pattern, and returned house before the words pass ever ran.
   *
   * Since the source CANNOT say techno, a title or a billing that says it is
   * strictly more information than anything the classification carries. So it
   * goes first. This is the one place words outrank the source, and it is only
   * because the source has been shown to have nothing to say here. */
  const byWords = first(WORDS, [e?.name, ...actsOf(e)].filter(Boolean).join(' · '));
  if (byWords === 'techno') return { id: 'techno', from: 'words' };

  const bySub = first(SUB, e?.subGenre);
  if (bySub) return { id: bySub, from: 'subgenre' };

  const byGenre = first(GENRE, e?.genre);
  if (byGenre) return { id: byGenre, from: 'genre' };

  if (byWords) return { id: byWords, from: 'words' };
  return { id: OTHER.id, from: null };
}

/* ── THE WEEKEND, AS A CLUB MEANS IT ──────────────────────────────────────
 *
 * Not Saturday 00:00–23:59. A Saturday night is filed by every ticketing
 * system on earth as Sunday 02:00, so a calendar weekend cuts every headline
 * set in half and drops it from the list it belongs to.
 *
 * Friday 18:00 through Monday 06:00, local. `now` is a Date; the dates coming
 * back from Ticketmaster are already local to the venue (`localDate`,
 * `localTime`), which is why this compares strings in that same local space
 * rather than converting anything to UTC and inventing an offset.
 */
export const WEEKEND_FROM_HOUR = 18;
export const WEEKEND_TO_HOUR = 6;

const two = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * The next weekend window, or the one we are inside.
 *
 * Returns { fromDate, fromTime, toDate, toTime, friday, saturday, sunday }.
 * Called on a Saturday it returns THIS weekend, not next — somebody opening
 * the app on Saturday afternoon is asking about tonight.
 */
export function weekendWindow(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const dow = d.getDay();               // 0 Sun … 6 Sat
  // How far back to Friday. Sunday counts as the weekend we are still in,
  // because Sunday 02:00 is Saturday night.
  const backToFriday = dow === 5 ? 0 : dow === 6 ? 1 : dow === 0 ? 2 : null;
  const friday = backToFriday != null ? addDays(d, -backToFriday) : addDays(d, (5 - dow + 7) % 7);
  const saturday = addDays(friday, 1);
  const sunday = addDays(friday, 2);
  const monday = addDays(friday, 3);
  return {
    fromDate: ymd(friday),
    fromTime: `${two(WEEKEND_FROM_HOUR)}:00:00`,
    toDate: ymd(monday),
    toTime: `${two(WEEKEND_TO_HOUR)}:00:00`,
    friday: ymd(friday),
    saturday: ymd(saturday),
    sunday: ymd(sunday),
  };
}

/** Is this event inside the window? A missing date is never assumed to be in. */
export function inWindow(e, w) {
  const date = String(e?.date ?? '');
  if (!date) return false;
  if (date < w.fromDate || date > w.toDate) return false;
  const time = String(e?.time ?? '');
  // No time means we do not know. It stays in on the middle days, because a
  // Saturday listing with no clock is still a Saturday listing; it is only the
  // boundary hours that need one, and there we keep it rather than guess.
  if (!time) return true;
  if (date === w.fromDate) return time >= w.fromTime;
  if (date === w.toDate) return time <= w.toTime;
  return true;
}

/**
 * Rank. What makes a night the one to print at the top.
 *
 * Every term is something a person would actually say out loud about why one
 * listing beats another. Nothing here is a popularity score, because
 * Ticketmaster does not sell us one and inventing one would be the third time
 * this repo has had to unpick a made-up ranking.
 */
export function score(e) {
  let s = 0;
  const acts = actsOf(e);
  if (acts.length) s += 30;                 // somebody is billed
  if (acts.length > 2) s += 6;              // a lineup, not a single support
  if (e?.venue) s += 20;                    // a room you can be told to go to
  if (e?.time) s += 16;                     // a door time you can plan around
  const t = String(e?.time ?? '');
  if (t && (t >= '21:00:00' || t < '06:00:00')) s += 12;   // actually at night
  if (e?.image) s += 4;
  if (bucketOf(e).from === 'subgenre') s += 5;             // the source was sure
  return s;
}

/**
 * The nights, bucketed and ranked.
 *
 * @param events  shaped Ticketmaster rows (see events.tm.mjs `shape`)
 * @param bucket  one of BUCKET_IDS, or null for everything
 * @param window  from `weekendWindow()`, or null for no date filter
 */
export function topNights(events, { bucket = null, window = null, limit = 12 } = {}) {
  const rows = (Array.isArray(events) ? events : [])
    .filter(isNight)
    .filter((e) => (window ? inWindow(e, window) : true))
    .map((e) => {
      const b = bucketOf(e);
      return { ...e, acts: actsOf(e), bucket: b.id, bucket_from: b.from, bucket_label: labelOf(b.id) };
    })
    .filter((e) => (bucket ? e.bucket === bucket : true));

  return rows
    .sort((a, b) => score(b) - score(a)
      || String(a.date ?? '9999').localeCompare(String(b.date ?? '9999'))
      || String(a.time ?? '99').localeCompare(String(b.time ?? '99')))
    .slice(0, Math.max(0, limit));
}

/** Counts per bucket, for the chips. Only buckets with something in them. */
export function bucketCounts(events, { window = null } = {}) {
  const out = new Map();
  for (const e of topNights(events, { window, limit: Infinity })) {
    out.set(e.bucket, (out.get(e.bucket) ?? 0) + 1);
  }
  return BUCKET_IDS
    .filter((id) => out.has(id))
    .map((id) => ({ id, label: labelOf(id), n: out.get(id) }));
}

/**
 * The distinct classifications actually coming back, with how many landed in
 * each bucket and how we decided. This is the instrument, not a feature: the
 * mapping above is a hypothesis about a taxonomy nobody outside Ticketmaster
 * has published, and this is what turns it into a measurement.
 */
export function genresSeen(events) {
  const seen = new Map();
  for (const e of (Array.isArray(events) ? events : [])) {
    const b = bucketOf(e);
    const key = `${e?.segment ?? '-'} / ${e?.genre ?? '-'} / ${e?.subGenre ?? '-'}`;
    const row = seen.get(key) ?? { key, n: 0, bucket: b.id, from: b.from, night: isNight(e) };
    row.n += 1;
    seen.set(key, row);
  }
  return [...seen.values()].sort((a, b) => b.n - a.n);
}

/**
 * Why is the screen empty? Three different sentences, because they ask the
 * person to do three different things.
 */
export function whyEmpty({ ready, covered, fetched, kept }) {
  if (!ready) return { code: 'not_connected', says: 'Listings are not switched on yet.' };
  if (!covered) {
    return {
      code: 'no_coverage',
      says: 'We cannot see this city’s listings yet — our events source does not cover it. '
        + 'The clubs and bars below are checked by NUM; what is on inside them, we would be guessing at.',
    };
  }
  if (!fetched) return { code: 'nothing_listed', says: 'Nothing is listed here for these nights yet.' };
  if (!kept) {
    return {
      code: 'nothing_at_night',
      says: 'Everything listed here for these nights is a daytime thing. Nothing after dark yet.',
    };
  }
  return null;
}
