/**
 * The four-second job: a driver says where they parked.
 *
 * ── WHY THERE IS NO LOGIN ────────────────────────────────────────────────
 *
 * The person who has to act is sitting in a truck with the engine running and
 * a queue forming. Anything that takes longer than opening a bookmark and
 * tapping once will not happen, and a feature that does not happen is a pin
 * that goes stale — which this whole design exists to prevent.
 *
 * So the driver's link carries a signed token for exactly one venue, the same
 * way bookdesk.mjs's confirm links do, and the token authorises exactly one
 * verb: say where this venue is. See the note on `hereToken`.
 *
 * ── AND WHY A TEXT CAN SET THE TIME BUT USUALLY NOT THE PIN ──────────────
 *
 * A driver who texts "abbot kinney till 3" has told us two useful things and
 * not the one we need: a street name is not a coordinate, and guessing one
 * from it is how a guest ends up at the wrong end of a long road.
 *
 * So the SMS path takes what it can prove — a shared-location link has real
 * coordinates in it, and so does a pasted map URL — and when there are none it
 * records the label and the time and asks for the tap. Half an answer,
 * correctly labelled, beats a whole one that is invented.
 */

import {
  setPosition, clearPosition, positionOf, parkedNear, recentPitches,
  hereToken, hereLink, sameToken, registerMobile, coord, sayWhere,
  MIN_DWELL_MIN, MAX_DWELL_MIN, DEFAULT_DWELL_MIN,
} from './mobilevenue.mjs';
import { adminGuard } from './adminkey.mjs';

const J = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/**
 * Coordinates out of whatever a phone pasted, or null.
 *
 * Handles what people actually send: an iOS or Android "share my location"
 * link, a copied Google Maps URL, an Apple Maps URL, or a bare "34.02,-118.49"
 * typed by somebody who knows what they are doing. Anything else returns null
 * rather than a guess.
 */
export function coordsFromText(text) {
  const s = String(text ?? '');
  const tries = [
    /@(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/,          // maps.google.com/@lat,lng,17z
    /[?&](?:q|ll|sll|daddr|destination)=(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/i,
    /!3d(-?\d{1,3}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/,          // the long Google place URL
    /\b(-?\d{1,2}\.\d{4,}),\s*(-?\d{1,3}\.\d{4,})\b/,        // bare pair, typed
  ];
  for (const re of tries) {
    const m = s.match(re);
    if (m) {
      const c = coord(m[1], m[2]);
      if (c) return c;
    }
  }
  return null;
}

/**
 * How long they said, in minutes, from ordinary English.
 *
 * "till 3", "until 3pm", "for 2 hours", "90 mins". Returns null when it cannot
 * tell, and the caller uses the default rather than inventing a number — a
 * wrong expiry is a wrong answer for however long it lasts.
 */
export function minutesFromText(text, now = new Date()) {
  const s = String(text ?? '').toLowerCase();

  const forM = s.match(/\bfor\s+(\d{1,3})\s*(m|min|mins|minutes)\b/);
  if (forM) return Math.round(Number(forM[1]));
  const forH = s.match(/\bfor\s+(\d{1,2})(?:\.(\d))?\s*(h|hr|hrs|hours?)\b/);
  if (forH) return Math.round((Number(forH[1]) + (forH[2] ? Number(forH[2]) / 10 : 0)) * 60);

  const till = s.match(/\b(?:till|til|until|to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (till) {
    let h = Number(till[1]);
    const mins = till[2] ? Number(till[2]) : 0;
    const ap = till[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    // No am/pm and an hour that has already passed today reads as this
    // afternoon — "till 3" at 11am means 3pm, and nobody means 3am.
    if (!ap && h < 12 && h <= now.getHours()) h += 12;
    const end = new Date(now);
    end.setHours(h, mins, 0, 0);
    if (end <= now) end.setDate(end.getDate() + 1);
    return Math.round((end - now) / 60000);
  }
  return null;
}

/**
 * The label: what they typed, minus the URL and the time words.
 *
 * The filler is stripped only from the FRONT, one word at a time, and not
 * globally. "at" and "on" are lead-ins at the start of a message and load
 * bearing in the middle of one — strip them everywhere and "corner of Main
 * and 3rd" survives but "on the corner" becomes "the corner", while
 * "Fish on Main" becomes "Fish Main". A label is the operator's own words
 * about their own pitch, so it is left alone wherever there is any doubt.
 */
// Longest alternative first. Regex alternation is leftmost-first, so listing
// `we` before `we're` matches the bare "we", leaves "'re" behind, and the next
// pass cannot strip a fragment that starts with an apostrophe.
const LEAD = /^(?:hello|hey|hi|num|we'?re|we\s+are|were|we|i'?m|i\s+am|im|i|it'?s|its|am|is|parked|parking|park|here|at|on|in|the|now|today|tonight|currently|standing|set\s+up)\b[\s,.:;'-]*/i;

export function labelFromText(text) {
  let s = String(text ?? '')
    // A curly apostrophe is what a phone keyboard actually produces, so the
    // patterns below would miss "we're" on every real message without this.
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b(?:till|til|until|to)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, ' ')
    .replace(/\bfor\s+\d{1,3}(?:\.\d)?\s*(?:m|min|mins|minutes|h|hr|hrs|hours?)\b/gi, ' ')
    .replace(/[\s,.;-]+/g, ' ')
    .trim();
  for (let i = 0; i < 6 && LEAD.test(s); i++) s = s.replace(LEAD, '').trim();
  return s.length >= 3 ? s.slice(0, 120) : null;
}

/**
 * One text from a driver, read.
 *
 * Returns what it could prove and what it could not, so the caller can answer
 * honestly — "got it, you're on the map till 3" or "I have the time but not
 * the spot, tap this".
 */
export function readHereText(text, now = new Date()) {
  return {
    coords: coordsFromText(text),
    minutes: minutesFromText(text, now),
    label: labelFromText(text),
  };
}

export async function handleMobile(request, env, path) {
  const url = new URL(request.url);
  const post = request.method === 'POST';
  const body = post ? await request.json().catch(() => ({})) : {};

  /* ── The driver's page, and the tap ─────────────────────────────────── */

  if (path === '/here' && (post || request.method === 'GET')) {
    const placeId = String((post ? body.p : url.searchParams.get('p')) ?? '').slice(0, 120);
    const token = String((post ? body.t : url.searchParams.get('t')) ?? '').slice(0, 64);
    if (!placeId) return J({ ok: false, error: 'no_place' }, 400);
    if (!sameToken(token, await hereToken(env, placeId))) {
      return J({ ok: false, error: 'bad_link', say: 'That link is not right. Ask NUM for a new one.' }, 403);
    }

    if (!post) {
      const pos = await positionOf(env, placeId);
      return J({
        ok: true, position: pos, say: sayWhere(pos),
        bounds: { min: MIN_DWELL_MIN, max: MAX_DWELL_MIN, default: DEFAULT_DWELL_MIN },
        recent: await recentPitches(env, placeId, { limit: 5 }),
      });
    }

    if (body.done === true) {
      await clearPosition(env, placeId, { by: 'driver' });
      return J({ ok: true, say: 'Packed up. You are off the map until you park again.' });
    }

    const out = await setPosition(env, placeId, {
      lat: body.lat, lng: body.lng, accuracy: body.accuracy,
      label: body.label, minutes: body.minutes ?? DEFAULT_DWELL_MIN,
      by: 'driver', via: 'link',
    });
    if (!out.ok) {
      const says = {
        bad_coordinates: 'Your phone did not give a usable location. Try again with location turned on.',
        position_too_vague: 'Your phone is only guessing where you are, to within a kilometre or more. '
          + 'Step outside or turn on precise location and try again.',
        bad_dwell: `Give a time between ${MIN_DWELL_MIN} minutes and ${Math.round(MAX_DWELL_MIN / 60)} hours.`,
      };
      return J({ ...out, say: says[out.error] ?? 'That did not save.' }, 422);
    }
    return J({ ...out, say: `You are on the map until ${out.until.slice(11, 16)}.` });
  }

  /* ── What a guest is allowed to know ────────────────────────────────── */

  if (path === '/near' && request.method === 'GET') {
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    const km = Math.min(Math.max(Number(url.searchParams.get('km')) || 5, 0.5), 25);
    const c = coord(lat, lng);
    if (!c) return J({ error: 'lat and lng, please' }, 400);
    // Only ever the ones standing somewhere now — the expiry is in the query.
    return J({ parked: await parkedNear(env, { ...c, km }), km });
  }

  if (path === '/where' && request.method === 'GET') {
    const placeId = String(url.searchParams.get('p') ?? '').slice(0, 120);
    const pos = await positionOf(env, placeId);
    return J({ position: pos, say: sayWhere(pos) });
  }

  /* ── Ours ───────────────────────────────────────────────────────────── */

  if (path === '/register' && post) {
    const denied = adminGuard(request, env);
    if (denied) return denied;
    if (!body.place_id) return J({ ok: false, error: 'place_id' }, 400);
    const out = await registerMobile(env, body.place_id, {
      businessId: body.business_id, name: body.name, kind: body.kind || 'truck',
      homeDest: body.dest, socialUrl: body.social_url,
    });
    return J({ ...out, link: await hereLink(env, body.place_id) });
  }

  if (path === '/link' && request.method === 'GET') {
    const denied = adminGuard(request, env);
    if (denied) return denied;
    const placeId = String(url.searchParams.get('p') ?? '').slice(0, 120);
    if (!placeId) return J({ error: 'p' }, 400);
    return J({ link: await hereLink(env, placeId) });
  }

  return J({ error: `no such route: ${request.method} ${path}` }, 404);
}
