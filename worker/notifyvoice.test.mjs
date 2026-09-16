// The voice, made enforceable.
//
// num-VOICE-HOW-TO-BE-BELIEVED asked for a banned-phrase lint on outbound copy
// by name. This is it — plus a sweep over the copy module, so the rules apply to
// what NUM actually sends rather than to a document nobody rereads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint, clean, when, fit, who, LIMITS, BANNED } from './notifyvoice.mjs';
import * as C from './notifycopy.mjs';

/* ── the rules catch what they are for ─────────────────────────────────── */

test('controlling language is refused', () => {
  // 33-study meta-analysis: reactance r = .20 on control, null on framing.
  for (const bad of [
    'You should confirm before 6pm.',
    'You must reply to hold the table.',
    "Don't forget to bring your passport.",
    'Be sure to arrive early.',
    'You need to pick a time.',
  ]) {
    assert.ok(lint({ body: bad }).some((p) => p.id === 'deontic'), `missed: ${bad}`);
  }
});

test('accounting language is refused inside a conversation', () => {
  for (const bad of [
    'This is included in your plan.',
    'You have 3 requests remaining.',
    'Upgrade to get more.',
    '2 credits left this month.',
  ]) {
    assert.ok(lint({ body: bad }).some((p) => p.id === 'accounting'), `missed: ${bad}`);
  }
});

test('engagement bait is refused, which is the whole point of the file', () => {
  for (const bad of [
    "Haven't seen you in a while!",
    'Come back and see what is new.',
    'We miss you.',
    "It's been a while since your last trip.",
    "Don't miss out.",
    'Last chance to book.',
  ]) {
    assert.ok(lint({ body: bad }).some((p) => p.id === 'engagement-bait'), `missed: ${bad}`);
  }
});

test('help that spotlights the person is refused', () => {
  // Bolger & Amarel: noticed support tested WORSE than no support, d = 0.63-1.09.
  for (const bad of [
    'I saw you were struggling so I sorted it.',
    'I noticed you had trouble with this.',
    'You seemed unsure, so I went ahead and booked it.',
    'I took care of it for you.',
  ]) {
    assert.ok(lint({ body: bad }).some((p) => p.id === 'spotlight-support'), `missed: ${bad}`);
  }
});

test('claiming friendship is refused', () => {
  for (const bad of ["I'm your friend, so I sorted it.", 'As your friend, I would skip it.', "I've missed you."]) {
    assert.ok(lint({ body: bad }).length, `missed: ${bad}`);
  }
});

test('an invented reason is refused', () => {
  // Langer: at 20 pages a fake reason gave 24% vs 24%. Only a real one moved it.
  assert.ok(lint({ body: 'Booked it because we thought you would like it.' }).some((p) => p.id === 'hollow-because'));
  assert.ok(lint({ body: 'Since you might enjoy this, here it is.' }).some((p) => p.id === 'hollow-because'));
});

test('understated good news is refused', () => {
  // Gable: passive-constructive predicts POORER outcomes than no response.
  assert.ok(lint({ body: 'Nice, glad it worked out.' }).some((p) => p.id === 'passive-good-news'));
  assert.ok(lint({ body: 'Great, happy you enjoyed it.' }).some((p) => p.id === 'passive-good-news'));
});

test('telling someone to open the app is refused', () => {
  // The tap already opens it — the words are the only thing that could have been useful.
  assert.ok(lint({ body: 'Open Num to see it.' }).some((p) => p.id === 'open-the-app'));
  assert.ok(lint({ body: 'Tap here to view.' }).some((p) => p.id === 'open-the-app'));
});

test('an unresolved placeholder is caught before it reaches a lock screen', () => {
  // The worst possible failure: it arrives, it cannot be recalled, and it says
  // plainly that nobody looked.
  for (const bad of ['Hi undefined, your table is ready.', 'Table for {{name}}', 'You earned NaN', '[object Object] confirmed']) {
    assert.ok(lint({ body: bad }).some((p) => p.id === 'placeholder'), `missed: ${bad}`);
  }
});

test('length is enforced per line, because a phone cuts mid-thought', () => {
  assert.ok(lint({ title: 'x'.repeat(LIMITS.title + 1) }).some((p) => p.id === 'too-long'));
  assert.ok(lint({ body: 'x'.repeat(LIMITS.body + 1) }).some((p) => p.id === 'too-long'));
  assert.equal(lint({ title: 'x'.repeat(LIMITS.title) }).length, 0);
});

test('every rule carries the finding behind it', () => {
  // A ban with no reason gets argued away by whoever is writing copy at 2am.
  for (const r of BANNED) {
    assert.ok(r.why && r.why.length > 20, `${r.id} has no reason attached`);
    assert.ok(r.id && r.test instanceof RegExp);
  }
});

test('ordinary warm copy passes — the lint must not ban being human', () => {
  // A guardrail that refuses everything gets switched off in a week.
  for (const good of [
    "Table's at 8 — the corner one.",
    'Marco has her fuelled and the tender is in the water.',
    'Confirmed. Everything is set.',
    'Stripe confirmed it. The receipt is in your wallet.',
    "I'll tell you the moment it lands.",
  ]) {
    assert.deepEqual(lint({ body: good }), [], `false positive on: ${good}`);
  }
});

/* ── time, said the way a person says it ───────────────────────────────── */

const NOW = new Date('2026-09-14T04:00:00Z');

test('a stored wall clock is never shifted — this one sends people to the wrong boat', () => {
  // num_plans.starts_time is what the host typed, already local. Running it
  // through a Bangkok conversion turns 9am into 4pm and a member arrives seven
  // hours after their boat left.
  assert.match(when('2026-09-15 09:00:00', { now: NOW }), /Tomorrow, 9am/);
  assert.match(when('2026-09-18 19:30:00', { now: NOW }), /7:30pm/);
});

test('a real instant IS converted into their zone', () => {
  assert.match(when('2026-09-15T02:00:00Z', { now: NOW, tz: 'Asia/Bangkok' }), /9am/);
});

test('today and tomorrow are named, not counted', () => {
  assert.match(when('2026-09-14 20:00:00', { now: NOW }), /^Today/);
  assert.match(when('2026-09-15 09:00:00', { now: NOW }), /^Tomorrow/);
  assert.match(when('2026-09-18 19:30:00', { now: NOW }), /^Friday/, 'inside a week, a weekday is how people hold a plan');
  assert.match(when('2026-12-25 18:00:00', { now: NOW }), /25 Dec/, 'beyond a week, a date');
});

test('a time we cannot read is null, never a guess', () => {
  for (const junk of ['not a date', '', null, undefined]) assert.equal(when(junk, { now: NOW }), null);
});

/* ── names and trimming ────────────────────────────────────────────────── */

test('a first name, or nothing — never an invented one', () => {
  // An invented nickname is a brand mascot and reads as CRM.
  assert.equal(who('Marco Chen'), 'Marco');
  assert.equal(who(''), null);
  assert.equal(who(undefined), null);
  assert.equal(who('undefined'), null, 'the string "undefined" has reached production before');
});

test('trimming never leaves a word in pieces', () => {
  const out = fit('Marco has her fuelled and the tender is already in the water', 30);
  assert.ok(out.length <= 30);
  assert.ok(!out.endsWith(' '));
  assert.ok(!/\s\S{1,2}$/.test(out) || out.split(' ').pop().length > 2);
  assert.ok(!out.includes('…'), "the phone adds its own ellipsis — ours would be the second one");
});

/* ── the copy itself ───────────────────────────────────────────────────── */

test('EVERY line the copy module produces passes its own lint', () => {
  const now = NOW;
  const samples = [
    ['confirmed', C.confirmed({ what: 'Baan Rim Pa', at: '2026-09-15 20:00:00', where: 'Kalim Bay', detail: 'Table for four on the terrace.' })],
    ['confirmed bare', C.confirmed({ what: 'Baan Rim Pa' })],
    ['couldNot', C.couldNot({ what: 'Baan Rim Pa', why: 'Fully booked Saturday', alternative: 'Suay has 8pm.' })],
    ['couldNot bare', C.couldNot({ what: 'Baan Rim Pa' })],
    ['changed', C.changed({ what: 'Baan Rim Pa', to: '2026-09-15 21:00:00' })],
    ['paid', C.paid({ amount: '฿4,200', to: 'Baan Rim Pa' })],
    ['paymentFailed', C.paymentFailed({ amount: '฿4,200', what: 'Baan Rim Pa' })],
    ['earned', C.earned({ amount: '★240', from: 'Arroyo del Sol', nth: 3 })],
    ['earned unknown', C.earned({ amount: '★240' })],
    ['cashoutQueued', C.cashoutQueued({ amount: '★1,200' })],
    ['message', C.message({ from: 'Marco Chen', text: 'On my way.' })],
    ['message unknown', C.message({ text: 'On my way.' })],
    ['addedToPlan', C.addedToPlan({ by: 'Marco Chen', plan: 'Phi Phi day trip', at: '2026-09-15 09:00:00' })],
    ['planTomorrow', C.planTomorrow({ plan: 'Phi Phi day trip', at: '2026-09-15 09:00:00', where: 'Royal Phuket' })],
    ['suggestion', C.suggestion({ headline: 'Serenity II', fact: 'Saturday · Royal Phuket', because: 'The only day she is free this month.' })],
    ['nowPossible', C.nowPossible({ what: 'Sunset table at Suay', theirWords: 'somewhere on the water' })],
    ['howWasIt', C.howWasIt({ place: 'Baan Rim Pa' })],
  ];
  for (const [name, copy] of samples) {
    assert.deepEqual(lint(copy), [], `${name} violates the voice: ${JSON.stringify(lint(copy))}`);
  }
});

test('the title is the thing, not the category', () => {
  // "Baan Rim Pa" in the half-second before someone decides to look, never
  // "Reservation update".
  assert.equal(C.confirmed({ what: 'Baan Rim Pa' }).title, 'Baan Rim Pa');
  assert.equal(C.message({ from: 'Marco Chen' }).title, 'Marco');
  assert.equal(C.planTomorrow({ plan: 'Phi Phi day trip' }).title, 'Phi Phi day trip');
});

test('the subtitle carries the fact so the body can carry the sentence', () => {
  // Tomorrow is COMPUTED, not typed. This line used to read '2026-09-15', which
  // was tomorrow on the day it was written and became today the next morning —
  // so the test passed once and then failed every day after. A date literal in
  // an assertion about relative time is a bomb with a one-day fuse.
  // ...and computed in UTC, because a zoneless `at` is displayed in UTC. On a
  // Pacific evening the local date is still yesterday and "tomorrow" in local
  // time is "today" in UTC, which failed this test every night after 17:00.
  const t = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const at = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} 20:00:00`;
  const c = C.confirmed({ what: 'Baan Rim Pa', at, where: 'Kalim Bay', detail: 'The corner table.' });
  assert.match(c.subtitle, /Tomorrow, 8pm/);
  assert.match(c.subtitle, /Kalim Bay/);
  assert.equal(c.body, 'The corner table.');
});

test('no subtitle is emitted when there is no fact for it', () => {
  // An empty subtitle still reserves its line on some layouts, and a blank gap
  // under a title reads as something failing to load.
  assert.ok(!('subtitle' in C.confirmed({ what: 'Baan Rim Pa' })));
  assert.ok(!('subtitle' in C.message({ from: 'Marco', text: 'hi' })));
});

test('a refusal always ends in a choice', () => {
  const withAlt = C.couldNot({ what: 'x', alternative: 'Suay has 8pm.' });
  const without = C.couldNot({ what: 'x' });
  assert.match(withAlt.body, /Say the word/);
  assert.match(without.body, /\?$/, 'with nothing to offer, it has to ask rather than close');
});

test('a suggestion cannot be sent without a real reason', () => {
  // The riskiest category in the product, so the reason is required by the
  // caller and never defaulted here — a default would guarantee the invented kind.
  assert.equal(C.suggestion({ headline: 'x', because: 'The only Saturday she is free.' }).body, 'The only Saturday she is free.');
  assert.equal(C.suggestion({ headline: 'x' }).body, '', 'no reason must produce no sentence, not a filler one');
});

test('money copy drops its hedges', () => {
  // Fischer & Orasanu: hinting is what the first officer does, and 75% of the
  // accidents reviewed involved a failure to challenge.
  const f = C.paymentFailed({ amount: '฿4,200', what: 'Baan Rim Pa' });
  assert.ok(!/might|maybe|it seems|possibly|appears/i.test(f.title + f.body), 'no hedging on money');
  assert.match(f.body, /Nothing has been charged/, 'the reassurance is a fact, and it belongs in the same breath');
});

test('the permission ask promises a limit and an exit', () => {
  const a = C.askToTell({ about: 'your table is confirmed' });
  assert.match(a.body, /only/i);
  assert.match(a.body, /stop it any time/i);
  assert.ok(a.yes && a.no, 'declining has to be as easy as accepting');
  // Linted as in-app: this is a dialogue with room, not a lock screen. The
  // banned-phrase rules still apply; only the truncation limits do not.
  assert.deepEqual(lint({ title: a.title, body: a.body }, { surface: 'app' }), []);
  assert.ok(lint({ title: a.title }, { surface: 'push' }).some((p) => p.id === 'too-long'),
    'and the same line WOULD be too long as a push — the distinction has to be real');
});
