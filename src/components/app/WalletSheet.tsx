// Stars wallet sheet — balance, instant top-up packs, payment methods,
// and the activity/receipts ledger.
import { useRef } from 'react';
import { useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase } from '../../lib/derive';
import { buyPack } from '../../lib/concierge';

const PACKS: Array<{ stars: string; price: string; n: number; via: string }> = [
  { stars: '★500', price: '฿5,000 · Apple Pay', n: 500, via: 'Apple Pay' },
  { stars: '★1,000', price: '฿9,900 · Apple Pay', n: 1000, via: 'Apple Pay' },
  { stars: '★5,000', price: '฿47,500 · card', n: 5000, via: 'Visa ··4242' },
];

export default function WalletSheet() {
  const open = useApp((s) => s.walletOpen);
  const stars = useApp((s) => s.stars);
  const bought = useApp((s) => s.bought);
  const txns = useApp((s) => s.txns);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  return (
    <div ref={ref} style={{ ...sheetBase, visibility: open ? 'visible' : 'hidden', transform: open ? 'translateY(0)' : 'translateY(105%)' }}>
      <div style={{ padding: 16, borderBottom: '2px solid var(--color-divider)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>STARS — YOUR BALANCE</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 30, lineHeight: 1, marginTop: 6 }}>★ {stars.toLocaleString()}</div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-neutral-600)', textAlign: 'right', lineHeight: 1.5 }}>
          1★ = ฿10 · Num is the payrail<br />friends see plans, never stars
        </div>
      </div>
      <div style={{ padding: '12px 16px', borderBottom: '2px solid var(--color-divider)' }}>
        <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)', marginBottom: 8 }}>TOP UP — INSTANT</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {PACKS.map((p) => (
            <div
              key={p.stars}
              {...pressable(() => buyPack(p.n, p.via))}
              className="hov-accent-100"
              style={{ flex: 1, cursor: 'pointer', border: '2px solid var(--color-text)', padding: '8px 10px', background: '#fff' }}
            >
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14 }}>{p.stars}</div>
              <div style={{ fontSize: 9.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>{p.price}</div>
            </div>
          ))}
        </div>
        {!!bought && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-accent-700)', fontWeight: 600 }}>{bought}</div>}
      </div>
      <div style={{ padding: '11px 16px', borderBottom: '2px solid var(--color-divider)', display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--color-neutral-700)' }}>
        <span style={{ fontWeight: 600 }}> Apple Pay · on</span>
        <span>Visa ··4242</span>
        <span style={{ color: 'var(--color-accent-700)', fontWeight: 600 }}>Crypto — we text a link</span>
      </div>
      <div className="no-scrollbar" style={{ padding: '12px 16px 18px', maxHeight: 150, overflowY: 'auto' }}>
        <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)', marginBottom: 6 }}>ACTIVITY & RECEIPTS</div>
        {txns.map((t) => (
          <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--color-neutral-200)', fontSize: 11.5 }}>
            <div>
              {t.t}
              <div style={{ fontSize: 9.5, color: 'var(--color-neutral-500)', marginTop: 1 }}>{t.meta}</div>
            </div>
            <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: t.dir ? 'var(--color-accent-700)' : 'var(--color-text)' }}>{t.amt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
