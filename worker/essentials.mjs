/**
 * THE ESSENTIALS — AND BEING HONEST ABOUT WHICH ONES NUM ACTUALLY KNOWS.
 *
 * Dre, 14 Sep 2026: "lets connect the embassy's hospitals and all essentials
 * are also connected. easy to find."
 *
 * ── WHAT A COUNT OF THE DIRECTORY ACTUALLY SHOWED ────────────────────────
 *
 * Before writing anything, the places table was counted. Two things came out
 * of it, and both changed the design.
 *
 * WHAT IS ALREADY THERE, in useful numbers:
 *   Pharmacy 37,301 · Dentist 26,430 · Hospital 22,026 · Bank 3,923
 *   Clinic 2,280 · Police 1,901 · Doctors 1,029 · Laundry 575 · ATM 231
 *
 * WHAT IS NOT THERE AT ALL:
 *   Embassies and consulates. Zero rows. Not thin — absent.
 *
 * And that absence is correct, because an embassy is not a nearby-place
 * problem. WHICH mission you need depends on YOUR PASSPORT, not on where you
 * are standing: a Canadian in Bangkok needs the Canadian embassy, and the
 * nearest embassy to them is likely to be some other country's. A geographic
 * index answers the wrong question no matter how many rows it holds.
 *
 * So missions follow the same rule as visas (see traveldocs.mjs): Num links
 * the traveller's OWN foreign ministry's official directory, which lists the
 * mission covering wherever they are and is correct on the day they read it.
 *
 * ── THE FINDING THAT MATTERS MOST ────────────────────────────────────────
 *
 * Opening hours, counted the same day:
 *
 *   Hospital   22,026 rows —     20 with hours   (0.09%)
 *   Police      1,901 rows —     64 with hours   (3.4%)
 *   Clinic      2,280 rows —    236 with hours   (10.4%)
 *   Pharmacy   37,301 rows —  4,978 with hours   (13.3%)
 *
 * A hospital with no hours barely matters — an emergency department is open
 * by definition, and the useful fact is the phone number, which 70% of them
 * have. A PHARMACY with no hours matters enormously, because "is it open
 * now" is the entire question at midnight and Num knows the answer for one
 * in eight.
 *
 * Which is why this file's job is not only to point at things. It is to tell
 * the model WHAT IT DOES NOT KNOW, per category, so that "open now" is never
 * said about a row that never carried hours. Somebody ill walking to a shut
 * pharmacy is the exact failure the urgent brief cannot afford.
 */
import { isOfficial } from './traveldocs.mjs';

/**
 * Where a traveller's own government lists its missions.
 *
 * Verified against each ministry's own site, 14 Sep 2026. Seeded with the
 * passports Num actually serves; an unlisted nationality is answered
 * honestly rather than guessed at — see `missionFor`.
 */
export const MISSIONS = Object.freeze({
  US: { name: 'U.S. Department of State', url: 'https://travel.state.gov/content/travel/en/find_us_embassies.html' },
  GB: { name: 'UK Foreign, Commonwealth & Development Office', url: 'https://www.gov.uk/world/embassies' },
  CA: { name: 'Government of Canada', url: 'https://travel.gc.ca/assistance/embassies-consulates' },
  AU: { name: 'Australian Department of Foreign Affairs and Trade', url: 'https://www.dfat.gov.au/about-us/our-locations/missions/our-embassies-and-consulates-overseas' },
  IN: { name: 'Indian Ministry of External Affairs', url: 'https://www.mea.gov.in/indian-mission-abroad' },
  DE: { name: 'German Federal Foreign Office', url: 'https://www.auswaertiges-amt.de/en' },
});

/**
 * @returns {{nationality: string, known: boolean, name?: string, url?: string}}
 *
 * An unknown nationality returns known:false rather than a plausible URL.
 * The consular-services search results are thick with paid "visa and
 * document" services that dress as ministries, and a traveller who has lost
 * a passport is the least equipped person in the world to tell them apart.
 */
export function missionFor(nationality) {
  const cc = String(nationality ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return { nationality: cc, known: false };
  const m = MISSIONS[cc];
  if (!m) return { nationality: cc, known: false };
  return { nationality: cc, known: true, ...m };
}

/**
 * The essentials Num can find in its OWN directory, and how much it knows.
 *
 * `hours` is the honest fraction of rows carrying opening hours, measured on
 * 14 Sep 2026. It is in the code rather than a comment because the model is
 * shown it: a category at 13% must never be described as open, and a
 * category where openness is not the question should not be hedged either.
 */
export const ESSENTIALS = Object.freeze([
  {
    key: 'pharmacy', category: 'Pharmacy', rows: 37301, hours: 0.13, phone: 0.68,
    ask: 'a chemist, medicine, a prescription',
    // The one where hours ARE the question, and Num usually does not know.
    hoursMatter: true,
  },
  {
    key: 'hospital', category: 'Hospital', rows: 22026, hours: 0.001, phone: 0.70,
    ask: 'A&E, emergency, something serious',
    // An emergency department does not close. Hedging its hours would be
    // noise; the number and the distance are what a frightened person needs.
    hoursMatter: false,
  },
  {
    key: 'clinic', category: 'Clinic', rows: 2280, hours: 0.10, phone: 0.24,
    ask: 'a doctor, a walk-in, a check-up',
    hoursMatter: true,
  },
  {
    key: 'dentist', category: 'Dentist', rows: 26430, hours: null, phone: null,
    ask: 'toothache, a chipped tooth',
    hoursMatter: true,
  },
  {
    key: 'police', category: 'Police', rows: 1901, hours: 0.03, phone: 0.76,
    ask: 'a theft report, a lost passport report',
    // A station is staffed around the clock; what you need is which one and
    // its number, and 76% of them have one.
    hoursMatter: false,
  },
  {
    key: 'bank', category: 'Bank', rows: 3923, hours: null, phone: null,
    ask: 'cash, a card problem, exchanging money',
    hoursMatter: true,
  },
  {
    key: 'laundry', category: 'Laundry', rows: 575, hours: null, phone: null,
    ask: 'washing, same-day laundry',
    hoursMatter: true,
  },
  {
    key: 'vet', category: 'Veterinary', rows: 239, hours: null, phone: null,
    ask: 'a sick animal',
    hoursMatter: true,
  },
]);

/** Thin enough that Num should say so rather than imply a full directory. */
export const THIN = 3000;

export const essentialByKey = (key) => ESSENTIALS.find((e) => e.key === key) ?? null;

/**
 * The block the concierge reads when somebody needs something essential.
 *
 * Two halves, because they fail in opposite directions:
 *
 *   WHAT NUM HAS   — real rows, with an honest note on what it does not know
 *                    about them. The risk here is overclaiming.
 *   WHAT NUM DOES  — the consular directory. The risk here is sending
 *   NOT HAVE         somebody who has lost a passport to a paid impostor.
 */
export function essentialsBlock({ nationality = null, place = null, country = null } = {}) {
  const lines = [];
  const where = place || country || 'here';

  lines.push(`ESSENTIALS NEAR ${String(where).toUpperCase()} — what Num can find, and what it cannot:`);

  const strong = ESSENTIALS.filter((e) => e.rows >= THIN);
  const thin = ESSENTIALS.filter((e) => e.rows < THIN);

  lines.push('IN NUM’S OWN DIRECTORY, with real addresses and usually a phone number:');
  for (const e of strong) {
    lines.push(`  · ${e.category} — when they say: ${e.ask}`);
  }
  if (thin.length) {
    lines.push(
      'THINLY COVERED — Num has some of these but nowhere near all of them. Offer what it has, '
      + 'and say plainly it is not a complete list rather than implying it is: '
      + thin.map((e) => e.category.toLowerCase()).join(', ') + '.',
    );
  }

  // The honesty that keeps somebody from walking to a shut pharmacy.
  const risky = ESSENTIALS.filter((e) => e.hoursMatter && typeof e.hours === 'number' && e.hours < 0.25);
  if (risky.length) {
    lines.push(
      'OPENING HOURS — READ THIS BEFORE YOU SAY "OPEN NOW". Num holds hours for only a small '
      + 'share of these: ' + risky.map((e) => `${e.category.toLowerCase()} about ${Math.round(e.hours * 100)}%`).join(', ')
      + '. When a place’s own listing does not state its hours you DO NOT KNOW whether it is '
      + 'open, and you must not say or imply that it is. Give the place, the distance and the '
      + 'PHONE NUMBER, and say ringing first is worth the thirty seconds. Somebody ill walking '
      + 'across a city to a shut chemist at midnight is the worst thing this whole layer can do.',
    );
    lines.push(
      'A HOSPITAL IS DIFFERENT: an emergency department does not close, so do not hedge its '
      + 'hours. Give the name, how far, and the number. A police station is the same.',
    );
  }

  const mission = missionFor(nationality);
  if (mission.known) {
    lines.push(
      `THEIR EMBASSY — Num holds NO embassy or consulate listings, and that is deliberate: which `
      + `mission somebody needs depends on THEIR PASSPORT, not on what is nearest. They are `
      + `${mission.nationality}. The official directory is ${mission.name}: ${mission.url} — give `
      + `that link EXACTLY and let it name the mission covering where they are. Never a search `
      + `result and never a "visa service": somebody who has just lost a passport is the least `
      + `equipped person alive to tell a ministry from a company that looks like one.`,
    );
  } else {
    lines.push(
      'THEIR EMBASSY — Num holds no embassy listings, and does not know this traveller’s '
      + 'nationality, so it cannot name their ministry’s directory. ASK which passport they '
      + 'hold rather than guessing or searching. If they have lost a passport, the police report '
      + 'comes FIRST — every mission asks for it — and their airline or hotel can also reach '
      + 'their consulate on their behalf.',
    );
  }

  return lines.join('\n');
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * GET /api/travel/essentials?me=CA
 *
 * Open, like the docs route: a directory of government addresses and a list
 * of what Num can look up is not personal data, and a traveller who is not
 * signed in still deserves the right link.
 */
export function handleEssentials(request) {
  const url = new URL(request.url);
  const me = url.searchParams.get('me') ?? '';
  const mission = missionFor(me);

  return json({
    finds: ESSENTIALS.map((e) => ({
      key: e.key,
      category: e.category,
      rows: e.rows,
      thin: e.rows < THIN,
      // Stated rather than hidden. An app that shows "open now" on a category
      // Num knows one in eight of is lying in the user's own interface, not
      // just in the model's reply.
      hours_known: typeof e.hours === 'number' ? Math.round(e.hours * 100) : null,
      hours_matter: e.hoursMatter,
    })),
    embassy: mission.known
      ? { nationality: mission.nationality, source: mission.name, official_url: mission.url }
      : {
        nationality: mission.nationality || null,
        known: false,
        why: 'Num links a traveller to their OWN government\'s mission directory, and does not '
          + 'know this passport. Tell us the nationality, or ask the traveller.',
        nationalities: Object.keys(MISSIONS),
      },
    note: 'Num holds no embassy listings on purpose — which mission you need depends on your '
      + 'passport, not on what is nearest to you.',
  });
}

/** Exported for the test that proves every mission URL is a government one. */
export const missionUrlsAreOfficial = () =>
  Object.values(MISSIONS).every((m) => isOfficial(m.url));
