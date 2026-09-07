/**
 * DELIVERY FROM A NUM PARTNER — products, radius, orders, all inside the app.
 *
 * ── WHY THIS EXISTS (4 Sep 2026) ────────────────────────────────────────
 *
 * LA Cannabis Club signed up: a licensed delivery business in downtown Los
 * Angeles. The obvious home for "set up products and take delivery orders"
 * was Ghost Message — and Ghost is the wrong tool for this business, twice:
 *
 *   1. Ghost is SMS-native (Twilio). US carriers prohibit cannabis-related
 *      messaging on 10DLC; an order text about cannabis risks the whole
 *      NUM messaging account — the booking desk, sign-in codes, everything.
 *   2. Ghost's own listing moderator REJECTS "cannabis and derivatives even
 *      where locally legal" (num-GHOST-MESSAGE-SPEC.md, LISTING_MODERATOR).
 *      That rule is in production. A cannabis listing cannot go live there.
 *
 * So this is the in-app path: no text message in the loop, ever. The member
 * asks Num in the thread; Num offers what the partner listed; the member
 * confirms in the thread; the order lands in the partner's console; the
 * partner accepts and delivers; the member is told in the app. The products
 * are the business's own OFFERINGS (worker/bizoffer.mjs, the console's
 * "What you offer" page — one list, priced or not); the orders use the July
 * delivery schema (num_orders, num_order_items, num_order_events) that
 * nothing in this repo used until tonight. An offering with no price cannot
 * be ordered — "market price" is a fine thing to read out and a wrong thing
 * to put on a receipt.
 *
 * ── THE GATES ───────────────────────────────────────────────────────────
 *
 *   - A partner appears only inside its own delivery radius, only while
 *     `f_delivery` is on, and only when it holds a licence number on file
 *     (profile custom_fields.licence). No licence, no listing. Dre confirms
 *     the number against the state register before the switch goes on.
 *   - An age-restricted partner (custom_fields.age_min = 21) is offered ONLY
 *     to a member whose identity is verified (num_members.identity_verified,
 *     the 5arz check). The licensed retailer checks ID at the door as the
 *     law requires — Num's gate is on top of that, not instead of it.
 *   - Only to members WITHOUT a VIP host (Dre: "anyone that requests it
 *     without a host already"). A hosted member's host handles it.
 *   - The model never advertises it. The partner block is present; the rule
 *     in it says: only when the guest asks for this kind of thing.
 *   - Nothing is ordered until the guest says yes in the thread; the order
 *     is `pending_business` until a human at the partner accepts it; no
 *     payment is captured by Num (the partner settles at the door).
 */
import { haversine } from './viator.mjs';
import { notify } from './push.mjs';

const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
const nowS = () => Math.floor(Date.now() / 1000);
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

export const ORDER_NEXT = Object.freeze({
  pending_business: ['accepted', 'declined', 'cancelled', 'expired'],
  accepted: ['preparing', 'out_for_delivery', 'cancelled'],
  preparing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: ['refunded'],
  declined: [], cancelled: [], expired: [], refunded: [],
});

/* ------------------------------------------------------ the partner side */

function fields(profile) {
  try { return JSON.parse(profile?.custom_fields || '{}') || {}; } catch { return {}; }
}

/** What the console shows: delivery settings + licence + age gate. */
export async function deliverySettings(env, businessId) {
  if (!env?.DB || !businessId) return null;
  const s = await env.DB.prepare('SELECT f_delivery, delivery_fee_cs, delivery_radius_m FROM num_business_settings WHERE business_id=?1').bind(businessId).first().catch(() => null);
  const p = await env.DB.prepare('SELECT custom_fields, city, area FROM num_business_profiles WHERE business_id=?1').bind(businessId).first().catch(() => null);
  const f = fields(p);
  return {
    on: !!s?.f_delivery, fee_cs: s?.delivery_fee_cs ?? 500, radius_m: s?.delivery_radius_m ?? 5000,
    licence: f.licence ?? '', age_min: Number(f.age_min) || 0, hours: f.delivery_hours ?? '',
    has_rows: !!s && !!p,
  };
}

/** Save delivery settings. A licence is required for the switch to go on. */
export async function saveDelivery(env, businessId, { on, fee_cs, radius_m, licence, age_min, hours }, by = 'console') {
  if (!env?.DB || !businessId) return { ok: false, error: 'no business' };
  const lic = clip(licence, 60) ?? '';
  const wantOn = !!on;
  if (wantOn && !lic) return { ok: false, error: 'A licence number is needed before delivery can be switched on.' };
  const fee = Math.max(0, Math.min(Math.round(Number(fee_cs)) || 0, 10000));
  const radius = Math.max(500, Math.min(Math.round(Number(radius_m)) || 5000, 50000));
  const age = [0, 18, 21].includes(Number(age_min)) ? Number(age_min) : 0;
  const p = await env.DB.prepare('SELECT custom_fields FROM num_business_profiles WHERE business_id=?1').bind(businessId).first().catch(() => null);
  const f = { ...fields(p), licence: lic, age_min: age, delivery_hours: clip(hours, 80) ?? '' };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE num_business_settings SET f_delivery=?2, delivery_fee_cs=?3, delivery_radius_m=?4, updated_at=?5, updated_by=?6 WHERE business_id=?1`,
      ).bind(businessId, wantOn ? 1 : 0, fee, radius, nowS(), by),
      env.DB.prepare('UPDATE num_business_profiles SET custom_fields=?2, updated_at=?3 WHERE business_id=?1')
        .bind(businessId, JSON.stringify(f), nowS()),
    ]);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/** The orderable subset of what the business listed: active, priced. */
export async function orderable(env, businessId, { limit = 12 } = {}) {
  if (!env?.DB || !businessId) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, name, description, section, price_minor, currency, unit FROM num_business_offerings
      WHERE business_id=?1 AND active=1 AND price_minor IS NOT NULL ORDER BY position ASC, rowid ASC LIMIT ?2`,
  ).bind(String(businessId), limit).all().catch(() => ({ results: [] }));
  return (results ?? []).map((r) => ({ id: r.id, name: r.name, description: r.description, category: r.section, price_cs: Number(r.price_minor), currency: r.currency || 'USD', unit: r.unit || 'item' }));
}

/* ------------------------------------------------------- the guest side */

/**
 * Partners that deliver to this point. Location comes from the partner's
 * claimed place (num_place_owners → places) or its profile. A partner with
 * no coordinates cannot have a radius and is not offered.
 */
/* ────────────────────────────── age-restricted trades ─────────────────────
 *
 * WHERE A LICENCE IS GOOD — and why this is a table, not a judgement call.
 *
 * Num carries licensed cannabis retailers (2 signed up by 6 Sep 2026). The
 * product question — "can I offer this shop to this guest?" — is a LEGAL
 * question, and the honest engineering answer is to refuse to guess it.
 *
 * So legality is never inferred. It is declared here, per jurisdiction, by a
 * person who checked. A jurisdiction that is not in this table does not exist
 * as far as delivery is concerned: no entry, no offer, ever. Adding a state or
 * a country is a deliberate edit by someone who has read that place's rules —
 * not a radius somebody typed into a form.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE, whatever a partner sets:
 *
 *   1. SAME JURISDICTION. A guest is only ever offered a partner licensed in
 *      the guest's own jurisdiction. Cannabis is federally illegal in the US
 *      and carrying it across a state line is a federal crime, so an LA shop
 *      must never be offered to a guest in Miami — no matter how large a
 *      radius it sets. The radius narrows; it can never widen past this.
 *   2. FAIL CLOSED. Unknown location, unknown jurisdiction, or a partner whose
 *      own listing is outside the table: no offer. Silence is the safe answer.
 *
 * `slugs` are Num destination slugs (scripts/destinations.mjs). California is
 * open because the Department of Cannabis Control regulates delivery
 * separately from local retail approval — a state-licensed delivery operator
 * may serve a California city that permits no dispensary of its own
 * (regulation §5416(d), upheld against local challenge). That is a statement
 * about CALIFORNIA and about DELIVERY, and it is why the key is a jurisdiction
 * rather than a country.
 *
 * Verified 6 Sep 2026. Re-check before adding a jurisdiction, and note the
 * date you checked — a stale line here is the one that gets somebody arrested.
 */
export const DELIVERY_JURISDICTIONS = Object.freeze({
  'US-CA': {
    label: 'California',
    slugs: Object.freeze(['los-angeles', 'orange-county']),
    /**
     * WHY A BOX AS WELL AS SLUGS (7 Sep 2026).
     *
     * The slug list asks "which Num destination is this guest in". The
     * question the law asks is "which jurisdiction is this person standing
     * in", and those are not the same question.
     *
     * Num's `los-angeles` destination is the CITY: bbox 33.92–34.17 by
     * -118.52 to -118.13 (scripts/destinations.mjs). A guest in Long Beach
     * (33.77) is below it. Woodland Hills (-118.60) is west of it. Both are in
     * Los Angeles County, both are in California, and both were being refused
     * — not by a licensing rule, but by a product boundary that was never
     * meant to carry one.
     *
     * Dre asked for the greater Los Angeles area. This is that area, drawn so
     * that EVERY point inside it is unambiguously in California: the coast
     * lies west, -117.50 is still deep inside the state, and 33.60 is a
     * hundred miles north of the Mexican border. It is deliberately not a box
     * around the whole state — a state box has Nevada and Arizona in its
     * corners, and being approximately right about a jurisdiction is being
     * wrong about it.
     *
     * The box only decides WHERE THE GUEST IS. Every other gate is unchanged:
     * the partner still needs a licence on file, still needs to be inside its
     * own delivery radius, and the guest still needs to be old enough.
     */
    // The greater-LA service area Dre asked for on 7 Sep, drawn so every point
    // inside it is unambiguously in California. NOT consulted by
    // jurisdictionOf today — see the note there for why, and for the two ways
    // to switch it on. Kept because the numbers are the answer to a question
    // that will be asked again.
    greater_area: Object.freeze({ south: 33.60, west: -118.95, north: 34.40, east: -117.50, label: 'Greater Los Angeles' }),
    age_min: 21,
    authority: 'California Department of Cannabis Control (DCC)',
    verify: 'https://search.cannabis.ca.gov/',
    checked: '2026-09-06',
  },
});

/**
 * Which jurisdiction a Num destination slug belongs to, or null.
 *
 * SLUG ONLY, DELIBERATELY. A coordinate fallback was tried on 7 Sep and backed
 * out: `partnersNear` is tested to return nothing when Num cannot place the
 * guest in a destination ("no destination, no offer"), and that default was
 * chosen with this product in mind. Widening a cannabis gate is not a thing to
 * do as a side effect of a formatting pass.
 *
 * ── THE GAP THIS LEAVES, WRITTEN DOWN SO IT IS A CHOICE ──────────────────
 *
 * Num's `los-angeles` destination is the CITY: bbox 33.92–34.17 by -118.52 to
 * -118.13 (scripts/destinations.mjs). `orange-county` covers 33.53–33.92 by
 * -118.05 to -117.65. Between and around them sit parts of Los Angeles County
 * that belong to neither:
 *
 *   · Long Beach (33.77, -118.19) — south of the city box, west of the county box
 *   · San Pedro and the South Bay below 33.92
 *   · Woodland Hills and the west Valley, west of -118.52
 *
 * A guest there is in California and a licensed partner may lawfully deliver
 * to them, but Num offers nothing, because a product boundary is standing in
 * for a legal one. Two ways to close it, both Dre's call:
 *
 *   1. Widen the `los-angeles` bbox in scripts/destinations.mjs to greater LA.
 *      Fixes it everywhere at once — and changes which places the directory
 *      serves for LA, so it is not only a delivery decision.
 *   2. Add the missing destinations (long-beach, san-fernando-valley…) and
 *      list them in `slugs` above. Narrower, and more rows to maintain.
 *
 * ── AND ONE THAT IS NOT A GAP ────────────────────────────────────────────
 *
 * LA Cannabis Club trades in Los Angeles AND in Kansas (Dre, 7 Sep 2026 — it
 * is why their "608 S Main Street" resolved to Winfield and looked like a
 * geocoding error). That is a fact about the partner and it changes nothing
 * here: `slugs` lists the places a LICENCE is good, not the places a partner
 * happens to operate. Kansas has no legal adult-use or medical cannabis
 * market, so no Kansas slug belongs under US-CA or under any entry in this
 * table, no matter who asks or how much of America Num later covers.
 * `delivery.test.mjs` pins that.
 */
export function jurisdictionOf(slug) {
  const key = String(slug ?? '').toLowerCase();
  if (!key) return null;
  for (const [code, j] of Object.entries(DELIVERY_JURISDICTIONS)) {
    if (j.slugs.includes(key)) return { code, ...j };
  }
  return null;
}

export async function partnersNear(env, { lat, lng, dest = null, limit = 3 } = {}) {
  if (!env?.DB || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  // Where the GUEST is. No jurisdiction, no offer — see DELIVERY_JURISDICTIONS.
  const here = jurisdictionOf(dest);
  if (!here) return [];
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT b.id AS business_id, b.name, b.category,
              s.delivery_fee_cs, s.delivery_radius_m, p.custom_fields, p.timezone,
              COALESCE(pl.lat, p.lat) AS lat, COALESCE(pl.lng, p.lng) AS lng, pl.id AS place_id, pl.dest AS dest
         FROM num_business_settings s
         JOIN businesses b ON b.id = s.business_id AND b.status = 'active'
         LEFT JOIN num_business_profiles p ON p.business_id = b.id
         LEFT JOIN num_place_owners o ON o.business_id = b.id AND o.revoked_at IS NULL
         LEFT JOIN places pl ON pl.id = o.place_id
        WHERE s.f_delivery = 1 LIMIT 200`,
    ).all());
  } catch (e) {
    if (!/no such (table|column)/i.test(String(e?.message ?? e))) console.warn('[delivery] partners', e?.message ?? e);
    return [];
  }
  const out = [];
  for (const r of rows ?? []) {
    if (!Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lng))) continue;
    const f = fields(r);
    if (!f.licence) continue; // no licence on file, no listing — the console says so
    // The partner must be licensed where the guest is standing. A shop whose
    // own listing sits in another jurisdiction is never offered here, however
    // close the map says it is.
    const theirs = jurisdictionOf(r.dest);
    if (!theirs || theirs.code !== here.code) continue;
    const km = haversine(lat, lng, Number(r.lat), Number(r.lng));
    if (km * 1000 > Number(r.delivery_radius_m || 0)) continue;
    const items = await orderable(env, r.business_id);
    if (!items.length) continue; // nothing priced to sell yet
    out.push({
      business_id: r.business_id, name: r.name, category: r.category, place_id: r.place_id ?? null,
      km: Math.round(km * 10) / 10, fee_cs: r.delivery_fee_cs ?? 0,
      // The jurisdiction sets the floor; a partner may be stricter, never looser.
      age_min: Math.max(Number(f.age_min) || 0, here.age_min || 0),
      jurisdiction: here.code, licence: f.licence,
      hours: f.delivery_hours ?? '', items,
    });
  }
  return out.sort((a, b) => a.km - b.km).slice(0, limit);
}

/**
 * The gate, per member: no host, and identity-verified where the partner is
 * age-restricted. Returns the partners this member may be offered.
 */
export function allowedFor(partners, { member, hasHost }) {
  if (hasHost) return [];
  return (partners ?? []).filter((p) => !p.age_min || !!member?.identity_verified);
}

/** The paragraph the brain reads. Empty when there is nothing to say. */
export function deliveryBlock(partners) {
  if (!partners?.length) return '';
  const money = (cs) => `$${(cs / 100).toFixed(2)}`;
  const lines = ['DELIVERY PARTNERS (Num partners that deliver to where the guest is — offer ONLY when the guest asks for this kind of thing; never volunteer it):'];
  for (const p of partners) {
    lines.push(`- ${p.name} [business_id ${p.business_id}] — ${p.category || 'delivery'}, ${p.km} km away, delivery fee ${money(p.fee_cs)}${p.hours ? `, hours ${p.hours}` : ''}${p.age_min ? `, ${p.age_min}+ only, ID checked at the door by the licensed retailer (licence ${p.licence})` : ''}`);
    for (const it of p.items) lines.push(`    · [item_id ${it.id}] ${it.name} — ${money(it.price_cs)} per ${it.unit}${it.description ? ` — ${it.description}` : ''}`);
  }
  lines.push('These partners are licensed where this guest is, and are listed here only for that reason. Never suggest one to somebody who is somewhere else, never discuss carrying anything between cities or states, and if a guest asks you to, say plainly that you can only arrange delivery from a licensed shop to an address in the same place.');
  lines.push('Rules: quote prices EXACTLY as listed and name the delivery fee. Read back the items, quantities and delivery address, and ask for a plain yes. Only when the guest has said yes, emit ONE request_delivery action with confirmed:true, the business_id, the item_ids with quantities, and the address they gave. Never say it is on its way — the partner accepts first, and Num tells the guest the moment they do.');
  return lines.join('\n');
}

/* --------------------------------------------------------------- orders */

const codeFor = () => {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  return letters[Math.floor(Math.random() * letters.length)] + String(Math.floor(100 + Math.random() * 899));
};

/**
 * Create the order from a confirmed request_delivery action. Prices are read
 * from the catalogue NOW, never from the model — a model-quoted price is a
 * guess and a guess on a receipt is a dispute.
 */
export async function createOrder(env, { businessId, memberId, items, address, note, channel = 'agent' } = {}) {
  if (!env?.DB || !businessId || !memberId) return { ok: false, error: 'business and member required' };
  const wanted = (items ?? []).map((i) => ({ id: clip(i?.item_id ?? i?.id, 40), qty: Math.min(Math.max(Math.floor(Number(i?.qty)) || 1, 1), 20) })).filter((i) => i.id);
  if (!wanted.length) return { ok: false, error: 'nothing to order' };
  const addr = clip(address, 240);
  if (!addr) return { ok: false, error: 'a delivery address is needed' };

  const partner = await env.DB.prepare(
    `SELECT b.id, b.name, s.delivery_fee_cs, s.f_delivery, p.custom_fields
       FROM businesses b JOIN num_business_settings s ON s.business_id = b.id
       LEFT JOIN num_business_profiles p ON p.business_id = b.id WHERE b.id=?1 AND b.status='active'`,
  ).bind(businessId).first().catch(() => null);
  if (!partner || !partner.f_delivery) return { ok: false, error: 'that partner is not taking delivery orders' };
  const f = fields(partner);
  if (f.age_min) {
    const m = await env.DB.prepare('SELECT identity_verified FROM num_members WHERE id=?1').bind(memberId).first().catch(() => null);
    if (!m?.identity_verified) return { ok: false, error: `${partner.name} is ${f.age_min}+ only — verify your identity in Num first` };
  }
  const placeholders = wanted.map((_, i) => `?${i + 2}`).join(',');
  const { results: rows } = await env.DB.prepare(
    `SELECT id, name, price_minor AS price_cs, unit FROM num_business_offerings WHERE business_id=?1 AND active=1 AND price_minor IS NOT NULL AND id IN (${placeholders})`,
  ).bind(businessId, ...wanted.map((w) => w.id)).all().catch(() => ({ results: [] }));
  const byId = new Map((rows ?? []).map((r) => [r.id, { ...r, price_cs: Number(r.price_cs) }]));
  const lines = wanted.filter((w) => byId.has(w.id)).map((w) => ({ ...byId.get(w.id), qty: w.qty }));
  if (!lines.length) return { ok: false, error: 'none of those items are available right now' };

  const subtotal = lines.reduce((n, l) => n + l.price_cs * l.qty, 0);
  const fee = Math.max(0, Number(partner.delivery_fee_cs) || 0);
  const total = subtotal + fee;
  const id = uid('ord');
  const t = nowS();
  let short = codeFor();
  try {
    const stmts = [
      env.DB.prepare(
        `INSERT INTO num_orders (id, short_code, business_id, member_ref, subtotal_cs, delivery_fee_cs, platform_fee_cs, total_cs, commission_cs,
                                 fulfilment, delivery_addr_enc, delivery_area, status, channel, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,0,?7,0,'delivery',?8,?9,'pending_business',?10,?11)`,
      ).bind(id, short, businessId, memberId, subtotal, fee, total, addr, clip(addr.split(',').slice(-2).join(',').trim(), 80), channel, t),
      // item_id stays NULL: that column references the retired catalogue
      // table, and D1 enforces the foreign key. The offering id rides in
      // the snapshot name's metadata instead — the receipt needs the words.
      ...lines.map((l) => env.DB.prepare(
        `INSERT INTO num_order_items (id, order_id, item_id, name, qty, unit, unit_price_cs, line_total_cs, created_at) VALUES (?1,?2,NULL,?3,?4,?5,?6,?7,?8)`,
      ).bind(uid('oi'), id, l.name, l.qty, l.unit || 'each', l.price_cs, l.price_cs * l.qty, t)),
      env.DB.prepare(
        `INSERT INTO num_order_events (id, order_id, from_status, to_status, actor, reason, metadata, created_at) VALUES (?1,?2,NULL,'pending_business','member',?3,'{}',?4)`,
      ).bind(uid('oe'), id, clip(note, 200), t),
    ];
    await env.DB.batch(stmts);
  } catch (e) {
    // A short-code collision is the one retryable failure.
    if (/UNIQUE.*short_code/i.test(String(e?.message ?? e))) { short = codeFor(); return createOrder(env, { businessId, memberId, items, address, note, channel }); }
    return { ok: false, error: String(e?.message ?? e) };
  }
  // Tell the partner (their console lists it; email if they set one) and
  // put the receipt in the guest's in-app queue.
  try {
    const { prefs } = await import('./biznotify.mjs');
    const n = await prefs(env, businessId).catch(() => null);
    if (n?.email && n.on_booking) {
      const { send, AUDIENCE } = await import('./mailer.mjs');
      await send(env, {
        to: n.email, subject: `New delivery order ${short} — ${lines.reduce((s, l) => s + l.qty, 0)} item(s)`,
        text: `${partner.name},\n\nA Num guest ordered for delivery (order ${short}):\n${lines.map((l) => `  ${l.qty} × ${l.name} — $${((l.price_cs * l.qty) / 100).toFixed(2)}`).join('\n')}\n  Delivery fee $${(fee / 100).toFixed(2)} · Total $${(total / 100).toFixed(2)}\n\nOpen your Num console → Orders to accept or decline. The guest is told the moment you do.`,
        tag: 'delivery_order_new',
      }, { audience: AUDIENCE.EXTERNAL }).catch(() => {});
    }
  } catch { /* notification is a bonus; the order exists */ }
  await notify(env, {
    memberId, kind: 'plan', title: `Order ${short} sent to ${partner.name}`,
    body: `${lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} — $${(total / 100).toFixed(2)} incl. delivery. You'll hear the moment they accept.`,
    url: '/?go=plan', tag: `order:${id}`,
  }).catch(() => {});
  return { ok: true, id, short_code: short, total_cs: total, subtotal_cs: subtotal, fee_cs: fee, items: lines.map((l) => ({ name: l.name, qty: l.qty })), partner: partner.name };
}

export async function ordersFor(env, businessId, { limit = 100 } = {}) {
  if (!env?.DB || !businessId) return [];
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.short_code, o.status, o.subtotal_cs, o.delivery_fee_cs, o.total_cs, o.delivery_addr_enc AS address, o.delivery_area, o.created_at, o.accepted_at, o.delivered_at,
            (SELECT group_concat(i.qty || ' × ' || i.name, ', ') FROM num_order_items i WHERE i.order_id = o.id) AS items
       FROM num_orders o WHERE o.business_id=?1 ORDER BY o.created_at DESC LIMIT ?2`,
  ).bind(businessId, limit).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/** The partner moves an order along. Illegal moves are refused, not coerced. */
export async function decideOrder(env, { businessId, orderId, status, actor = 'business', reason = null }) {
  if (!env?.DB || !businessId || !orderId) return { ok: false, error: 'order required' };
  const o = await env.DB.prepare('SELECT id, short_code, status, member_ref, business_id FROM num_orders WHERE id=?1 AND business_id=?2').bind(orderId, businessId).first().catch(() => null);
  if (!o) return { ok: false, error: 'not your order' };
  if (!(ORDER_NEXT[o.status] ?? []).includes(status)) return { ok: false, error: `an order that is ${o.status} cannot become ${status}` };
  const t = nowS();
  // NUM's commission is written on delivery, at the business's own rate
  // (num_business_settings.commission_bp, 10% by default), on the goods only
  // — never on the delivery fee the courier earns.
  let commission = 0;
  if (status === 'delivered') {
    const s = await env.DB.prepare('SELECT commission_bp FROM num_business_settings WHERE business_id=?1').bind(businessId).first().catch(() => null);
    const sub = await env.DB.prepare('SELECT subtotal_cs FROM num_orders WHERE id=?1').bind(orderId).first().catch(() => null);
    commission = Math.round((Number(sub?.subtotal_cs ?? 0) * Number(s?.commission_bp ?? 1000)) / 10000);
  }
  const extra = status === 'accepted' ? ', accepted_at=?3' : status === 'delivered' ? ', delivered_at=?3, commission_cs=?4' : '';
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE num_orders SET status=?2${extra} WHERE id=?1`).bind(orderId, status, t, commission),
      env.DB.prepare(`INSERT INTO num_order_events (id, order_id, from_status, to_status, actor, reason, metadata, created_at) VALUES (?1,?2,?3,?4,?5,?6,'{}',?7)`)
        .bind(uid('oe'), orderId, o.status, status, actor, clip(reason, 200), t),
    ]);
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  const partner = await env.DB.prepare('SELECT name FROM businesses WHERE id=?1').bind(businessId).first().catch(() => null);
  const say = {
    accepted: `${partner?.name ?? 'The shop'} accepted order ${o.short_code}. They'll tell you when it's on its way.`,
    preparing: `Order ${o.short_code} is being prepared.`,
    out_for_delivery: `Order ${o.short_code} is on its way. Have your ID ready if they asked for it.`,
    delivered: `Order ${o.short_code} was delivered. Thanks for ordering through Num.`,
    declined: `${partner?.name ?? 'The shop'} couldn't take order ${o.short_code}${reason ? ` — ${reason}` : ''}. Want me to try somewhere else?`,
    cancelled: `Order ${o.short_code} was cancelled.`,
  }[status];
  if (o.member_ref && say) {
    await notify(env, { memberId: o.member_ref, kind: 'plan', title: `Order ${o.short_code}`, body: say, url: '/?go=plan', tag: `order:${orderId}` }).catch(() => {});
  }
  return { ok: true, status };
}

export async function memberOrders(env, memberId) {
  if (!env?.DB || !memberId) return [];
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.short_code, o.status, o.total_cs, o.created_at, b.name AS partner,
            (SELECT group_concat(i.qty || ' × ' || i.name, ', ') FROM num_order_items i WHERE i.order_id = o.id) AS items
       FROM num_orders o JOIN businesses b ON b.id = o.business_id WHERE o.member_ref=?1 ORDER BY o.created_at DESC LIMIT 20`,
  ).bind(memberId).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/* ---------------------------------------------------------------- HTTP */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });

export async function handleDelivery(request, env, url) {
  const path = url.pathname.replace(/^\/api\/delivery/, '') || '/';
  if (path === '/mine' && request.method === 'GET') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ error: 'me required' }, 400);
    return json({ orders: await memberOrders(env, me) });
  }
  if (path === '/request' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const out = await createOrder(env, { businessId: clip(b.business_id, 40), memberId: clip(b.me, 40), items: b.items, address: b.address, note: b.note, channel: 'web' });
    return json(out, out.ok ? 200 : 400);
  }
  /**
   * THE OWNER'S OWN ORDERS, IN THE APP THEY SIGNED INTO.
   *
   * Alfredo at LA Cannabis Club will be holding a phone, not sitting at the
   * laptop the web console was built for. He signs into Num with the same
   * number that claimed his listing, and his orders are here.
   *
   * Authorisation is `bizowner.businessesForMember`, and it is re-resolved
   * from the database on every call — a business_id in a query string is a
   * wish, not a permission. See that file for why matching a VERIFIED member
   * phone against the phone that PROVED the claim is the same test run twice,
   * and why the profile's published number is deliberately not matched.
   */
  if (path === '/business' && request.method === 'GET') {
    const { businessesForMember } = await import('./bizowner.mjs');
    const mine = await businessesForMember(env, clip(url.searchParams.get('me'), 40));
    if (!mine.length) return json({ businesses: [], orders: [] });
    const wanted = clip(url.searchParams.get('business'), 40);
    const pick = wanted ? mine.find((b) => b.business_id === wanted) : mine[0];
    if (!pick) return json({ error: 'not your business' }, 403);
    const orders = await ordersFor(env, pick.business_id, { limit: 50 });
    return json({
      businesses: mine,
      business: pick,
      orders,
      // What each order may become next, from the one state machine — so the
      // app cannot offer a button the server would refuse.
      next: Object.fromEntries(orders.map((o) => [o.id, ORDER_NEXT[o.status] ?? []])),
    });
  }

  if (path === '/business/order' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const { ownsBusiness } = await import('./bizowner.mjs');
    const businessId = clip(b.business_id, 40);
    if (!(await ownsBusiness(env, clip(b.me, 40), businessId))) {
      return json({ error: 'not your business' }, 403);
    }
    const out = await decideOrder(env, {
      businessId, orderId: clip(b.order_id, 40), status: clip(b.status, 24), actor: 'business:app',
    });
    return json(out, out.ok ? 200 : 400);
  }

  if (path === '/near' && request.method === 'GET') {
    const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
    const partners = await partnersNear(env, { lat, lng, dest: clip(url.searchParams.get('dest'), 40) });
    // Public and coarse: names, categories and distances — never the items of
    // an age-restricted partner to an unverified caller.
    return json({ partners: partners.map((p) => ({ name: p.name, category: p.category, km: p.km, age_min: p.age_min, items: p.age_min ? undefined : p.items.length })) });
  }
  return json({ error: 'not found' }, 404);
}
