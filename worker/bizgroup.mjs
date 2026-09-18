/**
 * ONE COMPANY, SEVERAL ADDRESSES.
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────
 *
 * Every business object in this system is a single address. `places` is a
 * venue on a map. `num_business_profiles` holds one `place_id`, one address,
 * one `phone_e164`, one timezone, and its primary key is the business. A claim
 * proves control of one listing and mints a session scoped to that listing.
 *
 * That is correct, and it should stay correct: a table in Studio City is not a
 * table in West Hollywood, its hours are different, its phone is different,
 * and a booking sent to the wrong one is a guest standing outside the wrong
 * restaurant. Merging locations to make an account tidier would break the only
 * thing the model has to get right.
 *
 * What was missing is the layer above. Hugo's Restaurant asked on 18 Sep 2026
 * whether their four Los Angeles sites — two Hugo's Restaurant, two Hugo's
 * Tacos — could be managed under one business account. The honest answer was
 * that they would have been four separate claims, four sign-ins, four
 * dashboards, and no page anywhere that said the four were related.
 *
 * So: a GROUP owns sites. It does not replace them, flatten them, or hold any
 * operational data of its own. It answers exactly two questions —
 *
 *   who is allowed to manage these, and which other sites are theirs
 *
 * — and everything else stays where it already works.
 *
 * ── THE RULES, AND WHY EACH ONE IS A CONSTRAINT AND NOT A CONVENTION ─────
 *
 * 1. A SITE BELONGS TO AT MOST ONE GROUP. `business_id` is the primary key of
 *    the sites table, so the database refuses the second claim rather than
 *    leaving two groups both believing they own a restaurant. An ownership
 *    dispute that can be represented is an ownership dispute that will
 *    eventually be discovered by whichever party loses a booking.
 *
 * 2. A GROUP NEVER GRANTS ACCESS TO A SITE NOBODY PROVED. Joining a group does
 *    not claim anything. Each location is still claimed on its own evidence —
 *    a code sent to the contact published on THAT listing — and the group only
 *    links things that were separately proven. Otherwise "add a location"
 *    becomes a way to take one.
 *
 * 3. SWITCHING IS SIDEWAYS, NEVER UPWARD. `mayCross` lets a live session on
 *    site A mint a session on site B when both are in one group. It confers
 *    nothing that was not already conferred by the claim on A; it saves a
 *    manager from signing in four times. A session that never proved anything
 *    can cross nothing.
 *
 * 4. MEMBERSHIP IS AN EMAIL. That is what the sign-in link is sent to and what
 *    the person actually has. A separate identity with a password would be a
 *    second thing to lose, for a restaurant that already forgot the first.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_business_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  country     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS num_business_group_people (
  group_id    TEXT NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'manager'
              CHECK (role IN ('owner','manager','viewer')),
  added_by    TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT,
  PRIMARY KEY (group_id, email)
);

CREATE TABLE IF NOT EXISTS num_business_group_sites (
  business_id TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  place_id    TEXT,
  label       TEXT,
  added_by    TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_groupsites_group ON num_business_group_sites(group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groupsites_place
  ON num_business_group_sites(place_id) WHERE place_id IS NOT NULL;
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}
export function __resetReady() { ready = false; }

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const mail = (v) => (v ? String(v).trim().toLowerCase().slice(0, 160) : null);

export async function createGroup(env, { name, country = null, by = null } = {}) {
  if (!env?.DB) return { ok: false, error: 'no_db' };
  const n = clip(name, 120);
  if (!n) return { ok: false, error: 'no_name' };
  await ensure(env);
  const id = `grp_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
  await env.DB.prepare(
    'INSERT INTO num_business_groups (id, name, country, created_by) VALUES (?1,?2,?3,?4)',
  ).bind(id, n, clip(country, 2), clip(by, 160)).run();
  // Whoever creates it owns it. A group with no owner is a group nobody can
  // add anyone to, which is a support ticket on day one.
  if (mail(by)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO num_business_group_people (group_id, email, role, added_by) VALUES (?1,?2,'owner',?3)",
    ).bind(id, mail(by), clip(by, 160)).run().catch(() => {});
  }
  return { ok: true, id, name: n };
}

/**
 * Put a proven location into a group.
 *
 * `proven` is not decoration. The caller must pass the evidence that this
 * business was actually claimed — a verified claim or an admin acting
 * deliberately — and this refuses without it. Rule 2 above is enforced here or
 * it is not enforced anywhere, because this is the only door into the table.
 */
export async function addSite(env, groupId, { businessId, placeId = null, label = null, by = null, proven = false } = {}) {
  if (!env?.DB || !groupId || !businessId) return { ok: false, error: 'missing' };
  if (!proven) return { ok: false, error: 'not_proven' };
  await ensure(env);

  const existing = await env.DB.prepare(
    'SELECT group_id FROM num_business_group_sites WHERE business_id = ?1',
  ).bind(String(businessId)).first().catch(() => null);
  if (existing && existing.group_id !== groupId) {
    // Refused, loudly, rather than moved. A location changing hands between
    // two groups is a real event with real consequences for who sees its
    // bookings, and it deserves a person, not an UPSERT.
    return { ok: false, error: 'claimed_by_another_group', group_id: existing.group_id };
  }

  await env.DB.prepare(
    `INSERT INTO num_business_group_sites (business_id, group_id, place_id, label, added_by)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(business_id) DO UPDATE SET
       label    = COALESCE(excluded.label, num_business_group_sites.label),
       place_id = COALESCE(excluded.place_id, num_business_group_sites.place_id)`,
  ).bind(String(businessId), String(groupId), clip(placeId, 120), clip(label, 120), clip(by, 160))
    .run();
  return { ok: true };
}

export async function addPerson(env, groupId, { email, name = null, role = 'manager', by = null } = {}) {
  if (!env?.DB || !groupId) return { ok: false, error: 'missing' };
  const e = mail(email);
  if (!e || !/^[^@]+@[^@.]+(\.[^@.]+)+$/.test(e)) return { ok: false, error: 'bad_email' };
  if (!['owner', 'manager', 'viewer'].includes(role)) return { ok: false, error: 'bad_role' };
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO num_business_group_people (group_id, email, name, role, added_by)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(group_id, email) DO UPDATE SET
       role = excluded.role, name = COALESCE(excluded.name, num_business_group_people.name),
       revoked_at = NULL`,
  ).bind(String(groupId), e, clip(name, 120), role, clip(by, 160)).run();
  return { ok: true, email: e, role };
}

export async function removePerson(env, groupId, email) {
  if (!env?.DB || !groupId || !mail(email)) return { ok: false };
  await ensure(env);
  // Revoked, not deleted. "Who could see our bookings in March" is a question
  // a business will eventually ask, and a DELETE makes it unanswerable.
  await env.DB.prepare(
    "UPDATE num_business_group_people SET revoked_at = datetime('now') WHERE group_id=?1 AND email=?2",
  ).bind(String(groupId), mail(email)).run().catch(() => {});
  return { ok: true };
}

export async function groupForBusiness(env, businessId) {
  if (!env?.DB || !businessId) return null;
  await ensure(env);
  return env.DB.prepare(
    `SELECT g.* FROM num_business_group_sites s
       JOIN num_business_groups g ON g.id = s.group_id
      WHERE s.business_id = ?1`,
  ).bind(String(businessId)).first().catch(() => null);
}

export async function groupForPlace(env, placeId) {
  if (!env?.DB || !placeId) return null;
  await ensure(env);
  return env.DB.prepare(
    `SELECT g.* FROM num_business_group_sites s
       JOIN num_business_groups g ON g.id = s.group_id
      WHERE s.place_id = ?1`,
  ).bind(String(placeId)).first().catch(() => null);
}

/**
 * Every site in a group, with the one fact a switcher actually needs beside
 * the name: where it is. Four rows reading "Hugo's" are useless; "Hugo's —
 * West Hollywood" and "Hugo's Tacos — Studio City" are a menu.
 *
 * LEFT JOIN throughout on purpose. A site whose profile row has not been
 * written yet still appears, named, rather than vanishing from its owner's own
 * list because of a join they cannot see and did not cause.
 */
export async function sitesFor(env, groupId) {
  if (!env?.DB || !groupId) return [];
  await ensure(env);
  // The channel table is JOINed below and belongs to another module, so it is
  // guaranteed here rather than hoped for. See the note on the query itself.
  const { ensureChannels } = await import('./bookingchannel.mjs');
  await ensureChannels(env);
  const { results } = await env.DB.prepare(
    `SELECT s.business_id, s.place_id, s.label,
            b.name        AS business_name,
            p.city, p.area, p.address, p.vertical, p.commerce_status,
            c.via AS booking_via, c.email_to AS booking_email, c.system_name AS booking_system
       FROM num_business_group_sites s
       LEFT JOIN businesses b             ON b.id = s.business_id
       LEFT JOIN num_business_profiles p  ON p.business_id = s.business_id
       LEFT JOIN num_booking_channels c   ON c.place_id = s.place_id
      WHERE s.group_id = ?1
      ORDER BY COALESCE(s.label, b.name, s.business_id)`,
  // NOT `.catch(() => ({ results: [] }))`. A list query that answers "none" on
  // a failed read is banned in this codebase for a reason it earned: this one
  // would tell a business with four restaurants that it has none, and the page
  // would look merely empty rather than broken. A failed read must fail.
  ).bind(String(groupId)).all();
  return (results ?? []).map((r) => ({
    ...r,
    // What a human would call this site in a list of four.
    display: r.label || [r.business_name, r.area || r.city].filter(Boolean).join(' — ') || r.business_id,
  }));
}

export async function peopleFor(env, groupId) {
  if (!env?.DB || !groupId) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT email, name, role, added_at FROM num_business_group_people
      WHERE group_id = ?1 AND revoked_at IS NULL ORDER BY role, email`,
  // Same rule. "Nobody has access" is a dangerous thing to say by accident.
  ).bind(String(groupId)).all();
  return results ?? [];
}

/**
 * May a session proven on `fromPlaceId` act on `toPlaceId`?
 *
 * The whole of rule 3, in one place, so that no route has to reason about it
 * a second time and get it slightly different. Same place: yes, trivially.
 * Different places in the same group: yes. Anything else — including both
 * places being ungrouped, which would otherwise read as "two nulls match" —
 * no.
 *
 * That null case is the one worth being explicit about. `groupForPlace`
 * returns null for an unclaimed or ungrouped listing, and `null === null` is
 * true in JavaScript, so a naive equality check here would have let a session
 * on any ungrouped venue in the directory act on every other ungrouped venue
 * in the directory. That is 2.5 million venues.
 */
export async function mayCross(env, fromPlaceId, toPlaceId) {
  if (!fromPlaceId || !toPlaceId) return { ok: false, reason: 'missing_place' };
  if (String(fromPlaceId) === String(toPlaceId)) return { ok: true, reason: 'same_place' };
  const a = await groupForPlace(env, fromPlaceId);
  if (!a?.id) return { ok: false, reason: 'session place is not in a group' };
  const b = await groupForPlace(env, toPlaceId);
  if (!b?.id) return { ok: false, reason: 'target place is not in a group' };
  return a.id === b.id
    ? { ok: true, reason: 'same_group', group_id: a.id }
    : { ok: false, reason: 'different_group' };
}
