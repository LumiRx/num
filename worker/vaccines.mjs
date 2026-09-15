/**
 * NUM · vaccination requirements to ENTER a country.
 *
 * ── WHY THIS IS A TABLE AND NOT A LOOKUP ─────────────────────────────────
 *
 * There is no feed to consume. Not a paid one, not a free one. Verified
 * 14 Sep 2026:
 *
 *   · WHO publishes PDFs. No API, no JSON, no structured list.
 *   · CDC publishes HTML only. Its content-syndication API returns nothing
 *     for travel destinations; every "CDC travel API" on the internet is a
 *     third-party scraper.
 *   · TravelHealthPro (the official UK source) has a JavaScript widget behind
 *     a setup fee and an annual subscription. No documented REST endpoints.
 *   · The German foreign ministry has real JSON with a mandatory-vaccination
 *     block inside an HTML blob — German only, undocumented, no stated
 *     licence, reverse-engineered by a freedom-of-information request.
 *   · No open dataset exists at all.
 *
 * So this is a table, held to the same standard as emergency.mjs: read, not
 * recalled. Every row below came out of the two WHO PDFs named in SOURCES,
 * parsed by column, and cross-checked against CDC for the countries noted.
 *
 * ── AND WHY THE TABLE TELLS YOU HOW OLD IT IS ────────────────────────────
 *
 * The WHO list is the legal baseline and it is FOUR YEARS OLD. Worse, the
 * document itself reports that only 70 of 196 States Parties answered the
 * 2022 survey — 36% — and that NONE of the 47 African States Parties
 * answered. Per-country confirmation dates inside it run back to "prior to
 * 2013" for Sierra Leone, Kenya, Côte d'Ivoire and others.
 *
 * That is not a reason to leave the layer out. A traveller who does not know
 * Ghana wants a yellow fever certificate finds out at the airport. It IS a
 * reason to hand every answer to the official page with a date attached, and
 * never to let Num sound certain about a row WHO last confirmed in 2013.
 *
 * ── THE ONE THING PEOPLE GET WRONG ───────────────────────────────────────
 *
 * A yellow fever certificate is valid FOR LIFE. International Health
 * Regulations Annex 7 as amended by WHA67.13, in force since 11 July 2016:
 * boosters cannot be required as a condition of entry, and that applies to
 * certificates issued before 2016 too. Anything that implies a ten-year
 * expiry is wrong, and clinics still tell people otherwise.
 */

/** Where every row here came from, with the date it was published. */
export const SOURCES = Object.freeze({
  who_annex1: {
    url: 'https://cdn.who.int/media/docs/default-source/travel-and-health/countries-with-risk-of-yellow-fever-transmission.pdf',
    name: 'WHO · countries with risk of yellow fever transmission and countries requiring vaccination',
    published: '2022-11-18',
    revised: '2023-01-03',
  },
  who_country_list: {
    url: 'https://cdn.who.int/media/docs/default-source/travel-and-health/vaccination-requirements-and-who-recommendations-ith-2022-country-list.pdf',
    name: 'WHO · vaccination requirements and recommendations, ITH 2022 country list',
    published: '2022-11-19',
  },
  cdc: {
    url: 'https://wwwnc.cdc.gov/travel/destinations/list',
    name: 'US CDC · Travelers’ Health destinations',
    published: '2025-04-23',
  },
  nathnac: {
    url: 'https://travelhealthpro.org.uk/countries',
    name: 'NaTHNaC / UK Health Security Agency · TravelHealthPro',
    published: '2026-01-19',
  },
});

/**
 * Per-country pages, for the two sources that have them.
 *
 * TravelHealthPro's LEGACY pattern — /country/<numeric-id>/<slug> — still
 * returns HTTP 200 and SILENTLY SERVES THE WRONG COUNTRY: /country/220/thailand
 * is Tanzania. Only the /countries/<slug> form below is ever built.
 *
 * fitfortravel.nhs.uk is NOT here and must never be added. It was retired,
 * its TLS certificate expired on 7 June 2026, and it now fails to connect at
 * all — a link there is a security warning followed by a dead end.
 */
export const cdcPage = (slug) => `https://wwwnc.cdc.gov/travel/destinations/traveler/none/${slug}`;
export const nathnacPage = (slug) => `https://travelhealthpro.org.uk/countries/${slug}`;

/**
 * Yellow fever certificate required from EVERY arrival, whatever their route.
 * Value is the minimum age in MONTHS; null means the requirement is published
 * with no age threshold at all.
 */
export const YF_ALL = Object.freeze({
  AO: 9, BJ: 9, BF: 9, BI: 9, CM: 12, CF: 9, CG: 9, CI: 9, CD: 9,
  GF: 12, GA: 9, GH: 9, GW: 12, ML: 9, NE: 9, SL: null, SS: 9, TG: 9, UG: 12,
});

/**
 * Certificate required only from travellers ARRIVING FROM or having transited
 * a country with risk of transmission. Age in months.
 *
 * This is the larger and more confusing group, because whether it applies to
 * a given traveller depends on where they have BEEN, not where they are from.
 */
export const YF_FROM_RISK = Object.freeze({
  AL: 12, AG: 12, AU: 12, BS: 12, BD: 12, BB: 12, BO: 12, BW: 12, CV: 12,
  KH: 12, CX: 12, CO: 12, KP: 12, DJ: 12, DM: 12, DO: 12, EC: 12, SV: 12,
  FJ: 12, PF: 12, GD: 12, GP: 12, GT: 12, GY: 12, HT: 12, JM: 12, KE: 12,
  MW: 12, MY: 12, MQ: 12, MR: 12, YT: 12, MS: 12, MZ: 12, MM: 12, NC: 12,
  NI: 12, PK: 12, PA: 12, PG: 12, PY: 12, PN: 12, RW: 12, BL: 12, SH: 12,
  KN: 12, MF: 12, VC: 12, WS: 12, ST: 12, SC: 12, SG: 12, ZA: 12, SR: 12,
  TZ: 12, VE: 12, WF: 12, ZM: 12,
  DZ: 9, AW: 9, BH: 9, BQ: 9, BN: 9, TD: 9, CN: 9, CR: 9, CU: 9, CW: 9,
  EG: 9, GQ: 9, ER: 9, SZ: 9, ET: 9, GM: 9, GN: 9, IN: 9, ID: 9, IR: 9,
  LR: 9, MG: 9, MV: 9, MT: 9, NA: 9, NP: 9, NG: 9, NU: 9, OM: 9, PH: 9,
  QA: 9, LC: 9, SA: 9, SN: 9, SX: 9, SB: 9, LK: 9, TH: 9, AE: 9, ZW: 9,
  // No age threshold published; as written it applies to every age.
  KZ: null,
  // Honduras is the only country with an UPPER age limit, and WHO's own two
  // documents disagree: Annex 1 says 1–50, the ITH country list says 1–60,
  // CDC (Apr 2025) says 1–60. Two of three say 60, so 60 is used — and
  // DISPUTED below makes sure Num says so rather than picking silently.
  HN: 12,
});

/** Countries whose requirement Num knows to be contested between sources. */
export const DISPUTED = Object.freeze({
  HN: 'WHO’s own two documents disagree on the upper age limit (50 vs 60); CDC says 60. '
    + 'Num uses 60 and says it is disputed rather than choosing quietly.',
});

/** Honduras stops requiring it above this age. The only upper limit anywhere. */
export const YF_MAX_AGE_MONTHS = Object.freeze({ HN: 60 * 12 });

/** Sint Eustatius is the only place in the world with a six-month threshold. */
export const AGE_NOTES = Object.freeze({
  BQ: 'Bonaire is 9 months; Sint Eustatius is 6 months — the only six-month threshold '
    + 'anywhere, and the three islands share one country code, so check which island.',
});

/**
 * Where yellow fever actually circulates. Risk and requirement are DIFFERENT
 * things and they overlap only partly: Brazil, Peru, Sudan, Trinidad and
 * Tobago and Argentina all have risk and require nothing from anybody, while
 * Australia, Singapore, China, Malta and Saudi Arabia have no risk at all and
 * do require a certificate from travellers coming from a risk country.
 *
 * Risk drives what a doctor tells you. Requirement drives what a border does.
 */
export const YF_RISK_WHOLE = Object.freeze([
  'AO', 'BJ', 'BF', 'BI', 'CM', 'CF', 'CG', 'CI', 'CD', 'GQ', 'GF', 'GA',
  'GM', 'GH', 'GN', 'GW', 'GY', 'KE', 'LR', 'NG', 'PY', 'SN', 'SL', 'SS',
  'SR', 'TG', 'UG',
]);

export const YF_RISK_PARTIAL = Object.freeze([
  'AR', 'BO', 'BR', 'TD', 'CO', 'EC', 'ET', 'ML', 'MR', 'NE', 'PA', 'PE',
  'SD', 'TT', 'VE',
]);

export const yfRisk = (cc) => {
  const c = String(cc || '').toUpperCase();
  if (YF_RISK_WHOLE.includes(c)) return 'whole';
  if (YF_RISK_PARTIAL.includes(c)) return 'partial';
  return null;
};

/**
 * Countries that ignore WHO's risk list and publish their own.
 *
 * If Num models "arriving from a risk country" as one global boolean it is
 * wrong for every country below — usually in the traveller's favour, which is
 * still wrong, because it means telling somebody they need a vaccination they
 * do not. These are named so the answer says "check the list" instead.
 */
export const BESPOKE_SOURCE_LIST = Object.freeze({
  CO: 'Colombia applies it only to arrivals from Angola, Brazil, DR Congo and Uganda.',
  EC: 'Ecuador applies it only to arrivals from Brazil, DR Congo and Uganda.',
  VE: 'Venezuela applies it only to arrivals from Brazil.',
  DO: 'The Dominican Republic applies it only to arrivals from four Brazilian states — '
    + 'Minas Gerais, Espírito Santo, São Paulo and Rio de Janeiro.',
  PY: 'Paraguay applies it to arrivals from Brazil, Bolivia, Peru and Venezuela, '
    + 'counting transit over 24 hours.',
  IN: 'India publishes its own 43-country list and adds any country that reports a case.',
});

/**
 * How long you have to spend in a risk country's airport before it counts.
 * Absent means the country publishes no transit rule; twelve hours is the
 * common default where one is published.
 */
export const TRANSIT_HOURS = Object.freeze({
  GY: 4, PY: 24,
});

/** Countries where transit counts however brief it was. */
export const TRANSIT_ALWAYS = Object.freeze([
  'BD', 'BW', 'SZ', 'MS', 'NG', 'PG', 'ST', 'SN', 'SC', 'KZ',
]);

/**
 * Requirements that are not yellow fever.
 *
 * Yellow fever is the ONLY disease for which the International Health
 * Regulations permit a certificate as a standing condition of entry. Every
 * other rule below is a national measure or a visa condition, which is
 * exactly why they are easy to miss.
 */
export const OTHER = Object.freeze({
  SA: [{
    what: 'Meningococcal ACWY, for Hajj and Umrah',
    detail: 'Everyone over one year arriving for Umrah, Hajj or seasonal work in the '
      + 'Hajj zones needs a valid quadrivalent ACWY certificate, given at least 10 days '
      + 'before arrival. Polysaccharide counts for 3 years, conjugate for 5; a certificate '
      + 'that does not say which is treated as polysaccharide. It is a VISA condition, '
      + 'not something checked only at the airport.',
    source: 'https://travelhealthpro.org.uk/countries/saudi-arabia',
    // The Saudi Ministry of Health's own Hajj health-requirements pages all
    // 404 as of 14 Sep 2026, so this cites NaTHNaC, which is Crown Copyright
    // and was updated in January 2026. A deep link to moh.gov.sa would be a
    // broken link dressed as a primary source.
    note: 'Saudi MoH publishes this, but every direct URL Num could find returns 404.',
  }],
});

/**
 * Polio — real, current, and almost always explained backwards.
 *
 * The 2014 public health emergency is still running. But the measures are
 * EXIT requirements placed on infected states, not entry requirements placed
 * on arrivals: they ask a country to vaccinate its own residents and
 * long-term visitors before they travel out. A handful of countries have
 * separately made polio proof an entry or visa condition, and the
 * source-country lists in those rules are 2022-vintage and out of date even
 * where the requirement itself still stands.
 */
export const POLIO = Object.freeze({
  statement: 'https://www.who.int/news/item/25-08-2026-statement-of-the-forty-fifth-meeting-of-the-polio-ihr-emergency-committee',
  exitFrom: Object.freeze([
    'AF', 'PK', 'DE', 'CD', 'DJ', 'IL', 'LA', 'SS', 'CM', 'TD', 'NG',
  ]),
  entryCondition: Object.freeze(['EG', 'IR', 'GE', 'NP', 'MA', 'QA', 'BN', 'KN', 'PH', 'MV', 'BD', 'SA', 'IN']),
});

/** COVID-19: no verified entry requirement anywhere, and WHO asks states to drop any that remain. */
export const COVID = Object.freeze({
  standing: 'https://www.who.int/teams/ihr/standing-recommendations',
  verdict: 'no verified vaccination requirement for entry anywhere as of 14 Sep 2026',
});

/**
 * What a traveller entering `to` needs, given where they have been.
 *
 * `from` is a list of country codes they have been in or transited recently.
 * An EMPTY list is not the same as an empty answer: Num usually does not know
 * a traveller's whole route, so the from-risk rule is reported as a condition
 * to check rather than resolved into a yes or a no.
 */
export function vaccinesFor(to, { from = [] } = {}) {
  const cc = String(to || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return { known: false, country: cc, rules: [] };

  const rules = [];

  if (Object.prototype.hasOwnProperty.call(YF_ALL, cc)) {
    rules.push({
      kind: 'yellow_fever',
      applies: 'everyone',
      minAgeMonths: YF_ALL[cc],
      note: AGE_NOTES[cc] ?? null,
    });
  } else if (Object.prototype.hasOwnProperty.call(YF_FROM_RISK, cc)) {
    const been = (Array.isArray(from) ? from : [])
      .map((c) => String(c).toUpperCase())
      .filter((c) => yfRisk(c));
    rules.push({
      kind: 'yellow_fever',
      applies: 'from_risk',
      minAgeMonths: YF_FROM_RISK[cc],
      maxAgeMonths: YF_MAX_AGE_MONTHS[cc] ?? null,
      // Only ever 'yes' or 'unknown'. Num does not see a passport's stamps,
      // so it cannot say 'no' — and 'no' is the answer that gets somebody
      // turned around.
      triggered: been.length ? 'yes' : 'unknown',
      riskCountriesSeen: been,
      transitHours: TRANSIT_HOURS[cc] ?? (TRANSIT_ALWAYS.includes(cc) ? 0 : null),
      ownList: BESPOKE_SOURCE_LIST[cc] ?? null,
      disputed: DISPUTED[cc] ?? null,
      note: AGE_NOTES[cc] ?? null,
    });
  }

  for (const o of OTHER[cc] ?? []) rules.push({ kind: 'other', ...o });

  if (POLIO.entryCondition.includes(cc)) {
    rules.push({
      kind: 'polio',
      applies: 'from_listed_countries',
      source: POLIO.statement,
    });
  }

  return {
    known: true,
    country: cc,
    risk: yfRisk(cc),
    rules,
    asOf: SOURCES.who_country_list.published,
  };
}

const months = (m) => {
  if (m == null) return 'every age';
  if (m % 12 === 0) return `${m / 12} year${m === 12 ? '' : 's'} and older`;
  return `${m} months and older`;
};

/** The block the model reads. Null when there is nothing to say. */
export function vaccineBlock(result, { country_name = null } = {}) {
  if (!result?.known || !result.rules.length) return null;
  const where = country_name || result.country;
  const lines = [`VACCINATION RULES FOR ENTERING ${String(where).toUpperCase()}`];

  for (const r of result.rules) {
    if (r.kind === 'yellow_fever' && r.applies === 'everyone') {
      lines.push(`· Yellow fever certificate required from EVERY arrival, ${months(r.minAgeMonths)}. `
        + 'This one is not conditional on where they have been.');
      if (r.note) lines.push(`  ${r.note}`);
    }
    if (r.kind === 'yellow_fever' && r.applies === 'from_risk') {
      lines.push(`· Yellow fever certificate required from arrivals who have been in or transited `
        + `a country where yellow fever circulates, ${months(r.minAgeMonths)}.`);
      if (r.triggered === 'yes') {
        lines.push(`  THEY HAVE BEEN IN ONE: ${r.riskCountriesSeen.join(', ')}. Raise this early.`);
      } else {
        lines.push('  Num cannot see their route, so it does NOT know whether this applies to them. '
          + 'Say it as a condition — "if you are coming from or connecting through…" — and never '
          + 'as "you do not need it". Telling somebody they are exempt is the answer that gets '
          + 'them turned around.');
      }
      if (r.transitHours === 0) lines.push('  Transit counts here however brief it was.');
      else if (r.transitHours) lines.push(`  Transit counts after ${r.transitHours} hours.`);
      if (r.ownList) lines.push(`  ${r.ownList}`);
      if (r.maxAgeMonths) lines.push(`  It stops applying above ${r.maxAgeMonths / 12}.`);
      if (r.disputed) lines.push(`  DISPUTED: ${r.disputed}`);
      if (r.note) lines.push(`  ${r.note}`);
    }
    if (r.kind === 'other') lines.push(`· ${r.what}. ${r.detail}`);
    if (r.kind === 'polio') {
      lines.push('· Polio proof can be an entry or visa condition here, depending on which '
        + 'countries the traveller has come from. The published source lists are out of date '
        + 'even where the rule still stands, so point at the official page rather than listing them.');
    }
  }

  lines.push('');
  lines.push('A YELLOW FEVER CERTIFICATE IS VALID FOR LIFE. International Health Regulations '
    + 'Annex 7 since 11 July 2016 — a booster cannot be required for entry, and that covers '
    + 'certificates issued before 2016. Clinics still tell people it lasts ten years. If somebody '
    + 'says theirs has expired, that is worth correcting kindly.');
  lines.push(`Num's table is WHO's, published ${result.asOf}. WHO built it from a survey only 36% `
    + 'of countries answered, and none of the African ones did. So: say what the rule is, say it '
    + 'may have moved, and hand them the official page. Never present this as medical advice and '
    + 'never tell somebody they are exempt.');

  return lines.join('\n');
}

/** GET /api/travel/vaccines?to=GH&from=BR,PE */
export function handleVaccines(request) {
  const url = new URL(request.url);
  const to = url.searchParams.get('to') || '';
  const from = (url.searchParams.get('from') || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!/^[A-Za-z]{2}$/.test(to)) {
    return new Response(JSON.stringify({ error: 'to must be a two-letter country code' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  const result = vaccinesFor(to, { from });
  return new Response(JSON.stringify({
    ...result,
    sources: SOURCES,
    lifetimeCertificate: true,
    note: result.rules.length
      ? 'Requirements move. Check the official page before you travel; Num is not medical advice.'
      : 'Num holds no vaccination entry requirement for this country. That is not the same as there being none.',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' },
  });
}
