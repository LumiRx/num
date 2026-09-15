/**
 * NUM · the traveller's pack — everything you need to get in, in one place.
 *
 * ── WHAT IS BEING SOLD, AND WHAT IS NOT ──────────────────────────────────
 *
 * This is the part to get right, because getting it wrong would make Num
 * indistinguishable from the sites the rest of this product exists to protect
 * people from.
 *
 * Num sells ASSEMBLY. The work of knowing which rules apply to this passport
 * on this date for this country, checking six sources, laying it out in the
 * order you will actually need it, and putting a deadline on each line. That
 * is real work, nobody else does it for a traveller, and charging a dollar
 * for it is honest.
 *
 * Num does NOT sell government documents, government forms, or access to
 * them. It cannot: they are free, and in several jurisdictions charging for
 * them — or presenting a paid service as if it were the official one — is
 * exactly the conduct the EU, the UK and the US have gone after copycat
 * "ETIAS" and "ESTA" sites for. The traveldocs allowlist exists because those
 * sites outrank the real government for the government's own scheme name.
 * Num must never become a better-designed version of one.
 *
 * ── SO THE RULES ARE IN THE CODE, NOT IN A POLICY DOCUMENT ───────────────
 *
 * `PACK_RULES` below is enforced by `assertSellable`, which throws. A pack
 * that would breach one of them cannot be built, let alone charged for. That
 * is deliberate: a rule written in a wiki gets forgotten in eight months by
 * somebody shipping a feature at midnight, and a rule that throws does not.
 *
 * ── AND THE FREE PATH IS NOT A LESSER PATH ───────────────────────────────
 *
 * Every item in the pack is downloadable on its own, free, always, without
 * an account. That is not a marketing concession — it is what makes the
 * paid pack honest. If the free route were slower, uglier or buried, the
 * dollar would be buying its way past an obstacle Num built, and that is a
 * different business with a worse name.
 */
import { docsFor, isOfficial, isPublicHealth, isTrustedSource } from './traveldocs.mjs';
import { vaccinesFor, SOURCES as VACCINE_SOURCES } from './vaccines.mjs';
import { insuranceFor } from './insurancereq.mjs';

/** One dollar. Held here so nothing invents a second price somewhere else. */
export const PACK_PRICE_USD = 1;

export const PACK_RULES = Object.freeze([
  'Nothing a government gives away free is ever sold, bundled into a paid item, or '
    + 'placed behind the price.',
  'Every item is available on its own, free, with no account, and the free route is '
    + 'never slower or harder to find than the paid one.',
  'Every official link is reproduced exactly as the government publishes it, and only '
    + 'from a host on the verified allowlist.',
  'Num never describes itself as a visa service, never implies it is or acts for a '
    + 'government, and never offers to submit an application on somebody’s behalf.',
  'What the dollar buys is named on the page: the assembly, the checking and the '
    + 'deadlines. Not the documents.',
  'A rule Num could not verify is shown as unverified, in the pack, in plain words.',
]);

/**
 * Item kinds, and whether each may sit behind the price.
 *
 * `free: true` is not "free for now". It is a statement that this thing
 * belongs to the traveller or to a government and was never Num's to sell.
 */
export const KIND = Object.freeze({
  OFFICIAL_LINK: { id: 'official_link', free: true, what: 'A link to a government page' },
  OFFICIAL_FORM: { id: 'official_form', free: true, what: 'A form a government publishes' },
  REQUIREMENT: { id: 'requirement', free: true, what: 'A rule, stated, with its source' },
  EMERGENCY: { id: 'emergency', free: true, what: 'Emergency numbers and the nearest hospital' },
  CONSULATE: { id: 'consulate', free: true, what: 'Their own country’s mission finder' },
  CHECKLIST: { id: 'checklist', free: false, what: 'Num’s assembled, dated checklist' },
  TIMELINE: { id: 'timeline', free: false, what: 'Num’s deadline-ordered timeline' },
  PRINTABLE: { id: 'printable', free: false, what: 'The whole pack as one printable file' },
});

/**
 * Throws if a pack would break one of the rules above.
 *
 * Called on every build, not only on the paid path, because the mistake this
 * is guarding against is a free item quietly being marked paid during a
 * refactor — which is the only way this goes wrong in practice.
 */
export function assertSellable(items) {
  for (const it of items ?? []) {
    const kind = Object.values(KIND).find((k) => k.id === it.kind);
    if (!kind) throw new Error(`travelpack: unknown item kind '${it.kind}'`);
    if (kind.free && it.paid) {
      throw new Error(
        `travelpack: '${it.title}' is a ${kind.what.toLowerCase()} and cannot be sold. `
        + 'Government material and the traveller’s own essentials are always free. '
        + 'If this needs to change, it does not.',
      );
    }
    if (it.url && !isTrustedSource(it.url) && it.kind !== 'checklist' && it.kind !== 'timeline') {
      throw new Error(`travelpack: '${it.title}' links to ${it.url}, which is on neither verified allowlist`);
    }
    // A health authority is not a government and the pack says which it is.
    // An entry DOCUMENT may only ever come from a government — WHO does not
    // issue visas, and a health source appearing under a document heading
    // would be Num blurring the exact line it protects people at.
    if (it.url && isPublicHealth(it.url)) {
      if (it.kind === KIND.OFFICIAL_FORM.id || it.kind === KIND.OFFICIAL_LINK.id) {
        throw new Error(`travelpack: '${it.title}' is a document item citing a health authority (${it.url})`);
      }
      it.sourceKind = 'public health authority';
    } else if (it.url && isOfficial(it.url)) {
      it.sourceKind = 'government';
    }
    // A scheme operator is allowed, and is allowed ONLY here — never in
    // `url`, never silently. It has to be labelled in the pack so a traveller
    // can see it is not the government, which is the whole distinction a
    // copycat site depends on people not making.
    if (it.schemeOperator && !it.schemeOperatorLabel) {
      it.schemeOperatorLabel = 'Run by the scheme’s designated operator — not a government site.';
    }
  }
  return true;
}

const daysUntil = (iso, now = new Date()) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return null;
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.ceil((then - now.getTime()) / 86400000);
};

/**
 * Build the pack for one traveller and one trip.
 *
 * Everything here is assembled from layers that already exist and already
 * carry their own honesty about what they do not know. The pack does not
 * re-state any of it more confidently than the source did — that would be the
 * easiest way to turn six careful modules into one overconfident PDF.
 */
export function buildPack({
  to = null, nationality = null, tripDate = null, from = [], now = new Date(),
} = {}) {
  const cc = String(to || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return { ok: false, why: 'no destination' };

  const items = [];
  const unverified = [];

  // ── entry documents ────────────────────────────────────────────────
  const docs = docsFor(cc);
  for (const d of docs?.docs ?? []) {
    items.push({
      kind: KIND.OFFICIAL_LINK.id,
      paid: false,
      title: d.name,
      url: d.url,
      detail: d.note ?? null,
      // Deliberately not resolved. Whether THIS traveller needs THIS document
      // depends on their passport, their purpose and their length of stay,
      // and Num can see at most one of those.
      appliesTo: 'Depends on your passport and how long you are staying — the official page decides.',
    });
  }

  // ── vaccination ────────────────────────────────────────────────────
  const vax = vaccinesFor(cc, { from });
  for (const r of vax.rules ?? []) {
    items.push({
      kind: KIND.REQUIREMENT.id,
      paid: false,
      title: r.kind === 'yellow_fever' ? 'Yellow fever certificate' : (r.what ?? 'Vaccination rule'),
      url: r.source ?? null,
      detail: r.applies === 'everyone'
        ? 'Required from every arrival.'
        : r.applies === 'from_risk'
          ? 'Required if you have been in or transited a country where yellow fever circulates.'
          : (r.detail ?? null),
      asOf: vax.asOf,
    });
    if (r.disputed) unverified.push(r.disputed);
  }
  if (vax.rules?.length) {
    items.push({
      kind: KIND.REQUIREMENT.id,
      paid: false,
      title: 'A yellow fever certificate is valid for life',
      url: null,
      detail: 'International Health Regulations Annex 7, in force since 11 July 2016. '
        + 'A booster cannot be required for entry. Clinics still say ten years; they are wrong.',
    });
    unverified.push(`The vaccination table is WHO's, published ${VACCINE_SOURCES.who_country_list.published}, `
      + 'from a survey only 36% of countries answered and no African country answered. Treat it as '
      + 'the legal baseline, not as this week’s truth.');
  }

  // ── insurance ──────────────────────────────────────────────────────
  const ins = insuranceFor(cc);
  if (ins.required === true) {
    items.push({
      kind: KIND.REQUIREMENT.id,
      paid: false,
      title: 'Travel insurance is a condition of entry',
      url: ins.source ?? null,
      // Kept in its own field, never merged into `url`. A designated scheme
      // operator is not a government, and the allowlist check below must keep
      // refusing to treat it as one — that refusal is the feature.
      schemeOperator: ins.schemeOperator ?? null,
      detail: `${ins.appliesTo} Minimum: ${ins.minimum}`,
      careful: ins.mustBeLocal ?? null,
    });
  } else if (ins.required === 'unverified') {
    unverified.push(ins.why);
  }

  // ── their own country's consular mission ───────────────────────────
  if (nationality) {
    items.push({
      kind: KIND.CONSULATE.id,
      paid: false,
      title: 'Your embassy or consulate, from your own foreign ministry',
      url: null,
      detail: 'Which mission you need depends on your passport, not on where you are standing. '
        + 'Num links your own ministry’s official directory rather than the nearest building.',
    });
  }

  // ── what the dollar actually buys ──────────────────────────────────
  const days = daysUntil(tripDate, now);
  items.push({
    kind: KIND.CHECKLIST.id,
    paid: true,
    title: 'Your checklist, in the order you will need it',
    detail: 'Every rule above, filtered to your passport and your dates, with what to bring '
      + 'and what to carry printed rather than looked up.',
  });
  items.push({
    kind: KIND.TIMELINE.id,
    paid: true,
    title: days == null ? 'Your timeline' : `Your timeline — ${days} days out`,
    detail: 'What has to be done by when. A yellow fever certificate has to be given ten days '
      + 'before you arrive; a passport renewal takes four to eight weeks; an authorisation is '
      + 'checked at the gate. The order matters more than the list.',
  });
  items.push({
    kind: KIND.PRINTABLE.id,
    paid: true,
    title: 'The whole pack as one file, for a bag or a border queue',
    detail: 'Works with no signal.',
  });

  assertSellable(items);

  return {
    ok: true,
    country: cc,
    nationality: nationality ?? null,
    tripDate: tripDate ?? null,
    daysOut: days,
    priceUsd: PACK_PRICE_USD,
    items,
    free: items.filter((i) => !i.paid),
    paid: items.filter((i) => i.paid),
    unverified,
    rules: PACK_RULES,
    // The sentence that has to be on the page. Not a disclaimer at the bottom
    // — the thing that makes the offer honest, said where the price is.
    promise: 'Every document here is free and comes straight from the government. '
      + `The $${PACK_PRICE_USD} is for putting it together, checking it and dating it. `
      + 'Download any of it on its own, free, any time — no account. '
      + 'Num is not a visa service and cannot apply for anything on your behalf.',
  };
}

/** GET /api/travel/pack?to=TH&nationality=US&date=2026-12-01&from=BR */
export function handlePack(request) {
  const url = new URL(request.url);
  const to = url.searchParams.get('to') || '';
  const nationality = url.searchParams.get('nationality') || null;
  const tripDate = url.searchParams.get('date') || null;
  const from = (url.searchParams.get('from') || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!/^[A-Za-z]{2}$/.test(to)) {
    return new Response(JSON.stringify({ error: 'to must be a two-letter country code' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  let pack;
  try {
    pack = buildPack({ to, nationality, tripDate, from });
  } catch (err) {
    // assertSellable threw. That is a bug in Num, not a bad request, and it
    // must be loud — a pack that silently drops the offending item would be
    // the failure this whole file exists to prevent.
    return new Response(JSON.stringify({ error: 'pack refused', why: String(err.message) }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(pack), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
  });
}
