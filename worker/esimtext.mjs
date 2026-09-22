// "Just text ESIM" — the whole purchase inside a text thread.
//
//   traveller: ESIM BKK
//   Num:       Thailand eSIM, data only / 1) 3GB 7 days $2.49 / 2) ... / Reply 1, 2 or 3
//   traveller: 2
//   Num:       ... Pay here (Apple Pay works): <link>
//   (pays)     -> install link arrives in the same thread, and the concierge
//                 is right there for the rest of the trip.
//
// Sits in the inbound SMS/WhatsApp handler after STOP/HELP and before the
// concierge. Anything it does not recognise falls through to the concierge
// untouched ({ handled: false }).

import { resolveDestination, countryName, norm } from './esimplaces.mjs';
import { picks } from './esimcatalogue.mjs';
import { sms } from './esimcopy.mjs';
import * as O from './esimorders.mjs';
import { plansIn, planByCode } from './esimstore.mjs';

export function isEsimKeyword(body) {
  const w = norm(body).split(' ');
  return w[0] === 'esim' || w[0] === 'esims' || (w[0] === 'e' && w[1] === 'sim');
}

const DAY = 24 * 3600e3;

function destFor(resolved) {
  if (resolved.kind === 'region') return { label: resolved.label, region: resolved.region };
  const name = countryName(resolved.country) || resolved.country;
  return { label: name, country: resolved.country, airport: resolved.kind === 'airport' ? resolved.airport[0] : null };
}

async function offer(db, from, resolved) {
  if (resolved.kind === 'none') {
    await O.saveMenu(db, from, 'dest', {});
    return { handled: true, reply: sms.askDestination() };
  }
  if (resolved.kind === 'ambiguous') {
    await O.saveMenu(db, from, 'dest', {});
    return { handled: true, reply: sms.ambiguous(resolved.options) };
  }
  const dest = destFor(resolved);
  const plans = await plansIn(db, dest.region ? { region: dest.region } : { country: dest.country });
  if (!plans.length) {
    await O.clearMenu(db, from);
    return { handled: true, reply: sms.noPlans(dest.label) };
  }
  const chosen = picks(plans);
  await O.saveMenu(db, from, 'pick', { dest, options: chosen.map((p) => ({ provider: p.provider, code: p.code, priceCs: p.priceCs })) });
  return { handled: true, reply: sms.menu(dest.label, chosen) };
}

/**
 * @param {object} deps { origin, recordConsent?(phone, source), salesOpen?() }
 * @returns {{handled:boolean, reply?:string, orderId?:string}}
 */
export async function handleEsimText(env, db, { from, body, channel = 'sms' }, deps = {}) {
  if (!O.validPhone(from)) return { handled: false };
  const text = String(body || '');

  if (isEsimKeyword(text)) {
    // They wrote to us first and asked for this: replies about it are
    // transactional. Recorded so the register agrees with what we send.
    if (deps.recordConsent) await deps.recordConsent(from, `inbound:ESIM:${channel}`).catch(() => null);
    if (deps.salesOpen && !(await deps.salesOpen())) return { handled: true, reply: sms.paused() };
    return offer(db, from, resolveDestination(text));
  }

  const menu = await O.getMenu(db, from);
  if (!menu) return { handled: false };

  if (menu.stage === 'dest') {
    const resolved = resolveDestination(text);
    if (resolved.kind === 'none') { await O.clearMenu(db, from); return { handled: false }; }
    return offer(db, from, resolved);
  }

  // stage 'pick'
  const m = /^\s*([1-9])\s*[.)!]?\s*$/.exec(text);
  if (!m) return { handled: false };
  const n = Number(m[1]);
  const options = menu.data?.options || [];
  if (n < 1 || n > options.length) {
    return { handled: true, reply: `Num: reply ${options.length === 1 ? '1' : `a number from 1 to ${options.length}`}, or send ESIM and a country to start again.` };
  }
  if (deps.salesOpen && !(await deps.salesOpen())) return { handled: true, reply: sms.paused() };

  const since = new Date(Date.now() - DAY).toISOString();
  if ((await O.countRecent(db, { phone: from, sinceIso: since, paidOnly: true })) >= 3 || (await O.countRecent(db, { phone: from, sinceIso: new Date(Date.now() - 3600e3).toISOString() })) >= 10) {
    return { handled: true, reply: sms.tooMany() };
  }

  const pick = options[n - 1];
  const plan = await planByCode(db, pick.provider, pick.code);
  if (!plan) return offer(db, from, menu.data.dest.region ? { kind: 'region', region: menu.data.dest.region, label: menu.data.dest.label } : { kind: 'country', country: menu.data.dest.country });

  const q = await O.createQuote(db, { plan, dest: menu.data.dest, channel, phone: from, smsOk: true });
  if (!q.ok) return { handled: true, reply: sms.paused() };
  await O.clearMenu(db, from);
  return { handled: true, reply: sms.payLink(q.order, `${deps.origin}/esim/pay/${q.order.token}`), orderId: q.order.id };
}
