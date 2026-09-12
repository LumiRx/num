/**
 * The board: people who want a host, and hosts who want clients.
 *
 * ── THE GAP ──────────────────────────────────────────────────────────────
 *
 * Two matching paths already exist and both start from a name. `hostNearby`
 * lists hosts near a city and `hostIntro` asks ONE of them, by id. That works
 * for a traveller who already knows what a VIP host is and has picked one.
 *
 * It leaves out the two people this is meant to serve: the member who wants
 * help and does not know who to ask, and the host with an empty week who
 * cannot see that anyone nearby is asking. A member posts what they need; the
 * hosts who cover that place see it and offer.
 *
 * ── THE MEMBER IS NEVER SOLD BY BEING POSTED ─────────────────────────────
 *
 * This is a board of REQUESTS, not of people. Before a member has accepted a
 * particular host, a host sees the job and nothing that identifies the person
 * behind it: no name, no phone, no email, no street address, no member id.
 * They see a city, a rough distance, what is needed, when, for how many, and
 * how many other hosts have already offered.
 *
 * That is not squeamishness. A board that publishes a traveller's name, dates
 * and address to every host in the city is a list of empty homes, and NUM
 * would have built it. `redact()` is the only way a job reaches a host, and a
 * test walks the output for every contact field rather than trusting the
 * shape.
 *
 * ── OFFERING IS NOT WINNING ──────────────────────────────────────────────
 *
 * A host who offers has not got the client. The member chooses, exactly as in
 * `num_host_offers` today, where `host_said` and `member_said` both have to
 * be yes. A first-come-first-served board would reward whoever refreshes
 * fastest, and the person it is supposed to help would have no say at all.
 *
 * So a claim is a proposal. Several hosts may offer on the same job; the
 * member sees them and picks one; the rest are told, once, and the job closes.
 */

/** What a host can be asked for. Mirrors HOST_SERVICES in the worker. */
export const SERVICES = Object.freeze({
  car: { label: 'Getting around', hint: 'Airport runs, a driver for the day, a car when you need one.' },
  reservation: { label: 'Tables and tickets', hint: 'The restaurant that is fully booked, the show that sold out.' },
  stay: { label: 'Where to stay', hint: 'A room, a villa, an extra night when plans change.' },
  activity: { label: 'Things to do', hint: 'A guide, a boat, a class, the thing you would never find alone.' },
  appointment: { label: 'Appointments', hint: 'A doctor, a barber, a massage, a repair — booked and explained.' },
  delivery: { label: 'Fetch and deliver', hint: 'Something brought to you, or taken somewhere for you.' },
});

export const JOB_STATUS = Object.freeze(['open', 'matched', 'withdrawn', 'expired']);

/** A board is only useful if what is on it is still wanted. */
export const DEFAULT_TTL_DAYS = 14;

/**
 * A number, or null — and null is NOT zero.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious
 * one-liner turns a missing coordinate into a real point at 0,0. Its own test
 * caught what that means here: a host with no coordinates saved and a job with
 * none either both land on the same spot in the Gulf of Guinea, the distance
 * between them is zero, and that host is shown EVERY job in the world.
 *
 * The same shape of bug is written up in migration 0007 about `places.lat`.
 * It is worth being this careful twice.
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ms = (v) => {
  if (!v) return null;
  const t = Date.parse(String(v).includes('T') ? String(v) : `${String(v).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};

/** Great-circle kilometres. */
export function km(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Does this host cover where the job is?
 *
 * Coordinates decide it when both sides have them, because a radius is what a
 * host actually set. City name is the fallback and is compared
 * case-insensitively — a host who typed "bangkok" covers "Bangkok".
 *
 * A host with no areas saved covers nothing. That is not a bug to paper over:
 * `hostintegrity.mjs` already reports it as drift, and a host who sees jobs
 * they cannot reach learns to ignore the board.
 */
export function covers(job, areas) {
  const jLat = num(job?.lat);
  const jLng = num(job?.lng);
  const jCity = String(job?.city ?? '').trim().toLowerCase();
  return (areas ?? []).some((a) => {
    const aLat = num(a?.lat);
    const aLng = num(a?.lng);
    if (jLat != null && jLng != null && aLat != null && aLng != null) {
      return km(jLat, jLng, aLat, aLng) <= (num(a.radius_km) || 50);
    }
    const aCity = String(a?.city ?? '').trim().toLowerCase();
    return !!aCity && !!jCity && aCity === jCity;
  });
}

/**
 * What a host is allowed to see before the member has chosen them.
 *
 * An allowlist, never a blocklist. A delete-these-fields version stops
 * protecting anyone the day somebody adds a column.
 */
export function redact(job, { offers = 0, mine = false } = {}) {
  return {
    id: job.id,
    city: job.city ?? null,
    country: job.country ?? null,
    services: Array.isArray(job.services) ? job.services
      : (() => { try { return JSON.parse(job.services || '[]'); } catch { return []; } })(),
    detail: job.detail ?? null,
    starts_on: job.starts_on ?? null,
    party_size: job.party_size ?? null,
    // "3 hosts have already offered" changes whether it is worth writing a
    // careful reply, and it is true of the job rather than of the person.
    offers,
    // Whether THIS host has already offered. Without it the board invites the
    // same host to offer twice and looks broken when it refuses.
    offered: !!mine,
    posted_at: job.created_at ?? null,
    expires_at: job.expires_at ?? null,
  };
}

/**
 * The board for one host.
 *
 * Ordered by soonest needed, then newest. Not by distance: a job three
 * kilometres away next month is less useful than one across town on Friday,
 * and a host who covers an area has already said the distance is fine.
 */
export function boardFor(jobs, { areas = [], offers = [], now = Date.now() } = {}) {
  const mineByJob = new Map();
  for (const o of offers ?? []) mineByJob.set(o.job_id, o);
  const counts = new Map();
  for (const o of offers ?? []) counts.set(o.job_id, (counts.get(o.job_id) ?? 0) + 0);

  return (jobs ?? [])
    .filter((j) => String(j.status) === 'open')
    .filter((j) => {
      const exp = ms(j.expires_at);
      return exp == null || exp > now;
    })
    .filter((j) => covers(j, areas))
    .map((j) => redact(j, {
      offers: num(j.offer_count) ?? 0,
      mine: mineByJob.has(j.id),
    }))
    .sort((a, b) => {
      const as = ms(a.starts_on);
      const bs = ms(b.starts_on);
      if (as != null && bs != null && as !== bs) return as - bs;
      if (as != null && bs == null) return -1;
      if (as == null && bs != null) return 1;
      return (ms(b.posted_at) ?? 0) - (ms(a.posted_at) ?? 0);
    });
}

/**
 * Is this job worth posting at all?
 *
 * A city and at least one service. Without a city no host can be matched to
 * it; without a service the board fills with "help?" and hosts stop reading.
 */
export function validate(input = {}) {
  const city = String(input.city ?? '').trim().slice(0, 80);
  const services = (Array.isArray(input.services) ? input.services : [])
    .map(String).filter((s) => SERVICES[s]);
  if (!city) return { ok: false, error: 'Which city are you asking about?' };
  if (!services.length) {
    return { ok: false, error: 'Pick at least one thing you would like help with.' };
  }
  const party = Math.max(1, Math.min(Math.floor(Number(input.party_size)) || 1, 60));
  return {
    ok: true,
    value: {
      city,
      country: String(input.country ?? '').trim().slice(0, 2).toUpperCase() || null,
      services,
      detail: String(input.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) || null,
      starts_on: /^\d{4}-\d{2}-\d{2}$/.test(String(input.starts_on ?? '')) ? String(input.starts_on) : null,
      party_size: party,
      lat: num(input.lat),
      lng: num(input.lng),
    },
  };
}

/** What the member reads back about their own post. Theirs, so unredacted. */
export function mineView(job, hostOffers = []) {
  return {
    ...job,
    services: Array.isArray(job.services) ? job.services
      : (() => { try { return JSON.parse(job.services || '[]'); } catch { return []; } })(),
    // Named hosts, because this is the moment the member chooses one and a
    // choice between anonymous offers is not a choice.
    offers: hostOffers.map((h) => ({
      offer_id: h.offer_id,
      host_id: h.host_id,
      name: h.name,
      blurb: h.blurb ?? null,
      city: h.city ?? null,
      said: h.host_said ?? 'yes',
    })),
  };
}
