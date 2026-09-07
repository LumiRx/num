// Geocoding — the step migration 0007 was written for and nobody built.
//
// ── THE GAP ──────────────────────────────────────────────────────────────
//
// `num_place_submissions` is where a business that Num does not already hold
// describes itself. The migration that created it carries `geo_source`,
// `geo_at`, nullable `lat`/`lng`, and a status value `geocoded` sitting
// between `new` and `promoted`. Its comment says the row is "captured
// faithfully, held here, geocoded and reviewed, and only then promoted".
//
// The geocoder was never written. Every submission has sat at `new` with null
// coordinates, and nothing could ever promote one, because `places.lat` and
// `places.lng` are NOT NULL. The table has been a waiting room with no door.
//
// ── WHY THE CONFIDENCE FLOOR IS THE WHOLE DESIGN ─────────────────────────
//
// Migration 0007 states the harm precisely: writing 0,0 to satisfy the NOT
// NULL constraint "puts a pin in the Gulf of Guinea and, worse, into
// cell_lat/cell_lng — the index the concierge searches by proximity. One bad
// row is one wrong answer to 'what is near me', which is the only question
// NUM exists to answer."
//
// A geocoder that always returns something is exactly that failure with extra
// steps. Geoapify will happily resolve "Somchai's shop, near the big tree" to
// the centroid of a province and hand back a low confidence score, and a
// caller that ignores the score has invented a location. So:
//
//   · below MIN_CONFIDENCE the row stays `new` and records WHY. A human sees
//     it in the queue with a note, which is the correct outcome — the address
//     was too vague, and no amount of retrying fixes that.
//   · a result outside the country the submission came from is refused
//     outright, however confident. That is the classic geocoder failure — a
//     street name that also exists in Ohio — and country is the one piece of
//     context we hold independently of what the owner typed.
//   · `geo_source` records which geocoder and at what confidence, so a bad
//     batch can be found and undone later. That field exists in the schema
//     for exactly this reason.
//
// ── THE ONE THAT GOT THROUGH ─────────────────────────────────────────────
//
// On 5 Sep 2026 a real Los Angeles business — LA Cannabis Club, "608 S Main
// Street" — was geocoded to 37.0258, -97.6065. That is a field in Kansas,
// 1,200 miles away. Every guard above passed it: the country was right (US to
// US) and the confidence was high, because Geoapify HAD found a building at
// 608 S Main Street. It found the wrong one, out of the several hundred
// streets in America called Main.
//
// The bug was `limit=1`. Asking a geocoder for exactly one answer to an
// ambiguous question gets you a confident one, and destroys the only evidence
// that the question was ambiguous — the other answers. A high confidence score
// says "this IS a building at that address". It never says "and it is the only
// one".
//
// So we ask for several and look at the runners-up. If the second-best match
// is roughly as good as the best and is in a different part of the world, the
// geocoder was not identifying a place; it was picking one. That row goes to a
// human with a note naming the towns it could have been, which is a question
// the owner can answer in four words.
//
// Nothing here promotes anything into `places`. This moves a row from `new` to
// `geocoded` and stops. Review stays human.

const BASE = 'https://api.geoapify.com/v1/geocode/search';

/**
 * Below this, we do not know where the place is.
 *
 * 0.5 is deliberately not generous. Geoapify's rank.confidence is 1.0 for a
 * clean building match and falls away fast as the match gets vaguer; the
 * middle of the range is where "this street, roughly" lives, and roughly is
 * not good enough for a pin a concierge will send somebody to.
 */
export const MIN_CONFIDENCE = 0.5;

/**
 * How many candidates to ask for, so the runners-up can be inspected.
 *
 * Geoapify bills per request, not per result, so this costs exactly what
 * `limit=1` cost and buys the evidence that the answer was a guess.
 */
export const CANDIDATES = 5;

/**
 * Two matches this close in confidence are, as far as the geocoder is
 * concerned, equally good answers.
 */
export const RIVAL_CONFIDENCE = 0.1;

/**
 * ...and this far apart, they are not the same place.
 *
 * 25km is deliberately generous. A rooftop pin that disagrees with a doorway
 * pin, or two branches of one chain across a city, must not read as ambiguity
 * — those are a metre and a mile. A different town is tens of miles, and that
 * is the failure being caught.
 */
export const RIVAL_KM = 25;

/** How many submissions one cron tick will spend credits on. */
export const SWEEP_LIMIT = 10;

export const geocodeReady = (env) => !!env?.GEOAPIFY_KEY;

/** Great-circle distance in kilometres. */
export function kmBetween(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The most human way to say where a candidate is — town first, country last. */
const placeName = (r) => [r?.city, r?.state, r?.country]
  .map((v) => String(v ?? '').trim()).filter(Boolean).join(', ') || null;

/**
 * One address → one coordinate, or a stated reason why not.
 *
 * @returns {Promise<{ok:true, lat:number, lng:number, confidence:number, formatted:string, matchType:string}
 *                 | {ok:false, reason:string, confidence?:number}>}
 */
export async function geocode(env, { text, country = null }, fetchImpl = fetch) {
  if (!geocodeReady(env)) return { ok: false, reason: 'not_connected' };
  const q = String(text ?? '').trim();
  // Anything this short is a name, not an address. Sending it spends a credit
  // to be told the centre of a country.
  if (q.length < 6) return { ok: false, reason: 'too_vague' };

  const qs = new URLSearchParams({
    text: q, format: 'json', limit: String(CANDIDATES), apiKey: env.GEOAPIFY_KEY,
  });
  // Bias, not filter: a filter that is wrong returns nothing at all, whereas a
  // bias still lets a correct result through when our country context is the
  // thing that was stale. The hard country check happens below, on the result.
  if (country) qs.set('bias', `countrycode:${String(country).toLowerCase()}`);

  let res;
  try {
    res = await fetchImpl(`${BASE}?${qs}`);
  } catch (e) {
    return { ok: false, reason: `network_${e?.message || 'error'}` };
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };

  const body = await res.json();
  const all = Array.isArray(body?.results) ? body.results : [];
  const hit = all[0];
  if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) return { ok: false, reason: 'no_match' };

  const confidence = Number(hit?.rank?.confidence ?? 0);
  if (confidence < MIN_CONFIDENCE) return { ok: false, reason: 'low_confidence', confidence };

  // The Kansas check. A rival this good, this far away, means the geocoder
  // was choosing rather than identifying — and it had no way to tell us so,
  // because we used to throw the rivals away before looking at them.
  const rival = all.slice(1).find((r) =>
    Number.isFinite(r?.lat) && Number.isFinite(r?.lon)
    && Number(r?.rank?.confidence ?? 0) >= confidence - RIVAL_CONFIDENCE
    && kmBetween(hit.lat, hit.lon, r.lat, r.lon) > RIVAL_KM);
  if (rival) {
    return {
      ok: false,
      reason: 'ambiguous',
      confidence,
      // Named, because "ambiguous" is not a thing an owner can act on and
      // "did you mean Los Angeles or Wichita?" is answered in four words.
      alternatives: [hit, rival].map((r) => placeName(r)).filter(Boolean),
    };
  }

  // The country check. A street name that also exists in Ohio is the classic
  // way a geocoder returns something confident and wrong, and country is the
  // one piece of context we hold independently of what the owner typed.
  if (country && hit.country_code && String(hit.country_code).toLowerCase() !== String(country).toLowerCase()) {
    return { ok: false, reason: `wrong_country_${hit.country_code}`, confidence };
  }

  return {
    ok: true,
    lat: hit.lat,
    lng: hit.lon,
    confidence,
    formatted: hit.formatted ?? '',
    matchType: hit?.rank?.match_type ?? '',
  };
}

/**
 * What the human in the review queue reads.
 *
 * A reason code alone sends somebody to the source to find out what it means.
 * The ambiguous case in particular has to name the towns, because that turns
 * the queue item from "investigate" into one question with a four-word answer.
 */
export function noteFor(r) {
  const conf = r.confidence != null ? ` (${r.confidence})` : '';
  if (r.reason === 'ambiguous' && r.alternatives?.length) {
    return `geocode: ambiguous${conf} — this address matches ${r.alternatives.join(' and ')}. `
      + 'Ask which city before promoting.';
  }
  return `geocode: ${r.reason}${conf}`;
}

/**
 * Move `new` submissions to `geocoded`, or leave them with a note saying why not.
 *
 * Returns a small summary rather than logging, so the cron can report and the
 * tests can assert on it.
 */
export async function geocodeSweep(env, fetchImpl = fetch, limit = SWEEP_LIMIT) {
  if (!geocodeReady(env) || !env?.DB) return { ran: false, reason: 'not_connected' };

  const { results: rows = [] } = await env.DB.prepare(
    `SELECT id, name, address, country FROM num_place_submissions
      WHERE status = 'new' AND address IS NOT NULL AND length(trim(address)) > 5
      ORDER BY created_at LIMIT ?1`,
  ).bind(limit).all();

  let done = 0;
  const skipped = [];
  for (const row of rows) {
    // The business name helps far more than it hurts: "Baan Rim Pa, Kalim
    // Beach Road, Phuket" resolves where the road alone is ambiguous.
    const text = [row.name, row.address].filter(Boolean).join(', ');
    const r = await geocode(env, { text, country: row.country }, fetchImpl);

    if (!r.ok) {
      skipped.push({ id: row.id, reason: r.reason });
      // Stays `new` — a human sees it with the reason attached. Retrying a
      // vague address gets the same answer and spends another credit.
      await env.DB.prepare(
        `UPDATE num_place_submissions
            SET review_note = ?2, geo_at = datetime('now')
          WHERE id = ?1 AND status = 'new'`,
      ).bind(row.id, noteFor(r)).run();
      continue;
    }

    await env.DB.prepare(
      `UPDATE num_place_submissions
          SET lat = ?2, lng = ?3, geo_source = ?4, geo_at = datetime('now'),
              status = 'geocoded', review_note = ?5
        WHERE id = ?1 AND status = 'new'`,
    ).bind(
      row.id, r.lat, r.lng,
      `geoapify@${r.confidence.toFixed(2)}`,
      `geocoded to ${r.formatted}`.slice(0, 300),
    ).run();
    done++;
  }

  return { ran: true, seen: rows.length, geocoded: done, skipped };
}
