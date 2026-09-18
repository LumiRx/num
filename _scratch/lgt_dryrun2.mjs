const W='/Users/rick/NUM/code/num-site-fixes/worker/';
const { flightLink, stayLink, flightBlock, wantsFlight, wantsStay } = await import(W+'letsgo2trip.mjs');
const env = { LGT_PARTNER_ID:'num' };
console.log('prefilled flight link (as flighthandoff.mjs calls it):');
console.log(JSON.stringify(flightLink(env, { origin:'DXB', dest:'LHR', depart:'2026-10-14', return:'2026-10-21', adults:2 }), null, 1));
console.log('\nas index.mjs calls it in a chat turn — flightLink(env, {}):');
console.log(JSON.stringify(flightLink(env, {}), null, 1));
console.log('\nbad IATA is refused:', flightLink(env, { origin:'DUBAI', dest:'LHR' }));
console.log('\nintent gates:');
for (const t of ['cheapest flight to london in october','a quiet bar near the hotel','need a hotel in bangkok for 3 nights','get me to the airport'])
  console.log(`  flight=${String(wantsFlight(t)).padEnd(5)} stay=${String(wantsStay(t)).padEnd(5)} "${t}"`);
