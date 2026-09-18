/**
 * HOW THIS VENUE TAKES A BOOKING — asked once, honoured everywhere.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * Until 18 Sep 2026 the system had exactly one answer to "how does a booking
 * reach a venue", and it was `bookdesk.mjs`: text the number on the listing,
 * they tap CONFIRM or DECLINE. It is a good answer. It is not the only one,
 * and for a large and valuable class of venue it is the wrong one.
 *
 * Hugo's Restaurant in West Hollywood wrote in that day. Four sites, an
 * established reservation system, and — in their words — they "don't accept or
 * manage reservations via text message". They asked whether they could claim
 * their profile without turning text bookings on. The claim form's answer was
 * no. It should always have been yes.
 *
 * They are not an edge case. Any restaurant large enough to run OpenTable,
 * Resy, SevenRooms or Tock has a host stand, not a manager's mobile, and a
 * text to a personal phone is an actively worse experience than the one they
 * already have. The venues most worth listing are the ones the SMS-only
 * assumption turns away.
 *
 * ── AND ONE FACT THAT MAKES THIS URGENT RATHER THAN NICE ──────────────────
 *
 * `bookdesk.mjs` will not text a venue that is not in `num_sms_consent`, and
 * it fails closed when that register cannot be read. That gate is correct — it
 * is what keeps an A2P registration truthful and a TCPA exposure at zero — but
 * its consequence, today, is that NO venue has opted in and therefore NO
 * partner text has ever been sent. Every booking request in existence has been
 * worked by hand.
 *
 * So this is not a second channel added beside a working first one. Email is
 * the first channel that can actually carry a booking to a venue without a
 * human in the middle, and the SMS path stays switched off until venues opt in
 * on their own.
 *
 * ── THE FOUR ANSWERS ─────────────────────────────────────────────────────
 *
 *   sms    Text the number. Unchanged, still gated on consent.
 *   email  Email the reservations mailbox with the same signed accept and
 *          decline links the SMS carries. No login, no account, no app.
 *   own    Do not take the booking. Send the guest to the venue's own booking
 *          page with what we know already filled in, and record that we did.
 *          If we can integrate with their system properly, we will — but a
 *          handoff that works today beats an integration that might ship.
 *   none   Listed, described accurately, never sent a booking message.
 *
 * `none` is a first-class answer and is stored as one. A venue that wants to
 * be found and not messaged is a supported state, not an abandoned signup, and
 * nothing downstream may chase it as one. Treating "no" as "not yet" is how a
 * product earns the reputation the spam folder is made of.
 *
 * ── WHY place_id IS THE KEY ──────────────────────────────────────────────
 *
 * A booking request carries a `place_id` and may carry no business at all —
 * most of the directory is unclaimed, and the desk still works those by hand.
 * A business id exists only after a claim verifies. Keying on the place means
 * the channel is answerable for every venue we could ever send a booking to,
 * and `business_id` rides alongside for the claimed ones so the console can
 * find its own rows.
 *
 * This is also why multi-location works without special-casing: four Hugo's
 * sites are four places, four rows, four independent answers. The group layer
 * (bizgroup.mjs) puts one login over them; it does not merge them, because a
 * table in Studio City is not a table in West Hollywood.
 */

export const CHANNELS = Object.freeze(['sms', 'email', 'own', 'none']);

/** What we will do about a venue's own system, in order of how real it is. */
export const INTEGRATION = Object.freeze([
  'none',       // nothing known
  'handoff',    // we send the guest to their page with the details prefilled
  'requested',  // an integration has been asked for and is being worked
  'api',        // we push the booking into their system and read back an answer
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_booking_channels (
  place_id     TEXT PRIMARY KEY,
  business_id  TEXT,
  via          TEXT NOT NULL DEFAULT 'sms'
               CHECK (via IN ('sms','email','own','none')),
  sms_to       TEXT,
  email_to     TEXT,
  system_key   TEXT,
  system_name  TEXT,
  booking_url  TEXT,
  integration  TEXT NOT NULL DEFAULT 'none'
               CHECK (integration IN ('none','handoff','requested','api')),
  chosen_by    TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookchan_biz ON num_booking_channels(business_id);
CREATE INDEX IF NOT EXISTS idx_bookchan_sys ON num_booking_channels(system_key, integration);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(
    SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)),
  );
  ready = true;
}
/** Tests run many databases through one module instance. */
export function __resetReady() { ready = false; }

/**
 * Make sure the channel table exists, for a caller that JOINS it.
 *
 * bizgroup.mjs reads a site's chosen channel alongside its name, and a LEFT
 * JOIN against a table that has not been created yet fails the whole query.
 * Exported so that neighbour can guarantee the table rather than swallow the
 * error — which is the failure mode this codebase has already banned in
 * writing: a list query that answers `[]` on error reports "no locations" to a
 * business that has four.
 */
export const ensureChannels = ensure;

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

/**
 * An email address we are willing to send a booking to.
 *
 * Deliberately stricter than "contains an @". This address will be sent a
 * message containing a link that CONFIRMS A RESERVATION, so a typo is not a
 * bounced newsletter — it is a table given away to nobody, or an accept link
 * sitting in a stranger's inbox. Anything we are not sure about is refused at
 * the moment it is typed, where a human can fix it.
 */
export function bookingEmail(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s.length > 160 || /\s/.test(s)) return null;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(s) ? s : null;
}

/**
 * The venue's own booking page, normalised, or null.
 *
 * http is upgraded rather than refused — a restaurant's printed link is often
 * http and the destination almost always redirects — but anything that is not
 * a web address at all is refused, because this URL is shown to a guest as
 * "book with them here" and a broken one is worse than no link.
 */
export function bookingUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s || s.length > 400 || /\s/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  u.protocol = 'https:';
  return u.toString().slice(0, 400);
}

/**
 * Read the channel for a venue. Never invents one.
 *
 * The fallback when no row exists is `sms`, which is what every venue in the
 * directory has implicitly been on since the desk was built — and, because of
 * the consent gate, means "the desk works it by hand". It is deliberately not
 * `none`: a missing row means nobody has been asked yet, not that a venue has
 * refused, and those two are different facts.
 */
export async function channelFor(env, { placeId = null, businessId = null } = {}) {
  if (!env?.DB || (!placeId && !businessId)) return null;
  await ensure(env);
  const row = placeId
    ? await env.DB.prepare('SELECT * FROM num_booking_channels WHERE place_id = ?1')
        .bind(String(placeId)).first().catch(() => null)
    : await env.DB.prepare(
        'SELECT * FROM num_booking_channels WHERE business_id = ?1 ORDER BY updated_at DESC LIMIT 1',
      ).bind(String(businessId)).first().catch(() => null);
  if (row) return { ...row, asked: true };
  return {
    place_id: placeId, business_id: businessId,
    via: 'sms', sms_to: null, email_to: null,
    system_key: null, system_name: null, booking_url: null,
    integration: 'none',
    // The one field that is not a column. A caller that cannot tell "we asked
    // and they said text" from "nobody has ever asked" will write the first
    // into a report and mean the second.
    asked: false,
  };
}

/**
 * Record what a venue said. Returns the stored row, or an error naming the
 * field that was wrong — never a silent partial write.
 *
 * A channel that cannot work is refused rather than saved: `via:'email'` with
 * no deliverable address is a venue that believes bookings are arriving and a
 * guest who is told they were sent. That failure is silent on both ends, which
 * is the worst shape a failure can have, so it is made loud here.
 */
export async function setChannel(env, placeId, patch = {}, { businessId = null, by = null } = {}) {
  if (!env?.DB || !placeId) return { ok: false, error: 'no_place' };
  await ensure(env);

  const via = String(patch.via ?? '').trim();
  if (!CHANNELS.includes(via)) return { ok: false, error: 'bad_channel' };

  const smsTo = clip(patch.sms_to, 32);
  const mailTo = patch.email_to == null ? null : bookingEmail(patch.email_to);
  const url = patch.booking_url == null ? null : bookingUrl(patch.booking_url);

  if (patch.email_to && !mailTo) return { ok: false, error: 'bad_email' };
  if (patch.booking_url && !url) return { ok: false, error: 'bad_url' };
  if (via === 'email' && !mailTo) return { ok: false, error: 'email_required' };
  if (via === 'sms' && !smsTo) return { ok: false, error: 'phone_required' };

  // 'own' without a link is allowed on purpose. A venue frequently knows the
  // name of its system and not its own booking URL, and ressystem.mjs can
  // usually find the link from their website afterwards. Refusing here would
  // turn a true answer into a failed form.
  const integration = via === 'own'
    ? (url ? 'handoff' : 'requested')
    : 'none';

  await env.DB.prepare(
    `INSERT INTO num_booking_channels
       (place_id, business_id, via, sms_to, email_to, system_key, system_name,
        booking_url, integration, chosen_by, note, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,datetime('now'))
     ON CONFLICT(place_id) DO UPDATE SET
       business_id = COALESCE(excluded.business_id, num_booking_channels.business_id),
       via         = excluded.via,
       sms_to      = excluded.sms_to,
       email_to    = excluded.email_to,
       system_key  = COALESCE(excluded.system_key,  num_booking_channels.system_key),
       system_name = COALESCE(excluded.system_name, num_booking_channels.system_name),
       booking_url = COALESCE(excluded.booking_url, num_booking_channels.booking_url),
       integration = excluded.integration,
       chosen_by   = excluded.chosen_by,
       note        = COALESCE(excluded.note, num_booking_channels.note),
       updated_at  = datetime('now')`,
  ).bind(
    String(placeId), businessId ? String(businessId) : null, via,
    via === 'sms' ? smsTo : null,
    via === 'email' ? mailTo : mailTo,
    clip(patch.system_key, 40), clip(patch.system_name, 80), url,
    integration, clip(by, 60), clip(patch.note, 300),
  ).run();

  return { ok: true, channel: await channelFor(env, { placeId }) };
}

/**
 * Whether a venue may be sent a booking at all, and by what.
 *
 * One function so that every caller — the concierge, the desk, the host side —
 * asks the same question and gets the same answer. `reason` is always
 * populated, because "we did not send it" with no reason attached is how the
 * SMS consent gate went a month without anyone noticing it had never let a
 * single message through.
 */
export function deliverable(channel) {
  if (!channel) return { send: false, via: null, reason: 'unknown_venue' };
  switch (channel.via) {
    case 'email':
      return channel.email_to
        ? { send: true, via: 'email', to: channel.email_to, reason: 'venue chose email' }
        : { send: false, via: null, reason: 'email chosen with no address on file' };
    case 'sms':
      return channel.sms_to
        ? { send: true, via: 'sms', to: channel.sms_to, reason: 'venue chose sms' }
        : { send: false, via: null, reason: 'no number on file' };
    case 'own':
      return {
        send: false, via: 'handoff', to: channel.booking_url ?? null,
        reason: channel.booking_url
          ? 'venue books on its own system — the guest is handed the link'
          : 'venue books on its own system and we do not hold the link yet',
      };
    case 'none':
      return { send: false, via: null, reason: 'venue asked not to be sent bookings' };
    default:
      return { send: false, via: null, reason: 'no channel recorded' };
  }
}

/* ── The answer given on the claim form ──────────────────────────────────
 *
 * A claim arrives before a business exists and sometimes before a place does
 * (a venue we hold no listing for types its own name into the box). The answer
 * to "how should bookings reach you" has to survive that gap, so it is written
 * twice: onto the claim row, which always exists, and — when a listing is
 * bound — straight into the channel table, so the answer is live from the
 * moment it is given rather than from whenever a human approves the claim.
 *
 * The columns are added lazily, the way scoutintro.mjs and bizapproval.mjs add
 * theirs. `claims` is one of the oldest tables here and predates every
 * migration file in the repo; a CREATE TABLE IF NOT EXISTS would not add a
 * column to it, which is the precise reason a migration that looks applied can
 * do nothing at all.
 */
const CLAIM_COLUMNS = [
  'ALTER TABLE claims ADD COLUMN booking_via TEXT',
  'ALTER TABLE claims ADD COLUMN booking_system TEXT',
  'ALTER TABLE claims ADD COLUMN booking_url TEXT',
];
let claimColsReady = false;
async function ensureClaimColumns(env) {
  if (claimColsReady || !env?.DB) return;
  // One at a time, each swallowed: "duplicate column name" is the expected
  // result on every run after the first, and a batch would let that expected
  // error roll back the statements around it.
  for (const c of CLAIM_COLUMNS) await env.DB.prepare(c).run().catch(() => {});
  claimColsReady = true;
}

/**
 * Store what a claimant said about bookings. Never throws and never blocks a
 * signup: a business that has just filled in a form must not see it fail
 * because of a column we added this week.
 */
export async function recordClaimAnswer(env, {
  claimId = null, placeId = null, businessId = null,
  via, systemName = null, url = null, smsTo = null, emailTo = null, by = null,
} = {}) {
  if (!env?.DB) return { ok: false, error: 'no_db' };
  const choice = CHANNELS.includes(String(via)) ? String(via) : null;
  if (!choice) return { ok: false, error: 'bad_channel' };

  await ensureClaimColumns(env);
  if (claimId) {
    await env.DB.prepare(
      'UPDATE claims SET booking_via=?2, booking_system=?3, booking_url=?4 WHERE id=?1',
    ).bind(claimId, choice, clip(systemName, 80), clip(url, 400)).run().catch(() => {});
  }

  if (!placeId) return { ok: true, stored: 'claim_only' };

  // A named system gets matched against the registry so the key is recorded
  // and not only the words the owner typed. "open table", "OpenTable" and
  // "we use opentable" are one system, and a queue keyed on free text is a
  // queue with the same job in it three times.
  let systemKey = null;
  if (systemName) {
    const { SYSTEMS } = await import('./ressystem.mjs');
    const want = String(systemName).toLowerCase().replace(/[^a-z]/g, '');
    systemKey = SYSTEMS.find((s) => want.includes(s.key) || s.name.toLowerCase().replace(/[^a-z]/g, '') === want)?.key ?? null;
  }

  return setChannel(env, placeId, {
    via: choice,
    sms_to: smsTo,
    email_to: emailTo,
    system_key: systemKey,
    system_name: systemName,
    booking_url: url,
  }, { businessId, by });
}
