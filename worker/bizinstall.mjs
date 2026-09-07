/**
 * "Put NUM on your phone" — for the business, not the traveller.
 *
 * ── WHY A SECOND ONE OF THESE ────────────────────────────────────────────
 *
 * `src/components/app/InstallPrompt.tsx` already does this well for members,
 * and none of it is reusable here: the business console is server-rendered
 * HTML from `bizconsole.mjs` with no React and no bundle. So this is the same
 * idea, rebuilt for that surface — and pointed at a different payoff, because
 * the reason a business needs the app is not the reason a traveller does.
 *
 * ── THE PAYOFF IS THE ONLY PART THAT MATTERS ─────────────────────────────
 *
 * The member card's own comment gets this right: "Add to Home Screen" with no
 * reason given is a step people skip. A business reads the same instruction
 * and skips it harder, because they are at work.
 *
 * The reason for a business is specific and worth stating plainly: **a browser
 * tab cannot ring.** Web push only works from an installed app on iOS, so an
 * owner reading their dashboard in Safari finds out about an order when they
 * next happen to look. The console is for setting things up on a laptop. The
 * phone is where an order has to land, in the ninety seconds a hungry guest is
 * still deciding.
 *
 * ── AND WHY IT ASKS RATHER THAN DETECTS ──────────────────────────────────
 *
 * This page is rendered on a server. It cannot see whether the app is on
 * somebody's home screen — `display-mode: standalone` is a fact about a
 * browser on one device, and the owner is usually reading the console on a
 * laptop while the phone that needs the app is in their pocket. Detecting on
 * the laptop would answer a question about the wrong device.
 *
 * So it asks, and takes the answer as told: a business that says the app is on
 * their phone is believed, and stops being nagged. That is recorded as its own
 * fact rather than inferred, which is the same rule `bizreadiness.mjs` already
 * runs on everything else — a missing evidence table yields `unknown`, never
 * `false`.
 */

/** Which set of steps to show. Read from the User-Agent, which is a hint. */
export function platformOf(userAgent) {
  const ua = String(userAgent ?? '');
  if (/iPad|iPhone|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

/**
 * The steps, per platform.
 *
 * iOS names Safari explicitly because Add to Home Screen does not exist in
 * Chrome on iOS, and an owner who tries it there concludes the product is
 * broken rather than that they used the wrong browser.
 */
export const STEPS = Object.freeze({
  ios: [
    'Open <b>app.itsnum.com</b> in Safari — it has to be Safari',
    'Tap the Share button, the square with the arrow coming out of it',
    'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>',
  ],
  android: [
    'Open <b>app.itsnum.com</b> in Chrome',
    'Tap the <b>&#8942;</b> menu, top right',
    'Tap <b>Install app</b> (or <b>Add to Home screen</b>), then confirm',
  ],
  other: [
    'On the phone you actually carry, open <b>app.itsnum.com</b>',
    'iPhone: Share button &rarr; <b>Add to Home Screen</b>. Android: <b>&#8942;</b> menu &rarr; <b>Install app</b>',
    'Sign in with the number that claimed this listing',
  ],
});

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_business_app (
  business_id  TEXT PRIMARY KEY,
  installed_at TEXT,
  dismissed_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const ready = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(SCHEMA).run();
  ready.add(env.DB);
}

/**
 * What we have been told about this business and the app.
 *
 * Never invents a `false`. No row means nobody has said either way, which is
 * not the same as "they have not installed it" and must not be reported as if
 * it were.
 */
export async function appState(env, businessId) {
  if (!env?.DB || !businessId) return { known: false, installed: null, dismissed: false };
  await ensure(env);
  const row = await env.DB.prepare(
    'SELECT installed_at, dismissed_at FROM num_business_app WHERE business_id = ?1',
  ).bind(String(businessId)).first().catch(() => null);
  if (!row) return { known: false, installed: null, dismissed: false };
  return {
    known: true,
    installed: !!row.installed_at,
    dismissed: !!row.dismissed_at,
    installed_at: row.installed_at ?? null,
  };
}

/** They told us it is on their phone. */
export async function markInstalled(env, businessId) {
  if (!env?.DB || !businessId) return { ok: false };
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO num_business_app (business_id, installed_at, updated_at)
     VALUES (?1, datetime('now'), datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET installed_at = datetime('now'),
           dismissed_at = NULL, updated_at = datetime('now')`,
  ).bind(String(businessId)).run();
  return { ok: true };
}

/**
 * Not now.
 *
 * Recorded rather than hidden with a cookie, because the owner who dismisses
 * it on the laptop is the same owner who opens the console on a tablet
 * tomorrow, and asking again there is how a prompt becomes noise.
 */
export async function dismiss(env, businessId) {
  if (!env?.DB || !businessId) return { ok: false };
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO num_business_app (business_id, dismissed_at, updated_at)
     VALUES (?1, datetime('now'), datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET dismissed_at = datetime('now'),
           updated_at = datetime('now')`,
  ).bind(String(businessId)).run();
  return { ok: true };
}

/** Show it, or do not. */
export const shouldShow = (state) => !state?.installed && !state?.dismissed;

/**
 * The card.
 *
 * The payoff is the first sentence and the instructions are second, in that
 * order, on purpose.
 */
export function installCard({ platform = 'other', token = '', page = '' } = {}) {
  const steps = STEPS[platform] ?? STEPS.other;
  const H = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `
    <div class="card" style="border-left:3px solid currentColor">
      <h3 style="margin-bottom:2px">Put NUM on your phone</h3>
      <p class="sub" style="margin:0 0 10px">This page is for setting things up. Orders have to reach
        you where you are &mdash; and <b>a browser tab cannot ring</b>. Add NUM to your home screen and
        every request arrives as a notification, with the guest, the address and the total, wherever
        you happen to be standing.</p>
      <ol style="margin:0 0 12px 18px;padding:0;line-height:1.7">
        ${steps.map((t) => `<li>${t}</li>`).join('')}
      </ol>
      <p class="sub" style="margin:0 0 12px">Sign in with the number that claimed this listing &mdash;
        that is what connects the app to your orders. There is nothing to download from an app store.</p>
      <form method="post" style="margin:0;display:flex;gap:8px;flex-wrap:wrap">
        <input type="hidden" name="action" value="app_installed">
        <input type="hidden" name="s" value="${H(token)}">
        <input type="hidden" name="p" value="${H(page)}">
        <button type="submit">Done &mdash; it is on my phone</button>
        <button type="submit" name="later" value="1" class="ghost">Not now</button>
      </form>
    </div>`;
}
