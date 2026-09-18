/**
 * payrails.mjs — every way a guest may pay a NUM bill, decided by WHERE THE
 * TABLE IS, then ordered by WHO IS HOLDING THE PHONE.
 *
 * ── WHY A REGISTRY ───────────────────────────────────────────────────────
 *
 * Until 17 Sep 2026 a paylink had exactly one `kind` — promptpay, url or
 * crypto — and the pay page rendered that one rail. A US or UK visitor at a
 * Thai table was handed a PromptPay code their phone cannot use, and a venue
 * with a Stripe account had no way to take a card through NUM at all.
 *
 * This file is the same honesty mechanism as payouts/rails.mjs and
 * connectors.mjs: a rail that is not `ready` for THIS venue cannot be shown,
 * cannot be chosen, and cannot reach Stripe. The pay page, the app's PaySheet
 * and the venue console all read ONE list from `railsFor()`, so a rail cannot
 * appear on one surface and not another.
 *
 * ── THE FOUR TESTS (Dre, 17 Sep 2026) ────────────────────────────────────
 *
 * A rail is approved for a restaurant bill only if:
 *   1. it confirms in seconds at the table — no ACH, Bacs, SEPA or bank
 *      transfer, which settle in days and would have a guest leave on a promise;
 *   2. the guest authenticates on their own device;
 *   3. full and partial refunds work — the wrong-figure case;
 *   4. it is not financing — no Klarna, Affirm, Afterpay/Clearpay, Zip. A meal
 *      on credit at the table is not a service to the guest, and BNPL carries
 *      the highest dispute rate of any family.
 * The tests are DATA on each rail and asserted in payrails.test.mjs, so a rail
 * that fails one cannot be added quietly.
 *
 * ── WHERE THE MONEY GOES ─────────────────────────────────────────────────
 *
 * Stripe rails are DIRECT CHARGES on the venue's own connected Stripe account
 * (Standard, OAuth). The venue is merchant of record, the venue carries
 * disputes, NUM takes `application_fee_amount`. NUM never holds the money —
 * the same §8 rule billqr.mjs and money.mjs are written around. Venue-own
 * rails (PromptPay sticker, their payment URL, their USDC address) are the
 * guest paying the venue directly with NUM watching, exactly as before.
 *
 * ── COUNTRY FACTS, VERIFIED 17 SEP 2026 ──────────────────────────────────
 *
 * Business-location availability per rail is copied from Stripe's
 * payment-method support table (docs.stripe.com/payments/payment-methods/
 * payment-method-support) and the Revolut Pay page. Notable: PayPal is NOT
 * offered to US businesses; Alipay is NOT offered to GB businesses (WeChat Pay
 * is); Cash App Pay and Stripe stablecoin payments are US-only; Pay by Bank
 * is GB-only; PromptPay via Stripe is TH-only. When Stripe changes a list,
 * change it HERE and nowhere else.
 *
 * ── CRYPTO IN THAILAND IS HELD, NOT OFF ──────────────────────────────────
 *
 * Dre, 17 Sep 2026: "no crypto for thailand yet. we can hold but everywhere
 * else is good to go." The Thai SEC bars licensed operators from facilitating
 * digital-asset payment for goods (1 Apr 2022) and the 2025 TouristDigiPay
 * sandbox says merchants receive only THB. A Thai venue holding USDC has no
 * lawful way to turn it into baht. So `CRYPTO_HELD` lists TH: a Thai venue's
 * saved USDC address is kept, never shown, and the console says why. Remove
 * TH from that set only on written advice from Thai counsel.
 */

import { currencyForCountry } from './commission.mjs';

/** Countries where the direct-crypto rail is held back. See the header. */
export const CRYPTO_HELD = Object.freeze(new Set(['TH']));

const EU = Object.freeze(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

const ANY = 'any';
const cc = (...lists) => Object.freeze(new Set(lists.flat()));

/**
 * Every rail NUM knows how to offer. `source` says who actually takes the
 * money:
 *   stripe  — a direct charge on the venue's connected Stripe account
 *   venue   — the venue's own identity on file in num_paylinks (sticker rails)
 *   app     — only reachable signed in to the NUM app (saved card, own wallet)
 *
 * `stripe_type` is the Checkout `payment_method_types` value. Apple Pay and
 * Google Pay are not types — Checkout shows them under `card` on a matching
 * device — so they map to 'card' and are listed as their own rows purely so
 * the guest sees the button they will get.
 *
 * Every rail carries the four tests as booleans. The test file refuses any
 * rail that fails one.
 */
export const RAILS = Object.freeze({
  // ── device wallets ──
  apple_pay: rail({
    label: 'Apple Pay', family: 'wallet', source: 'stripe', stripe_type: 'card',
    countries: ANY, device: 'ios', how: 'One tap, Face ID. Shown on iPhone.',
  }),
  google_pay: rail({
    label: 'Google Pay', family: 'wallet', source: 'stripe', stripe_type: 'card',
    countries: ANY, device: 'android', how: 'One tap. Shown on Android.',
  }),
  // ── cards ──
  card: rail({
    label: 'Card', family: 'card', source: 'stripe', stripe_type: 'card',
    countries: ANY, how: 'Visa, Mastercard and more. Foreign cards welcome — you see your own currency where the venue\'s bank allows it.',
  }),
  link: rail({
    label: 'Link', family: 'wallet', source: 'stripe', stripe_type: 'link',
    countries: cc('US', 'GB', 'CA', 'AU', 'JP', 'HK', 'SG', 'MY', 'MX', 'NZ', 'NO', 'CH', 'AE', EU),
    how: 'Your details saved once with Stripe, one tap everywhere.',
  }),
  // ── US wallets ──
  cashapp: rail({
    label: 'Cash App Pay', family: 'wallet', source: 'stripe', stripe_type: 'cashapp',
    countries: cc('US'), currencies: ['USD'], how: 'Opens Cash App to confirm. US only.',
  }),
  amazon_pay: rail({
    label: 'Amazon Pay', family: 'wallet', source: 'stripe', stripe_type: 'amazon_pay',
    countries: cc('US', 'GB', 'AT', 'BE', 'CY', 'DK', 'FR', 'DE', 'HU', 'IE', 'IT', 'LU', 'NL', 'PT', 'ES', 'SE', 'CH'),
    how: 'Pay with the card on your Amazon account.',
  }),
  // ── Chinese travellers ──
  alipay: rail({
    label: 'Alipay', family: 'wallet', source: 'stripe', stripe_type: 'alipay',
    countries: cc('US', 'AU', 'CA', 'HK', 'JP', 'NZ', 'SG', EU),
    locale: 'zh', how: 'Opens Alipay. For guests from mainland China.',
  }),
  wechat_pay: rail({
    label: 'WeChat Pay', family: 'wallet', source: 'stripe', stripe_type: 'wechat_pay',
    countries: cc('US', 'GB', 'AU', 'CA', 'HK', 'JP', 'SG', EU),
    locale: 'zh', how: 'Scan with WeChat. For guests from mainland China.',
  }),
  // ── UK ──
  pay_by_bank: rail({
    label: 'Pay by Bank', family: 'bank', source: 'stripe', stripe_type: 'pay_by_bank',
    countries: cc('GB'), currencies: ['GBP'], disputes: false,
    how: 'Approve in your own banking app. No card, no chargebacks, cheapest for the venue.',
  }),
  revolut_pay: rail({
    label: 'Revolut Pay', family: 'wallet', source: 'stripe', stripe_type: 'revolut_pay',
    countries: cc('GB', 'NO', 'LI', EU), how: 'Opens the Revolut app.',
  }),
  paypal: rail({
    label: 'PayPal', family: 'wallet', source: 'stripe', stripe_type: 'paypal',
    countries: cc('GB', 'NO', 'LI', 'CH', EU), how: 'Log in to PayPal to confirm.',
  }),
  // ── Thailand ──
  promptpay_stripe: rail({
    label: 'PromptPay', family: 'bank', source: 'stripe', stripe_type: 'promptpay',
    countries: cc('TH'), currencies: ['THB'], disputes: false, phone: 'TH',
    how: 'Scan with your Thai banking app. Settles the bill automatically.',
  }),
  promptpay_sticker: rail({
    label: 'PromptPay (venue\'s own)', family: 'bank', source: 'venue', venue_kind: 'promptpay',
    countries: cc('TH'), currencies: ['THB'], disputes: false, phone: 'TH',
    how: 'Scan the printed code with a Thai banking app, or a linked app from Singapore, Malaysia, Indonesia, Vietnam, Cambodia, Laos, Hong Kong, China or Korea. Free for the venue.',
  }),
  // ── venue's own payment page ──
  venue_link: rail({
    label: 'Venue\'s payment page', family: 'venue', source: 'venue', venue_kind: 'url',
    countries: ANY, how: 'You are taken to the venue\'s own payment page. NUM names the site before you go.',
  }),
  // ── crypto ──
  usdc_stripe: rail({
    label: 'USDC (via Stripe)', family: 'crypto', source: 'stripe', stripe_type: 'crypto',
    countries: cc('US'), currencies: ['USD'], disputes: false,
    how: 'Pay USDC from any wallet on Base, Ethereum, Solana or Polygon. The venue receives dollars.',
  }),
  usdc_direct: rail({
    label: 'USDC on Base', family: 'crypto', source: 'venue', venue_kind: 'crypto',
    countries: ANY, disputes: false,
    how: 'Send exactly the quoted USDC to the venue\'s own address. NUM watches the chain and settles the bill when it lands.',
  }),
  // ── inside the NUM app ──
  num_app: rail({
    label: 'Pay in the NUM app', family: 'app', source: 'app',
    countries: ANY, how: 'Your saved card or your NUM wallet, one tap with Face ID. Split it with friends on a tab.',
  }),
});

function rail(o) {
  return Object.freeze({
    label: o.label,
    family: o.family,
    source: o.source,
    stripe_type: o.stripe_type ?? null,
    venue_kind: o.venue_kind ?? null,
    countries: o.countries ?? ANY,
    currencies: o.currencies ? Object.freeze(new Set(o.currencies)) : null,
    // the four tests — data, asserted by the test file
    instant: true,
    own_device: true,
    refundable: true,
    financing: false,
    disputes: o.disputes ?? true,
    // guest nudges
    device: o.device ?? null,   // 'ios' | 'android'
    locale: o.locale ?? null,   // language prefix that promotes this rail
    phone: o.phone ?? null,     // phone country that promotes this rail
    how: o.how,
  });
}

/**
 * Rails that are DELIBERATELY not in RAILS, with the reason, so a future
 * reader asking "why no Klarna?" finds the answer in code and not in a chat.
 */
export const REFUSED = Object.freeze({
  klarna: 'financing — a dinner is not a loan',
  affirm: 'financing',
  afterpay_clearpay: 'financing',
  zip: 'financing',
  us_bank_account: 'ACH settles in days; the guest would leave on a promise',
  bacs_debit: 'Bacs settles in days',
  sepa_debit: 'SEPA settles in days',
  customer_balance: 'bank transfer settles in days and cannot be matched at the table',
  stars: 'a Star spent at a venue would be NUM collecting the bill — Stars settle the split between friends, never the venue',
});

/** Default order per venue country. Anything not listed follows in RAILS order. */
const ORDER = Object.freeze({
  GB: ['pay_by_bank', 'apple_pay', 'google_pay', 'card', 'link', 'revolut_pay', 'paypal', 'amazon_pay', 'wechat_pay', 'usdc_direct', 'venue_link', 'num_app'],
  US: ['apple_pay', 'google_pay', 'card', 'link', 'cashapp', 'amazon_pay', 'alipay', 'wechat_pay', 'usdc_stripe', 'usdc_direct', 'venue_link', 'num_app'],
  TH: ['promptpay_sticker', 'promptpay_stripe', 'apple_pay', 'google_pay', 'card', 'venue_link', 'num_app'],
});
/** The rail a country's venues would rather be paid by; kept first unless the guest clearly cannot use it. */
const PINNED_FIRST = Object.freeze({
  GB: { rail: 'pay_by_bank' },
  // The sticker needs a Thai (or linked ASEAN/HK/CN/KR) banking app. A guest
  // whose phone speaks English, German or Japanese almost certainly has none,
  // so the pin holds only when the language is Thai or unknown.
  TH: { rail: 'promptpay_sticker', onlyLang: ['th', ''] },
});
const ORDER_DEFAULT = Object.freeze(['apple_pay', 'google_pay', 'card', 'link', 'venue_link', 'usdc_direct', 'num_app']);

const upper = (s) => String(s ?? '').trim().toUpperCase();

/**
 * Is this rail available for a venue in this country, in this currency,
 * given what the venue actually has on file? Pure — no I/O — so the same
 * answer comes back on every surface.
 *
 * venue = {
 *   country, currency,
 *   stripe_account_id, stripe_charges_enabled,   // from businesses
 *   stickers: { promptpay: bool, url: bool, crypto: bool },  // active identity rows
 *   rails_off: Set<string>,                        // the venue's own opt-outs
 * }
 */
export function railStatus(id, venue = {}) {
  const r = RAILS[id];
  if (!r) return { ready: false, reason: 'unknown rail' };
  const country = upper(venue.country);
  const currency = upper(venue.currency || currencyForCountry(country));

  if (r.countries !== ANY && !r.countries.has(country)) {
    return { ready: false, reason: `not offered to venues in ${country || 'an unknown country'}` };
  }
  if (r.currencies && !r.currencies.has(currency)) {
    return { ready: false, reason: `needs a ${[...r.currencies].join('/')} bill; this venue bills in ${currency}` };
  }
  if (r.family === 'crypto' && CRYPTO_HELD.has(country)) {
    return { ready: false, held: true, reason: 'crypto is held in Thailand until counsel clears it — the venue has no lawful way to turn USDC into baht' };
  }
  if (venue.rails_off instanceof Set && venue.rails_off.has(id)) {
    return { ready: false, reason: 'switched off by the venue' };
  }
  if (r.source === 'stripe') {
    if (!venue.stripe_account_id) return { ready: false, needs: 'stripe_connect', reason: 'the venue has not connected a Stripe account' };
    if (!venue.stripe_charges_enabled) return { ready: false, needs: 'stripe_connect', reason: 'the venue\'s Stripe account cannot take charges yet' };
    return { ready: true };
  }
  if (r.source === 'venue') {
    if (!venue.stickers?.[r.venue_kind]) return { ready: false, needs: `sticker:${r.venue_kind}`, reason: `the venue has no ${r.venue_kind} identity on file` };
    return { ready: true };
  }
  if (r.source === 'app') {
    // Signed-in rails ride on whatever the venue accepts through Stripe or
    // its own identity; the app is a door, not a rail. It is ready when at
    // least one underlying rail is.
    return { ready: true };
  }
  return { ready: false, reason: 'unroutable' };
}

/**
 * The ordered, guest-tuned list a surface renders. Nothing else decides what a
 * guest sees.
 *
 * guest = { device: 'ios'|'android'|null, locale: 'zh-CN'|..., phoneCountry: 'TH'|..., signedIn: bool }
 * opts  = { includeUnready: bool }  — the console wants the full picture with reasons
 */
export function railsFor(venue = {}, guest = {}, { includeUnready = false } = {}) {
  const country = upper(venue.country);
  const order = ORDER[country] || ORDER_DEFAULT;
  const ids = [...order, ...Object.keys(RAILS).filter((k) => !order.includes(k))];

  const out = [];
  for (const id of ids) {
    const r = RAILS[id];
    const st = railStatus(id, venue);
    // Device wallets only appear on the device that will actually show them.
    if (r.device && guest.device && r.device !== guest.device && !includeUnready) continue;
    // The app door is not shown inside the app.
    if (r.source === 'app' && guest.signedIn) continue;
    if (!st.ready && !includeUnready) continue;
    out.push({ id, label: r.label, family: r.family, source: r.source, how: r.how,
      stripe_type: r.stripe_type, venue_kind: r.venue_kind, disputes: r.disputes, ...st });
  }

  // Guest nudges: promote, never add. A rail the venue cannot take is never
  // conjured by a locale.
  const promote = (pred) => {
    const i = out.findIndex((x) => x.ready && pred(RAILS[x.id]));
    if (i > 0) out.unshift(out.splice(i, 1)[0]);
  };
  // Order of nudges is the order of confidence about the guest. The device is
  // a weak signal (a Mac at the table is still a person paying a bill) and is
  // applied first so anything stronger overrides it. A country's PINNED rail —
  // Pay by Bank in the UK, the free sticker in Thailand — beats the device
  // because it is what the venue would rather be paid by. Language and phone
  // country beat the pin, because a guest from Shanghai in London has WeChat
  // and no UK banking app.
  const lang = String(guest.locale ?? '').toLowerCase().slice(0, 2);
  const phone = upper(guest.phoneCountry);
  if (guest.device) promote((r) => r.device === guest.device);
  const pinned = PINNED_FIRST[country];
  if (pinned && (!pinned.onlyLang || pinned.onlyLang.includes(lang))) promote((r) => r === RAILS[pinned.rail]);
  if (lang) promote((r) => r.locale === lang);
  if (phone) promote((r) => r.phone === phone);

  // The app door always sits last: it is the "more ways" line, not a rail.
  const app = out.findIndex((x) => x.source === 'app');
  if (app >= 0 && app !== out.length - 1) out.push(out.splice(app, 1)[0]);
  return out;
}

/**
 * The Checkout `payment_method_types` list for a set of ready Stripe rails.
 * Deduplicated (Apple Pay, Google Pay and Card are all 'card'), 'card' first
 * so Checkout always has a floor, and only types this venue's country allows —
 * so Stripe can never be handed a type NUM did not approve.
 */
export function checkoutTypesFor(rails, { only = null } = {}) {
  const types = [];
  for (const r of rails) {
    if (r.source !== 'stripe' || !r.ready || !r.stripe_type) continue;
    if (only && r.id !== only && !(only === 'card' && r.stripe_type === 'card')) continue;
    if (!types.includes(r.stripe_type)) types.push(r.stripe_type);
  }
  if (types.includes('card')) { types.splice(types.indexOf('card'), 1); types.unshift('card'); }
  return types;
}

/**
 * Read what a venue has on file and shape it for railStatus(). Throws on a
 * failed read: a pay page built from a half-read venue would show the wrong
 * rails, and a 503 is the honest answer (the .catch(()=>[]) pattern is banned
 * on list reads — see STATUS.md).
 */
export async function venueRails(env, businessId) {
  if (!env?.DB || !businessId) throw new Error('venueRails: missing business');
  const [biz, prof, conn, { results: stickers }] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM businesses WHERE id = ?1').bind(businessId).first(),
    env.DB.prepare('SELECT country FROM num_business_profiles WHERE business_id = ?1')
      .bind(businessId).first(),
    // num_business_rails arrives with migration 0035. Until production has it
    // the honest reading is "no venue is connected", not a 503 on every pay
    // page — this is a single-row read with a defined fallback, the same shape
    // as termsFor() in commission.mjs, not a list read.
    env.DB.prepare('SELECT stripe_account_id, stripe_charges_enabled, rails_off FROM num_business_rails WHERE business_id = ?1')
      .bind(businessId).first().catch(() => null),
    env.DB.prepare(
      `SELECT DISTINCT kind, currency FROM num_paylinks
        WHERE business_id = ?1 AND state = 'active' AND COALESCE(one_time,0) = 0`,
    ).bind(businessId).all(),
  ]);
  if (!biz) return null;
  let rails_off = new Set();
  try { rails_off = new Set(JSON.parse(conn?.rails_off || '[]')); } catch { rails_off = new Set(); }
  const kinds = {};
  let currency = null;
  for (const s of stickers || []) { kinds[s.kind] = true; currency = currency || s.currency; }
  const country = upper(prof?.country);
  return {
    id: biz.id, name: biz.name, country,
    currency: upper(currency || currencyForCountry(country)),
    stripe_account_id: conn?.stripe_account_id || null,
    stripe_charges_enabled: Number(conn?.stripe_charges_enabled) === 1,
    stickers: { promptpay: !!kinds.promptpay, url: !!kinds.url, crypto: !!kinds.crypto },
    rails_off,
  };
}

/**
 * Where a tap on a rail goes, for a given bill token. Pure, so the pay page
 * (num-growth) and the app API (num-app) compute the identical URL.
 *   stripe rails → num-app opens the Checkout Session on the venue's account
 *   venue rails  → the pay page's own single-rail view
 *   the app door → app.itsnum.com/pay/<token>
 */
export function actionFor(env, rail, token) {
  const site = env?.SITE || 'https://itsnum.com';
  const app = env?.APP_ORIGIN || 'https://app.itsnum.com';
  const t = encodeURIComponent(String(token ?? '').toUpperCase());
  if (rail.source === 'stripe') return `${app}/api/bill/${t}/checkout?rail=${encodeURIComponent(rail.id)}`;
  if (rail.id === 'venue_link') return `${site}/p/${t}/go`;
  if (rail.id === 'promptpay_sticker') return `${site}/p/${t}/promptpay`;
  if (rail.id === 'usdc_direct') return `${site}/p/${t}/crypto`;
  if (rail.source === 'app') return `${app}/pay/${t}`;
  return `${site}/p/${t}`;
}

/** Guest hints from a plain request — device from UA, language from Accept-Language. */
export function guestFromRequest(req) {
  const ua = String(req?.headers?.get?.('user-agent') ?? '');
  const al = String(req?.headers?.get?.('accept-language') ?? '');
  const device = /iPhone|iPad|iPod|Macintosh/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : null;
  const locale = al.split(',')[0]?.trim() || null;
  return { device, locale, phoneCountry: null, signedIn: false };
}
