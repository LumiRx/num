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
import { amountOf, refreshActivity, stateNote, whenOf } from '../../lib/wallet';
import type { Pack } from '../../lib/wallet';
import MembershipCard from './MembershipCard';
import { apiUrl } from '../../lib/apibase';
import { loadMemberWallet, createMemberWallet, shortAddress, type MemberWallet } from '../../lib/memberwallet';
import { loadHistory, type PaidBill } from '../../lib/bill';
import { t } from '../../lib/i18n';

// No PACKS constant here on purpose. The wallet used to carry its own copy of
// the prices, which is two sources of truth for a number an attacker would
// love to control. /api/pay/status is the only one now.

export default function WalletSheet() {
  const open = useApp((s) => s.walletOpen);
  const stars = useApp((s) => s.stars);
  const bought = useApp((s) => s.bought);
  const txns = useApp((s) => s.txns);
  const account = useApp((s) => s.me);
  // The member's own wallet, if they have one. Its own state and its own
  // strip: Stars and USDC are different assets, and the moment they share a
  // total nobody can check the number.
  const [coin, setCoin] = useState<MemberWallet | null>(null);
  const [coinBusy, setCoinBusy] = useState(false);
  // What they have actually paid through NUM. Bills only — Stars on a tab and
  // money on a bill are different units, and a single total would be a number
  // that means nothing.
  const [paid, setPaid] = useState<PaidBill[]>([]);
  const [coinErr, setCoinErr] = useState<string | null>(null);
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
    if (account?.id) void loadMemberWallet(account.id).then(setCoin);
    if (account?.id) void loadHistory(account.id).then((h) => setPaid(h.bills));
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
  // IT HAS TO SCROLL (18 Sep 2026). The balance, the top-up packs, the two
  // plans, split-a-tab, errands and the receipts ledger do not fit on a phone,
  // and without this the bottom half simply could not be reached — the plans
  // went in and pushed everything below them off the sheet.
  // `overscrollBehavior: contain` keeps a flick at the end of the list from
  // dragging the page behind it.
  return (
    <div
      ref={ref}
      className="glass-strong sheet-in no-scrollbar"
      style={{
        ...sheetBase,
        visibility: open ? 'visible' : 'hidden',
        transform: open ? 'translateY(0)' : 'translateY(105%)',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label={t('Close')}
        className="glass press"
        style={{ position: 'absolute', top: 6, right: 6, width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>
      <div style={{ padding: 16, borderBottom: '1px solid var(--ink-08)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>{t('STARS — YOUR BALANCE')}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
            <StarIcon size={22} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 30, lineHeight: 1 }}>{stars.toLocaleString()}</span>
          </div>
        </div>
        {/* No exchange rate here. The old line ("1★ ≈ $0.30") read as a
            redemption promise across the whole balance, which is only true of
            the earned half — that number lives in its own row below. */}
        <div style={{ fontSize: 10, color: 'var(--color-neutral-600)', textAlign: 'right', lineHeight: 1.5 }}>{t('Earn it, spend it, cash it out')}<br />{t('friends see plans, never stars')}</div>
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
        <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)', marginBottom: 8 }}>{t('TOP UP — INSTANT')}</div>
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
            <div style={{ fontSize: 10.5, color: 'var(--color-neutral-500)', padding: '6px 0' }}>{t('Checking today’s prices…')}</div>
          )}
        </div>
        {!!bought && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-accent-700)', fontWeight: 600 }}>{bought}</div>}
        {/* Said plainly, where the money decision happens. */}
        <div style={{ marginTop: 8, fontSize: 9.5, color: 'var(--color-neutral-500)', lineHeight: 1.5 }}>{t('Stars you buy spend inside NUM — errands, tabs, bookings. Stars you')}{' '}<strong>{t('earn')}</strong>{' '}{t('can be cashed out to 5arz.')}</div>
      </div>
      )}
      {/* THE PLANS, beside the packs.
          A wallet is the one screen somebody opens having already decided to
          spend, and until 18 Sep 2026 the only pricing ladder lived in
          Profile — two taps away from here.

          RENDERED, NOT REBUILT. MembershipCard owns the tiers, the
          upgrade-with-Stars path and, most importantly, the
          canOfferSubscription() gate. Rebuilding the ladder here would have
          been a second notion of "may we sell on this platform", which is
          exactly the mistake the packs comment above warns about: on 15 Aug
          the gate existed and nothing called it, and the whole ladder
          rendered on iOS after we had told App Review it could not. Reuse
          keeps that promise for free — the card shows the member's current
          tier everywhere, and the paid rows only where selling is allowed.

          MOUNTED ONLY WHILE OPEN. This sheet never unmounts — it hides with
          `visibility: hidden` and a transform (see the root above), so an
          unguarded MembershipCard would fetch tiers, the member's plan and
          the Stars wallet on EVERY app load for the nine in ten launches
          where nobody opens the wallet. Three requests against a rate
          limiter that already answers 429 under light load. */}
      {open && (
        <div style={{ padding: '2px 16px 12px', borderBottom: '1px solid var(--ink-08)' }}>
          <MembershipCard />
        </div>
      )}
      {/* EARNED — the money side. Shown only when there is something to show,
          so it never nags a traveller who has never run an errand. */}
      {!!out && out.cashable > 0 && (
        <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--ink-08)' }}>
          <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)' }}>{t('EARNED — YOURS TO CASH OUT')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17 }}>★{out.cashable.toLocaleString()}</div>
              <div style={{ fontSize: 10, color: 'var(--color-neutral-600)', marginTop: 2, lineHeight: 1.45 }}>
                {out.open
                  ? 'Sends to your 5arz account.'
                  : 'Counted and safe — cash-out opens shortly.'}
                {out.locked_purchased > 0 && ` ★${out.locked_purchased.toLocaleString()} bought, spends in NUM.`}
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
      {/* ── USDC, kept apart from Stars on purpose ──────────────────────────
          Shown only when the member could actually use it: a wallet they have,
          or an offer to make one when wallets are switched on. No balance is
          invented — an unreadable chain says so rather than showing 0. */}
      {account && coin && (coin.wallet || coin.available) && (
        <div style={{ padding: '0 16px 14px' }}>
          <div className="glass" style={{ borderRadius: 14, padding: '12px 13px' }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>{t('YOUR WALLET')}</div>
            {coin.wallet ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 3 }}>
                  <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18 }}>
                    {coin.balance ? `${coin.balance.display} ${coin.balance.symbol}` : t('Balance unavailable')}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--ink-40)' }}>{t('on Base')}</span>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-60)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
                  {shortAddress(coin.wallet.address)}
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.45 }}>
                  {coin.balance
                    ? t('Yours, not NUM\'s — NUM never holds the key and never adds this to your Stars.')
                    : t('We could not reach the chain just now. Your money is where it was; only this number is missing.')}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>
                  {t('A wallet of your own on Base, made from the number you already verified. NUM never holds the key, never funds it, and never counts it as Stars.')}
                </div>
                {coinErr && <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 6 }}>{coinErr}</div>}
                <div
                  {...pressable(() => {
                    if (!account?.id || coinBusy) return;
                    setCoinBusy(true); setCoinErr(null);
                    void createMemberWallet(account.id).then(async (r) => {
                      if (r.ok) setCoin(await loadMemberWallet(account.id));
                      else setCoinErr(r.error);
                      setCoinBusy(false);
                    });
                  })}
                  role="button"
                  style={{
                    cursor: 'pointer', marginTop: 10, minHeight: 44, boxSizing: 'border-box', borderRadius: 999,
                    background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 11,
                    letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center', opacity: coinBusy ? 0.6 : 1,
                  }}
                >
                  {coinBusy ? t('MAKING IT…') : t('GIVE ME A WALLET')}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div style={{ padding: '0 16px 14px' }}>
        {/* WHAT YOU HAVE PAID.
            Only bills that actually settled, and only ones this member was
            signed in for. A bill paid in a browser by somebody not signed in
            belongs to nobody and appears here for nobody — half the value of
            a history is trusting that what is in it is yours. */}
        {!!paid.length && (
          <div className="glass lift" style={{ borderRadius: 14, padding: '12px 13px', marginBottom: 14 }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>{t('BILLS YOU HAVE PAID')}</div>
            {paid.slice(0, 8).map((b) => (
              <div key={b.token} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.venue}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 1 }}>
                    {new Date(b.paid_at).toLocaleDateString()}
                    {b.share_of ? ` · ${t('your share')}` : ''}
                  </div>
                </div>
                <div style={{ flex: 'none', fontWeight: 700, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>
                  {b.currency} {b.amount}
                </div>
              </div>
            ))}
          </div>
        )}
        <TabStarter />
        <div
          {...pressable(() => store.set({ walletOpen: false, errandsOpen: true }))}
          className="glass lift"
          style={{ cursor: 'pointer', marginTop: 14, borderRadius: 14, padding: '12px 13px' }}
        >
          <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>{t('ERRANDS')}</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 3 }}>{t('Need something fetched?')}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2, lineHeight: 1.45 }}>{t('Post it with a bounty and someone nearby goes — or earn Stars running one yourself.')}</div>
        </div>
      </div>
      {/* Payment methods: what the server says is wired, never a costume. */}
      <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--ink-08)', display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--color-neutral-700)' }}>
        {pay?.mode === 'stripe' ? (
          <>
            <span style={{ fontWeight: 600 }}>{' '}{t('Apple Pay · ready')}</span>
            <span>{t('Cards via Stripe')}</span>
            {!pay.stars_sale && <span style={{ color: 'var(--color-accent-700)', fontWeight: 600 }}>{t('Top-ups opening soon')}</span>}
          </>
        ) : (
          <span>{t('Pay rail connects soon — Stars are earned, and bills settle in person until then.')}</span>
        )}
      </div>
      <div className="no-scrollbar" style={{ padding: '12px 16px 18px', maxHeight: 150, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)', marginBottom: 6 }}>
          <WalletIcon size={12} style={{ color: 'var(--ink-40)' }} />{t('ACTIVITY & RECEIPTS')}</div>
        {activity.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--color-neutral-500)', lineHeight: 1.5, padding: '4px 0' }}>{t('Nothing yet. Stars you earn, bills you settle and anything you\'re charged all land here.')}</div>
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
