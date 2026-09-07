/**
 * HOW NUM SUGGESTS A PLACE. One standard, everywhere.
 *
 * ── WHY (6 Sep 2026) ──────────────────────────────────────────────────────
 *
 * Dre: "when suggesting places we need to provide a standard of text… look at
 * the way Nudge delivers to its users."
 *
 * What Nudge does well is not a font. It behaves like the friend who plans:
 * it names ONE specific place, says the single reason it is that place and not
 * the one next door, gives the two facts that decide whether you can actually
 * go, and stops. It sequences — "picnic here, then the bookshop two doors
 * down" — rather than listing four options and leaving the deciding to you.
 *
 * Num's answers drift because nothing writes that down. On a good turn the
 * model produces exactly this shape; on a tired turn it produces a paragraph
 * with three hedges and no address. The difference reaches a guest as
 * inconsistency, which reads as unreliability.
 *
 * ── WHAT THIS FILE IS ─────────────────────────────────────────────────────
 *
 * The rule, in one place, in words the model reads on every turn — plus the
 * shape the CARD renders, so the picture and the prose cannot disagree. It is
 * a house style, not a template: it constrains the shape of an answer, never
 * its content, and it never invents a fact.
 *
 * ── AMENDED 7 SEP 2026, FROM A SCREENSHOT ────────────────────────────────
 *
 * Dre sent a real thread: three massage places run together in one sentence
 * with their distances, no card and no link, then a follow-up that typed out a
 * street address and a phone number as prose. His words: "It is not organized
 * and it does not look clean… we are supposed to be giving the link to any
 * locations that we are suggesting and also if we are offering more than one
 * suggestion, it needs to be spaced and separated so that it can be easily
 * read."
 *
 * The cause was not a missing rule. It was two rules that disagreed. Rule 1
 * here said "ONE place per suggestion. Never a list of four" while the `reply`
 * schema in prompt.mjs said "fill `picks` with them… Three near you — the
 * first is what I would do". A model reading both does something different on
 * different turns, and inconsistency is what reaches a guest as unreliability.
 *
 * So rule 1 is now about WHERE a place goes, not how many: every place is a
 * pick, and picks are cards, and cards are separated and tappable by
 * construction. How many is rule 2's business, and the answer is still
 * "prefer one".
 *
 * ── THE ONE RULE UNDERNEATH ALL OF THEM ───────────────────────────────────
 *
 * Never say more than the directory knows. Every fact in a suggestion comes
 * from a verified row — the name, the distance, the hours, the price. A
 * sentence that sounds wonderful and cites nothing is the thing this file
 * exists to prevent, because a guest cannot tell the difference until they are
 * standing outside a closed door.
 */

/** The paragraph the brain reads on every turn that may recommend a place. */
export const SUGGESTION_STYLE = [
  'HOW YOU SUGGEST A PLACE — this is the house style, follow it every time:',
  '',
  '1. EVERY place you name goes in `picks`, one entry each — never written into the reply text. The app renders each pick as its own card with a tappable link, a call button, a map and the address. A place named only in a sentence is a place the guest cannot tap, cannot call and cannot find, and that is the difference between a concierge and a paragraph.',
  '2. PREFER ONE. You are the one who decides, that is the whole job. Where more than one genuinely earns its place — they asked to compare, or the first might be full — give two or three, each as its own pick, and say in one short line which ONE you would take and why. Never run several places together in a sentence: "A is 490m, B is 540m, and C is 520m" is a list the guest has to untangle, and it is exactly what the cards exist to replace.',
  '3. ONE line on why THIS one and not the place next door — the specific thing that makes it right for what they asked. Not "great food", not "a local favourite". A reason a friend would give.',
  '4. Then the facts that decide whether they can go: how far, whether it is open now, and the price if you have it. Only facts from the verified block. If you do not have a fact, leave it out — never estimate a distance, a price or an opening time.',
  '5. Sequence when it helps. "Dinner there, then the bar on the same street" is worth more than two separate suggestions, and it is the thing a search box cannot do.',
  '6. Stop. No summary of what you just said, no "let me know if you would like more options", no menu of alternatives. If they want another, they will say so.',
  '',
  'LENGTH: two or three short sentences per place. A guest reading on a phone with one thumb free will not read a paragraph, and a paragraph is usually a sign you were not sure.',
  'NEVER: bullet lists of venues, bold headings, emoji, "nestled", "hidden gem", "a must-visit", or any phrase you would not say out loud to somebody standing next to you.',
  'NEVER TYPE CONTACT DETAILS. No phone numbers, no street addresses, no web addresses in the reply text — ever. They ride on the card, where a thumb can tap them. A number written into a sentence is one a guest has to copy out by hand while standing in the street.',
  'ALWAYS: if the guest gave a constraint — a child, a wheelchair, halal, a budget, a time — answer that constraint explicitly in the first sentence. It is why they typed instead of searching.',
].join('\n');

/**
 * The card beside the words. The app already renders these fields
 * (src/components/app/PickCards.tsx); this names the ORDER they read in, so a
 * card and a sentence never disagree about which fact matters most.
 *
 * Image first is deliberate and is Dre's instruction: "people are more visual
 * now. less reading at the beginning more images and small info and click
 * deeper for more info."
 */
export const CARD_ORDER = Object.freeze([
  'photo',        // if we hold one with a licence to show it
  'name',         // the link — tapping the name opens the place
  'why',          // the one line from the reply, not a second description
  'facts',        // distance · open/closed · price — in that order, omitted when unknown
  'action',       // ask Num to hold a table, or the booking engine they use
]);

/** Facts in the order a guest actually needs them, and what each one requires. */
export const FACT_ORDER = Object.freeze([
  { key: 'distance', needs: 'km from the guest', omit_if: 'no coordinates' },
  { key: 'open', needs: 'hours in the venue’s own timezone', omit_if: 'no hours on file' },
  { key: 'price', needs: 'a price the business published itself', omit_if: 'never estimated' },
]);

/** Phrases that mean the answer stopped being specific. Checked by a test. */
export const BANNED = Object.freeze([
  'hidden gem', 'must-visit', 'must visit', 'nestled', 'bustling', 'vibrant',
  'something for everyone', 'a local favourite', 'local favorite',
  'whether you', 'look no further', 'foodie', 'plethora',
]);

/**
 * Does this reply follow the house style? Advisory, not a gate — it grades,
 * it does not refuse. A reply that trips this is worth a retry, not a
 * rejection: the guard in worker/router.mjs decides what is unsafe, and this
 * decides what is merely unlike us.
 */
export function styleNotes(reply) {
  const s = String(reply ?? '');
  const notes = [];
  const low = s.toLowerCase();
  for (const p of BANNED) if (low.includes(p)) notes.push(`stock phrase: "${p}"`);
  if (/^\s*[-*•]\s/m.test(s)) notes.push('bulleted list of venues');
  if (/\*\*/.test(s)) notes.push('bold headings');
  if (/[\u{1F300}-\u{1FAFF}]/u.test(s)) notes.push('emoji');
  if (s.split(/\n\s*\n/).length > 3) notes.push('too many paragraphs for a phone');
  return notes;
}
