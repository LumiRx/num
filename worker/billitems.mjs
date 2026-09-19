/**
 * What was actually on the bill, and the venue's own list of what it sells.
 *
 * A venue can still do what it did yesterday: tap the table, type 2400, send.
 * That path is untouched and always will be — a paper-bill restaurant in
 * Bangkok has no product list and never will, and the moment itemising becomes
 * compulsory the feature stops being for them.
 *
 * What this adds is the other half: staff tap "2 × Pad Thai, 1 × Singha" off a
 * saved list, the total is the sum of those lines, and the guest sees what they
 * are paying for instead of a number with a venue's name on it.
 *
 * ── THE ONE RULE THAT MATTERS ────────────────────────────────────────────
 *
 * When a bill is itemised, the total IS the lines. There is no second field
 * where staff type a total that the lines then fail to add up to. A bill whose
 * printed items say 2,400 and whose charge says 2,600 is the thing a guest
 * disputes at the door and a manager chases a server over, and the only way to
 * make it impossible is to never store the two separately. `totalMinor()` is
 * the single source of the figure, and the caller that mints the bill passes
 * that figure and nothing else.
 *
 * ── WHY line_minor IS STORED AND NOT COMPUTED ────────────────────────────
 *
 * A product's price changes. If a bill's lines pointed at the product row,
 * raising the price of a Singha in March would silently rewrite what a guest
 * was charged in February, and every receipt ever issued would quietly become
 * wrong. So a line copies the name and the price at the moment it is added and
 * never looks at the product again. The product list is a convenience for
 * staff, never a record of anything.
 */

const MAX_ITEMS = 60;
const MAX_QTY = 999;
/** Same ceiling parseAmount uses for a whole bill: 10,000,000 minor units. */
const MAX_LINE_MINOR = 10_000_000;

const uid = (p) => `${p}_${crypto.randomUUID().slice(0, 12)}`;
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

/**
 * Turn whatever the console sent into lines we are willing to charge for.
 *
 * Strict in the same spirit as parseAmount: a line nobody can read is refused,
 * never coerced. The reason comes back naming the row, because "not a plain
 * amount" on a bill of fourteen items is not an error message, it is a puzzle.
 */
export function normaliseItems(input) {
  if (!Array.isArray(input) || !input.length) return { ok: false, reason: 'no items' };
  if (input.length > MAX_ITEMS) return { ok: false, reason: `a bill can carry ${MAX_ITEMS} lines at most` };

  const items = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] ?? {};
    const where = `line ${i + 1}`;
    const name = clip(raw.name, 80);
    if (!name) return { ok: false, reason: `${where} has no name` };

    const qty = Number(raw.qty ?? 1);
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: `${where}: how many?` };
    if (qty > MAX_QTY) return { ok: false, reason: `${where}: ${MAX_QTY} is the most of one thing` };

    // The unit price arrives as a typed string ('12.50') or as minor units from
    // a saved product. Both are accepted, neither is guessed at.
    let unit;
    if (raw.unit_minor != null) {
      unit = Number(raw.unit_minor);
      if (!Number.isInteger(unit)) return { ok: false, reason: `${where}: price is not a whole number of cents` };
    } else {
      const s = String(raw.price ?? raw.unit ?? '').trim().replace(/[, ]/g, '');
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return { ok: false, reason: `${where}: price is not a plain amount` };
      unit = Math.round(Number(s) * 100);
    }
    // Zero is allowed on a line and nowhere else: a comped dessert is a real
    // line on a real bill, and hiding it would make the printed bill disagree
    // with what the guest ate. The BILL total still has to be above zero, and
    // parseAmount enforces that when the bill is minted.
    if (!Number.isFinite(unit) || unit < 0) return { ok: false, reason: `${where}: price must not be negative` };

    const line = unit * qty;
    if (line > MAX_LINE_MINOR) return { ok: false, reason: `${where} is above the per-line ceiling` };
    items.push({ pos: i, name, qty, unit_minor: unit, line_minor: line });
  }

  const total = items.reduce((n, it) => n + it.line_minor, 0);
  if (total <= 0) return { ok: false, reason: 'the bill comes to nothing' };
  if (total > MAX_LINE_MINOR) return { ok: false, reason: 'above the per-bill ceiling' };
  return { ok: true, items, total_minor: total, total: (total / 100).toFixed(2) };
}

/** The figure the bill is minted for. The lines are the total, always. */
export function totalMinor(items) {
  return (items ?? []).reduce((n, it) => n + Number(it.line_minor || 0), 0);
}

/**
 * Write the lines against a bill token.
 *
 * Called AFTER the bill code exists, so a failure here costs the itemisation
 * and not the bill — the same reasoning as stamping a POS reference in
 * billqr.mjs. A guest can always be shown a total.
 */
export async function saveItems(env, token, items) {
  if (!env?.DB || !token || !items?.length) return { ok: false, reason: 'nothing to save' };
  const stmts = items.map((it) => env.DB.prepare(
    'INSERT INTO num_bill_items (id, token, pos, name, qty, unit_minor, line_minor) VALUES (?1,?2,?3,?4,?5,?6,?7)',
  ).bind(uid('bi'), String(token).toUpperCase(), it.pos, it.name, it.qty, it.unit_minor, it.line_minor));
  try {
    await env.DB.batch(stmts);
    return { ok: true, saved: items.length };
  } catch (e) {
    console.warn('[billitems] could not save the lines', e?.message ?? e);
    return { ok: false, reason: 'could not save the lines' };
  }
}

/**
 * The lines on a bill, or an empty list.
 *
 * Empty means "this bill is a total, as most bills are" — not an error, and
 * never a reason to refuse to show a guest their bill. The table arrives with
 * migration 0045, so this reads behind a defined fallback and the pay page
 * survives the gap between the deploy and the migration.
 */
export async function itemsFor(env, token) {
  if (!env?.DB || !token) return [];
  const out = await env.DB.prepare(
    'SELECT name, qty, unit_minor, line_minor FROM num_bill_items WHERE token = ?1 ORDER BY pos',
  ).bind(String(token).toUpperCase()).all().catch(() => null);
  return out?.results ?? [];
}

/* ── the venue's own list of what it sells ─────────────────────────────── */

export async function listProducts(env, businessId) {
  if (!env?.DB || !businessId) return [];
  const out = await env.DB.prepare(
    `SELECT id, name, price_minor, currency, sort FROM num_business_products
      WHERE business_id = ?1 AND archived_at IS NULL ORDER BY sort, name LIMIT 300`,
  ).bind(businessId).all().catch(() => null);
  return out?.results ?? [];
}

export async function addProduct(env, businessId, { name, price, priceMinor = null, currency, sort = 0 }) {
  if (!env?.DB || !businessId) return { ok: false, reason: 'missing venue' };
  const nm = clip(name, 80);
  if (!nm) return { ok: false, reason: 'what is it called?' };
  let minor = priceMinor;
  if (minor == null) {
    const s = String(price ?? '').trim().replace(/[, ]/g, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return { ok: false, reason: 'price is not a plain amount' };
    minor = Math.round(Number(s) * 100);
  }
  if (!Number.isInteger(minor) || minor < 0) return { ok: false, reason: 'price must not be negative' };
  const cur = String(currency || 'THB').toUpperCase().slice(0, 3);
  const id = uid('pr');
  await env.DB.prepare(
    'INSERT INTO num_business_products (id, business_id, name, price_minor, currency, sort) VALUES (?1,?2,?3,?4,?5,?6)',
  ).bind(id, businessId, nm, minor, cur, Number(sort) || 0).run();
  return { ok: true, id, name: nm, price_minor: minor, currency: cur };
}

/**
 * Archive, never delete.
 *
 * A product that priced a bill last month must still be findable when somebody
 * asks what that bill was — and because a line copies its name and price at the
 * time, archiving one cannot change a single figure a guest was charged.
 */
export async function archiveProduct(env, businessId, id) {
  if (!env?.DB || !businessId || !id) return { ok: false, reason: 'missing product' };
  const r = await env.DB.prepare(
    "UPDATE num_business_products SET archived_at = datetime('now') WHERE id = ?1 AND business_id = ?2 AND archived_at IS NULL",
  ).bind(String(id), businessId).run();
  return r?.meta?.changes ? { ok: true } : { ok: false, reason: 'unknown product' };
}
