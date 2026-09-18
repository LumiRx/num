import { flightLink, stayLink, surchargeLine, surchargeCs, band, expectedFor, lgtReady, newRef } from '/Users/rick/NUM/code/num-site-fixes/worker/letsgo2trip.mjs';
import { fulfilment } from '/Users/rick/NUM/code/num-site-fixes/worker/services.mjs';
import { handoffAvailable, dollars } from '/Users/rick/NUM/code/num-site-fixes/worker/flighthandoff.mjs';

const show = (label, env) => {
  console.log('\n===== ' + label + ' =====');
  console.log('lgtReady        :', lgtReady(env));
  const f = fulfilment(env);
  console.log('fulfilment      :', f.primary, '| backup:', f.backup, '|', f.why);
  const a = handoffAvailable(env);
  console.log('handoffAvailable:', JSON.stringify(a));
  console.log('surcharge       :', surchargeCs(env), 'cents =', dollars(surchargeCs(env)));
  const link = flightLink(env, { from:'DXB', to:'LHR', depart:'2026-10-14', ret:'2026-10-21', adults:1 });
  console.log('flightLink      :', link);
  console.log('stayLink        :', stayLink(env, 'Bangkok', { checkin:'2026-10-14', checkout:'2026-10-17' }));
  console.log('ref sample      :', newRef());
};

// what production looks like RIGHT NOW
show('TODAY (nothing set)', {});

// what it looks like the minute we set the slug, surcharge still on
show('GO-LIVE, surcharge still on', { LGT_PARTNER_ID:'num' });

// what it looks like if Tina confirms the surcharge is OFF
show('GO-LIVE, surcharge confirmed off', { LGT_PARTNER_ID:'num', LGT_SURCHARGE_CS:'0' });

console.log('\n===== THE SENTENCE A TRAVELLER SEES =====');
console.log(surchargeLine({ LGT_PARTNER_ID:'num' }));
console.log('\n--- with surcharge 0 ---');
console.log(JSON.stringify(surchargeLine({ LGT_PARTNER_ID:'num', LGT_SURCHARGE_CS:'0' })));

console.log('\n===== MONEY ON THEIR OWN $305.45 EXAMPLE =====');
const gross = 30545;
const b = band('flight', gross);
for (const r of b.readings) console.log(`  ${String(r.cs/100).padEnd(6)} USD  <- ${r.says}  (${r.src})`);
console.log(`  spread: $${(b.spread/100).toFixed(2)}  low $${(b.low/100).toFixed(2)}  high $${(b.high/100).toFixed(2)}`);
console.log('  expectedFor with no LGT_RATE set:', expectedFor({}, 'flight', gross), '(null = honest)');
console.log('  stripe 4.5% gateway on that booking: $' + (gross*0.045/100).toFixed(2));
for (const p of ['stay','esim','tour']) {
  const x = band(p, 100000);
  if (x) console.log(`  ${p} on $1000: $${(x.low/100).toFixed(2)}–$${(x.high/100).toFixed(2)}`);
}
