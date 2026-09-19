/**
 * Which till is this venue probably already using?
 *
 * ── WHY GUESS AT ALL ─────────────────────────────────────────────────────
 *
 * Connecting a till is the single step with the most drop-off in the whole
 * venue onboarding, and the reason is that the console asks an abstract
 * question — "which POS do you use?" — of somebody standing behind a bar. But
 * NUM already holds a strong clue and has since the day they signed up: the
 * payment target on their own sticker. A venue whose paylink points at
 * square.link is on Square, and asking them to pick it out of a list is asking
 * them to tell us something we can already see.
 *
 * So this turns that into ONE prompt: "Looks like you use Square — connect
 * your till?" instead of a menu.
 *
 * ── AND WHY IT IS ONLY EVER A GUESS ──────────────────────────────────────
 *
 * A payment link is not a till. A venue can take card on a Square reader and
 * send guests to a Stripe payment page, or use a PayPal link and run Lightspeed
 * inside. So every answer here carries a confidence and the copy says "looks
 * like". It NEVER changes what a venue is allowed to do and never
 * pre-selects anything irreversible — the full list is always one tap away,
 * and a wrong guess costs a tap, not a mis-connected till.
 *
 * The other half is just as important: naming a vendor we CANNOT integrate,
 * and saying so. A venue on SumUp is better told "we cannot read your till,
 * here is what still works" than left tapping a button that will never do
 * anything.
 */

/**
 * Host fragment → what it means. Ordered most specific first; the first match
 * wins, so `pay.sumup.com` cannot be swallowed by a looser rule below it.
 *
 * `connect` is the honest bit: whether NUM has an adapter that can actually
 * read this venue's open checks today.
 */
const SIGNS = Object.freeze([
  { host: /(^|\.)square(up)?\.(com|site|link)$/i, vendor: 'square', label: 'Square', connect: true },
  { host: /(^|\.)clover\.com$/i, vendor: 'clover', label: 'Clover', connect: true },
  { host: /(^|\.)(lightspeed(hq)?\.com|lsk\.lightspeed\.app)$/i, vendor: 'lightspeed', label: 'Lightspeed Restaurant', connect: true },
  { host: /(^|\.)toasttab\.com$/i, vendor: 'toast', label: 'Toast', connect: false,
    why: 'Toast has no self-serve access — a restaurant has to ask its own Toast representative to start an integration, so NUM cannot read your checks yet.' },
  { host: /(^|\.)sumup\.(com|link|me)$/i, vendor: 'sumup', label: 'SumUp', connect: false,
    why: 'SumUp publishes payment APIs but nothing that reads an open tab, so NUM cannot see your checks. Typing the total takes a moment and everything else works.' },
  { host: /(^|\.)(zettle\.com|izettle\.com)$/i, vendor: 'zettle', label: 'Zettle', connect: false,
    why: 'Zettle exposes no open-check API, so the total is typed. Everything else works as normal.' },
  { host: /(^|\.)dojo\.tech$/i, vendor: 'dojo', label: 'Dojo', connect: false,
    why: 'Dojo integrates through its own partner programme rather than an open API.' },
  { host: /(^|\.)paypal\.(com|me)$/i, vendor: 'paypal', label: 'PayPal', connect: false,
    why: 'A PayPal link takes payments but is not a till, so there are no checks to read.' },
  { host: /(^|\.)stripe\.com$/i, vendor: 'stripe', label: 'Stripe', connect: false,
    why: 'You are already on Stripe — connect your Stripe account itself and NUM takes the payment there. A till connection is a separate thing and optional.' },
  { host: /(^|\.)revolut\.(com|me)$/i, vendor: 'revolut', label: 'Revolut', connect: false,
    why: 'A Revolut payment link is not a till, so there are no open checks to read.' },
]);

const hostOf = (u) => {
  try { return new URL(String(u)).hostname.replace(/^www\./i, ''); } catch { return null; }
};

/**
 * What this venue is probably running, from what NUM already knows.
 *
 * `kind` and `target` are the venue's own paylink: the same two fields a bill
 * code inherits its destination from. Nothing else is read, and nothing the
 * caller sends can change the answer into a vendor NUM would then act on.
 */
export function guessTill({ kind = null, target = null, country = null } = {}) {
  // A Thai venue on its own PromptPay sticker. Not a guess — the rail says so.
  if (kind === 'promptpay') {
    return {
      vendor: null, label: null, connect: false, confidence: 'certain',
      why: 'You take PromptPay directly, which no till API exposes. Staff type the total, or photograph the bill and confirm the figure.',
    };
  }
  if (kind === 'crypto') {
    return {
      vendor: null, label: null, connect: false, confidence: 'certain',
      why: 'You are paid to your own wallet. There is no till to read from, so staff type the total.',
    };
  }

  const host = hostOf(target);
  if (!host) return { vendor: null, label: null, connect: false, confidence: 'none', why: null };

  for (const s of SIGNS) {
    if (!s.host.test(host)) continue;
    return {
      vendor: s.vendor,
      label: s.label,
      connect: s.connect,
      // A payment link is not a till. Someone can take card on a Square reader
      // and send guests to a Stripe page, so this is never better than likely.
      confidence: 'likely',
      host,
      why: s.why ?? null,
      country: country ?? null,
    };
  }
  return { vendor: null, label: null, connect: false, confidence: 'none', host, why: null };
}

/**
 * The one line the console shows above the till picker.
 *
 * Always "looks like", never "you use". And when the answer is a vendor NUM
 * cannot read, it says that plainly instead of offering a button that would
 * never do anything.
 */
export function tillPrompt(guess) {
  if (!guess || guess.confidence === 'none') return null;
  if (guess.connect) return `Looks like you use ${guess.label} — connect your till and NUM can read the open check and close it when a guest pays.`;
  if (guess.why) return guess.why;
  return null;
}
