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

/** How many submissions one cron tick will spend credits on. */
export const SWEEP_LIMIT = 10;

export const geocodeReady = (env) => !!env?.GEOAPIFY_KEY;

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

  const qs = new URLSearchParams({ text: q, format: 'json', limit: '1', apiKey: env.GEOAPIFY_KEY });
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
  const hit = body?.results?.[0];
  if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) return { ok: false, reason: 'no_match' };

  const confidence = Number(hit?.rank?.confidence ?? 0);
  if (confidence < MIN_CONFIDENCE) return { ok: false, reason: 'low_confidence', confidence };

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
      ).bind(row.id, `geocode: ${r.reason}${r.confidence != null ? ` (${r.confidence})` : ''}`).run();
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
