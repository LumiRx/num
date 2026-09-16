// Stars wallet sheet — balance, instant top-up packs, payment methods,
// and the activity/receipts ledger.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { StarIcon, WalletIcon, XIcon } from '../../lib/icons';
import { buyPack, requestCashout } from '../../lib/concierge';
import { canOfferSubscription } from '../../lib/native';
import { TabStarter } from './TabSheet';
import MembershipCard from './MembershipCard';
import { amountOf, refreshActivity, stateNote, whenOf } from '../../lib/wallet';
import type { Pack } from '../../lib/wallet';
import { apiUrl } from '../../lib/apibase';

// No PACKS constant here on purpose. The wallet used to carry its own copy of
// the prices, which is two sources of truth for a number an attacker would
// love to control. /api/pay/status is the only one now.

export default function WalletSheet() {
  const open = useApp((s) => s.walletOpen);
  const stars = useApp((s) => s.stars);
  const bought = useApp((s) => s.bought);
  const txns = useApp((s) => s.txns);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  // What the pay rail can actually do right now — asked, not asserted.
  const [pay, setPay] = useState<{ mode: string; stars_sale?: boolean; packs?: Pack[] } | null>(null);
  // Earned vs bought. Only earned Stars can become money — the wallet says so
  // with a number rather than making someone find out at the worst moment.
  const [out, setOut] = useState<{ open: boolean; cashable: number; locked_purchased: number } | null>(null);
  const activity = useApp((s) => s.activity);

  useEffect(() => {
    if (!open) return;
    void fetch(apiUrl('/api/pay/status')).then((r) => r.json()).then(setPay).catch(() => setPay(null));
    // Pulled on every open. A wallet is read precisely when someone doubts
    // what it says, so a cached one is worth very little.
    void refreshActivity();
    const me = store.get().me;
    if (me) {
      void fetch(apiUrl(`/api/cashout/quote?me=${encodeURIComponent(me.id)}`))
        .then((r) => r.json())
        .then(setOut)
        .catch(() => setOut(null));
    }
  }, [open]);

  const close = () => store.set({ walletOpen: false });
  return (
    // maxHeight + overflowY: this sheet just grew.
    //
    // It was balance + top-ups + tab + errands + receipts, which fitted. Adding
    // the plan ladder on 16 Sep put two more priced cards inside it, and with
    // no ceiling on the root the bottom of the sheet simply runs off the
    // bottom of a phone — which is precisely how WelcomePlans shipped with its
    // only exit button below the fold. Caught by sheetbackground.test.mjs
    // within a minute of the ladder going in.
    //
    // The receipts list keeps its own inner scroller; this is the outer one,
    // so a short phone can still reach everything.
    <div
      ref={ref}
      className="glass-strong"
      style={{
        ...sheetBase,
        maxHeight: 'min(92%, calc(100% - var(--sat, 0px) - 8px))',
        overflowY: 'auto',
        visibility: open ? 'visible' : 'hidden',
        transform: open ? 'translateY(0)' : 'translateY(105%)',
      }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>
      <div style={{ padding: 16, borderBottom: '1px solid var(--ink-08)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>STARS — YOUR BALANCE</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
            <StarIcon size={22} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 30, lineHeight: 1 }}>{stars.toLocaleString()}</span>
          </div>
        </div>
        {/* No exchange rate here. The old line ("1★ ≈ $0.30") read as a
            redemption promise across the whole balance, which is only true of
            the earned half — that number lives in its own row below. */}
        <div style={{ fontSize: 10, color: 'var(--color-neutral-600)', textAlign: 'right', lineHeight: 1.5 }}>
          Earn it, spend it, cash it out<br />friends see plans, never stars
        </div>
      </div>
      {/* NOT ON iOS. Stars are currency spent inside the app — errands, tabs,
          bounties — so selling them here is digital content under App Store
          guideline 3.1.1 and must go through IAP. Our own App Review notes
          state "the app sells NO digital content"; with STARS_SALE_OK on and
          this panel rendering $500–$5,000 packs, that sentence stopped being
          true and a reviewer would have read it next to the packs. A false
          statement to App Review costs far more than a rejection.

          `canOfferSubscription()` already gates the membership card for the
          same reason on the same platform, so this reuses it rather than
          inventing a second notion of "may we sell here". Web and Android are
          unaffected; the wallet still shows the balance, the ledger and
          cash-out everywhere. */}
      {canOfferSubscription() && (
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ink-08)' }}>
        <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)', marginBottom: 8 }}>TOP UP — INSTANT</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(pay?.packs ?? []).map((p) => (
            <div
              key={p.stars}
              {...pressable(() => { void buyPack(p.stars, p.cents); })}
              className="glass lift press"
              style={{ flex: 1, cursor: 'pointer', borderRadius: 'var(--r-md)', padding: '10px 12px' }}
            >
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14 }}>★{p.stars.toLocaleString()}</div>
              <div style={{ fontSize: 9.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>{p.price}</div>
            </div>
          ))}
          {/* Until the server has answered, show nothing rather than a price
              we made up. A wrong price shown for half a second is still a
              wrong price someone can tap. */}
          {!pay?.packs?.length && (
            <div style={{ fontSize: 10.5, color: 'var(--color-neutral-500)', padding: '6px 0' }}>
              Checking today’s prices…
            </div>
          )}
        </div>
        {!!bought && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-accent-700)', fontWeight: 600 }}>{bought}</div>}
        {/* Said plainly, where the money decision happens. */}
        <div style={{ marginTop: 8, fontSize: 9.5, color: 'var(--color-neutral-500)', lineHeight: 1.5 }}>
          Stars you buy spend inside Num — errands, tabs, bookings. Stars you <strong>earn</strong> can be cashed out to 5arz.
        </div>
      </div>
      )}

      {/* WHY YOUR BALANCE CHANGED — shown only to the people it happened to.
          
          On 16 Sep 2026 the welcome grant was cut ★100 → ★5 and the 94 members
          already holding ★100 were brought down with it. They did nothing
          wrong and they were not asked, so the least we owe them is a
          sentence, in the one place they would go to find out — next to the
          balance, not buried in a changelog nobody reads.
          
          Conditioned on the member's OWN ledger rather than a date or a flag:
          if the rebalance move is not in their receipts, this never renders.
          The activity feed is already loaded for the sheet, so this costs no
          extra request. */}
      {activity.some((a) => String(a.id).startsWith('rebal20260916_')) && (
        <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--ink-08)', background: 'var(--ink-04, rgba(0,0,0,.02))' }}>
          <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)' }}>ABOUT YOUR WELCOME STARS</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
            We started everyone on ★100 and have moved that to ★5. The welcome
            Stars were only ever spendable between members inside Num — they
            could never be cashed out — and we would rather the number meant
            something real than look generous. Anything you bought or earned is
            untouched, and it is all itemised below.
          </div>
        </div>
      )}

      {/* THE PLANS, LISTED — this is the buy surface, so prices are shown.
          
          Dre, 16 Sep 2026: "we need to list the subscriptions to buy for the
          app in the buy section."
          
          This mounts the SAME MembershipCard the profile uses rather than a
          second copy of the ladder. That matters beyond tidiness: the card
          already owns the canOfferSubscription() gate, the server-owned
          prices, the Stars door, the cancel button and the rule that no tier
          may ever advertise a travel benefit (California B&P §17550.27). A
          hand-rolled list here would be a second surface where every one of
          those could drift out of agreement — and the travel one is a
          $100,000 bond, not a copy nit.
          
          `startOpen` because a shop that hides its prices behind a tap is a
          shop nobody buys from. iOS still renders none of it. */}
      <div style={{ borderBottom: '1px solid var(--ink-08)', padding: '2px 4px 8px' }}>
        <MembershipCard startOpen />
      </div>

      {/* EARNED — the money side. Shown only when there is something to show,
          so it never nags a traveller who has never run an errand. */}
      {!!out && out.cashable > 0 && (
        <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--ink-08)' }}>
          <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)' }}>EARNED — YOURS TO CASH OUT</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17 }}>★{out.cashable.toLocaleString()}</div>
              <div style={{ fontSize: 10, color: 'var(--color-neutral-600)', marginTop: 2, lineHeight: 1.45 }}>
                {out.open
                  ? 'Sends to your 5arz account.'
                  : 'Counted and safe — cash-out opens shortly.'}
                {out.locked_purchased > 0 && ` ★${out.locked_purchased.toLocaleString()} bought, spends in Num.`}
              </div>
            </div>
            <div
              {...pressable(() => { void requestCashout(out.cashable); })}
              className="press"
              style={{
                cursor: out.open ? 'pointer' : 'default', borderRadius: 999, padding: '9px 14px',
                fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', whiteSpace: 'nowrap',
                background: out.open ? 'var(--grad-accent)' : 'var(--ink-12)',
                color: out.open ? '#fff' : 'var(--ink-60)',
              }}
            >
              CASH OUT
            </div>
          </div>
        </div>
      )}
      <div style={{ padding: '0 16px 14px' }}>
        <TabStarter />
        <div
          {...pressable(() => store.set({ walletOpen: false, errandsOpen: true }))}
          className="glass lift"
          style={{ cursor: 'pointer', marginTop: 14, borderRadius: 14, padding: '12px 13px' }}
        >
          <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>ERRANDS</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 3 }}>
            Need something fetched?
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2, lineHeight: 1.45 }}>
            Post it with a bounty and someone nearby goes — or earn Stars running one yourself.
          </div>
        </div>
      </div>
      {/* Payment methods: what the server says is wired, never a costume. */}
      <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--ink-08)', display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--color-neutral-700)' }}>
        {pay?.mode === 'stripe' ? (
          <>
            <span style={{ fontWeight: 600 }}> Apple Pay · ready</span>
            <span>Cards via Stripe</span>
            {!pay.stars_sale && <span style={{ color: 'var(--color-accent-700)', fontWeight: 600 }}>Top-ups opening soon</span>}
          </>
        ) : (
          <span>Pay rail connects soon — Stars are earned, and bills settle in person until then.</span>
        )}
      </div>
      <div className="no-scrollbar" style={{ padding: '12px 16px 18px', maxHeight: 150, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)', marginBottom: 6 }}>
          <WalletIcon size={12} style={{ color: 'var(--ink-40)' }} />
          ACTIVITY & RECEIPTS
        </div>
        {activity.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--color-neutral-500)', lineHeight: 1.5, padding: '4px 0' }}>
            Nothing yet. Stars you earn, bills you settle and anything you're charged all land here.
          </div>
        )}
        {activity.map((a) => {
          const note = stateNote(a);
          const good = a.unit === 'stars' && a.delta > 0;
          // A refund or a failure must not read like a normal line. Someone
          // scanning for "why am I down money" should hit it immediately.
          const wrong = a.state === 'failed' || a.state === 'refunded' || a.state === 'disputed';
          return (
            <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--ink-08)', fontSize: 11.5 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</div>
                <div style={{ fontSize: 9.5, color: wrong ? '#a3271c' : 'var(--color-neutral-500)', marginTop: 1 }}>
                  {[note, a.detail, whenOf(a.at)].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span
                style={{
                  fontWeight: 700, whiteSpace: 'nowrap',
                  color: wrong ? 'var(--color-neutral-500)' : good ? '#1f7a48' : 'var(--ink)',
                  textDecoration: a.state === 'refunded' ? 'line-through' : 'none',
                }}
              >
                {amountOf(a)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
