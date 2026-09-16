// THE FIRST TIME WE EVER ASK.
//
// 16 Sep 2026: 152 members, zero subscriptions. Checkout has worked the whole
// time — Stripe subscriptions, a webhook that grants and lapses, a price guard.
// Nothing ever asked. This is the asking.
//
// ── IT DOES NOT RENDER ON iOS. NOT A SOFTER VERSION — NOTHING. ────────────
//
// An iOS app that offers a digital subscription outside Apple's own billing is
// App Store guideline 3.1.1, and Num bills through Stripe. `MembershipCard`
// already hides the whole pricing ladder behind `canOfferSubscription()`, with
// two independent platform witnesses behind it because a single false negative
// once reopened three separate bugs at once.
//
// A welcome sheet is the loudest possible version of the same offer, shown to
// every new member on their first run, which is exactly the screen a reviewer
// sees. It goes behind the same gate, and it is the first thing this file
// checks — before the fetch, before the state, before anything renders.
//
// ── WHAT IT LEADS WITH ───────────────────────────────────────────────────
//
// The free tier, as a possession rather than a limitation. "The concierge,
// your plans and your people are yours, free, forever" is true, it is the
// reason to stay, and a first-run screen that opens with a padlock teaches
// somebody in their first thirty seconds that the product is mostly not for
// them.
//
// Upgrades are ceilings lifting, never features unlocking, because that is
// what they are. Nothing is taken out of free to manufacture a reason to pay.
//
// ── AND WHAT IT MAY NEVER SAY ────────────────────────────────────────────
//
// NO TRAVEL BENEFIT, ON ANY TIER, EVER. Fare search, the priority lane and
// concierge booking are true on every tier (worker/membership.mjs UNGATED). A
// paid tier that advertises travel access is a "seller of travel discount
// program" under California B&P §17550.27(a)(1), carrying a $100,000 bond Num
// cannot lawfully post. The lines are derived from entitlements the server
// sends, and the derivation deliberately cannot produce a travel line.
import { useEffect, useRef, useState } from 'react';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { canOfferSubscription } from '../../lib/native';
import { apiUrl } from '../../lib/apibase';
import { useApp } from '../../lib/store';

/** Shown once per person, ever. A welcome that returns is not a welcome. */
const SEEN_KEY = 'num-welcome-plans-v1';

export const seenWelcomePlans = (): boolean => {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
};
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ } };

type Tier = {
  id: string;
  name: string;
  price_cents: number;
  blurb: string;
  entitlements: Record<string, boolean | number | null>;
};

const money = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);

/**
 * The two or three lines that actually differ from free.
 *
 * Derived, never written out. `MEMBERSHIP_TIERS` can change prices and limits
 * without a deploy, and a hand-written benefit list is a list that will one day
 * promise something the server does not honour.
 */
function raises(t: Tier, free: Tier | undefined): string[] {
  const out: string[] = [];
  const e = t.entitlements;
  const f = free?.entitlements ?? {};
  const lift = (k: string, unlimited: string, some: (n: number) => string) => {
    if (e[k] === f[k]) return;
    if (e[k] === null) out.push(unlimited);
    else if (typeof e[k] === 'number') out.push(some(e[k] as number));
  };
  lift('plans_max', 'Unlimited plans at once', (n) => `${n} plans at once`);
  lift('deep_research_monthly', 'Deep research, no monthly cap', (n) => `${n} deep searches a month`);
  if (e.early_features && !f.early_features) out.push('New things first');
  // NOTHING TRAVEL-SHAPED MAY BE ADDED HERE. See the header.
  return out;
}

export default function WelcomePlans({ onClose }: { onClose: () => void }) {
  // FIRST LINE OF THE COMPONENT, on purpose. Nothing fetches, nothing renders,
  // nothing is even considered on a storefront where Num does not sell.
  const selling = canOfferSubscription();

  const me = useApp((s) => s.me);
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(true, ref);

  useEffect(() => {
    if (!selling) return;
    void fetch(apiUrl('/api/membership/tiers'))
      .then((r) => r.json())
      .then((d) => setTiers(d.tiers))
      .catch(() => setTiers([]));
  }, [selling]);

  if (!selling) return null;
  if (!tiers?.length) return null;

  const free = tiers.find((t) => t.price_cents === 0);
  const paid = tiers.filter((t) => t.price_cents > 0).sort((a, b) => a.price_cents - b.price_cents);

  const close = () => { markSeen(); onClose(); };

  const subscribe = async (tier: string) => {
    if (!me?.id) return;
    setBusy(tier);
    setNote(null);
    try {
      // The body says WHICH plan. It never says what that costs — the server
      // owns the price, which is what stopped fifty cents buying a $28.98 plan.
      const out = await fetch(apiUrl('/api/membership/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ me: me.id, tier }),
      }).then((r) => r.json()) as { ok?: boolean; url?: string; error?: string };
      if (out.url) {
        // What they held BEFORE paying, so PaidReturn can tell a real change
        // from "already on a paid tier". Without it a Plus→Pro upgrade would
        // confirm the instant it saw any paid tier, including the old one.
        try { localStorage.setItem('num-tier-before-checkout', 'free'); } catch { /* private mode */ }
        // Seen, whatever happens next: they have been asked. Marked BEFORE the
        // redirect, or a member who pays and comes back gets asked again.
        markSeen();
        window.location.href = out.url;
        return;
      }
      setNote(out.error ?? 'Couldn’t start that just now.');
    } catch {
      setNote('Couldn’t reach the till — try again in a moment.');
    }
    setBusy(null);
  };

  return (
    // `glass-strong` IS THE BACKGROUND. Without it this sheet is transparent.
    //
    // 16 Sep 2026, from a screenshot on Dre's phone: the plans sheet rendered
    // with no background at all, so the dashboard showed straight through it.
    // "The concierge is yours. Free, forever." sat on top of "Nothing booked
    // yet", the tier cards overlapped the trip-check rows, and the whole thing
    // ran off the bottom of the screen. It was unreadable — on the one screen
    // whose entire job is to sell a subscription, while we were paying X for
    // traffic to reach it.
    //
    // `sheetBase` only does position, radius and safe-area padding; its own
    // comment says "pair with className='glass-strong'". Every other sheet in
    // the app does. This one was written without it and nothing caught that,
    // because a missing class is not a type error and the sheet still
    // "rendered" — it just rendered see-through.
    //
    // maxHeight + overflowY for the same reason: every other sheet caps itself
    // and scrolls inside. Without it a three-tier ladder on a small phone runs
    // off the bottom and the "Not now" button — the only way out — goes with it.
    <div
      ref={ref}
      className="glass-strong"
      role="dialog"
      aria-modal="true"
      aria-label="Your plan"
      style={{
        ...sheetBase,
        maxHeight: 'min(92%, calc(100% - var(--sat, 0px) - 8px))',
        overflowY: 'auto',
        padding: '0 16px',
      }}
    >
      <div style={grabberStyle} />

      <p style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)', margin: '4px 0 8px' }}>
        YOU’RE IN
      </p>
      <h2 style={{ margin: '0 0 8px', fontSize: 23, letterSpacing: '-.02em' }}>
        The concierge is yours. Free, forever.
      </h2>
      <p style={{ margin: '0 0 18px', color: 'var(--ink-55)', fontSize: 14.5, lineHeight: 1.55 }}>
        Ask for anything, anywhere — a table tonight, a doctor who speaks your language,
        the last ferry. Your plans and your people come with it. No trial, no countdown.
      </p>

      {free ? (
        <div style={{
          border: '1px solid var(--color-accent)', borderRadius: 14, padding: 13, marginBottom: 12,
        }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>
            {free.name} · <span style={{ color: 'var(--color-accent)' }}>you’re on this</span>
          </p>
          <p style={{ margin: '5px 0 0', color: 'var(--ink-55)', fontSize: 13, lineHeight: 1.5 }}>
            {free.blurb}
          </p>
        </div>
      ) : null}

      <p style={{ margin: '0 0 10px', color: 'var(--ink-55)', fontSize: 13 }}>
        If you want more room, these lift the ceilings. Cancel any time.
      </p>

      {paid.map((t) => {
        const lines = raises(t, free);
        return (
          <div key={t.id} style={{ border: '1px solid var(--ink-08)', borderRadius: 14, padding: 13, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{t.name}</p>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>
                {money(t.price_cents)}
                <span style={{ color: 'var(--ink-55)', fontWeight: 500, fontSize: 12.5 }}> /month</span>
              </p>
            </div>
            <ul style={{ margin: '8px 0 0', padding: '0 0 0 17px', color: 'var(--ink-55)', fontSize: 13, lineHeight: 1.65 }}>
              {lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
            <button
              {...pressable}
              type="button"
              disabled={busy !== null}
              onClick={() => { void subscribe(t.id); }}
              style={{
                width: '100%', marginTop: 11, height: 44, borderRadius: 999, border: 0,
                background: 'var(--color-accent)', color: '#fff', fontWeight: 700, fontSize: 14.5,
                opacity: busy !== null ? 0.5 : 1,
              }}
            >
              {busy === t.id ? 'Opening…' : `Get ${t.name}`}
            </button>
          </div>
        );
      })}

      {note ? (
        <p role="alert" style={{ margin: '4px 0 0', color: 'var(--color-accent)', fontSize: 13 }}>{note}</p>
      ) : null}

      {/* A real way out, the same size as everything else. A "no thanks" that is
          grey, tiny or phrased as an insult is the cheapest possible trick and it
          is the one people remember. */}
      <button
        {...pressable}
        type="button"
        onClick={close}
        style={{
          width: '100%', marginTop: 6, height: 44, borderRadius: 999,
          border: '1px solid var(--ink-08)', background: 'transparent',
          color: 'var(--ink)', fontWeight: 600, fontSize: 14.5,
        }}
      >
        Not now — start using Num
      </button>

      <p style={{ margin: '12px 0 0', color: 'var(--ink-40)', fontSize: 11.5, lineHeight: 1.5, textAlign: 'center' }}>
        You can change or cancel a plan any time from your profile.
      </p>
    </div>
  );
}
