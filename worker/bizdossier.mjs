// One dossier per business — its own data, its own options.
//
// A signup row is a name and a phone number. What the callback actually
// needs is a DOSSIER: who they are, what kind of place they run, and two or
// three promotions that would make sense FOR THEM — a beach club and a
// bookshop should not be pitched the same offer.
//
// This runs automatically for every web signup, because research done "when
// we get to it" is research done for the first three businesses and nobody
// after. The machine walks through all of them; the human walks in with the
// dossier already open.
//
// ── Sources, and their honesty ───────────────────────────────────────────
//
// Lookup is SerpAPI (key already in the worker); the summary and promo ideas
// come from a small model call. Everything generated is stored as a DRAFT
// marked ai_generated — it is preparation for Dre's call, never something
// sent to the business unreviewed. A wrong AI promo pitched by a human who
// trusted it blindly costs a partner; the dossier says what it is.

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_biz_dossiers (
  id TEXT PRIMARY KEY,
  claim_id TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  source TEXT,
  website TEXT,
  category TEXT,
  area TEXT,
  rating REAL,
  summary TEXT,
  promos TEXT,
  raw TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * Where is this business? The UK funnel (claim-uk) is Sean's Edinburgh
 * push; everything else is the Phuket pilot. A search without a place word
 * returns the wrong "Golden Dragon" — there are hundreds.
 */
const placeHint = (source) => (/uk/i.test(source ?? '') ? 'Edinburgh UK' : 'Phuket Thailand');

/** SerpAPI lookup — the public facts: website, category, rating, address. */
async function lookup(env, name, source) {
  if (!env.SERPAPI_KEY) return null;
  try {
    const q = `${name} ${placeHint(source)}`;
    const r = await fetch(
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=5&api_key=${env.SERPAPI_KEY}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return null;
    const d = await r.json();
    const kg = d.knowledge_graph ?? {};
    const first = d.organic_results?.[0] ?? {};
    return {
      website: kg.website ?? first.link ?? null,
      category: kg.type ?? null,
      rating: kg.rating ?? null,
      address: kg.address ?? null,
      description: kg.description ?? first.snippet ?? null,
      top: (d.organic_results ?? []).slice(0, 3).map((o) => ({ title: o.title, snippet: o.snippet, link: o.link })),
    };
  } catch {
    return null;
  }
}

/**
 * The tailored part: what Num should offer THIS business. Small model, small
 * prompt, JSON out — and the output is a draft for the human call, so a
 * mediocre suggestion costs a shrug, not a partner.
 */
async function tailor(env, name, source, found) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const market = /uk/i.test(source ?? '') ? 'Edinburgh' : 'Phuket';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.NUM_RESEARCH_MODEL || 'claude-haiku-4-5',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content:
            `A business signed up to Num, a travel-concierge app in ${market}. ` +
            `Name: "${name}". What we found publicly: ${JSON.stringify(found ?? {}).slice(0, 1500)}\n\n` +
            'Reply with ONLY JSON: {"category": "<one short label>", "summary": "<2 sentences on what this business is>", ' +
            '"promos": [{"title": "<short>", "pitch": "<one sentence, specific to THIS kind of business, that a Num rep could say on a call>"}, ...exactly 3]}. ' +
            'Promos must fit a concierge that sends guests: think first-visit perks, quiet-hours offers, group/plan deals — never generic discounts.',
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = d.content?.[0]?.text ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

/**
 * The sweep: every web signup gets a dossier, three per run.
 *
 * Three, because each costs a SerpAPI credit and a model call — bounded per
 * tick, unbounded over the day. A backlog of twelve is fully dossiered
 * twenty minutes after this deploys, and after that it keeps pace with
 * signups one-for-one.
 */
export async function dossierSweep(env) {
  if (!env.DB) return { built: 0 };
  await ensure(env);

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.business_name, c.contact_name, c.phone, c.email, c.source
       FROM claims c
      WHERE NOT EXISTS (SELECT 1 FROM num_biz_dossiers d WHERE d.claim_id = CAST(c.id AS TEXT))
      ORDER BY c.created_at DESC LIMIT 3`,
  ).all().catch(() => ({ results: [] }));
  const todo = results ?? [];
  let built = 0;

  for (const c of todo) {
    // Claim the row FIRST (unique claim_id) — two overlapping crons must not
    // research the same business twice; the credits are real money.
    const id = `dos_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
    const claimed = await env.DB.prepare(
      'INSERT OR IGNORE INTO num_biz_dossiers (id, claim_id, business_name, phone, email, source) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(id, String(c.id), clip(c.business_name, 120), clip(c.phone, 30), clip(c.email, 120), clip(c.source, 80))
      .run().catch(() => null);
    if (!claimed?.meta?.changes) continue;

    const found = await lookup(env, c.business_name, c.source);
    const brain = await tailor(env, c.business_name, c.source, found);

    await env.DB.prepare(
      `UPDATE num_biz_dossiers SET
         website=?2, category=?3, area=?4, rating=?5, summary=?6, promos=?7, raw=?8,
         state=?9, updated_at=datetime('now')
       WHERE id=?1`,
    ).bind(
      id,
      clip(found?.website, 250),
      clip(brain?.category ?? found?.category, 80),
      clip(found?.address, 200),
      found?.rating ?? null,
      clip(brain?.summary, 500),
      // Marked at the field level, not in a README nobody reads: these are
      // drafts for the call, generated, unreviewed.
      brain?.promos ? JSON.stringify({ ai_generated: true, options: brain.promos }).slice(0, 2000) : null,
      found ? JSON.stringify(found).slice(0, 4000) : null,
      found || brain ? 'researched' : 'lookup_failed',
    ).run().catch((e) => console.warn('[dossier]', e?.message));
    built++;
  }

  if (built) console.log('[dossier] built', built, 'dossier(s)');
  return { built, pending: Math.max(todo.length - built, 0) };
}
