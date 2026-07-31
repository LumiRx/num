import { verticalFor, toE164, VERTICALS } from '/Users/rick/num-concierge/claim/onboard.mjs';

// The measured GB/IE head of distribution, with the accented cafe as stored.
const CATS = [
  ['restaurant', 'restaurant'], ['convenience', 'shop'], ['street food', 'restaurant'],
  ['bar', 'bar'], ['café', 'cafe'], ['Café', 'cafe'], ['cafe', 'cafe'],
  ['beauty & spa', 'spa'], ['shopping', 'shop'], ['supermarket', 'shop'],
  ['hotel', 'hotel'], ['vehicle rental', 'transport'], ['gym & fitness', 'gym'],
  ['pharmacy', 'shop'], ['souvenirs & gifts', 'shop'], ['attraction', 'attraction'],
  ['bakery', 'cafe'], ['guesthouse', 'guesthouse'], ['wine & spirits', 'shop'],
  ['gallery', 'attraction'], ['nightlife', 'nightclub'], ['dessert', 'cafe'],
  ['massage & spa', 'massage'], ['museum', 'attraction'], ['theatre', 'attraction'],
  ['tours & travel', 'tour'], ['market', 'market'], ['deli', 'shop'],
  ['hostel', 'hostel'], ['apartment', 'guesthouse'], ['tailor', 'shop'],
  ['cinema', 'attraction'], ['hospital', 'clinic'], ['dentist', 'clinic'],
  ['retail', 'shop'], ['martial arts club', 'gym'], ['sports club and league', 'gym'],
  ['shoe store', 'shop'], ['arts and crafts', 'shop'], ['antique store', 'shop'],
  ['golf', 'attraction'], ['transport', 'transport'], ['bookstore', 'shop'],
  ['travel agents', 'tour'], ['carpet store', 'shop'], ['train station', 'transport'],
  ['food delivery service', 'restaurant'], ['home goods store', 'shop'],
  // long tail -> keyword ladder
  ['Italian restaurant', 'restaurant'], ['Indian Restaurant', 'restaurant'],
  ['womens clothing store', 'shop'], ['childrens clothing store', 'shop'],
  ['photography store and services', 'shop'], ['topic concert venue', 'event'],
  ['used vintage and consignment', 'other'], ['tattoo & piercing', 'salon'],
  ['viewpoint', 'attraction'], ['arts and entertainment', 'other'],
  // subcategory form, real separator
  ['Shopping · jewellery', 'shop'], ['Attraction · park', 'attraction'],
  // ordering guards: "barber shop" is a salon not a shop, "sports bar" is a
  // bar not a gym -- both only hold because the ladder is ordered narrow-first.
  ['Barber shop', 'salon'], ['Sports bar', 'bar'],
  // must not crash
  [null, 'other'], ['', 'other'], ['place of worship', 'other'],
  ['anglican church', 'other'], ['·', 'other'],
];

let bad = 0;
for (const [input, want] of CATS) {
  const got = verticalFor(input);
  if (got !== want) { bad++; console.log(`  MISMATCH ${JSON.stringify(input)} -> ${got} (wanted ${want})`); }
  if (!VERTICALS.has(got)) { bad++; console.log(`  OUT OF SET ${JSON.stringify(input)} -> ${got}`); }
}
console.log(`vertical: ${CATS.length - bad}/${CATS.length} as expected`);

const PHONES = [
  ['0131 555 1234', 'GB', '+441315551234'],
  ['+44 131 555 1234', 'GB', '+441315551234'],
  ['(0)20 7946 0958', 'GB', '+442079460958'],
  ['01 234 5678', 'IE', '+35312345678'],
  ['02 1234 5678', 'TH', '+66212345678'],
  ['06 1234567', 'IT', '+39061234567'],
  ['754-444-8885', 'US', '+17544448885'],
  ['+66 2 123 4567', 'TH', '+6621234567'],
  ['123', 'GB', null],
  [null, 'GB', null],
  ['0131 555 1234', 'ZZ', null],
  ['0131 555 1234', null, null],
];
let pbad = 0;
for (const [raw, cc, want] of PHONES) {
  const got = toE164(raw, cc);
  if (got !== want) { pbad++; console.log(`  MISMATCH ${raw} / ${cc} -> ${got} (wanted ${want})`); }
}
console.log(`e164: ${PHONES.length - pbad}/${PHONES.length} as expected`);
