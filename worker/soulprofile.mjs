/**
 * NUM · the soulprofile — what kind of traveller is this, and what would
 * actually delight them.
 *
 * ── THE GAP THIS FILLS ───────────────────────────────────────────────────
 *
 * Two learning systems already exist and neither answers the question a
 * concierge actually asks itself:
 *
 *   learn.mjs   — which PLACES are good, globally, from ratings. Says nothing
 *                 about who is standing in front of you.
 *   memory.mjs  — what this guest TOLD us, so we never re-ask. Authoritative,
 *                 and on 31 Aug 2026 it held two facts across 138 members.
 *
 * Two facts. Not because the plumbing is broken — it works — but because the
 * only instruction in the prompt is "whenever the user reveals a lasting fact,
 * emit a remember action". Everything is passive. Num waits to be told, and a
 * guest who never volunteers "I hate crowds" is a guest Num will send to a
 * packed rooftop every single time, for ever, while believing it is helping.
 *
 * This file is the missing middle: what we BELIEVE about a guest's taste, how
 * strongly, and what one question would sharpen it most.
 *
 * ── STATED BEATS OBSERVED, ALWAYS ────────────────────────────────────────
 *
 * A guest who says "we are vegetarian" outranks a hundred inferred signals.
 * Observation is for the things people never think to say — that they always
 * ask at 11pm, that they open the quiet places and skip the loud ones. So
 * `memory.mjs` facts are read as ground truth and the observed layer only ever
 * fills gaps. It never overwrites, and it never argues.
 *
 * ── WHY IT IS KEYED ON A SUBJECT, NOT A MEMBER ───────────────────────────
 *
 * 370 of 412 asks have no member id. Sixteen members have ever asked anything.
 * A member-keyed profile would be a feature for 10% of traffic that looks
 * broken to everyone else — and worse, it would learn nothing during exactly
 * the conversation where a first-time guest is deciding whether Num is any
 * good. So the key is `member_id ?? anon_id`: the profile starts on the first
 * message, for everyone, and `mergeAnon` folds it into the account the moment
 * they verify a phone. Nothing is lost by joining, which is the only honest
 * way round for a product asking people to sign up.
 *
 * ── WHAT IS NEVER STORED, AND THE LINE THAT MATTERS ──────────────────────
 *
 * This builds a behavioural picture of real people across the US, the UK and
 * Thailand. Two of those are GDPR jurisdictions and all three deserve better
 * than "we collected it because we could".
 *
 * The rule: STORE THE OPERATIONAL PREFERENCE, NEVER THE REASON.
 *
 *   "avoids shellfish"        → stored. It is what a kitchen needs to know.
 *   "shellfish allergy"       → NOT stored. That is a medical record.
 *   "no pork"                 → stored. Same reason.
 *   "Muslim"                  → NOT stored. That is a religious belief.
 *   "prefers step-free access"→ stored. It changes which venue we pick.
 *   "uses a wheelchair"       → NOT stored. That is a disability record.
 *
 * The stored half is everything the recommendation actually needs. The
 * discarded half is the half that turns a helpful profile into a liability in
 * a breach, a subpoena or an acquisition. We lose nothing useful and shed all
 * of the risk, so this is not a compliance tax — it is the better design.
 */

/**
 * Value patterns we refuse to keep, whatever key they arrive under.
 *
 * Checked against the VALUE as well as the key, because the model will
 * cheerfully emit `{key: 'dietary', value: 'coeliac disease'}` — a legitimate
 * key carrying a medical diagnosis.
 */
const NEVER_STORE = [
  // Health, in all the shapes a food conversation produces it.
  /\ballerg|anaphyla|coeliac|celiac|diabet|intoleran|crohn|medical|diagnos|medication|pregnan|disease|disorder|condition\b/i,
  // Common abbreviations, which no keyword list will ever finish catching.
  /\b(?:MS|PTSD|OCD|HIV|IBS|ADHD|CFS|ME|IBD|COPD|T1D|T2D)\b/,
  // THE SHAPE, not the vocabulary.
  //
  // "wife has MS" defeated the list above, and adding MS would only have
  // moved the goalposts to the next abbreviation. What gives it away is not
  // the condition — it is the grammar: somebody, a possession verb, and a
  // capitalised abbreviation. A taste preference is a phrase ("two of us",
  // "cheap eats", "somewhere quiet"); it is never a clause about a person's
  // body. Recognising the sentence shape means we do not have to recognise
  // the illness, which is the only version of this that can keep working.
  /\b(?:has|have|had|got|suffers?\s+from|is\s+on|takes?)\b[^.]{0,25}\b[A-Z]{2,5}\b/,
  /\b(?:suffers?\s+from|diagnosed|prescribed|chronic)\b/i,
  // Belief and identity.
  /\bmuslim|halal.{0,12}(because|as a|since)|jewish|kosher.{0,12}(because|as a|since)|christian|hindu|buddhist|religio|church|mosque|temple.{0,10}(every|weekly)|faith\b/i,
  /\bgay\b|\blesbian|bisexual|transgender|\btrans\b|queer|sexuality|orientation/i,
  /\bdisab|wheelchair|blind\b|deaf\b|autis|adhd|mental health|depress|anxiety|therapy|therapist/i,
  // Politics and money troubles.
  /\bvote[ds]?\b|political|left.?wing|right.?wing|conservative party|labour party|republican|democrat/i,
  /\bbroke\b|in debt|cannot afford|can't afford|struggling financially|benefits\b|unemploy/i,
];

/** A value we will keep. Short, non-sensitive, not a sentence. */
export function storable(key, value) {
  const k = String(key ?? '').trim().toLowerCase();
  const v = String(value ?? '').trim();
  if (!k || !v) return false;
  // A fact is a phrase, not a paragraph. Anything long is a transcript
  // fragment, and this table is explicitly not a transcript.
  if (v.length > 120) return false;
  const both = `${k} ${v}`;
  return !NEVER_STORE.some((re) => re.test(both));
}

/**
 * Strip a stored value down to the operational preference.
 *
 * Runs BEFORE `storable`, so "no shellfish, I'm allergic" becomes
 * "no shellfish" and is kept, rather than being discarded whole. Throwing the
 * useful half away with the sensitive half would push guests to repeat
 * themselves — the exact failure memory.mjs exists to end — and would quietly
 * make the profile worse at the thing it is for.
 */
export function toPreference(value) {
  return String(value ?? '')
    // "because I'm coeliac", "as I have an allergy", "due to my diabetes"
    .replace(/\s*[—,-]?\s*\b(because|since|as|due to|owing to)\b[^,.;]*/gi, '')
    // "I'm allergic to X" → "no X"
    .replace(/\bi(?:'m| am) allergic to\b/gi, 'no')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[,;]+$/, '');
}

/**
 * The dimensions worth holding. Deliberately short: a profile with forty axes
 * is a profile nobody can reason about and the model will not read.
 *
 * `ask` is the question Num may earn the right to put, written the way a
 * concierge would say it out loud — never the way a form would print it.
 */
export const DIMENSIONS = [
  { key: 'crew', ask: 'Who am I planning for — just you, the two of you, or a group?', when: 'always' },
  { key: 'budget', ask: 'Are we going for a great cheap find, or is this a treat?', when: 'money' },
  { key: 'atmosphere', ask: 'Do you want somewhere buzzing, or somewhere you can actually talk?', when: 'venue' },
  { key: 'eats', ask: 'What food makes you happiest when you travel?', when: 'food' },
  { key: 'avoids', ask: 'Anything you would rather I never put in front of you?', when: 'food' },
  { key: 'pace', ask: 'Do you like packing a day full, or one good thing done properly?', when: 'plan' },
];

const DIMENSION_KEYS = new Set(DIMENSIONS.map((d) => d.key));

/** member id when we have one, else the device's anon id. */
export const subjectOf = ({ memberId = null, anonId = null } = {}) =>
  (memberId ? String(memberId) : anonId ? `anon:${String(anonId)}` : null);

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_soul_signals (
  subject TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subject, key)
)`;
let ready = false;
export const _resetSchemaCache = () => { ready = false; };
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.prepare(SCHEMA).run();
  ready = true;
}

/**
 * How many times we must see something before we act on it.
 *
 * One mention is a mood; three is a pattern. Acting on a single observation is
 * how a guest who once asked about a steakhouse gets steak suggested for the
 * rest of their life — the behaviour that makes people say an app "thinks it
 * knows me" as an insult.
 */
export const CONFIDENT_AT = 3;

/**
 * Record one observed leaning. Never throws; a profile write must never cost
 * somebody their answer.
 */
export async function observe(env, subject, key, value) {
  if (!env?.DB || !subject || !DIMENSION_KEYS.has(key)) return { stored: 0 };
  const pref = toPreference(value);
  if (!storable(key, pref)) return { stored: 0, refused: true };
  try {
    await ensure(env);
    await env.DB.prepare(
      `INSERT INTO num_soul_signals (subject, key, value, seen, updated_at)
       VALUES (?1,?2,?3,1,datetime('now'))
       ON CONFLICT(subject, key) DO UPDATE SET
         seen = CASE WHEN num_soul_signals.value = excluded.value THEN num_soul_signals.seen + 1 ELSE 1 END,
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ).bind(subject, key, pref).run();
    return { stored: 1 };
  } catch (e) {
    console.warn('[soul] observe failed', e?.message ?? e);
    return { stored: 0 };
  }
}

/**
 * The merged picture: what they said, plus what we have noticed enough times
 * to trust.
 *
 * Stated facts are spread LAST so they always win. An observation that
 * contradicts something the guest actually told us is an observation that is
 * wrong, by definition.
 */
export async function profileFor(env, { stated = {}, memberId = null, anonId = null } = {}) {
  const subject = subjectOf({ memberId, anonId });
  const observed = {};
  if (env?.DB && subject) {
    try {
      await ensure(env);
      const { results } = await env.DB.prepare(
        'SELECT key, value, seen FROM num_soul_signals WHERE subject = ?1',
      ).bind(subject).all().catch(() => ({ results: [] }));
      for (const r of results ?? []) {
        if (Number(r.seen) >= CONFIDENT_AT) observed[r.key] = r.value;
      }
    } catch { /* a profile is an enhancement, never a dependency */ }
  }
  return { ...observed, ...stated };
}

/**
 * Fold a device's history into the account it just became.
 *
 * Runs on phone verification. Existing member facts win — the account is older
 * and more trusted than the device — so this only ever fills blanks.
 */
export async function mergeAnon(env, anonId, memberId) {
  if (!env?.DB || !anonId || !memberId) return { merged: 0 };
  const from = `anon:${String(anonId)}`;
  try {
    await ensure(env);
    const r = await env.DB.prepare(
      `INSERT INTO num_soul_signals (subject, key, value, seen, updated_at)
       SELECT ?2, key, value, seen, updated_at FROM num_soul_signals WHERE subject = ?1
       ON CONFLICT(subject, key) DO NOTHING`,
    ).bind(from, String(memberId)).run();
    return { merged: Number(r?.meta?.changes ?? 0) };
  } catch (e) {
    console.warn('[soul] merge failed', e?.message ?? e);
    return { merged: 0 };
  }
}

/**
 * THE EARNED QUESTION.
 *
 * Exactly one per conversation, and only when the answer would change the
 * recommendation. Chosen here, deterministically, rather than left to the
 * model — a model told "ask when useful" asks constantly, and a guest being
 * interviewed is a guest filling in a form. Forms are what people leave.
 *
 * Returns null far more often than it returns a question, and that is the
 * point. Silence is the default; a question has to earn its place by being
 * about the thing they are asking for RIGHT NOW.
 */
export function nextQuestion(profile = {}, { topic = null, asked = [] } = {}) {
  const known = (k) => {
    const v = profile?.[k];
    return v !== undefined && v !== null && String(v).trim() !== '';
  };
  const already = new Set(asked ?? []);
  // A NULL TOPIC IS NOT A LICENCE TO ASK.
  //
  // `when: 'always'` means "relevant to any turn we understand" — not "ask
  // regardless". When we cannot tell what the guest is even asking about, we
  // cannot claim the answer would change anything, and asking anyway is
  // exactly the form-filling this design exists to avoid.
  const relevant = (d) => !!topic && (d.when === 'always' || d.when === topic);

  for (const d of DIMENSIONS) {
    if (known(d.key)) continue;      // never ask what we already know
    if (already.has(d.key)) continue; // never ask the same thing twice
    if (!relevant(d)) continue;       // never ask something this turn cannot use
    return { key: d.key, ask: d.ask };
  }
  return null;
}

/** What the model is shown: the question, and the strict rules for using it. */
export function questionBlock(q) {
  if (!q) return null;
  return `ONE QUESTION YOU MAY EARN THIS TURN — "${q.ask}"

Ask it ONLY if answering the guest well actually depends on it, and only AFTER
you have given them something useful. Never lead with it, never ask more than
this one, and never ask it twice in a conversation. If you can give a good
answer without it, give the answer and stay quiet — a guest being interviewed
is a guest filling in a form. When they answer, emit a remember action with
key "${q.key}".`;
}

/**
 * What is this turn ABOUT — deterministically, with no model call.
 *
 * The topic gates the question: a food question during a taxi conversation is
 * an interruption, not a concierge noticing something. Returns null freely,
 * and a null topic means no question at all.
 */
export function topicOf(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (/\b(eat|eating|food|dinner|lunch|breakfast|brunch|hungry|restaurant|cuisine|dish|menu|meal|starving)\b/.test(t)) return 'food';
  if (/\b(bar|bars|drink|drinks|cocktail|beer|wine|club|rooftop|caf[eé]|coffee|pub|night out|nightlife)\b/.test(t)) return 'venue';
  if (/\b(plan|itinerary|days?|tomorrow|weekend|trip|things to do|what should we do|schedule)\b/.test(t)) return 'plan';
  if (/\b(cost|costs|price|pricing|budget|cheap|expensive|afford|how much|spend)\b/.test(t)) return 'money';
  return null;
}

/**
 * Which dimensions Num has already put to this guest in this conversation.
 *
 * Scans what NUM said, not what the guest said. A guest who ignored a question
 * still counts as having been asked — pressing it again is how a conversation
 * turns into an interrogation, and the fact that they did not answer is
 * usually the answer.
 *
 * Keyword sets rather than the literal sentence, because the model paraphrases
 * and an exact-match check would silently never fire.
 */
const ASK_MARKS = {
  crew: /\b(who am i planning for|just you|two of you|a group|who(?:'s| is) coming|how many of you)\b/i,
  budget: /\b(cheap find|is this a treat|budget|splash out|price range)\b/i,
  atmosphere: /\b(buzzing|somewhere you can actually talk|lively or quiet|quiet or lively|atmosphere)\b/i,
  eats: /\b(what food makes you|what do you like to eat|favourite cuisine|favorite cuisine|kind of food)\b/i,
  avoids: /\b(never put in front of you|anything you avoid|anything you(?:'d| would) rather not|off the menu for you)\b/i,
  pace: /\b(packing a day full|one good thing|slow or packed|how fast)\b/i,
};

export function askedAlready(messages = []) {
  const said = (messages ?? [])
    .filter((m) => m?.role === 'assistant')
    .map((m) => String(m?.content ?? ''))
    .join('\n');
  if (!said) return [];
  return Object.entries(ASK_MARKS).filter(([, re]) => re.test(said)).map(([k]) => k);
}
