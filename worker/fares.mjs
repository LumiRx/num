// Official metered taxi fares, as arithmetic.
//
// WHY THIS EXISTS. "How much should a taxi from the airport cost?" is the most
// common question a traveller has in the first ten minutes of a trip, and it is
// the one where being wrong costs them money and being vague costs us trust.
// There is no API for it — Grab, Bolt and every Thai taxi app are closed — but
// there IS a published tariff, and a tariff is just sums. A number the traveller
// can check against the meter is the whole brand.
//
// WHAT THIS IS NOT. It is not a quote. The meter also runs on time in slow
// traffic (Bangkok: 3 THB a minute under 6 km/h), tolls are paid by the
// passenger, and in Phuket almost nobody uses the meter at all. So every result
// carries `caveats`, and callers MUST show them. A bare number from this file,
// presented as a price, would be exactly the kind of invented certainty the
// product exists to avoid.
//
// SOURCES (checked 17 Sep 2026)
//   Bangkok: Airports of Thailand, Suvarnabhumi transport page
//     https://suvarnabhumi.airportthai.co.th/service/transportation/detail/834
//   Phuket:  official tariff unchanged since 2014; secondary source only —
//     no primary table from the Phuket Land Transport Office could be found,
//     which is why `verified` is false and the caveat says so.

/** [upToKm, thbPerKm] bands applied after the flag-fall distance. */
export const TARIFFS = Object.freeze({
  bangkok: Object.freeze({
    city: 'Bangkok', currency: 'THB', verified: true, checked: '2026-09-17',
    source: 'https://suvarnabhumi.airportthai.co.th/service/transportation/detail/834',
    flagFall: 35, flagFallKm: 1,
    bands: [[10, 6.5], [20, 7], [40, 8], [60, 8.5], [80, 9], [Infinity, 10.5]],
    airportSurcharge: 50,
    caveats: [
      'Meter only. Tolls are extra and the passenger pays them.',
      'In slow traffic the meter also adds 3 THB a minute.',
      'From the airport taxi counter there is a 50 THB fee on top.',
    ],
  }),
  phuket: Object.freeze({
    city: 'Phuket', currency: 'THB', verified: false, checked: '2026-09-17',
    source: 'https://www.evephuket.com/blog/phuket-taxi-prices-2026/',
    flagFall: 50, flagFallKm: 2,
    bands: [[15, 12], [Infinity, 10]],
    airportSurcharge: 100,
    caveats: [
      'This is the official meter tariff. In practice most Phuket drivers quote a fixed fare, and it is usually higher.',
      'Agree the price before you get in.',
      'From the airport there is a 100 THB surcharge.',
    ],
  }),
});

/**
 * Metered fare for a distance.
 * @returns {{city,currency,km,fare,low,high,fromAirport,verified,source,caveats}|null}
 *   `low`/`high` are the honest range: the pure meter, and the meter plus a
 *   quarter for traffic time. null for a city we hold no tariff for — never a guess.
 */
export function meterFare(cityKey, km, { fromAirport = false } = {}) {
  const t = TARIFFS[String(cityKey || '').toLowerCase()];
  const d = Number(km);
  if (!t || !Number.isFinite(d) || d <= 0 || d > 500) return null;

  let fare = t.flagFall;
  let from = t.flagFallKm;
  for (const [upTo, rate] of t.bands) {
    if (d <= from) break;
    const span = Math.min(d, upTo) - from;
    if (span > 0) fare += span * rate;
    from = upTo;
  }
  if (fromAirport) fare += t.airportSurcharge;

  const round = (n) => Math.round(n / 5) * 5;          // nobody pays 183.5 baht
  return {
    city: t.city, currency: t.currency, km: d, fromAirport,
    fare: Math.round(fare), low: round(fare), high: round(fare * 1.25),
    verified: t.verified, source: t.source, caveats: [...t.caveats],
  };
}

export const hasTariff = (cityKey) => Boolean(TARIFFS[String(cityKey || '').toLowerCase()]);

/* -------------------------------------------------------------------------- *
 * The prompt block.
 *
 * Narrow on purpose, like essentialsBlock next door: matched on the ASK, not
 * pushed every turn. A tariff table in front of somebody choosing a restaurant
 * is noise, and a block nobody reads is a block that teaches the model to skim.
 *
 * What it deliberately does NOT do is quote a fare for a named trip. That needs
 * a distance, Num has no routing engine, and a made-up "about 400 baht to
 * Patong" is exactly the invented certainty this product exists to avoid. The
 * rates are published and checkable; the distance is not ours to guess. If the
 * guest supplies the distance, the model has everything it needs to do the sum
 * and is told to show its working so they can check it against the meter.
 * -------------------------------------------------------------------------- */

const TAXI_ASK = new RegExp([
  'taxi|cab\\b|meter|metered',
  'tuk.?tuk|songthaew|song.?taew',
  'how much.{0,30}(?:ride|car|airport|town|from the airport)',
  '(?:fare|cost|price).{0,20}(?:taxi|cab|ride|airport|transfer)',
  'grab (?:price|fare|cost)|rip.?off|overcharg',
].join('|'), 'i');

export const wantsFares = (text) => TAXI_ASK.test(String(text || ''));

/**
 * @param {{place: {slug?: string}|null, text: string}} args
 * @returns {string|null} a prompt block, or null when this turn does not need one.
 */
export function faresBlock({ place = null, text = '' } = {}) {
  if (!wantsFares(text)) return null;
  const t = TARIFFS[String(place?.slug || '').toLowerCase()];
  if (!t) return null;

  const bands = t.bands.map(([upTo, rate], i) => {
    const from = i === 0 ? t.flagFallKm : t.bands[i - 1][0];
    const span = upTo === Infinity ? `beyond ${from} km` : `${from}–${upTo} km`;
    return `  ${span}: ${rate} ${t.currency}/km`;
  }).join('\n');

  return [
    `OFFICIAL METERED TAXI FARE — ${t.city}. Published tariff, checked ${t.checked}. Source: ${t.source}`,
    `  first ${t.flagFallKm} km: ${t.flagFall} ${t.currency}`,
    bands,
    `  from the airport: +${t.airportSurcharge} ${t.currency}`,
    '',
    ...t.caveats.map((c) => `- ${c}`),
    '',
    'HOW TO USE THIS. Quote the rates, not a total — you do not know how far their trip is.',
    'If they tell you the distance, work it out and show the arithmetic so they can check it against the meter.',
    'If they ask what a specific trip costs and have not said how far it is, say what the meter charges and ask,',
    'or tell them to agree the price before getting in. Never invent a distance and never quote a flat fare as if it were official.',
    t.verified
      ? ''
      : 'This tariff could not be confirmed against a primary government source. Say it is the official rate and that drivers here mostly quote fixed fares instead.',
  ].filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}
