/**
 * Response quality control — does this reply actually answer what was asked?
 *
 * Dre, 11 Aug 2026, in the same breath as moving everyday traffic to the
 * cheaper response brain: "we need a response quality control. to make sure
 * each message is meeting what the user is requesting clearly."
 *
 * That order matters. Routing turns to a model that costs 1/76th as much is
 * only defensible if something is watching what comes back — otherwise the
 * saving is real and the regression is invisible. This is that something.
 *
 * ── WHY THIS IS NOT A MODEL CALL ─────────────────────────────────────────
 *
 * The obvious design is to ask a model to grade each reply. It is also the
 * wrong one here, three times over: it doubles the per-turn cost we just cut,
 * it adds a second round trip to a guest who is waiting, and it fails exactly
 * when the answer path fails — a grader on the same vendor as the answerer is
 * unavailable in precisely the outage it was meant to catch.
 *
 * So every check below is deterministic string work: microseconds, no vendor,
 * no bill, and it cannot go down. It catches less than a model would. It
 * catches the things that have actually gone wrong in production, which is a
 * different and more useful set. Each check maps to a shipped bug.
 *
 * ── WHY IT NEVER CAUSES SILENCE ──────────────────────────────────────────
 *
 * Also Dre, same message: "no message goes unanswered." A quality gate that
 * can reject is a quality gate that can produce nothing, and nothing is worse
 * than imperfect. So the contract is strict:
 *
 *   HARD flags  → ONE corrective retry. If the retry is no better, the
 *                 ORIGINAL reply still ships. The flags are logged either way.
 *   SOFT flags  → logged only. Never retried, never blocked.
 *
 * There is no path through this file that returns nothing. `inspect` grades;
 * it does not gate. The caller decides, and the caller always ships something.
 */

/** Digits only, so "THB 1,200" and "1200" compare equal. */
const digits = (s) => String(s).replace(/[^\d]/g, '');

/**
 * Money and ratings mentioned in a reply.
 *
 * Deliberately narrow. Distances, durations, party sizes and times are
 * routinely computed or restated rather than quoted, and flagging them
 * produces retries on correct answers — a false positive here costs a guest
 * real seconds. Money and ratings are the two that have actually been
 * invented in front of paying users, so they are the two treated as hard.
 */
export function figuresIn(text) {
  const s = String(text ?? '');
  const out = [];
  // THB 1,200 / ฿1200 / 1,200 baht / $45 / 45 USD — and the rest of the
  // 38 countries Num is live in. The first version knew four currencies, so
  // "¥3,000 for the omakase" or "AED 250 a head" passed as not-a-price.
  for (const m of s.matchAll(/(?:฿|THB|USD|\$|€|£|¥|₩|₹|₫|₱|Rp|RM|NT\$|S\$|A\$|C\$|HK\$|AED|SGD|AUD|CAD|HKD|JPY|KRW|INR|IDR|MYR|VND|PHP|TWD|CHF|EUR|GBP)\s?([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s?(?:baht|THB|USD|dollars?|euros?|pounds?|yen|won|rupees?|dirhams?|ringgit|rupiah|dong|pesos?|francs?|AED|SGD|AUD|CAD|HKD|JPY|KRW|INR|IDR|MYR|VND|PHP|TWD|CHF|EUR|GBP)\b/gi)) {
    const n = digits(m[1] ?? m[2] ?? '');
    if (n) out.push({ kind: 'money', n });
  }
  // 4.6 stars / rated 4.6 / 4.6/5
  for (const m of s.matchAll(/\b(\d\.\d)\s*(?:\/\s*5|stars?\b)|rated\s+(\d\.\d)/gi)) {
    const n = digits(m[1] ?? m[2] ?? '');
    if (n) out.push({ kind: 'rating', n });
  }
  return out;
}

const RECOMMENDY = /\b(recommend|suggest|where should|best|good place|any good|options?|ideas?|what should i (?:do|eat|see)|somewhere to)\b/i;
const YESNO = /^(?:is|are|was|were|does|do|did|can|could|should|will|would|has|have|am)\b/i;
const VERDICT = /\b(yes|no|yep|nope|it is|it isn'?t|you can|you can'?t|there is|there isn'?t|not really|afraid not)\b/i;
// A bare URL or domain typed into the prose. Deliberately narrow: it must
// look like a link a guest could tap, not any string with a dot in it, or
// "open at 7.30" and "£24.50" would trip it.
const URL_IN_TEXT = /\b(?:https?:\/\/\S+|www\.[a-z0-9-]+\.[a-z]{2,}|[a-z0-9-]+\.(?:com|net|org|co|io|travel|rest|menu|shop|site)\b(?:\/\S*)?)/i;

/**
 * Does this reply appear to name actual places? Used to tell a recommendation
 * that listed venues in prose from one that honestly said it had none — the
 * second must not be retried, because "I have nothing verified nearby" is the
 * correct answer to give and retrying would push the model to invent.
 */
function namesPlaces(text) {
  const capitalised = String(text ?? '').match(/\b[A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*)*/g) ?? [];
  return capitalised.filter((n) => n.length > 3 && !/^(I|The|You|If|It|And|But|Or|Num|Sorry|There|That|This|Nothing|Unfortunately)$/i.test(n)).length >= 2;
}

const DEFLECTION = /\b(i (?:don'?t|do not) (?:have|know)|i'?m not sure|i can'?t help|unable to|no information)\b/i;

/**
 * The block headers that mean the grounding context actually contains
 * something the model could have answered from. Must match the headers
 * written by contextBlock() in prompt.mjs.
 */
const HOLDS_ANSWER = /VERIFIED NEARBY PARTNERS|LIVE SHOWTIMES TODAY|WHAT IS ON HERE/;
// Words too common to prove a reply is on topic.
const STOP = new Set('the a an and or but for with from into to of in on at by is are was were be been am do does did i you we they it he she this that these those my your our their me us them what when where which who whom how why can could should would will shall may might must have has had not no yes if then than so as about near around get got go going want need like just some any there here more most very really please thanks thank ok okay hi hello hey num'.split(' '));

/** Content words in an ask — the things a reply ought to be about. */
function topics(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

/**
 * Grade one reply against the question that produced it.
 *
 * @param {object} a
 * @param {string} a.ask      what the guest said
 * @param {string} a.reply    what came back
 * @param {string} [a.context] the grounding block the model was given —
 *                             the ONLY place a price or rating may come from
 * @returns {{ ok: boolean, hard: boolean, flags: string[], note: string|null }}
 *   `hard` means one corrective retry is worth it. `ok` means nothing at all
 *   was flagged. Neither is permission to withhold the reply.
 */
export function inspect({ ask = '', reply = '', picks = null, context = '' } = {}) {
  const flags = [];
  let hard = false;
  const q = String(ask ?? '').trim();
  const r = String(reply ?? '').trim();
  if (!r) return { ok: false, hard: false, flags: ['empty'], note: null };

  const haystack = `${context ?? ''}\n${q}`;
  const haveDigits = digits(haystack);

  // 1. INVENTED MONEY OR RATINGS. Shipped twice: "about THB 2,800" for an
  //    airport transfer nobody had priced, and a rating quoted for a place
  //    whose row had none. A number a guest can act on must be traceable to
  //    the verified block or to their own question — anywhere else it is a
  //    guess wearing a decimal point.
  for (const f of figuresIn(r)) {
    if (!haveDigits.includes(f.n)) {
      flags.push(`invented-${f.kind}:${f.n}`);
      hard = true;
    }
  }

  // 2. DEFLECTED WHILE HOLDING THE ANSWER. "I don't have that information"
  //    with a full grounding block attached is not honesty, it is a model
  //    not reading its own context.
  //
  //    "Holding the answer" means the block carries verified content — a
  //    partner list, live showtimes, date-checked events. It does NOT mean
  //    the block is long. The previous test was `context.length > 400`, and
  //    the EMPTY context block (date line, location rules, the unsupported-
  //    city instruction) is already ~850 characters. So a guest asking about
  //    Del Mar got the honest "I don't have anywhere verified there", this
  //    flagged it, and the retry told the model "it is in the verified block
  //    above — answer from it". There was nothing above. That is an
  //    instruction to invent, issued by the code whose job is to stop it.
  if (DEFLECTION.test(r) && HOLDS_ANSWER.test(String(context ?? ''))) {
    flags.push('deflected-with-context');
    hard = true;
  }

  // 3. ANSWERED WITH ONLY A QUESTION. One clarifying question is allowed and
  //    often right; a reply that is nothing BUT a question has moved the work
  //    back onto the guest.
  //    Question-only means EVERY sentence ends in a question mark — not
  //    merely that the reply ends in one, which is the common and correct
  //    "here is the answer, now one question" shape.
  const sentences = r.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  if (sentences.length && sentences.every((x) => x.endsWith('?'))) {
    flags.push('question-only');
    hard = true;
  }

  // 3b. A RECOMMENDATION WITH NO LINK. Dre, 3 Sep 2026: "every time we give a
  //     recommendation for a place, we need to give a link to the location."
  //
  //     This is the check that makes that true rather than aspirational. A
  //     recommendation-shaped ask must come back with `picks`, and every pick
  //     that ships has a link attached server-side (worker/placelink.mjs) —
  //     so an EMPTY picks array on a recommendation means one of two things,
  //     and both are worth a retry:
  //
  //       · the model wrote its recommendations into prose, the old habit
  //         this schema change exists to break; or
  //       · it named places that matched no verified row, and they were
  //         dropped — in which case the honest answer is "I don't have
  //         anywhere verified for that", not three names with no way to
  //         reach them.
  //
  //     Deliberately HARD, unlike the thin-recommendation flag below. That
  //     one is soft because a thin directory is an honest reason for two
  //     options instead of three; this one cannot be excused by the data,
  //     because the picks are built FROM the data.
  const isRec = RECOMMENDY.test(q);
  const picked = Array.isArray(picks) ? picks : null;
  if (isRec && picked && picked.length === 0 && namesPlaces(r)) {
    flags.push('recommendation-without-picks');
    hard = true;
  }

  // 3c. A URL TYPED INTO PROSE. Links are attached from the verified
  //     directory; a URL in the reply text is one the model wrote, which is
  //     the one kind of link nobody can check. Hard, because a wrong link
  //     does not fail loudly — it opens a competitor or a 404 while looking
  //     exactly like a working one.
  if (URL_IN_TEXT.test(r)) {
    flags.push('model-written-url');
    hard = true;
  }

  // 3d. THE MESSAGE REPEATS THE CARDS. With picks rendering as their own
  //     cards, a reply that also lists the names, numbers and addresses in
  //     prose says everything twice — the exact clutter the structure
  //     replaced. Soft: a reply naming its top pick once is good writing,
  //     so this only fires when MOST of the picks are restated.
  if (picked && picked.length >= 2) {
    const restated = picked.filter((pk) => pk?.name && r.toLowerCase().includes(String(pk.name).toLowerCase())).length;
    if (restated >= picked.length) flags.push('picks-restated-in-prose');
    // A phone number or a street address in the prose is always duplication
    // now: both are on the card, both are tappable there, and neither is
    // readable run into a sentence.
    if (picked.some((pk) => pk?.phone && r.includes(String(pk.phone)))) flags.push('phone-in-prose');
  }

  // ── SOFT: logged, never retried ──────────────────────────────────────────

  // 4. A recommendation with fewer than three options. Dre's rule, 11 Aug:
  //    "give them at least 3 options." Soft on purpose — a thin directory is
  //    a real and honest reason to offer two, and retrying would push the
  //    model to invent a third. The flag makes the gap visible in the data;
  //    it does not demand the model paper over it.
  if (RECOMMENDY.test(q)) {
    const named = (r.match(/\b[A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*)*/g) ?? [])
      .filter((n) => n.length > 3 && !/^(I|The|You|If|It|And|But|Or|Num|Kata|Karon|Patong|Phuket)$/i.test(n));
    if (new Set(named).size < 3) flags.push('thin-recommendation');
  }

  // 5. A yes/no question that never says yes or no. "Is the beach walkable
  //    from here?" deserves an answer before it deserves detail.
  if (YESNO.test(q) && !VERDICT.test(r)) flags.push('no-verdict');

  // 6. Nothing in the reply touches what was asked about.
  const t = topics(q);
  if (t.length) {
    const lower = r.toLowerCase();
    // Loose stem match so "restaurants" satisfies "restaurant".
    const hit = t.some((w) => lower.includes(w.slice(0, Math.max(4, w.length - 2))));
    if (!hit) flags.push('off-topic');
  }

  // 7. Length. The cap is 40 words for an ordinary ask and 70 for a
  //    recommendation; flag well past either so ordinary variation is not
  //    noise. Long answers are the first thing to come back when a prompt
  //    drifts, and they are how a concierge starts reading like a brochure.
  const words = r.split(/\s+/).filter(Boolean).length;
  if (words > (RECOMMENDY.test(q) ? 110 : 70)) flags.push(`long:${words}`);

  return {
    ok: flags.length === 0,
    hard,
    flags,
    note: hard ? correction(flags) : null,
  };
}

/** The instruction for the one retry a hard flag earns. */
function correction(flags) {
  const bits = [];
  if (flags.some((f) => f.startsWith('invented-'))) {
    bits.push('You stated a price or rating that does not appear in the verified information you were given. Remove it, or say plainly that you would need to check.');
  }
  if (flags.includes('deflected-with-context')) {
    bits.push('You said you did not have the information, but it is in the verified block above. Answer from it.');
  }
  if (flags.includes('question-only')) {
    bits.push('You replied with only a question. Give the answer first, then ask at most one thing you genuinely need.');
  }
  if (flags.includes('recommendation-without-picks')) {
    bits.push('You recommended places in prose instead of in `picks`. Put every place you are recommending in the `picks` array, copying its id and name exactly from the VERIFIED NEARBY PARTNERS block, with one short reason each — the app attaches the link, phone and address and shows each as its own card. Keep `reply` to one line framing the choice. If none of the places you had in mind are in the verified block, say plainly that you have nothing verified for that and offer to look, rather than naming places Num cannot link to.');
  }
  if (flags.includes('model-written-url')) {
    bits.push('You wrote a web address in the message. Remove it. Links are attached automatically from Num’s verified directory — name the place in `picks` and its real link comes with it.');
  }
  return bits.join(' ');
}
