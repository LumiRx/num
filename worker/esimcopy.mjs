// Every word a traveller reads about an eSIM, in one place, so the claims
// can be checked by a test instead of by memory.
//
// House rules for this copy:
//   - It is a data-only eSIM. Say so. No phone number comes with it.
//   - Never "cheapest", "lowest", "best price", "guaranteed", "no markup",
//     "official" or "verified". The price speaks for itself; a claim about
//     every other seller on earth is one we cannot check.
//   - Texts stay in the plain GSM-7 alphabet, so one message is one message
//     (a single "·" or accented letter turns 160 characters into 70).

import { usd } from './esimprice.mjs';
import { planLabel } from './esimcatalogue.mjs';

/** Make any string safe for a single-alphabet SMS. */
export function smsSafe(s) {
  return String(s ?? '')
    .replace(/[·•–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\n]/g, '');
}

export function textNumberDisplay(env = {}) {
  const raw = String(env.ESIM_TEXT_NUMBER || env.TWILIO_FROM || '').trim();
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(raw);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : raw;
}

const shortPlan = (p) => smsSafe(planLabel(p)).replace(' - ', ', ').replace(/ GB/, 'GB').replace(/ MB/, 'MB');

export const sms = {
  askDestination: () => 'Num: where are you headed? Reply with a country or airport code, e.g. THAILAND or BKK. STOP to opt out',
  ambiguous: (options) => smsSafe(`Num: which one - ${options.slice(0, 4).join(', ')}? Reply with the country.`),
  noPlans: (label) => smsSafe(`Num: I don't have an eSIM for ${label} yet. Tell me about the trip and I'll find another way to get you online there.`),
  menu: (label, plans) =>
    smsSafe(
      `Num: ${label} eSIM, data only\n` +
        plans.map((p, i) => `${i + 1}) ${shortPlan(p)} ${usd(p.priceCs)}`).join('\n') +
        `\nReply ${plans.length === 1 ? '1' : plans.length === 2 ? '1 or 2' : '1, 2 or 3'}. STOP to opt out`,
    ),
  payLink: (order, url) =>
    smsSafe(`Num: ${order.dest_label} eSIM, ${order.plan_label}, ${usd(order.price_cs)}. Pay here (Apple Pay works): ${url} - your install link comes the moment it's paid.`),
  // "Just text me" only when the concierge really answers texts
  // (SMS_CONCIERGE=on). Otherwise the promise points at the app, which always
  // answers. A promise the channel cannot keep is worse than no promise.
  ready: (order, url, { textConcierge = false } = {}) =>
    smsSafe(`Num: your ${order.dest_label} eSIM is ready. Install it here: ${url} (on an iPhone, tap Install on this iPhone). Switch it on when you land. ${textConcierge ? 'Need anything there? Just text me.' : 'Anything else for the trip? Ask Num at app.itsnum.com.'} STOP to opt out`),
  refunded: (order) =>
    smsSafe(`Num: I couldn't issue your ${order.dest_label} eSIM, so I've refunded the full ${usd(order.paid_cs ?? order.price_cs)}. It can take 5-10 days to show. Sorry - reply and I'll find you another option.`),
  paused: () => 'Num: eSIM sales are paused for a few minutes. Try again shortly, or reply and I will sort it out for you.',
  tooMany: () => 'Num: that is a lot of eSIMs in a short time, so I have paused new orders on this number for today. Reply if you need help.',
};

export const email = {
  ready: (order, url) => ({
    subject: `Your ${order.dest_label} eSIM is ready`,
    text:
      `Your ${order.dest_label} eSIM (${order.plan_label}) is ready.\n\n` +
      `Install it: ${url}\n\n` +
      `On an iPhone (iOS 17.4 or later), open that link on the phone and tap "Install on this iPhone".\n` +
      `On other phones, scan the QR code on that page from another screen, or type in the two codes shown there.\n\n` +
      `Install it before you fly if you can (you need wifi to install), then switch it on when you land.\n` +
      `This is a data-only eSIM: it does not come with a phone number.\n\n` +
      `Need anything on your trip? Ask Num in the app at app.itsnum.com, or reply to this email.\n\n- Num`,
  }),
  refunded: (order) => ({
    subject: `We refunded your ${order.dest_label} eSIM`,
    text:
      `We couldn't issue your ${order.dest_label} eSIM, so we've refunded the full ${usd(order.paid_cs ?? order.price_cs)}.\n` +
      `It can take 5-10 days to appear on your statement.\n\nSorry about that. Reply and we'll find you another option.\n\n- Num`,
  }),
};

export const page = {
  headline: 'Land connected.',
  pitch: (env) => `Text ESIM to ${textNumberDisplay(env)} and get your eSIM now, with your own Num concierge.`,
  dataOnly: 'Data-only eSIM. It does not come with a phone number.',
  compatible: 'Works on phones that support eSIM and are carrier-unlocked. Not sure about yours? Text us your phone model and we will check.',
  how: [
    'Pick a plan.',
    'Pay with Apple Pay, Google Pay or a card.',
    'Install: on an iPhone, tap Install on this iPhone. On other phones, scan the QR from another screen or type the two codes.',
    'Switch it on when you land. Your concierge is a text away the whole trip.',
  ],
  refundLine: "If we can't issue your eSIM, we refund you in full. Trouble installing? Text us and we'll fix it or refund it.",
  smsConsent: 'Text my eSIM install link and order updates to this number. Msg & data rates may apply. Reply STOP to opt out.',
  marketingConsent: 'Also text me travel tips and offers from Num. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Not required to buy.',
};

export const BANNED = /\b(cheapest|lowest|best price|guarantee[ds]?|no markup|official|verified)\b/i;
