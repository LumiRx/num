/**
 * NUM · public holidays — the day the door is shut for a reason nobody told you.
 *
 * ── WHY THIS LAYER EXISTS ────────────────────────────────────────────────
 *
 * A traveller lands in Bangkok on a Tuesday needing a bank, a pharmacy that
 * takes a prescription, and a visa office. On Chakri Day all three behave
 * differently and none of them say so on their own page. This is the single
 * most common reason a plan Num made politely falls apart: the plan was right
 * and the country was closed.
 *
 * ── TWO SOURCES, IN A FIXED ORDER, BOTH VERIFIED ─────────────────────────
 *
 * 1. Nager.Date — free, no key, clean JSON, 204 countries. First choice for
 *    everything it covers, because it returns structured data with a `global`
 *    flag and local names rather than text we have to parse.
 *
 * 2. Google's public holiday calendars — used ONLY for countries Nager does
 *    not carry. Google's calendar ids are not derivable: Thailand is `en.th`,
 *    Taiwan is `en.taiwan`, India is `en.indian`, Vietnam is `en.vietnamese`.
 *    Guessing the slug returns HTTP 500, not an error message, so every id in
 *    GOOGLE_CAL below was requested live and confirmed to return events before
 *    it was written down. Same discipline as OFFICIAL_HOSTS in traveldocs.mjs
 *    and the table in emergency.mjs: checked, not inferred.
 *
 * ── THE RULE THAT MATTERS ────────────────────────────────────────────────
 *
 * A country we cannot cover returns `{ covered: false }`, never an empty list.
 * An empty list reads as "nothing is closed that week", which is the exact
 * wrong thing to tell somebody planning around a national holiday. Not knowing
 * and knowing there is nothing are different answers and this module never
 * confuses them.
 *
 * Nothing here decides anything. It hands the model a fact and a confidence,
 * and the prompt does the rest.
 */

/** Nager.Date coverage, as returned by /api/v3/AvailableCountries. */
export const NAGER = Object.freeze([
  'AD', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AW', 'AX', 'BA', 'BB', 'BD',
  'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BO', 'BQ', 'BR', 'BS', 'BW', 'BY',
  'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR',
  'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'ER', 'ES', 'ET', 'FI', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GT', 'GW', 'GY', 'HK', 'HN',
  'HR', 'HT', 'HU', 'ID', 'IE', 'IM', 'IQ', 'IS', 'IT', 'JE', 'JM', 'JP', 'KE', 'KH',
  'KI', 'KM', 'KN', 'KR', 'KY', 'KZ', 'LC', 'LI', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MN', 'MP', 'MQ', 'MR', 'MS',
  'MT', 'MW', 'MX', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NR', 'NU',
  'NZ', 'PA', 'PE', 'PF', 'PG', 'PH', 'PL', 'PM', 'PN', 'PR', 'PT', 'PW', 'PY', 'RO',
  'RS', 'RU', 'RW', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM',
  'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TG', 'TK', 'TN',
  'TO', 'TR', 'TT', 'TV', 'TZ', 'UA', 'UG', 'US', 'UY', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'ZA', 'ZM', 'ZW',
]);

/**
 * Countries Nager does not carry, mapped to the Google calendar id that does.
 *
 * Every one of these was requested live on 14 Sep 2026 and returned HTTP 200
 * with a non-empty VEVENT list. The wrong slug returns HTTP 500 with no
 * explanation, so there is no way to discover these except by asking.
 *
 * Six of these are countries Nager simply does not carry, all of them in NUM's
 * largest markets: Taiwan is 251,767 places, Thailand 207,605 and the city the
 * daily brief is written in. The seventh, Vietnam, is listed by Nager and
 * answered wrongly — see the note on it below. That is why coverage is checked
 * per country against real output rather than against a country list.
 */
export const GOOGLE_CAL = Object.freeze({
  TH: 'en.th',            // Nager does not list Thailand at all
  TW: 'en.taiwan',        // Nager does not list Taiwan at all
  AE: 'en.ae',            // Nager does not list the UAE at all
  MY: 'en.malaysia',      // Nager does not list Malaysia at all
  IN: 'en.indian',        // Nager does not list India at all
  SA: 'en.saudiarabian',  // Nager does not list Saudi Arabia at all
  // Vietnam is the one country here that Nager DOES list — and gets wrong in
  // the way that matters. Asked for 2026 it returns four days: New Year,
  // Reunification, Labour and National Day. Tet is absent. Tet is the week
  // Vietnam closes, and Vietnam is NUM's fourth-largest market at 209,358
  // places. Google's feed carries Tet's Eve and its four following days.
  // Checked 14 Sep 2026.
  VN: 'en.vietnamese',
});
/** Does Num know this country's calendar at all? */
export function covers(cc) {
  const c = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return false;
  return NAGER.includes(c) || Object.prototype.hasOwnProperty.call(GOOGLE_CAL, c);
}

/** Which of the two rails answers for this country. */
export function railFor(cc) {
  const c = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  // Google wins where it is listed: those entries exist because Nager either
  // does not carry the country or carries it without usable dates.
  if (Object.prototype.hasOwnProperty.call(GOOGLE_CAL, c)) return 'google';
  if (NAGER.includes(c)) return 'nager';
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Is this a date that exists?
 *
 * `/^\d{4}-\d{2}-\d{2}$/` is a SHAPE check, not a date check: it happily
 * accepts 2026-13-45. An upstream that returns one bad row should not get a
 * traveller told to avoid the 45th of the thirteenth month, so the string is
 * parsed and read back. Round-tripping catches both the impossible month and
 * the 31st of February, which Date silently rolls forward to March.
 */
export function realDay(s) {
  const str = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && isoDay(d) === str;
}

/** '2026-09-14' from a Date, in UTC, with no library and no surprises. */
export function isoDay(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days from `from` to `to`, negative if `to` is in the past. */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Parse Google's iCal into the same shape Nager gives us.
 *
 * Only DTSTART;VALUE=DATE and SUMMARY are read. Holiday calendars are all-day
 * events, so a VEVENT without a plain date is not a holiday and is skipped
 * rather than guessed at. Folded lines (RFC 5545 wraps at 75 octets with a
 * leading space) are unfolded first, or long holiday names arrive truncated.
 */
export function parseIcs(text) {
  const src = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const out = [];
  for (const block of src.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const day = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(body);
    if (!day) continue;
    const sum = /\nSUMMARY:([^\r\n]*)/.exec(`\n${body}`);
    const name = (sum ? sum[1] : '').trim();
    if (!name) continue;
    // Several Asian feeds carry make-up working days alongside the holidays
    // they compensate for — Vietnam's 2026 feed lists "Working day for New Year
    // Holiday" on 10 January. Those rows mean the country is OPEN on a Saturday,
    // which is the exact opposite of what this module exists to report, so they
    // are dropped rather than shown.
    if (/^working day\b/i.test(name)) continue;
    const date = `${day[1]}-${day[2]}-${day[3]}`;
    if (!realDay(date)) continue;
    out.push({
      date,
      name,
      // Google's feed does not distinguish a statutory holiday from an
      // observance. Saying "public" for all of them would overstate what we
      // know, so the flag is null and the prompt is told the source is blunter.
      national: null,
    });
  }
  return out;
}

/** Normalise one Nager row. */
export function fromNager(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && realDay(r.date))
    .map((r) => ({
      date: r.date,
      name: String(r.localName || r.name || '').trim() || String(r.name || '').trim(),
      national: r.global === true,
    }))
    .filter((r) => r.name);
}

export const NAGER_URL = (cc, year) =>
  `https://date.nager.at/api/v3/PublicHolidays/${year}/${String(cc).toUpperCase()}`;

export const GOOGLE_URL = (calId) =>
  `https://calendar.google.com/calendar/ical/${encodeURIComponent(calId)}%23holiday%40group.v.calendar.google.com/public/basic.ics`;

/**
 * Holidays for one country across a window of days.
 *
 * `fetchImpl` is injected so every path here is testable without the network,
 * and so a worker can pass a fetch that carries its own timeout.
 *
 * Returns `{ covered:false }` for a country neither rail carries. That is the
 * whole contract: an empty `days` array means "checked, nothing falls in this
 * window", and is never used to mean "we don't know".
 */
export async function holidaysFor(cc, { from, days = 30, fetchImpl = fetch } = {}) {
  const c = String(cc || '').toUpperCase();
  const rail = railFor(c);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? String(from) : isoDay(new Date());
  if (!rail) return { covered: false, country: c, rail: null, days: [] };

  const endMs = Date.parse(`${start}T00:00:00Z`) + days * 86400000;
  const end = isoDay(new Date(endMs));
  const years = new Set([start.slice(0, 4), end.slice(0, 4)]);

  let all = [];
  try {
    if (rail === 'nager') {
      for (const y of years) {
        const res = await fetchImpl(NAGER_URL(c, y));
        // 204 means Nager lists the country but has no data for that year.
        // That is not an outage and it is not "no holidays" either.
        if (!res || res.status === 204) continue;
        if (!res.ok) return { covered: true, country: c, rail, days: [], stale: true };
        all = all.concat(fromNager(await res.json()));
      }
    } else {
      const res = await fetchImpl(GOOGLE_URL(GOOGLE_CAL[c]));
      if (!res || !res.ok) return { covered: true, country: c, rail, days: [], stale: true };
      all = parseIcs(await res.text());
    }
  } catch {
    // A network failure is not evidence that the country has no holidays.
    return { covered: true, country: c, rail, days: [], stale: true };
  }

  const inWindow = all
    .filter((h) => h.date >= start && h.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // The same holiday can appear twice when two years were fetched, or when a
  // calendar lists an observance and its substitute day under one date.
  const seen = new Set();
  const out = [];
  for (const h of inWindow) {
    const key = `${h.date}|${h.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...h, inDays: daysBetween(start, h.date) });
  }

  return { covered: true, country: c, rail, from: start, to: end, days: out };
}

/**
 * The block the model reads.
 *
 * Written so that the three states — a holiday is coming, nothing is coming,
 * and we do not know — cannot be confused with each other by a model skimming
 * for something to say.
 */
export function holidayBlock(result, { country_name = null } = {}) {
  if (!result) return null;
  const where = country_name || result.country || 'this country';

  if (!result.covered) {
    return 'PUBLIC HOLIDAYS — NOT KNOWN\n'
      + `Num does not hold a public-holiday calendar for ${where}. Do not say whether `
      + 'anything is open or closed on a given date, and do not guess from a neighbouring '
      + 'country. If the date matters to them — a bank, a government office, a clinic — say '
      + 'plainly that you cannot check the calendar there and suggest they ring ahead. '
      + 'Saying "I am not sure" is the correct answer here and it is not a failure.';
  }

  if (result.stale) {
    return 'PUBLIC HOLIDAYS — COULD NOT BE READ\n'
      + `The holiday calendar for ${where} did not answer just now. That is a Num problem, `
      + 'not an answer. Do not report that there are no holidays — say the calendar is not '
      + 'responding and treat the date as unchecked.';
  }

  if (!result.days.length) {
    return 'PUBLIC HOLIDAYS — CHECKED, NONE\n'
      + `Checked ${where} from ${result.from} to ${result.to}: no public holidays fall in `
      + 'that window. This one you can state.';
  }

  const lines = result.days.slice(0, 12).map((h) => {
    const when = h.inDays === 0 ? 'today'
      : h.inDays === 1 ? 'tomorrow'
        : `in ${h.inDays} days`;
    const kind = h.national === true ? ' (national)' : h.national === false ? ' (regional)' : '';
    return `  ${h.date} — ${h.name}${kind}, ${when}`;
  });

  const soft = result.rail === 'google'
    ? '\nThis calendar lists observances alongside public holidays and does not mark which '
      + 'is which, so say "a holiday" rather than promising the country shuts.'
    : '';

  return `PUBLIC HOLIDAYS IN ${where.toUpperCase()}\n${lines.join('\n')}\n`
    + 'Banks, government offices, visa counters and many clinics close or run short hours on '
    + 'these days, and transport fills up around them. Mention it BEFORE they build a plan '
    + 'around that date, not after. A pharmacy or hospital is a different matter — do not '
    + 'tell somebody who needs medicine that everything is shut.'
    + soft;
}

/** HTTP surface: GET /api/travel/holidays?country=TH&from=2026-09-14&days=30 */
export async function handleHolidays(request, env, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  const cc = url.searchParams.get('country') || '';
  const from = url.searchParams.get('from') || '';
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), 365) : 30;

  if (!/^[A-Za-z]{2}$/.test(cc)) {
    return new Response(JSON.stringify({ error: 'country must be a two-letter code' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  const result = await holidaysFor(cc, { from, days, fetchImpl });
  return new Response(JSON.stringify({
    ...result,
    note: result.covered
      ? null
      : 'Num has no verified holiday calendar for this country. It will say so rather than guess.',
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // A national calendar changes about once a year. Six hours is generous
      // to the upstream and invisible to a traveller.
      'cache-control': 'public, max-age=21600',
    },
  });
}
