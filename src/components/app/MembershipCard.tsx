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
// possible for NUM to post lawfully. See HQ COMPLIANCE_GUARDRAILS.md.
import { useEffect, useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { CheckIcon } from '../../lib/icons';
import { canOfferSubscription } from '../../lib/native';
import { forgetTier } from '../../lib/tier';
import { apiUrl } from '../../lib/apibase';
import { t } from '../../lib/i18n';

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
function highlights(tier: Tier, free: Tier | undefined): string[] {
  const out: string[] = [];
  const e = tier.entitlements;
  const f = free?.entitlements ?? {};
  const limit = (k: string, one: string, many: (n: number) => string) => {
    if (e[k] === f[k]) return;
    if (e[k] === null) out.push(one);
    else if (typeof e[k] === 'number') out.push(many(e[k] as number));
  };
  limit('plans_max', t('Unlimited plans'), (n) => `${n} plans at once`);
  limit('deep_research_monthly', t('Unlimited deep research'), (n) => `${n} deep searches a month`);
  if (e.early_features && !f.early_features) out.push(t('New things first'));
  // NOTHING ABOUT TRAVEL GOES HERE. See the header note: a paid tier may not
  // advertise a travel benefit. If a new capability is travel-shaped, it goes
  // in worker/membership.mjs UNGATED and never on this list.
  return out;
}

/**
 * The badge on a tier card.
 *
 * It names what the tier IS. It is deliberately not "Most popular" or
 * "Recommended": we would be inventing social proof for plans that have
 * barely been sold, and an invented number is the one thing this product
 * cannot afford to print. Derived from the ladder's own shape — the top paid
 * tier is the one with no ceilings — so adding a middle tier tomorrow needs
 * no new copy here.
 */
function badgeOf(tr: Tier): { label: string; bg: string; fg: string; top: boolean } {
  const top = tr.entitlements?.plans_max === null || tr.entitlements?.deep_research_monthly === null;
  return top
    ? { label: t('NO CEILINGS'), bg: 'var(--grad-accent)', fg: '#fff', top }
    : { label: t('MORE ROOM'), bg: 'var(--field-bg)', fg: 'var(--color-accent-700)', top };
}

export default function MembershipCard() {
  const me = useApp((s) => s.me);
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [mine, setMine] = useState<{ tier: string; used?: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
      setNote(t('Couldn’t reach the till — try again in a moment.'));
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
        // The tier changed in place (no Stripe redirect to reload the page),
        // so the cached tier behind the booking-card nudge must go now.
        forgetTier();
        void fetch(apiUrl(`/api/membership/me?me=${encodeURIComponent(me.id)}`))
          .then((r) => r.json()).then(setMine).catch(() => {});
        void fetch(apiUrl(`/api/membership/stars?me=${encodeURIComponent(me.id)}`))
          .then((r) => r.json()).then(setWallet).catch(() => {});
      } else {
        setNote(out.error ?? 'Couldn’t do that just now.');
      }
    } catch {
      setNote(t('Couldn’t reach the till — try again in a moment.'));
    }
    setBusy(null);
  };

  return (
    <div className="glass" style={card}>
      {/* A SELL, NOT A FILING CABINET (18 Sep 2026).
          This opened as "YOUR PLAN · Num" over a paragraph, with the prices
          folded behind a grey link reading SEE WHAT MORE ROOM COSTS. Nobody
          buys what they cannot see: the two plans and their prices are on
          screen now, each with its own badge, and the line about the free
          tier being real sits under them where it reassures instead of
          arguing you out of upgrading. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* "UPGRADE" only where upgrading is possible. On iOS every paid row
            below is hidden by canOfferSubscription(), so a free member opened
            the wallet, read UPGRADE and a line promising more, and found
            nothing to tap — reported 18 Sep as "it has plan and you can't
            click it". The gate is right and stays; the advertisement for a
            door we deliberately do not open is what was wrong. */}
        <div style={kicker}>{current === 'free' && canOfferSubscription() ? t('UPGRADE') : t('YOUR PLAN')}</div>
        <div style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, letterSpacing: '.06em', padding: '3px 8px', borderRadius: 999, background: current === 'free' ? 'var(--field-bg)' : 'var(--grad-accent)', color: current === 'free' ? 'var(--ink-60)' : '#fff', border: current === 'free' ? '1px solid var(--ink-12)' : 'none' }}>
          {(currentTier?.name ?? 'Num').toUpperCase()}
        </div>
      </div>

      {current === 'free' && canOfferSubscription() && (
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, lineHeight: 1.15, marginTop: 7, letterSpacing: '-.01em' }}>
          {t('Travel in style')}
        </div>
      )}

      {/* ONE LINE. The old one ran to three, opening with what stays free —
          which is true, belongs here, and was arguing people out of the
          upgrade before they had seen a price. It is in the small print under
          the plans now, where it reassures instead. */}
      {/* The same rule for the line under it. "More plans, deeper research,
          new things first" is a sales line; on iOS it sells something the
          screen cannot deliver. A free member there gets a plain statement of
          where they stand instead — no pitch, no price, and deliberately no
          pointer anywhere else, because the promise made to App Review is
          that this app has no purchase surface at all. */}
      <div style={{ fontSize: 12.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
        {current !== 'free'
          ? currentTier?.blurb
          : canOfferSubscription()
            ? t('More plans, deeper research, new things first.')
            : t('You are on the free plan, and everything you have used so far is part of it.')}
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
      {canOfferSubscription() && (
        <div style={{ marginTop: 12, display: 'grid', gap: 9 }}>
          {paid.map((tr) => {
            const on = tr.id === current;
            const lines = highlights(tr, free);
            return (
              <div
                key={tr.id}
                // THE TOP TIER CATCHES THE LIGHT. A slow sheen across the card
                // and a warmer border — enough that Pro reads as the special
                // one at a glance, and slow enough (5s, once every 5s) that it
                // never becomes a flicker beside the text. Reduced-motion
                // readers get the border and no movement: see .sheen in
                // styles/glass.css.
                className={badgeOf(tr).top ? 'sheen' : undefined}
                style={{
                  borderRadius: 14, padding: 12, position: 'relative', overflow: 'hidden',
                  border: '1.5px solid ' + (on ? 'var(--color-accent)' : badgeOf(tr).top ? 'var(--color-accent-300)' : 'var(--ink-08)'),
                  background: 'var(--field-bg)',
                }}
              >
                {/* THE BADGE. A word for what the tier IS — never a claim
                    about how many people chose it. "Most popular" on a plan
                    nobody has bought yet is the kind of small lie that costs
                    more than it earns, and NUM does not print one. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 800, letterSpacing: '.1em', padding: '3px 8px', borderRadius: 999,
                    background: badgeOf(tr).bg, color: badgeOf(tr).fg, flex: 'none',
                  }}>{t(badgeOf(tr).label)}</span>
                  {on && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', color: 'var(--color-accent)' }}>{t('ACTIVE')}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 7 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 16 }}>{tr.name}</div>
                  <div style={{ marginLeft: 'auto', fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 800 }}>{money(tr.price_cents)}<span style={{ fontSize: 10, color: 'var(--ink-40)', fontWeight: 600 }}>/mo</span></div>
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
                  <div style={{ marginTop: 10, fontSize: 10.5, fontWeight: 800, letterSpacing: '.07em', color: 'var(--color-accent)', textAlign: 'center' }}>{t('YOUR PLAN')}</div>
                ) : (
                  <>
                    <div
                      {...pressable(() => { if (!busy) void subscribe(tr.id); })}
                      style={{
                        cursor: 'pointer', marginTop: 11, borderRadius: 999, padding: '11px 14px', textAlign: 'center',
                        background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '.06em',
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      {busy === tr.id ? t('OPENING…') : `GET ${tr.name.toUpperCase()}`}
                    </div>
                    {/* The Stars door. Shown whenever a Star price exists, and
                        AFFORDABLE only when the member has enough of their own
                        Stars — the welcome gift is deliberately not spendable
                        here, so the price is shown either way rather than the
                        button quietly vanishing and leaving them puzzled. */}
                    {starCost(tr.id) != null && (
                      (wallet?.spendable ?? 0) >= (starCost(tr.id) as number) ? (
                        <div
                          {...pressable(() => { if (!busy) void payWithStars(tr.id); })}
                          style={{
                            cursor: 'pointer', marginTop: 7, borderRadius: 999, padding: '10px 14px', textAlign: 'center',
                            border: '1.5px solid var(--color-accent)', color: 'var(--color-accent-700)',
                            fontWeight: 800, fontSize: 11, letterSpacing: '.06em', opacity: busy ? 0.5 : 1,
                          }}
                        >
                          {busy === `stars:${tr.id}` ? t('PAYING…') : `OR PAY ★${starCost(tr.id)} FOR A MONTH`}
                        </div>
                      ) : (
                        <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--ink-40)', textAlign: 'center', lineHeight: 1.5 }}>
                          Or ★{starCost(tr.id)} a month — you have ★{wallet?.spendable ?? 0} to spend
                        </div>
                      )
                    )}
                  </>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>{t('Everything you use today stays free — a plan only lifts the ceilings. Cancel any time; if a payment lapses you drop back to the free plan and never lose the app.')}</div>
          {(wallet?.promo_locked ?? 0) > 0 && (
            <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>
              ★{wallet?.promo_locked} of your balance is the welcome gift — that one spends on plans, tabs and errands rather than on a membership.
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>{t('Months paid in Stars simply end — nothing renews on its own and no card is stored.')}</div>
        </div>
      )}

      {note && <div style={{ marginTop: 9, fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
