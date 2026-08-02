// Stars wallet sheet — balance, instant top-up packs, payment methods,
// and the activity/receipts ledger.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { StarIcon, WalletIcon, XIcon } from '../../lib/icons';
import { buyPack } from '../../lib/concierge';
import { TabStarter } from './TabSheet';

const PACKS: Array<{ stars: string; price: string; n: number; cents: number }> = [
  { stars: '★500', price: '$150', n: 500, cents: 15000 },
  { stars: '★1,000', price: '$295', n: 1000, cents: 29500 },
  { stars: '★5,000', price: '$1,425', n: 5000, cents: 142500 },
];

export default function WalletSheet() {
  const open = useApp((s) => s.walletOpen);
  const stars = useApp((s) => s.stars);
  const bought = useApp((s) => s.bought);
  const txns = useApp((s) => s.txns);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  // What the pay rail can actually do right now — asked, not asserted.
  const [pay, setPay] = useState<{ mode: string; stars_sale?: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetch('/api/pay/status')
      .then((r) => r.json())
      .then((d: { mode: string; stars_sale?: boolean }) => setPay(d))
      .catch(() => setPay(null));
  }, [open]);

  const close = () => store.set({ walletOpen: false });
  return (
    <div ref={ref} className="glass-strong" style={{ ...sheetBase, visibility: open ? 'visible' : 'hidden', transform: open ? 'translateY(0)' : 'translateY(105%)' }}>
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
        {/* Stars are closed-loop: credit for Num, never convertible to cash.
            The old line ("1★ ≈ $0.30") read as an exchange rate, which is the
            one thing they are not. */}
        <div style={{ fontSize: 10, color: 'var(--color-neutral-600)', textAlign: 'right', lineHeight: 1.5 }}>
          Spends inside Num<br />friends see plans, never stars
        </div>
      </div>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ink-08)' }}>
        <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)', marginBottom: 8 }}>TOP UP — INSTANT</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {PACKS.map((p) => (
            <div
              key={p.stars}
              {...pressable(() => { void buyPack(p.n, p.cents); })}
              className="glass lift press"
              style={{ flex: 1, cursor: 'pointer', borderRadius: 'var(--r-md)', padding: '10px 12px' }}
            >
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14 }}>{p.stars}</div>
              <div style={{ fontSize: 9.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>{p.price}</div>
            </div>
          ))}
        </div>
        {!!bought && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-accent-700)', fontWeight: 600 }}>{bought}</div>}
        {/* Said plainly, where the money decision happens. */}
        <div style={{ marginTop: 8, fontSize: 9.5, color: 'var(--color-neutral-500)', lineHeight: 1.5 }}>
          Stars are credit for Num — errands, tabs, bookings. They don’t convert to cash and don’t leave the app.
        </div>
      </div>
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
        {txns.map((t) => (
          <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--ink-08)', fontSize: 11.5 }}>
            <div>
              {t.t}
              <div style={{ fontSize: 9.5, color: 'var(--color-neutral-500)', marginTop: 1 }}>{t.meta}</div>
            </div>
            <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: t.dir ? '#1f7a48' : 'var(--ink)' }}>{t.amt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
