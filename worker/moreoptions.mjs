/**
 * "GIVE ME MORE" MUST MEAN MORE, NOT THE SAME THREE AGAIN.
 *
 * ── THE COMPLAINT ────────────────────────────────────────────────────────
 *
 * Dre, 14 Sep 2026: "when people are making request they get 3 and ask for
 * more and get the same 3 suggestions again."
 *
 * ── WHY IT HAPPENED, AND WHY NO PROMPT LINE WAS GOING TO FIX IT ──────────
 *
 * The VERIFIED NEARBY PARTNERS block is the same list, in the same order,
 * every single turn — ranked by quality and distance. The model is told to
 * prefer it and to give three. So on the second ask it does exactly what it
 * did on the first, correctly, from identical input. It is not forgetting
 * anything; it is being consistent with a list that never moved.
 *
 * Asking it nicely not to repeat is the weak fix. Models are agreeable about
 * that instruction roughly as often as they are agreeable about any other,
 * which is not often enough for something a guest notices immediately.
 *
 * THE FIX IS TO REMOVE THE OPTION, NOT TO FORBID IT. When somebody asks for
 * more, the places they have already been shown are taken OUT of the block.
 * The model cannot repeat what it cannot see, and what is left is genuinely
 * the next three best — which is what "more" meant all along.
 *
 * ── WHAT COMES BACK WHEN THE LIST RUNS OUT ───────────────────────────────
 *
 * A concierge with nothing left says so. `exhausted` tells the prompt to
 * admit it and widen the search rather than quietly serving a repeat, which
 * is the failure mode this file exists to end.
 */

/** Places already put in front of this guest, normalised for comparison. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Do they want DIFFERENT options, or are they asking something new?
 *
 * Deliberately narrow. A false positive strips good places out of the block
 * for a guest who never asked for alternatives, which is a worse bug than
 * the one being fixed — so this matches the handful of ways people actually
 * say it and nothing clever.
 */
const MORE = new RegExp([
  // "more", "any more", "3 more", "show me more", "more options|ideas|places"
  '\\b(?:any |some |a few |three |3 )?more\\b',
  '\\bothers?\\b',
  '\\bother (?:options|ideas|places|spots|choices|suggestions)\\b',
  '\\b(?:some|any)thing else\\b',
  '\\banything else\\b',
  '\\b(?:some|any)thing different\\b',
  '\\bdifferent (?:options|ideas|places|spots|ones)\\b',
  '\\balternatives?\\b',
  '\\bnot (?:these|those|that one|any of (?:these|those))\\b',
  '\\bdo(?:n\'?t| not) like (?:these|those|any of them|them)\\b',
  '\\bnone of (?:these|those)\\b',
  '\\bwhat else\\b',
  '\\bkeep going\\b',
  '\\bnext (?:three|3)\\b',
].join('|'), 'i');

export function wantsMore(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 200) return false;
  return MORE.test(t);
}

/**
 * The partner rows minus everything this guest has already seen.
 *
 * Matches on NAME rather than id on purpose: a pick can reach the guest
 * from the model's own knowledge with no partner row behind it, and that
 * place still must not come back as though it were new.
 */
export function withoutShown(partners = [], shown = []) {
  const seen = new Set((shown ?? []).map(norm).filter(Boolean));
  if (!seen.size) return partners ?? [];
  return (partners ?? []).filter((p) => !seen.has(norm(p?.name)));
}

/** Cap what we carry: a guest who has seen forty places has a different problem. */
export const MAX_SHOWN = 40;

export function cleanShown(shown) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(shown) ? shown : []) {
    const name = String(s ?? '').trim().slice(0, 80);
    const k = norm(name);
    if (!name || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= MAX_SHOWN) break;
  }
  return out;
}

/**
 * What the model is told. Two different jobs depending on the ask:
 *
 *   ordinary turn — a quiet "you have already shown these" so it does not
 *                   re-offer them as though they were a new idea.
 *   a "more" ask  — an explicit contract: three NEW ones, and say so plainly
 *                   when there are no more to give.
 */
export function shownBlock({ shown = [], more = false, remaining = null } = {}) {
  const list = cleanShown(shown);
  if (!list.length) return null;
  const named = list.map((s) => `- ${s}`).join('\n');

  if (!more) {
    return 'ALREADY SHOWN TO THIS GUEST IN THIS CONVERSATION:\n' + named
      + '\nDo not present any of these as a new suggestion. Referring back to one they are '
      + 'considering is fine and good; offering it again as though it were fresh is not.';
  }

  const exhausted = remaining !== null && remaining <= 0;
  return 'THEY ASKED FOR MORE. THESE ARE THE ONES THEY HAVE ALREADY SEEN:\n' + named
    + '\n\nGive them THREE THEY HAVE NOT SEEN. Not one of the above, not a rewording of one, '
    + 'not the same place under another name. They asked because the first set did not land, '
    + 'so lead with how these are DIFFERENT — a different neighbourhood, a different price, a '
    + 'different mood — rather than repeating why the category is good.'
    + (exhausted
      ? '\n\nNUM HAS NOTHING VERIFIED LEFT NEARBY. Say that plainly in one line — it is the '
        + 'honest answer and guests respect it — then offer the real next step: widen the area, '
        + 'change the kind of place, or name well-known spots from general knowledge while being '
        + 'clear those are not from Num\'s own verified list. Never pad the gap with a repeat.'
      : '');
}

/**
 * Everything the turn needs, in one call.
 * @returns {{more: boolean, shown: string[], partners: object[], block: string|null}}
 */
export function moreOptions({ text, shown = [], partners = [] } = {}) {
  const clean = cleanShown(shown);
  const more = wantsMore(text);
  // Only a "more" ask strips the block. On an ordinary turn the guest may
  // well be asking ABOUT one of the places they were shown, and removing it
  // would leave the model unable to answer a question about its own pick.
  const left = more ? withoutShown(partners, clean) : (partners ?? []);
  return {
    more,
    shown: clean,
    partners: left,
    block: shownBlock({ shown: clean, more, remaining: more ? left.length : null }),
  };
}
