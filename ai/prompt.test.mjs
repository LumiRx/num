/**
 * Prompt-assembly test.
 *
 * The t2 system prompt is the single largest recurring cost in NUM: it is sent
 * in full on every message that reaches the big model. Three blocks of it are
 * now conditional, and a conditional block has two ways to go wrong that a
 * human re-reading the file will not catch:
 *
 *   1. it travels when it shouldn't — the saving silently never happens, and
 *      nothing looks broken;
 *   2. it is missing when it should be there — the concierge stops asking for
 *      a pickup point, or meets a robbed guest with a restaurant list.
 *
 * Both are invisible from the outside, which is exactly why they are tested.
 * The last section prints the actual byte and token cost of each shape, so the
 * savings claim in the console is one somebody can check rather than believe.
 */
import { SYSTEM } from './worker.js';
import { estimateTokens, detectSignals } from './router.js';

const place = {
  dest: { name: 'Phuket', country: 'Thailand', slug: 'phuket', tz: 'Asia/Bangkok' },
  label: 'Kata Beach', precise: true,
  rows: [
    { name: 'Bang Tao Seafood', category: 'restaurant', area: 'Bang Tao', km: 0.4, rating: 4.6, reviews: 812, phone: '+66 76 000 000' },
    { name: 'Kata Thai Massage', name_local: 'กะตะไทยมาสสาจ', category: 'spa', area: 'Kata', km: 0.9, rating: 4.4, reviews: 233 },
  ],
};
const guest = { display_name: 'Rick', prefs: 'seafood, diving', memory: '{"party":"couple","trip_stage":"mid_trip"}' };
const guide = 'Kata and Karon are the calm south-west beaches; Patong is the loud one.';

const SEA     = '- Boats, jet-ski, water sports & transfers:';
const PRODUCT = '- Product asks (sunscreen, water';
const PSYCH   = 'TRAVEL PSYCHOLOGY';
const EMPATHY = '- If something has gone wrong for the guest, open with';

let pass = 0, fail = 0;
function expect(label, cond) {
  if (cond) pass++; else { fail++; console.log(`  FAIL — ${label}`); }
}

/* Each case is a real message, run through the real signal detector, so this
   tests the path the worker actually takes rather than a hand-built object. */
const CASES = [
  { msg: 'best seafood restaurant tonight',      sea: false, product: false, psych: false },
  { msg: 'can you arrange a boat trip tomorrow', sea: true,  product: false, psych: false },
  { msg: 'I need a taxi to the airport',         sea: true,  product: false, psych: false },
  { msg: 'where can I buy sunscreen',            sea: false, product: true,  psych: false },
  { msg: 'my wallet was stolen',                 sea: false, product: false, psych: true  },
  { msg: 'first time here, feeling overwhelmed', sea: false, product: false, psych: true  },
  { msg: 'jet ski rental, and some flip flops',  sea: true,  product: true,  psych: false },
];

// The worker computes `product` itself from its partner catalogue; mirror that.
const PRODUCT_WORDS = /\b(sunscreen|sun cream|spf|flip ?flops?|beer|swimsuit|swimwear|towel|sim card|goggles|bottled water)\b/i;

console.log('Conditional blocks:');
for (const c of CASES) {
  const sig = { ...detectSignals(c.msg), product: PRODUCT_WORDS.test(c.msg) };
  const p = SYSTEM(place, guest, 'Mon, 27 Jul, 18:40', guide, sig);

  expect(`"${c.msg}" sea block`,     p.includes(SEA)     === c.sea);
  expect(`"${c.msg}" product block`, p.includes(PRODUCT) === c.product);
  expect(`"${c.msg}" psych block`,   p.includes(PSYCH)   === c.psych);
  // The empathy rule is the one thing that must never simply vanish: either the
  // full psychology block is attached, or the one-line version is.
  expect(`"${c.msg}" empathy present exactly once`,
    (p.includes(PSYCH) ? 1 : 0) + (p.includes(EMPATHY) ? 1 : 0) === 1);
  // Assembly hygiene — a dropped block must not leave a hole in the document.
  expect(`"${c.msg}" no triple newline`, !/\n{3}/.test(p));
  expect(`"${c.msg}" no orphaned bullet join`, !/\n- [^\n]*\$\{/.test(p));

  const flags = [c.sea && 'sea', c.product && 'product', c.psych && 'psych'].filter(Boolean).join('+') || 'none';
  console.log(`  ${String(estimateTokens(p)).padStart(4)} tok  [${flags.padEnd(15)}] ${c.msg}`);
}

/* Invariants — things that must be in EVERY t2 prompt regardless of routing.
   These are the rules that stop the model inventing a business or answering in
   the wrong language; a conditional refactor is exactly the kind of change
   that could drop one by accident. */
console.log('\nAlways present, whatever the signals:');
const bare = SYSTEM(place, guest, 'Mon, 27 Jul, 18:40', guide, {});
for (const [label, needle] of [
  ['reply in the guest\'s language', 'ALWAYS reply in the same language'],
  ['never invent a business',        'NEVER invent a business'],
  ['partner list attached',          'VERIFIED PARTNERS'],
  ['the actual partner rows',        'Bang Tao Seafood'],
  ['guest brain attached',           'GUEST BRAIN'],
  ['destination knowledge',          'PHUKET KNOWLEDGE'],
  ['REPORT correction flow',         'REPORT'],
]) { expect(label, bare.includes(needle)); console.log(`  ${bare.includes(needle) ? 'ok  ' : 'MISS'} ${label}`); }

/* What the conditional assembly actually saves. The "all blocks" figure is
   what every message used to cost, because before this change all three blocks
   travelled unconditionally. */
const all  = SYSTEM(place, guest, 'Mon, 27 Jul, 18:40', guide,
  { sea: true, arranging: true, product: true, trouble: true, feeling: true });
const none = bare;
console.log('\nCost of the t2 system prompt:');
console.log(`  every message, before this change   ${String(estimateTokens(all)).padStart(5)} tok  (${all.length} chars)`);
console.log(`  a plain "where's good for dinner"   ${String(estimateTokens(none)).padStart(5)} tok  (${none.length} chars)`);
console.log(`  saved on the common case            ${String(estimateTokens(all) - estimateTokens(none)).padStart(5)} tok  ` +
  `(${((1 - estimateTokens(none) / estimateTokens(all)) * 100).toFixed(0)}% of the prompt)`);

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} prompt assertions`);
process.exit(fail ? 1 : 0);
