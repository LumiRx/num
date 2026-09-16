// THE ONE TIME WE MENTION A PLAN INSIDE THE APP.
//
// Dre, 16 Sep 2026: "we need a notification for them to purchase the
// subscription."
//
// ── WHY IT WAITS ─────────────────────────────────────────────────────────
//
// The same day this was asked, the X flight was sending real people into the
// app and not one of them typed anything. That is what an ad-funded product
// looks like when it asks before it gives, and it is the exact failure
// InstallPrompt already learned the hard way: it used to appear 1.2 seconds
// after load, and of the first seven arrivals we could measure, seven did
// nothing at all. It now waits for the first message, and says so in its own
// comments.
//
// So this does not appear on arrival, and it does not appear to someone still
// deciding whether Num is any good. It waits until a member has asked THREE
// times — enough that Num has demonstrably been useful — and only then
// mentions that the ceilings lift. An upgrade offered after value is a fair
// offer. The same words offered before it are a toll gate.
//
// ── AND WHY IT IS NOT ON iOS ─────────────────────────────────────────────
//
// `canOfferSubscription()` is false on iOS and this returns null there, for
// the same reason MembershipCard, WalletSheet's top-up block and WelcomePlans
// all do: Num bills through Stripe, and an iOS surface that sells a digital
// subscription is App Store guideline 3.1.1. Our App Review notes say, in
// these words, that there is "no purchase surface in the app" on iOS. A
// notification is a purchase surface — arguably the loudest kind, because
// nobody reviewing a screenshot would ever see it.
//
// It is shown ONCE, ever. A nudge that returns is an advert.
import { useEffect, useState } from 'react';
import { pressable } from '../../lib/a11y';
import { canOfferSubscription } from '../../lib/native';
import { apiUrl } from '../../lib/apibase';
import { store, useApp } from '../../lib/store';

const SEEN_KEY = 'num-plan-nudge-v1';
/** Asks before Num mentions money. Three is "this works", not "hello". */
const ASKS_BEFORE_ASKING = 3;

const seen = (): boolean => {
  // Private mode throws. Failing CLOSED means it is never shown rather than
  // shown on every single launch — the same choice WelcomePlans makes, and
  // for the same reason.
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
};
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ } };

export default function PlanNudge({ suppressed = false }: { suppressed?: boolean }) {
  // FIRST LINE, on purpose: nothing is fetched, nothing is subscribed to and
  // nothing renders on a storefront where Num does not sell.
  const selling = canOfferSubscription();

  const me = useApp((s) => s.me);
  const [show, setShow] = useState(false);
  const [tier, setTier] = useState<string | null>(null);

  // Wait for the third ask. Read from the store rather than a counter of our
  // own, so a reload mid-conversation does not restart the count.
  useEffect(() => {
    if (!selling || seen() || !me?.id) return;
    const enough = () => store.get().msgs.filter((m) => m.who === 'u').length >= ASKS_BEFORE_ASKING;
    if (enough()) { setShow(true); return; }
    const stop = store.subscribe(() => { if (enough()) { setShow(true); stop(); } });
    return () => { stop(); };
  }, [selling, me?.id]);

  // Only once we are going to show it — a member on a paid plan must never be
  // asked to buy the plan they already have.
  useEffect(() => {
    if (!show || !me?.id) return;
    void fetch(apiUrl(`/api/membership/me?me=${encodeURIComponent(me.id)}`))
      .then((r) => r.json())
      .then((d: { tier?: string }) => setTier(d?.tier ?? 'free'))
      .catch(() => setTier(null));
  }, [show, me?.id]);

  if (!selling || !show || suppressed) return null;
  // `null` means the account could not be read. Silence beats guessing: an
  // upgrade offer shown to somebody already paying is worse than no offer.
  if (tier !== 'free') return null;

  const dismiss = () => { markSeen(); setShow(false); };
  const openPlans = () => {
    markSeen();
    setShow(false);
    // The wallet is where the plans are listed and where checkout starts.
    store.set({ walletOpen: true });
  };

  return (
    <div
      className="glass-strong msg-in"
      role="status"
      style={{
        // Above InstallPrompt's lift of 78, not on top of it. Both are
        // one-shot and the install card fires after the FIRST ask while this
        // waits for the third, so they rarely coincide — but "rarely" is not
        // "never", and two cards in the same 12px gutter is a bug somebody
        // would have to reproduce by hand.
        position: 'absolute', left: 12, right: 12, bottom: 150, zIndex: 60,
        borderRadius: 'var(--r-md)', padding: '12px 13px',
      }}
    >
      <div style={{ fontSize: 9.5, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
        YOU’VE BEEN USING NUM
      </div>
      <div style={{ fontSize: 12.5, marginTop: 5, lineHeight: 1.45 }}>
        Everything you’ve done so far stays free, forever. If you want more room —
        more plans at once, deeper research — a plan lifts the ceilings.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
        <div
          {...pressable(openPlans)}
          className="press tap"
          style={{
            flex: 1, textAlign: 'center', borderRadius: 999, padding: '10px 12px',
            background: 'var(--grad-accent)', color: '#fff',
            fontWeight: 800, fontSize: 10.5, letterSpacing: '.06em', cursor: 'pointer',
          }}
        >
          SEE PLANS
        </div>
        {/* A real way out, the same height as the other one. A "no thanks"
            that is grey, tiny or phrased as an insult is the cheapest trick
            available and the one people remember. */}
        <div
          {...pressable(dismiss)}
          className="press tap"
          style={{
            flex: 1, textAlign: 'center', borderRadius: 999, padding: '10px 12px',
            border: '1px solid var(--ink-12)', color: 'var(--ink-60)',
            fontWeight: 700, fontSize: 10.5, letterSpacing: '.06em', cursor: 'pointer',
          }}
        >
          NOT NOW
        </div>
      </div>
    </div>
  );
}
