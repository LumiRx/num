/**
 * DEEP RESEARCH — the long answer, and the first thing NUM sells by volume.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * `deep_research_monthly` has been in the tier table since memberships
 * shipped: 3 a month free, 40 on Plus, unlimited on Pro. It is the headline
 * difference between the three plans and the main reason to pay. On 18 Sep
 * 2026 an audit of the feature registry found it appeared in exactly two
 * files — the table that sells it and the card that displays it. There was no
 * implementation anywhere in the repository. NUM was charging for a feature
 * that had never been built.
 *
 * This is the feature.
 *
 * ── What makes it deep, and not just slow ────────────────────────────────
 *
 * An ordinary turn answers one question from one gather in a few seconds:
 * "where should we eat tonight" → ten candidates → three picks. That shape
 * cannot answer the questions people actually arrive with:
 *
 *   "Compare Ari, Thonglor and Ekkamai for a month of working remotely —
 *    noise, cafés, what it costs, how long to Sathorn in the morning."
 *   "Three days in Phuket with a five-year-old and a grandmother who can't
 *    walk far."
 *   "Dinner for eight on Saturday at nine, two vegans, one who hates
 *    seafood, fifteen minutes from Sukhumvit 24."
 *
 * Each is several questions wearing one coat, and each carries constraints
 * that DISQUALIFY rather than rank. So this runs a different shape:
 *
 *   1. DECOMPOSE — one model call turns the brief into up to four concrete
 *      sub-questions and a list of hard constraints, separated from soft
 *      preferences. A constraint is a thing that makes a place wrong, not a
 *      thing that makes it less good.
 *   2. GATHER — each sub-question pulls real candidates from NUM's own
 *      directory, in parallel, through the same ranking the concierge uses.
 *      Nothing is invented here and nothing is fetched from the open web.
 *   3. WRITE — one model call answers the brief using only those candidates,
 *      and must say plainly where a constraint could not be met.
 *   4. VERIFY — every place named in the answer is checked back against the
 *      candidate set. A name that was not in the evidence is struck out
 *      before a guest ever sees it. See `verify()` below; this is the step
 *      that makes the output worth paying for.
 *
 * Two model calls and N data calls, bounded. Thirty to ninety seconds, which
 * is why it does not happen on the guest's turn.
 *
 * ── Why metering this is lawful, and the bit a lawyer should still read ──
 *
 * membership.mjs explains at length why travel benefits can never sit behind
 * a price: B&P §17550.27 turns a paid plan carrying travel benefits "not made
 * generally available to the public" into a seller-of-travel discount
 * programme, which NUM cannot comply with at any price. flight_search,
 * priority_queue and concierge_booking are permanently ungated for exactly
 * that reason.
 *
 * Deep research is metered rather than gated, and the distinction is the
 * whole argument: THE FREE TIER HAS IT. Three a month, for everybody, with no
 * trial and no card. What Plus and Pro buy is volume, the way a phone plan
 * sells minutes rather than the right to make calls. The benefit is generally
 * available; the quantity differs. That is the same structure as `plans_max`
 * and it is why `deep_research_monthly` was left out of UNGATED when the
 * others went in.
 *
 * It is NOT a lawyer's opinion. If anyone ever proposes taking the free
 * allowance to zero, that single change is what would convert this from a
 * metered feature into a gated travel benefit, and it must not be made
 * without advice. The floor is load-bearing, and `assertFreeFloor()` below
 * refuses to run without it.
 *
 * ── The honesty rules, which outrank the output ──────────────────────────
 *
 *   · Never name a place that is not in the evidence. Verified, not trusted.
 *   · A constraint that could not be met is said out loud, not quietly
 *     dropped. "Nothing here seats eight at nine on a Saturday" is a good
 *     answer; eight seats invented at a place that has four is not.
 *   · A run that fails costs the member nothing. `countUse` is called after
 *     the work succeeded, never before it started.
 */
import { may, countUse, tiers } from './membership.mjs';
import { callProse, chain } from './brains.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Bounds. Every one of these is a cost ceiling, not a taste. */
export const LIMITS = Object.freeze({
  maxQuestions: 4,       // sub-questions per brief
  candidatesEach: 12,    // rows gathered per sub-question
  briefChars: 600,       // what a guest can type
  answerTokens: 1200,    // the written answer
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_research (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  brief TEXT NOT NULL,
  dest TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  questions TEXT,
  constraints TEXT,
  evidence TEXT,
  answer TEXT,
  unmet TEXT,
  brain TEXT,
  ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_member ON num_research(member_id, created_at DESC);
`;
const ready = new WeakSet();
async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready.add(env.DB);
}

/**
 * The free allowance must stay above zero. See the §17550.27 note above: a
 * free tier of 3 is what keeps this a metered feature rather than a travel
 * benefit sold only to subscribers. MEMBERSHIP_TIERS can move prices and
 * limits from a dashboard with no deploy and no review, so the floor is
 * checked at run time rather than trusted to a constant.
 */
export function assertFreeFloor(env) {
  const free = tiers(env)?.free?.entitlements?.deep_research_monthly;
  // null means unlimited, which is more than enough.
  if (free === null || (typeof free === 'number' && free > 0)) return true;
  console.error('[research] free allowance is 0 — refusing to run; see B&P §17550.27 in membership.mjs');
  return false;
}

/**
 * The best brain that `callProse` can actually reach.
 *
 * The kind filter is not a preference, it is the only thing that works.
 * `callProse` handles workers-ai and openai-compatible and then throws
 * `has no prose path` — it has no Anthropic branch at all, by design, so that
 * background work can never quietly spend the Claude balance the product
 * needs to serve guests (see the header of consensus.mjs).
 *
 * The first version of this function preferred Anthropic, on the reasoning
 * that research is a paid, guest-facing answer and should get the best brain
 * available. Every run failed in 286ms with that exact error. Preference
 * cannot beat a code path that does not exist; BRAINS is already in priority
 * order, so taking the first reachable one gives the strongest brain that can
 * genuinely answer.
 */
export const PROSE_KINDS = Object.freeze(['openai-compatible', 'workers-ai']);

/**
 * Every brain that could serve prose, in the product's own priority order —
 * not one brain, a LIST.
 *
 * This returned a single brain until 18 Sep 2026 and deep research failed on
 * two consecutive releases for two different reasons, both of which a list
 * would have survived:
 *
 *   · it preferred Anthropic, and callProse has no Anthropic path — it
 *     handles workers-ai and openai-compatible and then throws, deliberately,
 *     so background work cannot spend the Claude balance guests need;
 *   · it then took the first reachable brain, which is `openai`, and
 *     callProse sends `reasoning: {enabled: false}` to every
 *     openai-compatible vendor. That flag exists because reasoning models
 *     hang mid-thought, and the real OpenAI API rejects it outright:
 *     HTTP 400, "Unknown parameter: 'reasoning'". That brain cannot answer
 *     a prose call at all today. ← worth fixing in brains.mjs on its own
 *     merits; nothing else calls it this way, so nothing else noticed.
 *
 * The rest of this product has always answered that question the same way:
 * `chain()` returns the configured order and callers try each until one
 * answers. A feature that picks one brain and dies with it is the only part
 * of NUM that does not survive a vendor having a bad afternoon.
 */
export function proseBrains(env) {
  return chain(env).filter((b) => PROSE_KINDS.includes(b.kind));
}

/** Kept for callers that want the first candidate; prefer proseBrains(). */
export function brainFor(env) {
  return proseBrains(env)[0] ?? null;
}

const readJson = (text) => {
  if (!text) return null;
  // Models fence JSON about a third of the time whatever the prompt says.
  const m = String(text).match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { return null; }
};

/**
 * PASS ONE — what is actually being asked.
 *
 * The separation that matters is constraint vs preference. "Two vegans" and
 * "must seat eight" disqualify a place; "somewhere lively" ranks it. Conflate
 * them and the answer either rejects everything or recommends a place that
 * cannot take the booking, and the second is the one that ends a trip badly.
 */
export async function decompose(env, brain, { brief, dest }) {
  const out = await callProse(env, brain, {
    system: 'You break a traveller\'s request into researchable parts. Answer with JSON only, no prose.',
    messages: [{
      role: 'user',
      content: `Traveller is in or heading to: ${dest || 'unknown'}.\nTheir request:\n"""${brief}"""\n\n`
        + `Return JSON:\n{\n  "constraints": ["hard requirements that make a place WRONG if unmet — party size, dietary, accessibility, time, budget ceiling"],\n`
        + `  "preferences": ["soft wants that only rank"],\n  "questions": [{"q":"one concrete searchable question","cat":"restaurant|bar|cafe|attraction|spa|hotel|market|shopping|beach|tour"}]\n}\n\n`
        + `At most ${LIMITS.maxQuestions} questions. Each question must be answerable by looking at real venues in one neighbourhood. No question about prices, visas or flights.`,
    }],
    maxTokens: 500,
    wantJson: true,
  });
  const parsed = readJson(out?.text) ?? {};
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .filter((q) => q && typeof q.q === 'string')
    .slice(0, LIMITS.maxQuestions)
    .map((q) => ({ q: clip(q.q, 200), cat: clip(q.cat, 30) || 'restaurant' }));
  return {
    constraints: (Array.isArray(parsed.constraints) ? parsed.constraints : []).slice(0, 8).map((c) => clip(c, 160)),
    preferences: (Array.isArray(parsed.preferences) ? parsed.preferences : []).slice(0, 8).map((c) => clip(c, 160)),
    // A brief that decomposes into nothing is still a brief. Falling back to
    // the whole thing as one question is better than answering nothing.
    questions: questions.length ? questions : [{ q: clip(brief, 200), cat: 'restaurant' }],
  };
}

/**
 * PASS TWO — real candidates, in parallel, from NUM's own directory.
 *
 * Every row here has an id that exists in `places`. That is what makes the
 * verify step possible at all, and it is the difference between research and
 * a model talking confidently about a city it has read about.
 */
export async function gather(env, { questions, dest, lat, lng, memberId }) {
  const { nearbyPlaces } = await import('../ai/places.js');
  const loc = { dest: { slug: dest, name: dest, lat, lng }, lat, lng, precise: false, source: 'named' };
  const per = await Promise.all(questions.map(async (q) => {
    try {
      const r = await nearbyPlaces(env, loc, q.q, LIMITS.candidatesEach, q.cat, { memberId });
      return { q: q.q, cat: q.cat, rows: (r?.rows ?? []).filter((x) => x?.id && x?.name) };
    } catch (err) {
      console.warn('[research] gather failed', q.q, err?.message ?? err);
      return { q: q.q, cat: q.cat, rows: [] };
    }
  }));
  // One flat, de-duplicated evidence set — the same place answering two
  // sub-questions is one place, and counting it twice would make a thin
  // neighbourhood look well covered.
  const byId = new Map();
  for (const g of per) for (const r of g.rows) if (!byId.has(r.id)) byId.set(r.id, r);
  return { per, all: [...byId.values()] };
}

/** How the evidence is shown to the model: numbered, factual, no opinions. */
export function evidenceBlock(rows) {
  return rows.map((r, i) => {
    const bits = [r.cuisine || r.category, r.area].filter(Boolean).join(', ');
    const rating = r.rating != null ? `${r.rating}★${r.reviews ? ` (${r.reviews})` : ''}` : 'unrated';
    const km = r.km != null ? `${Math.round(r.km * 10) / 10}km` : '';
    return `${i + 1}. ${r.name}${bits ? ` — ${bits}` : ''} · ${rating}${km ? ` · ${km}` : ''}`;
  }).join('\n');
}

/**
 * PASS THREE — the answer, written against the evidence and nothing else.
 */
export async function write(env, brain, { brief, dest, constraints, preferences, evidence }) {
  const out = await callProse(env, brain, {
    system: 'You are NUM, a travel concierge. You recommend only places listed in the evidence, by their exact name. '
      + 'You never invent a venue, a price, an opening time or a capacity. Where the evidence cannot satisfy a '
      + 'requirement, you say so plainly in one sentence rather than working around it.',
    messages: [{
      role: 'user',
      content: `Destination: ${dest || 'unknown'}\nThe request:\n"""${brief}"""\n\n`
        + `Hard requirements (a place failing one is WRONG, not merely worse):\n${constraints.length ? constraints.map((c) => `- ${c}`).join('\n') : '- none stated'}\n\n`
        + `Preferences (ranking only):\n${preferences.length ? preferences.map((c) => `- ${c}`).join('\n') : '- none stated'}\n\n`
        + `EVIDENCE — the only venues you may name:\n${evidence}\n\n`
        + `Write the answer. Group it the way the request is shaped. Name specific venues from the evidence and say why each one. `
        + `Put EVERY venue name in **bold**, exactly as it is spelled in the evidence — Num checks the bolded names against its own list before showing this to anyone, and an unbolded name cannot be checked. `
        + `End with a short line headed "Couldn't confirm:" listing any hard requirement the evidence does not settle — omit the line entirely if there are none.`,
    }],
    maxTokens: LIMITS.answerTokens,
  });
  return out?.text ?? '';
}

/**
 * PASS FOUR — strike out anything that was not in the evidence.
 *
 * This is the step that makes the feature worth money. A model given twelve
 * real restaurants will, perhaps one time in twenty, add a thirteenth it
 * remembers from training — usually a famous one, usually closed. A guest
 * cannot tell which of the names came from NUM's directory and which came
 * from the model's memory, so NUM checks rather than asks them to trust.
 *
 * Returns the answer plus every invented name found, because a silent strike
 * is its own kind of lie: if the answer loses a paragraph, the guest is told.
 */
export function verify(answer, rows) {
  const known = rows.map((r) => String(r.name)).filter(Boolean);
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const knownNorm = known.map(norm);

  // ── WHY ONLY BOLD ──────────────────────────────────────────────────────
  //
  // The first version of this scanned every Title Case run in the answer, on
  // the theory that a venue name looks like one. It flagged "Saturday Night"
  // as an invented restaurant. A checker that cries wolf is worse than no
  // checker at all, because the one time it is right nobody reads it.
  //
  // So the model is TOLD to bold every venue it names (see write()), and this
  // checks the bold. That turns an unbounded guess about English into an
  // exact test of a claim the model made on purpose. If the model ignores the
  // instruction there is nothing to check, and `unmarked` says so rather than
  // reporting a clean bill of health it has not earned.
  // ── A HEADING IS NOT A VENUE ───────────────────────────────────────────
  //
  // First live run, 18 Sep 2026: a good answer, 24 real places, and this
  // reported "3 names are not in NUM's checked list and may not exist:
  // Quiet Work Spot with Good Coffee, Dinner Nearby within Walking Distance,
  // Couldn't confirm:". All three were the model's own section headings. It
  // was told to bold venue names and it also bolded its headings, which is
  // what any writer would do.
  //
  // The tell is the line, not the words. A heading is bold that IS the whole
  // line; a venue is bold inside a line that goes on to say something about
  // it ("- **CupC Coffee** – 0.3km away, this café…"). So a bolded run only
  // counts as a claim when its line carries other prose, once the list marker
  // is stripped. Same principle as bold-only itself: check what the model
  // deliberately said, and do not invent accusations out of formatting.
  const named = new Set();
  for (const line of String(answer).split('\n')) {
    const bare = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim();
    const bolds = [...bare.matchAll(/\*\*([^*]{2,60})\*\*/g)];
    if (!bolds.length) continue;
    // The whole line is one bold run and nothing else — a heading.
    if (bolds.length === 1 && bare.replace(/\*\*/g, '').trim() === bolds[0][1].trim()) continue;
    for (const m of bolds) named.add(m[1].trim());
  }

  const invented = [];
  for (const n of named) {
    const nn = norm(n);
    if (nn.length < 4) continue;
    if (knownNorm.some((k) => k === nn || k.includes(nn) || nn.includes(k))) continue;
    invented.push(n);
  }
  // No marks at all, with evidence available and an answer long enough to be
  // recommending something, means this answer was not verified — not that it
  // was found clean.
  const unmarked = named.size === 0 && rows.length > 0 && String(answer).trim().length > 200;
  return { answer, invented, unmarked };
}

/** Everything a guest is shown, once a run is finished. */
function shape(row) {
  if (!row) return null;
  const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  return {
    id: row.id,
    state: row.state,
    brief: row.brief,
    dest: row.dest,
    questions: parse(row.questions, []),
    constraints: parse(row.constraints, []),
    answer: row.answer ?? null,
    unmet: parse(row.unmet, []),
    places: parse(row.evidence, []),
    ms: row.ms ?? null,
    error: row.error ?? null,
    created_at: row.created_at,
    finished_at: row.finished_at ?? null,
  };
}

/**
 * Run one piece of research to completion. Called from waitUntil, never on
 * the guest's turn.
 *
 * Failure is recorded and costs the member nothing: `countUse` is the last
 * thing that happens, after an answer exists. A run that dies half way
 * through leaves a row saying so and an allowance untouched.
 */
export async function runResearch(env, id) {
  await ensure(env);
  const t0 = Date.now();
  const row = await env.DB.prepare('SELECT * FROM num_research WHERE id=?1').bind(id).first().catch(() => null);
  if (!row || row.state !== 'queued') return { ok: false, error: 'not queued' };
  const fail = async (msg) => {
    await env.DB.prepare("UPDATE num_research SET state='failed', error=?2, ms=?3, finished_at=datetime('now') WHERE id=?1")
      .bind(id, clip(msg, 300), Date.now() - t0).run().catch(() => {});
    return { ok: false, error: msg };
  };
  const candidates = proseBrains(env);
  if (!candidates.length) return fail('no brain available');

  try {
    // Try each brain until one decomposes the brief. A vendor that 400s on
    // the first call is a vendor this run should walk past, not die on — see
    // proseBrains() for the two different ways dying on the first one has
    // already broken this feature in production.
    let brain = null; let plan = null; const tried = [];
    for (const b of candidates) {
      try {
        plan = await decompose(env, b, { brief: row.brief, dest: row.dest });
        brain = b;
        break;
      } catch (err) {
        tried.push(`${b.id}: ${String(err?.message ?? err).slice(0, 80)}`);
        console.warn('[research] brain declined', b.id, err?.message ?? err);
      }
    }
    if (!brain) return fail(`every brain declined — ${tried.join(' | ')}`);
    await env.DB.prepare("UPDATE num_research SET state='running', brain=?2 WHERE id=?1").bind(id, brain.id).run().catch(() => {});
    let lat = null; let lng = null;
    if (row.dest) {
      const d = await env.DB.prepare('SELECT lat, lng FROM destinations WHERE slug=?1').bind(row.dest).first().catch(() => null);
      lat = d?.lat ?? null; lng = d?.lng ?? null;
    }
    const { all } = await gather(env, { questions: plan.questions, dest: row.dest, lat, lng, memberId: row.member_id });
    if (!all.length) {
      // An honest empty. NUM holds nothing here, and saying so is the correct
      // answer — it is also why this does not charge the allowance.
      await env.DB.prepare(
        "UPDATE num_research SET state='empty', questions=?2, constraints=?3, ms=?4, finished_at=datetime('now'), answer=?5 WHERE id=?1",
      ).bind(id, JSON.stringify(plan.questions), JSON.stringify(plan.constraints), Date.now() - t0,
        `I don't hold enough checked places in ${row.dest || 'that area'} to research this properly yet, so I'm not going to guess. Ask me in the thread and I'll work with what there is.`).run();
      return { ok: true, empty: true };
    }
    const draft = await write(env, brain, {
      brief: row.brief, dest: row.dest,
      constraints: plan.constraints, preferences: plan.preferences,
      evidence: evidenceBlock(all),
    });
    const { answer, invented, unmarked } = verify(draft, all);
    const unmet = [];
    if (invented.length) {
      unmet.push(`${invented.length} name${invented.length === 1 ? ' is' : 's are'} not in NUM's checked list and may not exist: ${invented.join(', ')}`);
    }
    if (unmarked) {
      // Said out loud rather than passed off as verified. See verify().
      unmet.push('This answer did not mark its venues, so NUM could not check them against its own list.');
    }
    await env.DB.prepare(
      `UPDATE num_research SET state='done', questions=?2, constraints=?3, evidence=?4, answer=?5, unmet=?6,
       ms=?7, finished_at=datetime('now') WHERE id=?1`,
    ).bind(
      id, JSON.stringify(plan.questions), JSON.stringify(plan.constraints),
      JSON.stringify(all.slice(0, 40).map((r) => ({ id: r.id, name: r.name, area: r.area ?? null, rating: r.rating ?? null }))),
      answer, JSON.stringify(unmet), Date.now() - t0,
    ).run();
    // LAST. The member is charged for work that exists.
    await countUse(env, row.member_id, 'deep_research_monthly', 1);
    try {
      const { notify } = await import('./push.mjs');
      await notify(env, {
        memberId: row.member_id,
        kind: 'research',
        title: 'Your research is ready',
        body: clip(row.brief, 80),
        tag: id,
      });
    } catch { /* a push that did not send is not a failed run */ }
    return { ok: true, ms: Date.now() - t0, invented: invented.length };
  } catch (err) {
    return fail(String(err?.message ?? err));
  }
}

/** POST /api/research — gate, record, kick off, answer immediately. */
export async function startResearch(request, env, ctx) {
  await ensure(env);
  if (!assertFreeFloor(env)) return json({ error: 'Deep research is unavailable.' }, 503);
  const b = await request.json().catch(() => ({}));
  const me = clip(b?.me, 40);
  const brief = clip(b?.brief, LIMITS.briefChars)?.trim();
  if (!me) return json({ error: 'me required' }, 400);
  if (!brief || brief.length < 12) return json({ error: 'Tell me what to look into — a sentence or two.' }, 400);

  const gate = await may(env, me, 'deep_research_monthly');
  if (!gate.ok) {
    const table = tiers(env);
    const better = gate.upgrade_to ? table[gate.upgrade_to] : null;
    return json({
      error: `That's all ${gate.limit} deep searches on ${table[gate.tier]?.name ?? 'your plan'} this month. `
        + `They reset at the start of next month`
        + (better ? ` — or ${better.name} gives you ${gate.upgrade_gives ?? 'as many as you like'}.` : '.'),
      reason: 'deep_research_monthly',
      limit: gate.limit, used: gate.used, tier: gate.tier,
      upgrade_to: gate.upgrade_to ?? null, upgrade_gives: gate.upgrade_gives ?? null,
    }, 402);
  }

  const id = `res_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await env.DB.prepare('INSERT INTO num_research (id, member_id, brief, dest) VALUES (?1,?2,?3,?4)')
    .bind(id, me, brief, clip(b?.dest, 80)).run();
  // waitUntil, so the guest gets an id in milliseconds and the work carries on
  // after the response closes. Without it the run dies with the request.
  if (ctx?.waitUntil) ctx.waitUntil(runResearch(env, id));
  else runResearch(env, id).catch(() => {});
  return json({ id, state: 'queued', left: gate.left ?? null, limit: gate.limit ?? null }, 202);
}

/** GET /api/research?id= | ?me= — one run, or the member's recent ones. */
export async function readResearch(env, url) {
  await ensure(env);
  const id = clip(url.searchParams.get('id'), 40);
  const me = clip(url.searchParams.get('me'), 40);
  if (id) {
    const row = await env.DB.prepare('SELECT * FROM num_research WHERE id=?1').bind(id).first().catch(() => null);
    if (!row) return json({ error: 'not found' }, 404);
    // A run belongs to the member who paid for it.
    if (me && row.member_id !== me) return json({ error: 'not yours' }, 403);
    return json({ research: shape(row) });
  }
  if (!me) return json({ error: 'id or me required' }, 400);
  const { results } = await env.DB.prepare(
    'SELECT * FROM num_research WHERE member_id=?1 ORDER BY created_at DESC LIMIT 20',
  ).bind(me).all().catch(() => ({ results: [] }));
  return json({ research: (results ?? []).map(shape) });
}

export async function handleResearch(request, env, url, ctx) {
  if (request.method === 'POST') return await startResearch(request, env, ctx);
  return await readResearch(env, url);
}
