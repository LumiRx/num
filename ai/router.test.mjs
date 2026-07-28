/**
 * Router test — the point of this file is not that the code runs, it is that
 * the code routes the way a concierge would. Two failure modes matter and they
 * are not symmetric:
 *
 *   FALSE T0  — we answered a real question with a canned greeting. This is a
 *               visible product failure in front of a paying guest. Must be 0.
 *   FALSE T1  — we sent a supply question to the model with no partner list.
 *               Recoverable (looksWeak escalates) but wasteful. Must be 0.
 *   OVER-T2   — we spent 70B money on chit-chat. Costs money, not quality.
 *               Tolerated, but counted, because it is the whole savings case.
 */
import {
  route, matchT0, templateReply, looksWeak, estimateTokens, smallSystem,
} from './router.js';

let pass = 0, fail = 0;
const failures = [];

function check(msg, expectTier, note, guest = null, opts = {}) {
  const r = route(msg, guest, opts);
  const ok = r.tier === expectTier;
  if (ok) pass++;
  else { fail++; failures.push({ msg, want: expectTier, got: r.tier, why: r.why, note }); }
}

/* ---------- T0: nothing is being asked ---------- */
const T0 = [
  'hi', 'Hi!', 'hey', 'heyyy', 'Hello', 'hello!!!', 'good morning', 'yo',
  'thanks', 'Thank you', 'thx', 'ty', 'cheers', 'thanks!!', 'appreciate it',
  'ok', 'okay', 'Got it', 'sure', 'perfect', 'great', 'cool', 'noted', 'will do',
  'yes', 'nope',
  'bye', 'goodbye', 'see you', 'good night', 'ttyl',
  'help', 'menu', 'what can you do', 'what can you do?',
  '👍', '🙏', '❤️', '😊', '👍👍👍', '🙏🙏',
  // multilingual — each one self-identifies its language with zero detection
  'สวัสดีค่ะ', 'ขอบคุณมากค่ะ', 'โอเค',
  'спасибо', 'привет', 'хорошо', 'пока',
  '谢谢', '你好', '好的', '再见',
  'ありがとう', 'こんにちは', 'わかりました',
  '감사합니다', '안녕하세요',
  'gracias', 'hola', 'merci', 'danke', 'grazie', 'obrigado', 'ciao',
];
T0.forEach(m => check(m, 't0', 'template'));

/* ---------- The dangerous near-misses. A greeting with a question attached
     is a question. If any of these come back t0 the feature is unshippable. ---- */
const NOT_T0 = [
  ['hi, where should I eat tonight?',      't2'],
  ['hello! any good massage nearby?',      't2'],
  ['thanks! what about tomorrow?',         't2'],
  ['ok but where is it',                   't2'],
  ['good seafood?',                        't2'],
  ['great, can you book it',               't2'],
  ['yes please book a taxi',               't2'],
  ['bye — actually one more thing, I lost my passport', 't2'],
  ['help me, I have been robbed',          't2'],
  ['สวัสดีค่ะ แนะนำร้านอาหารหน่อย',              't2'],
  ['спасибо! а где лучший пляж?',           't2'],
  ['谢谢！附近有好的餐厅吗？',                  't2'],
  ['👍 now find me a boat',                't2'],
];
NOT_T0.forEach(([m, t]) => check(m, t, 'near-miss must not template'));

/* ---------- T2: supply, money, plans, or a bad day ---------- */
const T2 = [
  'best seafood restaurant tonight',
  'where can I get a massage',
  'any good bars near me',
  'recommend somewhere for dinner',
  'show me options for tomorrow',
  'book a table for 4 at 7pm',
  'I need a taxi to the airport',
  'can you arrange a boat trip',
  'pick me up at 9am',
  'my wallet was stolen',
  'I feel sick, where is a pharmacy',
  'the driver never showed up, I am furious',
  'I want a refund',
  'snorkelling tomorrow?',
  'jet ski rental',
  'ferry to the island',
  'แนะนำร้านซีฟู้ด',
  'где хороший ресторан',
  '附近有按摩店吗',
  'おすすめのレストランは',
  '맛집 추천해주세요',
  'dónde puedo comer bien',
  'je cherche un bon restaurant',
  // The commonest form of the question in any language: just the noun.
  'un bon restaurant?',
  'ein gutes Restaurant',
  'マッサージ',
  'спа',
  'ร้านอาหาร',
];
T2.forEach(m => check(m, 't2', 'must carry the partner list'));

// A guest with something outstanding always gets the full brain.
check('sounds good to me overall', 't2', 'open request in brain',
  { memory: '{"open_requests":["boat trip Thu"]}' });

// The caller's own category detector overrides everything.
check('somewhere for dinner', 't2', 'detectCat said so', null, { hasCategory: true });

/* ---------- T1: general knowledge and warmth, no supply lookup ---------- */
const T1 = [
  'is the water safe to drink here',
  'what is the weather like in november',
  'do I need to tip in thailand',
  'is it rainy season now',
  'what language do people speak here',
  'how do I say hello in thai',
  'is it safe to walk at night',
  'what currency do you use',
  'do people speak english',
  'I am so tired from the flight',
  'first time here, feeling a bit overwhelmed',
  'my wife and I are celebrating our anniversary',
  'what is the time difference to london',
  'are the beaches sandy or rocky',
];
T1.forEach(m => check(m, 't1', 'small model can answer this'));

/* ---------- Regression: unanchored foreign words eating English ----------
   Every string here is plain English containing the letters of a foreign
   trigger word. Before the _INTL/_LATIN split, "you use" matched the French
   "où" and "two " matched the German "wo" — so ordinary English chit-chat was
   being billed at 70B rates while every test still looked green. These are
   the canaries. */
const NO_FOREIGN_FALSE_POSITIVE = [
  'what currency do you use',      // "y-ou u-se"
  'is it about two hours away',    // "tw-o ", "ab-ou-t "
  'how long would you say',        // "w-ou-ld y-ou "
  'our group is quite large',      // "our "
];
NO_FOREIGN_FALSE_POSITIVE.forEach(m => check(m, 't1', 'must not read as a foreign trigger'));

/* ---------- Accepted over-triggering ----------
   These go to T2 and arguably did not need to. Each costs money, not quality,
   which is the direction this router is built to fail in. Listed rather than
   fixed, because tightening the patterns to win them back would risk missing
   the real request they resemble. */
const ACCEPTED_OVER_T2 = [
  ['how much is a taxi usually',  'price question, but "taxi" usually means the guest wants one'],
  ['are the pharmacies open late', '"pharmacy" is also a distress signal — worth the false alarm'],
  ['I dove straight in', 'English "dove" collides with Italian "dove" (where); kept because ' +
    'Italian guests ask "dove" constantly and English "dove" nearly always sits ' +
    'beside "dive/diving", which routes to T2 anyway'],
];
ACCEPTED_OVER_T2.forEach(([m, why]) => {
  const r = route(m, null);
  console.log(`  over-T2 (accepted): "${m}" → ${r.tier} · ${why}`);
});

/* ---------- Report ---------- */
console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} routed as expected`);
if (fail) {
  console.log('\nMisroutes:');
  for (const f of failures) {
    console.log(`  want ${f.want} got ${f.got}  "${f.msg}"`);
    console.log(`      router said: ${f.why}`);
  }
}

/* ---------- Rendering ---------- */
console.log('\nTemplate rendering:');
for (const [k, l, c] of [['greeting','en','Bath'], ['greeting','th','ภูเก็ต'], ['greeting','fr','Nice'],
                         ['thanks','ru',null], ['greeting','zh','普吉'], ['help','en',null]]) {
  const t = templateReply(k, l, c);
  console.log(`  ${k}/${l}: ${t ? t.split('\n')[0].slice(0, 78) : 'NO TEMPLATE (falls through to a model)'}`);
}
console.log(`  greeting/nl (unsupported): ${templateReply('greeting','nl','Amsterdam') ?? 'null — falls through, correct'}`);

/* ---------- Escalation ---------- */
console.log('\nEscalation from T1:');
for (const a of ['NEEDS_PARTNERS',
                 'I recommend Blue Elephant Restaurant, it is excellent.',
                 "I'm sorry, I don't have that information.",
                 'Yes!',
                 'November is the start of high season here — warm, dry and busy. Book ahead if you can!']) {
  console.log(`  ${String(looksWeak(a) ?? 'keep').padEnd(16)} ← "${a.slice(0, 58)}"`);
}

/* ---------- What this actually saves ---------- */
const T2_PROMPT = 1270 + 240 + 500;          // measured: system core + partners + brain
const t1p = estimateTokens(smallSystem('Phuket', '18:40'));
console.log('\nPrompt size, input tokens per message:');
console.log(`  T2  ~${T2_PROMPT}   (system core 1270 + partner list 240 + guest brain 500)`);
console.log(`  T1  ~${t1p}   (${(100 - t1p / T2_PROMPT * 100).toFixed(0)}% less than T2)`);
console.log('  T0   0');
console.log('\nToken estimator across scripts (same sentence):');
for (const [l, s] of [['en', 'Where is the best seafood restaurant near the beach?'],
                      ['th', 'ร้านซีฟู้ดที่ดีที่สุดใกล้ชายหาดอยู่ที่ไหน'],
                      ['zh', '海滩附近最好的海鲜餐厅在哪里？'],
                      ['ja', 'ビーチの近くで一番おいしい海鮮レストランはどこですか']]) {
  console.log(`  ${l}  ${String(s.length).padStart(3)} chars → ~${estimateTokens(s)} tokens`);
}

process.exit(fail ? 1 : 0);
