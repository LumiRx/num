/**
 * THE DETAILS A CONCIERGE ACTUALLY SAYS — derived from the row, never invented.
 *
 * On 3 Sep 2026 a guest asking for dinner in Bangkok got back three verified
 * places, each with a map link, a phone number, a distance in kilometres and
 * `open_now: null`, `rating: null`, `name_local: null`. Every field was
 * honest and almost none of it was USEFUL to a person standing in a street:
 * nobody thinks in "0.07 km"; nobody wants a boolean when the question is
 * "will they still be serving when I get there"; and a Thai name rendered
 * only in Latin script is a name a taxi driver cannot read.
 *
 * This turns what the directory holds into what a concierge would say —
 * and says NOTHING where the directory is silent. Every field below is
 * either present because the row proves it, or absent. There is no default,
 * no "probably", no placeholder. A concierge who fills a gap with a guess is
 * the one the guest stops trusting the first time it is wrong.
 */
import { fromHex, getBit, localSlot, WIDTH } from './hours.mjs';

/** Walking minutes from a distance, at a comfortable city pace (~80 m/min). */
export function walkMinutes(km) {
  // `Number(null)` is 0, and 0 km is "1 min walk" — so a missing distance
  // would have read as standing next door. Absent is absent.
  if (km == null || km === '') return null;
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(1, Math.round((n * 1000) / 80));
}

/**
 * "4 min walk", "15 min walk", "3.2 km" — the way a person hears distance.
 * Past twenty minutes on foot it is a taxi, and the number that matters is
 * the kilometres, not the walk nobody will take.
 */
export function distanceLabel(km) {
  if (km == null || km === '') return null;
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0) return null;
  const min = walkMinutes(n);
  if (min <= 20) return `${min} min walk`;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} km`;
}

/** Hour index → "23:00", in the venue's own local day. */
const hh = (slotHour) => `${String(slotHour % 24).padStart(2, '0')}:00`;

/**
 * Open right now, and until when — or closed, and since/until when.
 *
 *   { state: 'open',   closes: '23:00', closes_in_min: 40 }
 *   { state: 'closed', opens:  '11:00', opens_in_h: 7, day: 'tomorrow' }
 *   null  — no verified hours. Not "closed". Not "probably open". Nothing.
 *
 * `soon` is the one judgement call in this file, and it is a narrow one: a
 * venue closing inside the hour is flagged, because "closes in 40 minutes"
 * is the single most useful thing a concierge can say about dinner.
 */
export function openState(hex, tz, now = new Date()) {
  const mask = fromHex(hex);
  const slot = localSlot(tz, now);
  if (!mask || !slot) return null;
  const i0 = slot.day * 24 + slot.hour;
  if (getBit(mask, i0)) {
    let n = 0;
    while (n < WIDTH && getBit(mask, (i0 + n) % WIDTH)) n++;
    if (n >= WIDTH) return { state: 'open', always: true };
    // Minutes left in the current hour count toward "closes in".
    const minuteNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, minute: '2-digit' })
      .formatToParts(now).find((p) => p.type === 'minute')?.value ?? 0);
    const closesInMin = n * 60 - (Number.isFinite(minuteNow) ? minuteNow : 0);
    return { state: 'open', closes: hh(slot.hour + n), closes_in_min: closesInMin, soon: closesInMin <= 60 };
  }
  let n = 0;
  while (n < WIDTH && !getBit(mask, (i0 + n) % WIDTH)) n++;
  if (n >= WIDTH) return { state: 'closed', always: true };
  const opensSlot = i0 + n;
  const sameDay = Math.floor(opensSlot / 24) % 7 === slot.day;
  return {
    state: 'closed',
    opens: hh(opensSlot),
    opens_in_h: n,
    day: sameDay ? 'today' : (n < 48 ? 'tomorrow' : 'later'),
  };
}

/** One short line a card can print. Nothing when nothing is known. */
export function openLabel(s) {
  if (!s) return null;
  if (s.state === 'open') {
    if (s.always) return 'Open 24 hours';
    return s.soon ? `Open · closes ${s.closes} (${s.closes_in_min} min)` : `Open · closes ${s.closes}`;
  }
  if (s.always) return 'Closed';
  return s.day === 'today' ? `Closed · opens ${s.opens}` : `Closed · opens ${s.opens} ${s.day}`;
}

/**
 * Everything the row can honestly add to a pick. Applied after resolvePicks,
 * which already guarantees the row is verified and has a link.
 *
 * @param pick  the resolved pick (from placelink.resolvePicks)
 * @param row   the matching directory row
 * @param tz    the destination's IANA zone
 */
export function detail(pick, row, tz, now = new Date()) {
  if (!pick || !row) return pick;
  const out = { ...pick };

  const dist = distanceLabel(row.km ?? pick.km);
  if (dist) out.distance = dist;

  const st = openState(row.hours_mask, tz, now);
  if (st) {
    out.open = st;
    out.open_label = openLabel(st);
    // Keep the old boolean in step with the richer state, so nothing that
    // read `open_now` before this file existed can disagree with it.
    out.open_now = st.state === 'open';
  }

  // Rating is only meaningful with the count that earned it. "4.6" from one
  // review is a coin toss; "4.6 (2,100)" is a fact.
  const rating = Number(row.rating);
  const reviews = Number(row.reviews);
  if (Number.isFinite(rating) && rating > 0 && Number.isFinite(reviews) && reviews >= 5) {
    out.rating = Math.round(rating * 10) / 10;
    out.reviews = reviews;
  }
  // What NUM's own guests said, kept separate — it is the only number in the
  // directory that NUM learned rather than crawled.
  const nr = Number(row.num_rating);
  const nrn = Number(row.num_rating_n);
  if (Number.isFinite(nr) && nrn > 0) out.guest_rating = { score: Math.round(nr * 10) / 10, n: nrn };

  if (row.cuisine) out.cuisine = String(row.cuisine);
  if (row.name_local && row.name_local !== row.name) out.name_local = String(row.name_local);
  // A photo only when it is ours to show: the licence rides with it so a
  // client can attribute, and a photo with no licence is not shown.
  if (row.photo_url && row.photo_license) {
    out.photo = { url: String(row.photo_url), attribution: row.photo_attr ?? null, license: String(row.photo_license) };
  }
  return out;
}

/** Apply `detail` across a reply's picks, keyed by id. Never throws. */
export function enrichPicks(picks, rows, tz, now = new Date()) {
  if (!Array.isArray(picks) || !picks.length) return picks ?? [];
  const byId = new Map();
  for (const r of rows ?? []) if (r?.id != null) byId.set(String(r.id), r);
  return picks.map((p) => {
    try {
      const row = p?.id != null ? byId.get(String(p.id)) : null;
      return row ? detail(p, row, tz, now) : p;
    } catch { return p; }
  });
}
