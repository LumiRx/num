/**
 * A real business NUM's directory never crawled.
 *
 * ── THE GAP ──────────────────────────────────────────────────────────────
 *
 * All three claim doors require a `places` row to exist before anything can
 * happen. `places` holds ~2.5M venues off OSM and Google, which is good
 * coverage and is not everyone — a new restaurant, a business that never made
 * a Google listing, anything the crawl missed. Those owners reach the door,
 * search their own name, find nothing, and there is no next step.
 *
 * The public `/claim/` form on the growth worker learned to handle this in
 * August (migration 0007, `num_place_submissions`). The self-serve
 * `/business/` console — the door new businesses are actually pointed at —
 * never did. This is that path, writing to the same table the review queue and
 * the geocode sweep already read, so nothing new has to be built downstream.
 *
 * ── WHY IT DOES NOT JUST CREATE THE LISTING ──────────────────────────────
 *
 * Migration 0007 sets out the reasons at length and they all still hold:
 *
 *   · `places.lat`/`lng` are NOT NULL and a typed address is not coordinates.
 *     Writing 0,0 to satisfy the constraint puts a pin in the Gulf of Guinea —
 *     and into the proximity index the concierge searches to answer "what is
 *     near me", which is the only question NUM exists to answer.
 *   · `places` is what NUM tells travellers is real, and anyone on the
 *     internet can reach this form.
 *   · Claiming proves control by messaging a contact ALREADY PUBLISHED on the
 *     listing. A self-submitted listing has no such contact — the person
 *     submitting it supplies it. That is not a reason to turn them away; it is
 *     a reason their row is treated differently until something else confirms
 *     it.
 *
 * So: their own words, kept as typed, geocoded, reviewed, and only then
 * promoted. And they are TOLD that is what is happening, because a form that
 * swallows a submission and says "thanks" is how a business concludes we did
 * nothing.
 */

/**
 * Control characters, built from a string rather than written as a literal
 * class. A literal control byte in source is invisible in every diff and every
 * review that will ever look at this line.
 */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/** Strip control characters, collapse whitespace, keep every script's letters. */
const clean = (v, n) => {
  const s = String(v ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

const cleanUrl = (v) => {
  const s = clean(v, 300);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try { return new URL(withScheme).toString().slice(0, 300); } catch { return null; }
};

const looksEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v ?? '').trim());

/**
 * What a submission must carry to be worth a human's time.
 *
 * A name alone is not a business — it is a word. Requiring an address AND a
 * way to reach them is what makes the review queue reviewable: without a
 * contact, a promoted listing has nobody behind it, which is the exact thing
 * this flow exists to avoid.
 */
export function validate(input = {}) {
  const name = clean(input.name, 120);
  const address = clean(input.address, 300);
  const email = looksEmail(input.email) ? clean(input.email, 200) : null;
  const phone = clean(input.phone, 40);
  const country = clean(input.country, 2);

  if (!name || name.length < 2) return { ok: false, error: 'What is the business called?' };
  if (!address) return { ok: false, error: 'We need the street address — it is how a traveller finds you.' };
  if (!email && !phone) {
    return { ok: false, error: 'Leave an email or a phone number, or we have no way to come back to you.' };
  }
  // A licensed trade without its licence is not a listing we can carry. Said
  // once, plainly, at the moment it can still be fixed.
  if (input.regulated && !clean(input.licence, 60)) {
    return { ok: false, error: 'A cannabis business needs its licence number before we can list it. Add the number your regulator issued you.' };
  }
  return {
    ok: true,
    value: {
      name,
      name_local: clean(input.name_local, 120),
      address,
      email,
      phone,
      website: cleanUrl(input.website),
      category: clean(input.category, 60),
      // A regulated trade declares itself here, with its licence, or it is
      // refused above. Carried into review so a person sees it before the
      // listing exists — never inferred from the category text.
      regulated: input.regulated ? 'cannabis' : null,
      licence: clean(input.licence, 60),
      dest: clean(input.dest, 40),
      country: country ? country.toUpperCase() : null,
      lang: /^[a-z]{2}$/.test(String(input.lang ?? '')) ? String(input.lang) : null,
    },
  };
}

/**
 * Self-migrating, like the rest of this codebase. A duplicate-column error is
 * the steady state, not a fault — it means the column is already there.
 *
 * `regulated` names the trade ('cannabis'); `licence` is what the regulator
 * issued. Kept on the SUBMISSION, not only on the later business row, so the
 * person reviewing the queue sees it before a listing exists at all.
 */
async function ensure(env) {
  for (const col of ['regulated TEXT', 'licence TEXT']) {
    await env.DB.prepare(`ALTER TABLE num_place_submissions ADD COLUMN ${col}`).run().catch(() => {});
  }
}

/**
 * Record it.
 *
 * Deduped on name + address rather than on name alone: two branches of the
 * same chain on different streets are two businesses, and a chain owner
 * submitting both must not be told the second is a duplicate of the first.
 * A repeat submission returns the existing row instead of an error — from the
 * owner's side, pressing the button twice is not a mistake worth a red message.
 */
export async function submit(env, input, { source = 'console' } = {}) {
  if (!env?.DB) return { ok: false, error: 'Momentarily unavailable — try again in a minute.' };
  const v = validate(input);
  if (!v.ok) return v;
  const b = v.value;
  await ensure(env);

  const existing = await env.DB.prepare(
    `SELECT id, status, place_id FROM num_place_submissions
      WHERE lower(name) = lower(?1) AND lower(COALESCE(address,'')) = lower(?2)
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(b.name, b.address).first().catch(() => null);
  if (existing) return { ok: true, id: existing.id, status: existing.status, already: true };

  const id = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await env.DB.prepare(
    `INSERT INTO num_place_submissions
       (id,name,name_local,lang,address,website,category,phone,email,country,dest,regulated,licence,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,datetime('now'))`,
  ).bind(
    id, b.name, b.name_local, b.lang, b.address, b.website, b.category,
    b.phone, b.email, b.country, b.dest, b.regulated, b.licence,
  ).run();

  // Somebody has to know. The submissions queue lives in the ops console, and
  // an unread queue is how six businesses waited three weeks in August — so
  // this raises once, when it arrives, rather than relying on anyone opening a
  // tab.
  try {
    const { alert } = await import('./health.mjs');
    await alert(env, `[biz] new business submitted (${source}): ${b.name} — ${b.address}`
      + `${b.email ? ` · ${b.email}` : ''}${b.phone ? ` · ${b.phone}` : ''}`);
  } catch { /* an alert that cannot send must not lose the submission */ }

  return { ok: true, id, status: 'new', already: false, source };
}

/**
 * Where a submission has got to, in words its owner can act on.
 *
 * Every state says what happens next and roughly when. "Pending" on its own is
 * the sentence that makes a person email to ask what pending means.
 */
export const SUBMISSION_STATE = Object.freeze({
  new: 'We have it. A person checks every new business by hand — usually within a couple of days — '
    + 'and we will email you the moment your listing is live.',
  geocoded: 'We have found you on the map and a person is reviewing the details now. '
    + 'We will email you when your listing goes live.',
  promoted: 'Your listing is live. Sign in above to manage it.',
  duplicate: 'You were already in NUM under a listing we held — we have pointed you at that one, '
    + 'which is better than a second copy. Sign in above to claim it.',
  rejected: 'We were not able to list this one. Reply to our email and a person will explain why.',
});

/** Read a submission back — used by the console to tell an owner where it stands. */
export async function statusOf(env, id) {
  if (!env?.DB || !id) return null;
  const row = await env.DB.prepare(
    'SELECT id, name, status, place_id, review_note, created_at FROM num_place_submissions WHERE id = ?1',
  ).bind(String(id)).first().catch(() => null);
  return row ? { ...row, message: SUBMISSION_STATE[row.status] ?? SUBMISSION_STATE.new } : null;
}
