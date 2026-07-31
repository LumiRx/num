/**
 * Guard: when we could not work out where the guest is, no prompt may name a
 * city. This is the check that stops a guest in London being told they are in
 * Phuket — the thing that made the concierge look wrong in 37 of our 38
 * countries. Run: node ai/unknown-city.test.mjs
 */
import { SYSTEM } from './worker.js';
import { smallSystem } from './router.js';

const dest = { slug: 'phuket', name: 'Phuket', country: 'TH', tz: 'Asia/Bangkok', lat: 7.953, lng: 98.338 };
const guest = { display_name: 'Alex', memory: null, prefs: null };

const guessed = { dest, rows: [], label: null, precise: false, source: 'city_centre', guessed: true };
const resolved = { dest, rows: [], label: null, precise: false, source: 'named', guessed: false };

let fail = 0;
const check = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fail++; };

const unknown = SYSTEM(guessed, guest, 'Mon, 27 Jul, 18:40', null, {});
const placed = SYSTEM(resolved, guest, 'Mon, 27 Jul, 18:40', null, {});

console.log('t2 prompt, location unknown:');
check('never names the fallback city', !/Phuket/i.test(unknown));
check('never names the fallback country', !/\bTH\b/.test(unknown));
check('says the city is unknown', /CITY: UNKNOWN/.test(unknown));
check('tells Num to ask', /Ask once, warmly/.test(unknown));
check('does not assert a local time', !/LOCAL TIME THERE/.test(unknown));

console.log('t2 prompt, location resolved (unchanged behaviour):');
check('still states the city', /GUEST IS IN: Phuket, TH/.test(placed));
check('still states the local time', /LOCAL TIME THERE: Mon, 27 Jul/.test(placed));

console.log('t1 prompt:');
const t1unknown = smallSystem(null, null);
const t1placed = smallSystem('Phuket', 'Mon, 27 Jul, 18:40');
check('unknown names no city', !/Phuket/i.test(t1unknown));
check('unknown asks instead', /which city they are in/.test(t1unknown));
check('resolved still names the city', /messaging you from Phuket/.test(t1placed));

console.log(fail ? `\nFAIL — ${fail} assertion(s)` : '\nPASS — location honesty holds');
process.exit(fail ? 1 : 0);
