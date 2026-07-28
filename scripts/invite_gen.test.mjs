import { catOf, excludeReason, normaliseCategory } from './invite_gen.mjs';

/* Three defects the first honest spread run surfaced, plus the regressions
   each fix could plausibly cause. A fix that drops paying customers to catch
   a youth club is not a fix. */

const DROP = [
  ["Bath Women's Badminton Club", 'Badminton Court'],
  ['Bath Netball Club', 'Sports Club'],
  ['Keynsham Cricket Club', 'Cricket Ground'],
  ['Avon Rowing Club', 'Rowing Club'],
  ['Larkhall Athletic Youth Football Club', 'Football Club'],
  ['Combe Down Minis Rfc', 'Rugby Club'],
  ['Bath Hockey Club', 'Sports Club'],
  ['Team Bath Athletics Club', 'Athletic Club'],
];

const KEEP = [
  ['The Golf Club Restaurant', 'Restaurant'],
  ['Club Lounge Bath', 'Night Club'],
  ['The Sports Bar', 'Bar'],
  ['Bath Racquets Club Hotel', 'Hotel'],
  ['Club Sandwich Deli', 'Deli'],
  ['A Yarn Story', 'Arts And Crafts'],
  ['Bath Bike Park', 'Bike Rentals'],
  ['Cycle Bath', 'Bicycle Store'],
];

const MAP = [
  ['A Yarn Story', 'Arts And Crafts', 'Shopping'],
  ['Bath Bike Park', 'Bike Rentals', 'Bike rental'],
  ['Bath Cycle Hire', 'Bicycle Rental Service', 'Bike rental'],
  ['Enterprise Bath', 'Car Rental Agency', 'Vehicle rental'],
  ['Victoria Art Gallery', 'Art Gallery', 'Gallery'],
  ['The Edge Arts Centre', 'Arts Centre', 'Gallery'],
];

let bad = 0;
for (const [n, c] of DROP) {
  const why = excludeReason({ name: n, category: c });
  if (!why) { console.log(`MISS  should drop: ${n} · ${c}`); bad++; }
}
for (const [n, c] of KEEP) {
  const why = excludeReason({ name: n, category: c });
  if (why) { console.log(`FALSE should keep: ${n} · ${c} → dropped as ${why}`); bad++; }
}
for (const [n, c, want] of MAP) {
  const got = normaliseCategory(c);
  if (got !== want) { console.log(`MAP   ${n} · ${c} → ${got} (want ${want})`); bad++; }
}

/* And the copy itself: a bike hire shop must not be offered a car, and a yarn
   shop must not be asked where the local art is. */
const bike = catOf('Bike Rentals', 'Bath Bike Park');
const yarn = catOf('Arts And Crafts', 'A Yarn Story');
if (/car|scooter/i.test(bike.noun + bike.asks.join(' '))) { console.log(`COPY  bike hire offered a car: ${bike.noun}`); bad++; }
if (/art\b/i.test(yarn.noun + yarn.asks.join(' ')))       { console.log(`COPY  yarn shop asked about art: ${yarn.noun}`); bad++; }

console.log(bad ? `\n${bad} failing` : `\nclean — ${DROP.length} drop, ${KEEP.length} keep, ${MAP.length} mapped, copy correct`);

/* shortName must never leave a hanging connector and must never eat a word.
   Both failure modes were live in the same run. */
import { shortName } from './invite_gen.mjs';
const NAMES = [
  ['1 The Paragon', '1 The Paragon'], ['The Paragon', 'The Paragon'],
  ['Camera Obscura & World of Illusions', 'Camera Obscura'],
  ['Bath Saturday Antique & Flea', 'Bath Saturday Antique'],
  ['Fish and Chips of Bath', 'Fish and Chips'], ['Marks and Spencer', 'Marks and Spencer'],
  ['Bath Inn', 'Bath Inn'], ['Onion', 'Onion'], ['Paddington', 'Paddington'],
  ['Bar Boulud at Mandarin', 'Bar Boulud'], ["Bill's", "Bill's"],
];
let nbad = 0;
for (const [inp, want] of NAMES) {
  const got = shortName(inp);
  if (got !== want) { console.log(`NAME  "${inp}" → "${got}" (want "${want}")`); nbad++; }
}
console.log(nbad ? `${nbad} name failures` : `shortName clean — ${NAMES.length} cases`);
