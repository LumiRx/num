// YOUR PLAN.
//
// The card leads with what you already have rather than what you're missing.
// A pricing wall that opens with a locked padlock teaches people the product
// is mostly not for them; this one opens with "the concierge, your plans and
// your people are yours, free, forever" — which is true and is the reason to
// stay.
//
// Upgrades are framed as ceilings lifting, never as features unlocking, because
// that is what they actually are. Nothing in the free tier gets taken away to
// create a reason to pay.
//
// PAYING WITH STARS (7 Sep 2026).
// A member can put Stars towards a membership instead of a card, which is the
// only door for someone who was PAID in Stars for running an errand or was
// given them by a friend. Two things about it are load-bearing:
//   · It sits behind the SAME canOfferSubscription() gate as the card. Stars
//     buying a digital service is a sale, and iOS sells nothing here — see the
//     App Review note further down. A Stars button that rendered on iOS would
//     reopen 3.1.1 through a side door.
//   · The Star price comes from the server, per tier, and is never computed in
//     this file. See worker/starmembership.mjs: it is derived from what a Star
//     actually costs, so paying in Stars is never the cheap way in.
//
// TRAVEL IS NEVER A PAID BENEFIT AND MUST NEVER BE ADVERTISED AS ONE.
// Fare search, the priority lane and concierge booking are true on every tier
// (worker/membership.mjs UNGATED), so `highlights` can never surface them as a
// difference — and the three lines that used to name them are gone from this
// file so a future table change cannot bring the copy back. A paid tier that
// advertises travel access is a "seller of travel discount program" under
// California B&P §17550.27(a)(1), which carries a $100,000 bond it is not
// possible for Num to post lawfully. See HQ COMPLIANCE_GUARDRAILS.md.
import { useEffect, useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { CheckIcon } from '../../lib/icons';
import { canOfferSubscription } from '../../lib/native';
import { apiUrl } from '../../lib/apibase';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };

type Tier = {
  id: string;
  name: string;
  price_cents: number;
  blurb: string;
  entitlements: Record<string, boolean | number | null>;
};

type StarTier = { id: string; stars_per_month: number };
type StarWallet = { star_tiers?: StarTier[]; spendable?: number; promo_locked?: number };

const money = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);

/** Turn raw entitlements into the two or three lines that actually differ. */
function highlights(t: Tier, free: Tier | undefined): string[] {
  const out: string[] = [];
  const e = t.entitlements;
  const f = free?.entitlements ?? {};
  const limit = (k: string, one: string, many: (n: number) => string) => {
    if (e[k] === f[k]) return;
    if (e[k] === null) out.push(one);
    else if (typeof e[k] === 'number') out.push(many(e[k] as number));
  };
  limit('plans_max', 'Unlimited plans', (n) => `${n} plans at once`);
  limit('deep_research_monthly', 'Unlimited deep research', (n) => `${n} deep searches a month`);
  if (e.early_features && !f.early_features) out.push('New things first');
  // NOTHING ABOUT TRAVEL GOES HERE. See the header note: a paid tier may not
  // advertise a travel benefit. If a new capability is travel-shaped, it goes
  // in worker/membership.mjs UNGATED and never on this list.
  return out;
}

export default function MembershipCard() {
  const me = useApp((s) => s.me);
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [mine, setMine] = useState<{ tier: string; used?: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState<StarWallet | null>(null);

  useEffect(() => {
    void fetch(apiUrl('/api/membership/tiers')).then((r) => r.json()).then((d) => setTiers(d.tiers)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!me?.id) return;
    void fetch(apiUrl(`/api/membership/me?me=${encodeURIComponent(me.id)}`))
      .then((r) => r.json()).then(setMine).catch(() => {});
  }, [me?.id]);
  // What the plans cost in Stars, and how many of this member's Stars may go
  // towards one. Both come from the server; neither is worked out here.
  useEffect(() => {
    if (!me?.id || !canOfferSubscription()) return;
    void fetch(apiUrl(`/api/membership/stars?me=${encodeURIComponent(me.id)}`))
      .then((r) => r.json()).then(setWallet).catch(() => {});
  }, [me?.id]);

  if (!tiers?.length) return null;
  const free = tiers.find((t) => t.price_cents === 0);
  const current = mine?.tier ?? 'free';
  const currentTier = tiers.find((t) => t.id === current);
  const paid = tiers.filter((t) => t.price_cents > 0);

  const subscribe = async (tier: string) => {
    if (!me?.id) return;
    setBusy(tier);
    setNote(null);
    try {
      const out = await fetch(apiUrl('/api/membership/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ me: me.id, tier }),
      }).then((r) => r.json()) as { ok?: boolean; url?: string; error?: string };
      if (out.url) { window.location.href = out.url; return; }
      setNote(out.error ?? 'Couldn’t start that just now.');
    } catch {
      setNote('Couldn’t reach the till — try again in a moment.');
    }
    setBusy(null);
  };

  const starCost = (tier: string): number | null =>
    wallet?.star_tiers?.find((t) => t.id === tier)?.stars_per_month ?? null;

  const payWithStars = async (tier: string) => {
    if (!me?.id) return;
    setBusy(`stars:${tier}`);
    setNote(null);
    try {
      const out = await fetch(apiUrl('/api/membership/upgrade-with-stars'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The body says WHICH plan and HOW MANY months. It never says what
        // that costs — the server owns the price, the way it owns pack prices.
        body: JSON.stringify({ me: me.id, tier, months: 1, idem: `stars_${tier}_${Date.now()}` }),
      }).then((r) => r.json()) as { ok?: boolean; error?: string; note?: string };
      if (out.ok) {
        setNote(out.note ?? 'Done.');
        void fetch(apiUrl(`/api/membership/me?me=${encodeURIComponent(me.id)}`))
          .then((r) => r.json()).then(setMine).catch(() => {});
        void fetch(apiUrl(`/api/membership/stars?me=${encodeURIComponent(me.id)}`))
          .then((r) => r.json()).then(setWallet).catch(() => {});
      } else {
        setNote(out.error ?? 'Couldn’t do that just now.');
      }
    } catch {
      setNote('Couldn’t reach the till — try again in a moment.');
    }
    setBusy(null);
  };

  return (
    <div className="glass" style={card}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={kicker}>YOUR PLAN</div>
        <div style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, color: current === 'free' ? 'var(--ink-60)' : 'var(--color-accent)' }}>
          {currentTier?.name ?? 'Num'}
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.55 }}>
        {current === 'free'
          ? 'The concierge, your plans, your people and live fare search are yours — free, no trial, no countdown. Paying only lifts the ceilings.'
          : currentTier?.blurb}
      </div>

      {/* What you've actually used. Shown before any upsell so the number is
          informative rather than a nudge. */}
      {mine?.used && Object.keys(mine.used).length > 0 && (
        <div style={{ marginTop: 9, display: 'grid', gap: 3 }}>
          {Object.entries(mine.used).map(([k, v]) => {
            const cap = currentTier?.entitlements?.[k];
            return (
              <div key={k} style={{ fontSize: 11, color: 'var(--ink-40)' }}>
                {k.replace(/_/g, ' ')}: {v}{typeof cap === 'number' ? ` of ${cap}` : ''} this month
              </div>
            );
          })}
        </div>
      )}

      {/* iOS SELLS NOTHING. Our App Review notes state, in these words, that
          there is "no purchase surface in the app" on iOS and that this is
          "enforced in code, not by policy: canOfferSubscription() in
          src/lib/native.ts returns false on iOS". Until 15 Aug that function
          existed and NOTHING CALLED IT — the whole pricing ladder rendered on
          iOS. We had described an enforcement to Apple that was not wired.
          A rejection is recoverable; telling App Review something untrue is
          the thing to avoid.

          A member who already subscribed on the web still sees their tier —
          `current` is read from the account, and the paid rows below are the
          only part that is a SALE. */}
      {!open && current === 'free' && canOfferSubscription() && (
        <div
          {...pressable(() => setOpen(true))}
          style={{ cursor: 'pointer', marginTop: 12, fontSize: 11, fontWeight: 800, letterSpacing: '.07em', color: 'var(--color-accent-700)' }}
        >
          SEE WHAT MORE ROOM COSTS
        </div>
      )}

      {(open || current !== 'free') && canOfferSubscription() && (
        <div style={{ marginTop: 12, display: 'grid', gap: 9 }}>
          {paid.map((t) => {
            const on = t.id === current;
            const lines = highlights(t, free);
            return (
              <div
                key={t.id}
                style={{
                  borderRadius: 14, padding: 12,
                  border: '1.5px solid ' + (on ? 'var(--color-accent)' : 'var(--ink-08)'),
                  background: 'var(--field-bg)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15 }}>{t.name}</div>
                  <div style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800 }}>{money(t.price_cents)}<span style={{ fontSize: 10, color: 'var(--ink-40)', fontWeight: 600 }}>/mo</span></div>
                </div>
                <div style={{ marginTop: 7, display: 'grid', gap: 4 }}>
                  {lines.map((l) => (
                    <div key={l} style={{ fontSize: 11.5, color: 'var(--ink)', display: 'flex', gap: 6, alignItems: 'flex-start', lineHeight: 1.45 }}>
                      <CheckIcon size={11} style={{ color: 'var(--color-accent)', marginTop: 3, flex: 'none' }} />
                      <span>{l}</span>
                    </div>
                  ))}
                </div>
                {on ? (
                  <div style={{ marginTop: 10, fontSize: 10.5, fontWeight: 800, letterSpacing: '.07em', color: 'var(--color-accent)', textAlign: 'center' }}>
                    YOUR PLAN
                  </div>
                ) : (
                  <>
                    <div
                      {...pressable(() => { if (!busy) void subscribe(t.id); })}
                      style={{
                        cursor: 'pointer', marginTop: 11, borderRadius: 999, padding: '11px 14px', textAlign: 'center',
                        background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '.06em',
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      {busy === t.id ? 'OPENING…' : `GET ${t.name.toUpperCase()}`}
                    </div>
                    {/* The Stars door. Shown whenever a Star price exists, and
                        AFFORDABLE only when the member has enough of their own
                        Stars — the welcome gift is deliberately not spendable
                        here, so the price is shown either way rather than the
                        button quietly vanishing and leaving them puzzled. */}
                    {starCost(t.id) != null && (
                      (wallet?.spendable ?? 0) >= (starCost(t.id) as number) ? (
                        <div
                          {...pressable(() => { if (!busy) void payWithStars(t.id); })}
                          style={{
                            cursor: 'pointer', marginTop: 7, borderRadius: 999, padding: '10px 14px', textAlign: 'center',
                            border: '1.5px solid var(--color-accent)', color: 'var(--color-accent-700)',
                            fontWeight: 800, fontSize: 11, letterSpacing: '.06em', opacity: busy ? 0.5 : 1,
                          }}
                        >
                          {busy === `stars:${t.id}` ? 'PAYING…' : `OR PAY ★${starCost(t.id)} FOR A MONTH`}
                        </div>
                      ) : (
                        <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--ink-40)', textAlign: 'center', lineHeight: 1.5 }}>
                          Or ★{starCost(t.id)} a month — you have ★{wallet?.spendable ?? 0} to spend
                        </div>
                      )
                    )}
                  </>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>
            Cancel any time. If a payment lapses you drop back to the free plan — you never lose the app, only the extra room.
          </div>
          {(wallet?.promo_locked ?? 0) > 0 && (
            <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>
              ★{wallet?.promo_locked} of your balance is the welcome gift — that one spends on plans, tabs and errands rather than on a membership.
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>
            Months paid in Stars simply end — nothing renews on its own and no card is stored.
          </div>
        </div>
      )}

      {note && <div style={{ marginTop: 9, fontSize: 11.5, color: '#a3271c', lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
