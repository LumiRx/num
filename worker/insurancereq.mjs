/**
 * NUM · where travel insurance is a CONDITION OF ENTRY, not a good idea.
 *
 * ── THE DISTINCTION THIS FILE EXISTS TO HOLD ─────────────────────────────
 *
 * Almost every travel site says "insurance is recommended" about everywhere,
 * which is true and useless. A much smaller number of places will not let you
 * in without it, and that is a fact with a deadline attached.
 *
 * Every row below was verified against an official government or official
 * scheme page on 14 Sep 2026, and the URL is stored with the row. Countries
 * that are WIDELY reported to require insurance but whose own government
 * pages do not say so are in UNVERIFIED, and Num says "check" about them
 * rather than "you need it". Cuba is the loudest of those: half the internet
 * says it is mandatory, and neither the Cuban foreign ministry pages nor the
 * UK FCDO advisory says it.
 *
 * ── THE TWO PLACES A POLICY FROM ANYWHERE WILL NOT DO ────────────────────
 *
 * Qatar and Thailand's long-stay visas are strict about WHO underwrites. A
 * good policy from a good insurer does not satisfy either. That matters more
 * than the requirement itself, because a traveller who buys insurance, reads
 * "insurance required", and ticks it off is exactly the person who gets
 * stopped. Both rows carry `mustBeLocal`.
 */

/**
 * Countries and areas where proof of insurance is a condition of entry.
 *
 * `appliesTo` is deliberately narrow. Most of these are not blanket rules —
 * the Schengen one, which is the biggest, only touches people who need a visa
 * in the first place, so an American or a Briton flying to Paris is NOT
 * covered by it and must not be told they are.
 */
export const REQUIRED = Object.freeze({
  SCHENGEN: {
    where: 'The Schengen area (all 29 states)',
    appliesTo: 'Only travellers applying for a short-stay Schengen visa. Visa-exempt '
      + 'nationals — American, British, Australian, Canadian, Japanese and many others — '
      + 'are NOT covered by this rule and must not be told they are.',
    minimum: '€30,000, covering emergency medical treatment, emergency hospital treatment, '
      + 'and repatriation for medical reasons or death. Valid across all member states for '
      + 'the whole stay.',
    source: 'https://home-affairs.ec.europa.eu/policies/schengen/visa-policy/applying-schengen-visa_en',
    law: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32009R0810',
    countries: Object.freeze([
      'AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
      'IS', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO',
      'SK', 'SI', 'ES', 'SE', 'CH',
    ]),
  },
  BY: {
    where: 'Belarus',
    appliesTo: 'All foreign citizens, at the border or when applying for a visa. Citizens '
      + 'of Armenia, Kazakhstan, Kyrgyzstan, Moldova, Tajikistan, Uzbekistan, Ukraine, '
      + 'Russia and Turkmenistan are exempt.',
    minimum: '€10,000. It can be bought at the border checkpoint, so this one is '
      + 'recoverable if they arrive without it.',
    source: 'https://mfa.gov.by/en/visa/useful/',
    corroboration: 'https://www.gov.uk/foreign-travel-advice/belarus/entry-requirements',
  },
  TH_LONGSTAY: {
    where: 'Thailand — Non-Immigrant O-A and O-X long-stay visas only',
    appliesTo: 'Long-stay retirement visa applicants. NOT tourist entry: a normal visitor '
      + 'to Thailand needs no insurance to get in.',
    minimum: 'USD 100,000 for the first year of an O-A, and it must include Covid-19. '
      + 'Renewals are THB 400,000 inpatient and THB 40,000 outpatient.',
    mustBeLocal: 'The certificate has to be on the Thai scheme’s own template. A good policy '
      + 'from a good insurer that is not on that template does not satisfy this.',
    // longstay.tgia.org is the Thai General Insurance Association, which
    // OPERATES the scheme the Thai authorities designated — it is not a
    // government site, and it is not on the government allowlist in
    // traveldocs.mjs, which stays government-only on purpose. It is carried
    // here as a scheme operator with the government's own circular beside it.
    source: 'https://image.mfa.go.th/mfa/0/tDJBi9m15g/The_Amendment_to_Additional_Criteria_for_Purchasing_Health_Insurance_fo_Non-Immigrant_O-A_Visa.pdf',
    schemeOperator: 'https://longstay.tgia.org/guidelineoa',
    countries: Object.freeze(['TH']),
  },
  QA: {
    where: 'Qatar — stays over 30 days',
    appliesTo: 'Anyone staying more than 30 days. Thirty days or fewer: not required.',
    minimum: 'QAR 50 per person per month, bought BEFORE travelling.',
    mustBeLocal: 'It must be from an insurer registered with Qatar’s Ministry of Public '
      + 'Health. No international travel-insurance policy satisfies this, whatever it covers.',
    source: 'https://www.gov.uk/foreign-travel-advice/qatar/entry-requirements',
    note: 'Qatar’s own tourism site calls insurance "recommended". The requirement is the '
      + 'health ministry scheme, not the tourism page.',
  },
  EC_GALAPAGOS: {
    where: 'Ecuador — the Galápagos Islands only',
    appliesTo: 'Foreign tourists travelling to Galápagos. Mainland Ecuador does not require it.',
    minimum: 'Not published.',
    source: 'https://www.gov.uk/foreign-travel-advice/ecuador/entry-requirements',
    countries: Object.freeze(['EC']),
  },
  AW: {
    where: 'Aruba — only when extending beyond 30 days',
    appliesTo: 'Not required to enter. It becomes required when applying to extend a stay '
      + 'past 30 days, and then it must cover liability as well as medical.',
    minimum: 'Not published.',
    // Aruba's tourism authority, not a ministry. It publishes the immigration
    // rules for visitors and there is no better source — so it is carried as
    // a scheme operator and deliberately NOT added to the government
    // allowlist in traveldocs.mjs.
    source: null,
    schemeOperator: 'https://www.aruba.com/uk/plan-your-visit-today/getting-to-aruba/immigration-regulations',
  },
});

/** Not a requirement, but people expect one, so Num should be able to say so. */
export const NOT_REQUIRED_BUT_ASKED = Object.freeze({
  NP: {
    where: 'Nepal',
    what: 'Border officers MAY ask to see insurance covering healthcare and repatriation. '
      + 'It is discretionary rather than an absolute rule.',
    source: 'https://www.gov.uk/foreign-travel-advice/nepal/entry-requirements',
  },
  SA: {
    where: 'Saudi Arabia',
    what: 'The e-visa INCLUDES health cover up to SAR 100,000 automatically. The electronic '
      + 'travel authorisation and the visa waiver do not, and no separate proof is asked for.',
    source: 'https://www.gov.uk/foreign-travel-advice/saudi-arabia/entry-requirements',
  },
});

/**
 * Widely reported as mandatory; NOT confirmed by any official page Num could
 * reach on 14 Sep 2026. These produce "check with them", never "you need it".
 */
export const UNVERIFIED = Object.freeze({
  RU: 'Russia requires medical insurance from visa applicants who are citizens of a Schengen '
    + 'state, Israel or Finland — but the only page Num found saying so is a single consular '
    + 'post’s site, which did not respond when checked on 14 Sep 2026, and is not the ministry’s '
    + 'own front door. The rule is probably real. Num will not cite a link it cannot open.',
  CU: 'Cuba is reported everywhere as requiring insurance. Neither the Cuban foreign '
    + 'ministry pages nor the UK FCDO advisory says so, and the ministry sites would not '
    + 'load. It may well be true — Num just cannot show a source for it.',
  TR: 'No insurance requirement on Türkiye’s own e-visa requirements page. Individual '
    + 'consulates may ask when issuing a sticker visa.',
  AE: 'The UAE publishes health-insurance rules for RESIDENCE visas. Nothing found making '
    + 'it a condition of a visit visa.',
  LK: 'No official page found confirming a current requirement.',
  IL: 'No official page found confirming a current requirement.',
  JO: 'No official page found confirming a current requirement.',
});

/** Is proof of insurance a condition of entry for this country? */
export function insuranceFor(cc) {
  const c = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return { known: false, country: c, required: null };

  for (const [key, row] of Object.entries(REQUIRED)) {
    if (row.countries?.includes(c)) {
      return { known: true, country: c, required: true, rule: key, ...row };
    }
  }
  if (Object.prototype.hasOwnProperty.call(REQUIRED, c)) {
    return { known: true, country: c, required: true, rule: c, ...REQUIRED[c] };
  }
  if (Object.prototype.hasOwnProperty.call(UNVERIFIED, c)) {
    return { known: true, country: c, required: 'unverified', why: UNVERIFIED[c] };
  }
  if (Object.prototype.hasOwnProperty.call(NOT_REQUIRED_BUT_ASKED, c)) {
    return { known: true, country: c, required: false, ...NOT_REQUIRED_BUT_ASKED[c] };
  }
  return { known: true, country: c, required: false };
}

/** The block the model reads. Null when there is nothing worth saying. */
export function insuranceBlock(result, { country_name = null } = {}) {
  if (!result?.known) return null;
  const where = country_name || result.where || result.country;

  if (result.required === 'unverified') {
    return 'TRAVEL INSURANCE — WIDELY REPORTED, NOT CONFIRMED\n'
      + `${result.why} Say that it is commonly required and that they should confirm with the `
      + 'embassy or airline — do not assert it and do not dismiss it.';
  }

  if (result.required === false && result.what) {
    return `TRAVEL INSURANCE — ${String(where).toUpperCase()}\n${result.what} Source: ${result.source}`;
  }

  if (result.required !== true) return null;

  const lines = [
    'TRAVEL INSURANCE IS A CONDITION OF ENTRY HERE',
    `Where: ${result.where}`,
    `Who it applies to: ${result.appliesTo}`,
    `Minimum: ${result.minimum}`,
  ];
  if (result.mustBeLocal) {
    lines.push(`CAREFUL: ${result.mustBeLocal} Do not let them tick this off because they `
      + 'already bought travel insurance — that is exactly the person who gets stopped.');
  }
  if (result.note) lines.push(result.note);
  if (result.source) lines.push(`Official source, give it exactly as written: ${result.source}`);
  if (result.schemeOperator) {
    lines.push(`The scheme itself is run at ${result.schemeOperator} — that is the designated `
      + 'operator, not a government site. Say which is which; a traveller who cannot tell them '
      + 'apart is the traveller a copycat site catches.');
  }
  lines.push('Say WHO the rule applies to, not just that it exists. Most of these rules touch '
    + 'a narrow group, and telling somebody they need insurance when they do not is its own '
    + 'kind of wrong.');
  return lines.join('\n');
}

/** GET /api/travel/insurance?to=FR */
export function handleInsurance(request) {
  const url = new URL(request.url);
  const to = url.searchParams.get('to') || '';
  if (!/^[A-Za-z]{2}$/.test(to)) {
    return new Response(JSON.stringify({ error: 'to must be a two-letter country code' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  const result = insuranceFor(to);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' },
  });
}
