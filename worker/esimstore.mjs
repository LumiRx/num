// The listing cache. Supplier catalogues are big and change slowly, so we
// fetch them on a schedule, price every plan once, and serve pages, texts
// and the concierge from D1 — never from a live supplier call per visitor.

import { priceCatalogue, plansForCountry, plansForRegion } from './esimcatalogue.mjs';

const nowIso = () => new Date().toISOString();

function rowToPlan(r) {
  return {
    provider: r.provider,
    code: r.code,
    name: r.name,
    scope: r.scope,
    countries: String(r.countries || '').split(',').filter(Boolean),
    dataMb: r.data_mb,
    unlimited: Boolean(r.unlimited),
    days: r.days,
    costUnits: r.cost_units,
    costCs: r.cost_cs,
    retailCs: r.retail_cs,
    priceCs: r.price_cs,
    activateWithinDays: r.activate_within_days,
    networks: r.networks ? String(r.networks).split('|') : [],
    topup: Boolean(r.topup),
    daily: false,
  };
}

/**
 * Pull every plan from every ready supplier, price it, store it.
 * A supplier fetch that fails or comes back suspiciously small leaves that
 * supplier's existing listing untouched — a bad night must not empty the shop.
 */
export async function refreshCatalogue(db, drivers, env = {}, { minPlans = 20 } = {}) {
  const stamp = nowIso();
  const report = [];
  for (const d of drivers) {
    if (!d.ready()) { report.push({ provider: d.id, skipped: 'not configured' }); continue; }
    const r = await d.packages({ country: '' });
    if (!r.ok) { report.push({ provider: d.id, error: r.error }); continue; }
    const priced = priceCatalogue(r.plans, env);
    if (priced.length < minPlans) { report.push({ provider: d.id, error: `only ${priced.length} sellable plans; listing left unchanged` }); continue; }
    const stmts = priced.map((p) =>
      db
        .prepare(
          `INSERT INTO num_esim_plans (provider, code, name, scope, countries, data_mb, unlimited, days, cost_units, cost_cs, retail_cs, price_cs, activate_within_days, networks, topup, refreshed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(provider, code) DO UPDATE SET name=excluded.name, scope=excluded.scope, countries=excluded.countries,
             data_mb=excluded.data_mb, unlimited=excluded.unlimited, days=excluded.days, cost_units=excluded.cost_units,
             cost_cs=excluded.cost_cs, retail_cs=excluded.retail_cs, price_cs=excluded.price_cs,
             activate_within_days=excluded.activate_within_days, networks=excluded.networks, topup=excluded.topup,
             refreshed_at=excluded.refreshed_at`,
        )
        .bind(p.provider, p.code, p.name, p.scope, `,${p.countries.join(',')},`, p.dataMb, p.unlimited ? 1 : 0, p.days, p.costUnits, p.costCs, p.retailCs, p.priceCs, p.activateWithinDays, (p.networks || []).join('|'), p.topup ? 1 : 0, stamp),
    );
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    const gone = await db.prepare('DELETE FROM num_esim_plans WHERE provider = ? AND refreshed_at < ?').bind(d.id, stamp).run();
    report.push({ provider: d.id, plans: priced.length, dropped: r.plans.length - priced.length, removed: gone.meta?.changes ?? 0 });
  }
  const countries = await rebuildCountryIndex(db, stamp);
  return { ok: report.some((x) => x.plans), at: stamp, providers: report, countries };
}

/** One row per country: cheapest plan and how many plans work there. */
export async function rebuildCountryIndex(db, stamp = nowIso()) {
  const { results } = await db.prepare('SELECT * FROM num_esim_plans').all();
  const plans = results.map(rowToPlan);
  const seen = new Set();
  for (const p of plans) for (const c of p.countries) seen.add(c);
  const stmts = [db.prepare('DELETE FROM num_esim_countries')];
  for (const c of seen) {
    const usable = plansForCountry(c, plans);
    if (!usable.length) continue;
    stmts.push(
      db.prepare('INSERT INTO num_esim_countries (country, from_cs, plans, local_plans, refreshed_at) VALUES (?,?,?,?,?)')
        .bind(c, Math.min(...usable.map((p) => p.priceCs)), usable.length, usable.filter((p) => p.scope === 'local').length, stamp),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length - 1;
}

export async function plansIn(db, { country, region } = {}) {
  if (country) {
    const c = String(country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return [];
    const { results } = await db.prepare('SELECT * FROM num_esim_plans WHERE countries LIKE ?').bind(`%,${c},%`).all();
    return plansForCountry(c, results.map(rowToPlan));
  }
  if (region) {
    const { results } = await db.prepare("SELECT * FROM num_esim_plans WHERE scope != 'local'").all();
    return plansForRegion(region, results.map(rowToPlan));
  }
  return [];
}

export async function planByCode(db, provider, code) {
  const r = await db.prepare('SELECT * FROM num_esim_plans WHERE provider = ? AND code = ?').bind(provider, code).first();
  return r ? rowToPlan(r) : null;
}

export async function countryIndex(db) {
  const { results } = await db.prepare('SELECT country, from_cs, plans, local_plans FROM num_esim_countries ORDER BY country').all();
  return results;
}

export async function countryEntry(db, country) {
  return db.prepare('SELECT country, from_cs, plans, local_plans FROM num_esim_countries WHERE country = ?').bind(String(country || '').toUpperCase()).first();
}

export async function catalogueStatus(db) {
  const plans = await db.prepare('SELECT COUNT(*) AS n, MAX(refreshed_at) AS at FROM num_esim_plans').first();
  const countries = await db.prepare('SELECT COUNT(*) AS n FROM num_esim_countries').first();
  return { plans: plans?.n ?? 0, refreshedAt: plans?.at ?? null, countries: countries?.n ?? 0 };
}
