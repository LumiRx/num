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
