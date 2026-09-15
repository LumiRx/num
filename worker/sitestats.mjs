/**
 * NUM · the numbers on the website, counted rather than remembered.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The homepage said "more than half a million" places. The directory holds
 * 2,701,320. Other pages still said "77 destinations" when 104 are live. A
 * number typed into HTML is true on the day it is typed and slowly stops
 * being true after that, in whichever direction nobody is watching — and
 * here it drifted DOWNWARD, so Num has spent months underselling itself by
 * a factor of five.
 *
 * So the counts come from the database, on a schedule, and the page reads
 * them. Nobody types a number into a marketing page again.
 *
 * ── THE PART THAT MATTERS MORE THAN THE COUNTING ─────────────────────────
 *
 * Every stat here carries the LABEL of what it actually counts, and the two
 * travel together and cannot be separated. That is not bureaucracy. It is
 * the difference between a claim that survives a journalist, an investor's
 * diligence, or a regulator, and one that does not:
 *
 *   · 2,701,320 PLACES IN A DIRECTORY is true, verifiable, and genuinely
 *     impressive.
 *   · "2.7 million businesses on Num" would be false. SIX businesses have an
 *     account. Three places are claimed by their owner.
 *
 * Those two sentences describe the same database and only one of them can be
 * published. `assertLabelled` below refuses to emit a stat whose label does
 * not match its source, so the wrong one cannot reach a page by accident
 * during a redesign at midnight.
 *
 * ── AND WHY THE HONEST NUMBER IS THE BIGGER ONE ──────────────────────────
 *
 * Worth saying plainly, because it is the whole argument: telling the truth
 * here RAISES every number on the site. 2.7M beats "half a million". 104
 * destinations beats 77. The only figure honesty costs us is a business
 * count nobody was claiming yet.
 */

/**
 * What each stat counts, in words a stranger would accept.
 *
 * `claim` is the sentence the site is allowed to build. `never` is the
 * sentence it is not — written down because the tempting wrong version is
 * always one word away from the right one.
 */
export const STATS = Object.freeze({
  places: {
    sql: 'SELECT COUNT(*) AS n FROM places',
    label: 'places in the directory',
    claim: 'places Num can look up and talk about',
    never: 'businesses on Num, partners, or customers — a directory listing is '
      + 'not a relationship, and the overwhelming majority of these places have '
      + 'never heard of us.',
  },
  countries: {
    sql: 'SELECT COUNT(DISTINCT country) AS n FROM places WHERE country IS NOT NULL',
    label: 'countries covered',
    showFrom: 10,
    claim: 'countries with places in the directory',
    never: 'countries Num operates in as a business, or has a licence in.',
  },
  destinations: {
    sql: 'SELECT COUNT(DISTINCT dest) AS n FROM places WHERE dest IS NOT NULL',
    label: 'destinations live',
    showFrom: 10,
    claim: 'destinations Num covers properly enough to plan a day in',
    never: 'cities Num has staff or partners in.',
  },
  members: {
    sql: 'SELECT COUNT(*) AS n FROM num_members',
    label: 'members',
    claim: 'people who have created a Num account',
    never: 'active users, monthly actives, or customers. Most have never come back.',
  },
  businesses: {
    sql: 'SELECT COUNT(*) AS n FROM businesses',
    label: 'businesses with an account',
    claim: 'businesses that have signed up',
    never: 'anything drawn from the places table. These are two different '
      + 'numbers four orders of magnitude apart.',
  },
  claimed: {
    sql: "SELECT COUNT(*) AS n FROM places WHERE status <> 'unclaimed'",
    label: 'places claimed by their owner',
    claim: 'places whose owner has claimed the listing',
    never: 'verified places. Claimed means somebody said it is theirs.',
  },
  emergency_countries: {
    // Not from the database — from the checked table in emergency.mjs. It is
    // here because it is the most trustworthy number Num has and the site
    // does not use it at all.
    label: 'countries with verified emergency numbers',
    claim: 'countries where Num holds a checked emergency number rather than a guess',
    never: 'countries Num provides emergency services in.',
  },
  entry_countries: {
    label: 'countries with entry-document rules on file',
    claim: 'countries whose entry documents Num links from the government’s own page',
    never: 'countries Num can get you a visa for. Num is not a visa service.',
  },
});

/**
 * A stat may not leave this module without the label of what it counts.
 *
 * Throws rather than returning a bare number, because a bare number is
 * exactly what gets pasted into a headline next to the wrong noun.
 */
export function assertLabelled(rows) {
  for (const [key, value] of Object.entries(rows ?? {})) {
    const def = STATS[key];
    if (!def) throw new Error(`sitestats: '${key}' is not a defined stat`);
    if (typeof value?.n !== 'number' || !Number.isFinite(value.n)) {
      throw new Error(`sitestats: '${key}' has no finite count`);
    }
    if (value.label !== def.label) {
      throw new Error(
        `sitestats: '${key}' is labelled '${value.label}' but counts ${def.label}. `
        + `It must never be published as: ${def.never}`,
      );
    }
  }
  return true;
}

/** Round DOWN to a friendly figure. Never up — rounding up is inventing. */
export function friendly(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1_000_000) {
    const m = Math.floor(n / 100_000) / 10;
    return `${m}M+`;
  }
  if (n >= 10_000) return `${Math.floor(n / 1_000)}k+`;
  if (n >= 1_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}k+`;
  return String(n);
}

/**
 * Should this number go on a marketing page at all?
 *
 * A count in single or low double digits is not a proof point, it is an
 * admission — and putting "6 businesses" in a stat strip is worse for Num
 * than showing no business stat. So small numbers are returned to the caller
 * with `show: false` rather than being quietly inflated to something rounder.
 */
export const SHOW_FROM = 100;

/**
 * The threshold is PER STAT, because "impressive" is not a single magnitude.
 *
 * Thirty-eight countries is a strong number. Six businesses is not, and the
 * two are three tiles apart on the same strip. A single global cut-off either
 * hides the countries or shows the businesses, and both are wrong — so each
 * stat carries its own floor and the default only applies where none is set.
 */
export const showFloor = (key) => STATS[key]?.showFrom ?? SHOW_FROM;

export async function collect(env, { now = new Date() } = {}) {
  const out = {};
  if (!env?.DB) return { ok: false, why: 'no database', stats: {} };

  for (const [key, def] of Object.entries(STATS)) {
    if (!def.sql) continue;
    try {
      const row = await env.DB.prepare(def.sql).first();
      const n = Number(row?.n);
      if (!Number.isFinite(n)) continue;
      out[key] = {
        n,
        label: def.label,
        claim: def.claim,
        friendly: friendly(n),
        show: n >= showFloor(key),
      };
    } catch {
      // A count that will not run is left out. A stat strip missing one tile
      // is a smaller problem than a tile showing zero because a query failed.
    }
  }

  // The two counted in code rather than in the database.
  try {
    const { EMERGENCY } = await import('./emergency.mjs');
    const n = Object.keys(EMERGENCY ?? {}).length;
    if (n) {
      out.emergency_countries = {
        n,
        label: STATS.emergency_countries.label,
        claim: STATS.emergency_countries.claim,
        friendly: String(n),
        show: true,
      };
    }
  } catch { /* module shape changed; drop the tile rather than guess */ }

  try {
    const { COVERED } = await import('./traveldocs.mjs');
    const n = Array.isArray(COVERED) ? COVERED.length : Object.keys(COVERED ?? {}).length;
    if (n) {
      out.entry_countries = {
        n,
        label: STATS.entry_countries.label,
        claim: STATS.entry_countries.claim,
        friendly: String(n),
        show: true,
      };
    }
  } catch { /* same */ }

  assertLabelled(out);
  return { ok: true, at: now.toISOString(), stats: out };
}

/**
 * GET /api/site/stats
 *
 * Cached for an hour at the edge. These numbers move by a few thousand a
 * week at most, and a homepage that queries a 2.7-million-row table on every
 * visit is a homepage that gets slower the more successful it is.
 */
export async function handleSiteStats(request, env) {
  const result = await collect(env);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 503,
    headers: {
      'content-type': 'application/json',
      'cache-control': result.ok ? 'public, max-age=3600, s-maxage=3600' : 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
