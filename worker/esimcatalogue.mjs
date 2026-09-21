// The eSIM listing: supplier plans -> priced, honest, easy to choose from.
//
// Pure functions over plan arrays, so the same rules drive the web pages,
// the text-message menu and the concierge. A plan is only ever shown with a
// price the server computed from supplier cost (pricing.mjs).

import { priceFor, usd } from './esimprice.mjs';
import { continentOf } from './esimplaces.mjs';

const SCOPE_RANK = { local: 0, regional: 1, global: 2 };

/** Price every plan; drop the ones we will not sell. */
export function priceCatalogue(plans, env = {}) {
  const out = [];
  for (const p of plans || []) {
    if (!p || p.daily) continue; // per-day plans need per-day pricing; not in v1
    if (!p.unlimited && !(p.dataMb > 0)) continue;
    if (!(p.days > 0)) continue;
    const q = priceFor({ costCs: p.costCs, retailCs: p.retailCs }, env);
    if (!q.ok) continue;
    out.push({ ...p, priceCs: q.priceCs, marginCs: q.marginCs, subsidised: q.subsidised });
  }
  return out;
}

export function dataLabel(p) {
  if (p.unlimited) return 'Unlimited';
  const gb = p.dataMb / 1024;
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  return `${p.dataMb} MB`;
}

export function planLabel(p) {
  return `${dataLabel(p)} · ${p.days} day${p.days === 1 ? '' : 's'}`;
}

function sameShape(a, b) {
  return a.unlimited === b.unlimited && a.dataMb === b.dataMb && a.days === b.days && a.scope === b.scope;
}

/** Keep the cheapest of any plans that give the traveller the same thing. */
export function dedupe(plans) {
  const out = [];
  for (const p of [...plans].sort((a, b) => a.priceCs - b.priceCs)) {
    if (!out.some((q) => sameShape(p, q))) out.push(p);
  }
  return out;
}

function order(plans) {
  return plans.sort(
    (a, b) =>
      SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
      a.days - b.days ||
      (a.unlimited ? 1e9 : a.dataMb) - (b.unlimited ? 1e9 : b.dataMb) ||
      a.priceCs - b.priceCs,
  );
}

/**
 * Plans that work in a country. Local plans first; regional and global plans
 * that cover it come after, and only the ones that are not beaten on price
 * by a local plan giving at least as much.
 */
export function plansForCountry(country, priced) {
  const c = String(country || '').toUpperCase();
  const local = dedupe(priced.filter((p) => p.scope === 'local' && p.countries.includes(c)));
  const wider = dedupe(priced.filter((p) => p.scope !== 'local' && p.countries.includes(c))).filter(
    (w) => !local.some((l) => l.days >= w.days && (l.unlimited || (!w.unlimited && l.dataMb >= w.dataMb)) && l.priceCs <= w.priceCs),
  );
  return order([...local, ...wider]);
}

/** Multi-country plans for a region request ("ESIM europe"). */
export function plansForRegion(region, priced) {
  if (region === 'WORLD') return order(dedupe(priced.filter((p) => p.scope === 'global')));
  const wide = priced.filter((p) => p.scope !== 'local' && p.countries.length >= 5);
  const inRegion = wide.filter((p) => {
    const hits = p.countries.filter((c) => (region === 'ME' ? ['AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'JO', 'IL', 'EG', 'LB', 'TR', 'IQ'].includes(c) : continentOf(c) === region)).length;
    return hits / p.countries.length >= 0.6;
  });
  return order(dedupe(inRegion));
}

/**
 * Three picks for a text message: a short trip, a normal trip, a big one.
 * Distinct plans, cheapest that satisfies each need.
 */
export function picks(plans) {
  const cheapest = (pred) => [...plans].filter(pred).sort((a, b) => a.priceCs - b.priceCs)[0];
  const chosen = [];
  const add = (p) => { if (p && !chosen.includes(p)) chosen.push(p); };
  add(cheapest((p) => (p.unlimited || p.dataMb >= 1024) && p.days >= 7));
  add(cheapest((p) => (p.unlimited || p.dataMb >= 5 * 1024) && p.days >= 15 && !chosen.includes(p)));
  add(cheapest((p) => (p.unlimited || p.dataMb >= 20 * 1024) && p.days >= 30 && !chosen.includes(p)));
  for (const p of [...plans].sort((a, b) => a.priceCs - b.priceCs)) {
    if (chosen.length >= 3) break;
    add(p);
  }
  return chosen
    .slice(0, 3)
    .sort((a, b) => (a.unlimited ? 1e9 : a.dataMb) - (b.unlimited ? 1e9 : b.dataMb) || a.days - b.days);
}

export function fromPriceCs(plans) {
  return plans.length ? Math.min(...plans.map((p) => p.priceCs)) : null;
}

export function priceLabel(p) {
  return usd(p.priceCs);
}
