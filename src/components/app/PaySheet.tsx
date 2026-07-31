// Paying by scan. The QR is a plain https link, so the phone's own camera opens
// it — no in-app scanner to build, nothing to install, and it works on iOS
// where the web has no barcode API at all. Scanning lands here with the payee
// and amount already filled in; all that is left is to look at it and confirm.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { StarIcon, XIcon } from '../../lib/icons';
import { payStars } from '../../lib/stars';

const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};

export default function PaySheet() {
  const req = useApp((s) => s.payOpen);
  const balance = useApp((s) => s.stars);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(!!req, ref);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // One idempotency key per open request: a retry after a dropped connection
  // must not be able to pay twice.
  const idem = useRef<string>('');

  useEffect(() => {
    if (!req) return;
    setAmount(req.amount ? String(req.amount) : '');
    setNote(req.note ?? '');
    setDone(null);
    idem.current = crypto.randomUUID();
  }, [req?.to, req?.amount]);

  if (!req) return null;
  const close = () => store.set({ payOpen: null });
  const n = Math.floor(Number(amount));
  const valid = Number.isFinite(n) && n > 0 && n <= balance;

  const send = async () => {
    if (!valid) return;
    setBusy(true);
    const out = await payStars(req.to, n, note.trim() || undefined, idem.current);
    setDone(out.message);
    setBusy(false);
  };

  return (
    <div ref={ref} className="glass-strong" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: '86%', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label="Close" className="glass press" style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>PAY WITH STARS</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>
          {done ? done : `Pay ${req.toName ?? 'them'}`}
        </div>

        {!me ? (
          <>
            <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 6, lineHeight: 1.55 }}>
              Add your name and number first — Stars move between accounts, so we need to know whose they are.
            </div>
            <div {...pressable(() => store.set({ payOpen: null, inviteOpen: {} }))} style={{ cursor: 'pointer', marginTop: 14, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center' }}>
              ADD MY NAME &amp; NUMBER
            </div>
          </>
        ) : done ? (
          <>
            <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 6 }}>Balance ★{balance.toLocaleString()}</div>
            <div {...pressable(close)} style={{ cursor: 'pointer', marginTop: 14, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center' }}>
              DONE
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 6, display: 'flex', gap: 5, alignItems: 'center' }}>
              <StarIcon size={12} style={{ color: 'var(--color-accent)' }} /> You have ★{balance.toLocaleString()}
            </div>
            <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
              <input style={field} inputMode="numeric" placeholder="How many Stars?" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
              <input style={field} placeholder="What for? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div
                {...pressable(send)}
                style={{
                  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
                  fontSize: 12, letterSpacing: '.06em', padding: '14px 16px', textAlign: 'center',
                  boxShadow: '0 4px 14px rgba(236,48,19,.3)', opacity: busy || !valid ? 0.55 : 1,
                }}
              >
                {busy ? 'SENDING…' : valid ? `SEND ★${n.toLocaleString()}` : n > balance ? 'NOT ENOUGH STARS' : 'ENTER AN AMOUNT'}
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
              Stars are in-app credit, not money, and they move instantly between Num accounts. Check the name above before you send — this cannot be undone from here.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
