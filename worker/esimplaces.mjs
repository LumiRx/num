// Where is the traveller going? Turns "ESIM BKK", "esim thailand",
// "esim to koh samui pls" or "ESIM europe" into a country, an airport or a
// region — from the public-domain world airport list, not from a guess.
//
// When it cannot tell, it says so (kind: 'none' or 'ambiguous') and the
// caller asks. Selling someone the wrong country's eSIM is worse than asking.

import { AIRPORTS, COUNTRIES, CONTINENTS } from './esimairports.data.mjs';

const BY_IATA = new Map(AIRPORTS.map((a) => [a[0], a]));

export function airport(iata) {
  return BY_IATA.get(String(iata || '').toUpperCase()) || null;
}

export function countryName(code) {
  return COUNTRIES[String(code || '').toUpperCase()] || null;
}

export function continentOf(code) {
  return CONTINENTS[String(code || '').toUpperCase()] || null;
}

const SIZE_RANK = { L: 0, M: 1, S: 2, W: 3 };

/** Airports in a country, biggest first then by code. */
export function airportsIn(code) {
  const c = String(code || '').toUpperCase();
  return AIRPORTS.filter((a) => a[3] === c).sort((a, b) => SIZE_RANK[a[4]] - SIZE_RANK[b[4]] || (a[0] < b[0] ? -1 : 1));
}

/** Every country that has at least one airport with scheduled flights. */
export function countriesWithAirports() {
  return [...new Set(AIRPORTS.map((a) => a[3]))].sort();
}

export function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Names travellers use that are not the ISO name.
const COUNTRY_ALIASES = {
  uk: 'GB', 'u k': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  'northern ireland': 'GB', london: 'GB',
  usa: 'US', 'u s a': 'US', 'u s': 'US', america: 'US', 'united states of america': 'US', states: 'US',
  uae: 'AE', 'u a e': 'AE', emirates: 'AE', dubai: 'AE', 'abu dhabi': 'AE',
  holland: 'NL', netherlands: 'NL', korea: 'KR', 'south korea': 'KR', vietnam: 'VN', 'viet nam': 'VN',
  czechia: 'CZ', 'czech republic': 'CZ', turkey: 'TR', turkiye: 'TR', russia: 'RU', laos: 'LA',
  burma: 'MM', myanmar: 'MM', 'ivory coast': 'CI', 'cote d ivoire': 'CI', 'hong kong': 'HK', macau: 'MO', macao: 'MO',
  taiwan: 'TW', 'the bahamas': 'BS', bahamas: 'BS', 'the philippines': 'PH', philippines: 'PH', 'the maldives': 'MV',
  'saudi': 'SA', 'saudi arabia': 'SA', 'south africa': 'ZA', 'new zealand': 'NZ', 'puerto rico': 'PR',
  bali: 'ID', lombok: 'ID', 'koh samui': 'TH', samui: 'TH', 'koh phangan': 'TH', phangan: 'TH', 'koh tao': 'TH',
  pattaya: 'TH', 'koh lanta': 'TH', 'koh phi phi': 'TH', 'phi phi': 'TH', krabi: 'TH', phuket: 'TH', 'chiang mai': 'TH',
  cancun: 'MX', 'tulum': 'MX', ibiza: 'ES', mallorca: 'ES', majorca: 'ES', tenerife: 'ES', santorini: 'GR', mykonos: 'GR',
  hawaii: 'US', 'new york': 'US', 'los angeles': 'US', vegas: 'US', 'las vegas': 'US', miami: 'US',
  paris: 'FR', rome: 'IT', tokyo: 'JP', osaka: 'JP', kyoto: 'JP', seoul: 'KR', singapore: 'SG', 'kuala lumpur': 'MY',
  sydney: 'AU', melbourne: 'AU', toronto: 'CA', vancouver: 'CA', lisbon: 'PT', barcelona: 'ES', madrid: 'ES',
  amsterdam: 'NL', berlin: 'DE', istanbul: 'TR', doha: 'QA', 'hanoi': 'VN', 'ho chi minh': 'VN', saigon: 'VN',
  manila: 'PH', 'bangkok': 'TH', edinburgh: 'GB', glasgow: 'GB', dublin: 'IE', reykjavik: 'IS',
};

// Regions. A region request is answered with plans that cover many
// countries, never with one country's plan.
const REGION_WORDS = {
  europe: 'EU', eu: 'EU', schengen: 'EU',
  asia: 'AS', 'southeast asia': 'AS', 'south east asia': 'AS', 'se asia': 'AS',
  'north america': 'NA', 'south america': 'SA', 'latin america': 'SA', 'central america': 'NA', caribbean: 'NA',
  africa: 'AF', 'middle east': 'ME', oceania: 'OC',
  global: 'WORLD', world: 'WORLD', worldwide: 'WORLD', 'everywhere': 'WORLD', 'multiple countries': 'WORLD',
};

export const REGION_LABELS = {
  EU: 'Europe', AS: 'Asia', NA: 'North America', SA: 'Latin America', AF: 'Africa', ME: 'the Middle East',
  OC: 'Oceania', WORLD: 'worldwide',
};

// Words that carry no destination.
const FILLER = new Set(
  'esim e sim esims sim data plan plans please pls plz thanks thank you a an the to for in into at i im i m me my we our need want get buy going heading headed travelling traveling trip travel visiting visit flying fly landing land from hey hi hello num can could would like some an for next week tomorrow today tonight'
    .split(' '),
);

let _countryIndex = null;
function countryIndex() {
  if (_countryIndex) return _countryIndex;
  const m = new Map();
  for (const [code, name] of Object.entries(COUNTRIES)) m.set(norm(name), code);
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) m.set(alias, code);
  _countryIndex = m;
  return m;
}

let _cityIndex = null;
function cityIndex() {
  if (_cityIndex) return _cityIndex;
  const m = new Map();
  for (const a of AIRPORTS) {
    for (const part of String(a[2]).split(/[(),/]/)) {
      const key = norm(part);
      if (key.length < 3) continue;
      const list = m.get(key) || [];
      list.push(a);
      m.set(key, list);
    }
  }
  _cityIndex = m;
  return m;
}

/** Strip the keyword and filler, leaving just the destination words. */
export function destinationWords(text) {
  const words = norm(text).split(' ').filter(Boolean);
  // "e sim" arrives as two words once punctuation is stripped
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 'e' && words[i + 1] === 'sim') { i++; continue; }
    if (FILLER.has(words[i])) continue;
    out.push(words[i]);
  }
  return out;
}

/**
 * @returns {{kind:'airport'|'country'|'region'|'none'|'ambiguous', country?:string,
 *            airport?:Array, region?:string, label?:string, options?:string[]}}
 */
export function resolveDestination(text) {
  const raw = String(text || '');
  const words = destinationWords(raw);
  if (!words.length) return { kind: 'none' };
  const phrase = words.join(' ');

  const region = REGION_WORDS[phrase];
  if (region) return { kind: 'region', region, label: REGION_LABELS[region] };

  // Country names and aliases win over airport codes: "USA" and "UAE"
  // are what people type, and neither should be read as an airport.
  const byName = countryIndex().get(phrase);
  if (byName && COUNTRIES[byName]) return { kind: 'country', country: byName, label: COUNTRIES[byName] };

  // A single three-letter token that is an airport with scheduled flights.
  if (words.length === 1 && words[0].length === 3) {
    const a = airport(words[0]);
    if (a) return { kind: 'airport', airport: a, country: a[3], label: `${a[2] || a[1]} (${a[0]})` };
  }

  // A two-letter ISO code, only when typed in capitals ("ESIM IT") — in
  // lowercase too many of them are ordinary words (it, in, me, no, at).
  if (words.length === 1 && words[0].length === 2) {
    const upper = raw.match(/\b([A-Z]{2})\b(?![\s\S]*\b[A-Z]{2}\b)/);
    const code = upper && upper[1];
    if (code && code.toLowerCase() === words[0] && COUNTRIES[code]) {
      return { kind: 'country', country: code, label: COUNTRIES[code] };
    }
  }

  // A city with an airport. Only answered when every airport by that name
  // is in the same country; otherwise ask ("Victoria" is in four).
  const hits = cityIndex().get(phrase);
  if (hits && hits.length) {
    const countries = [...new Set(hits.map((a) => a[3]))];
    if (countries.length === 1) {
      const best = [...hits].sort((x, y) => SIZE_RANK[x[4]] - SIZE_RANK[y[4]])[0];
      return { kind: 'airport', airport: best, country: best[3], label: `${best[2] || best[1]} (${best[0]})` };
    }
    return { kind: 'ambiguous', options: countries.map((c) => COUNTRIES[c] || c) };
  }

  return { kind: 'none' };
}
