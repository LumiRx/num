// Carrying a friend across the Safari ↔ home-screen wall.
//
// iOS gives the installed app and Safari separate storage, so each has its own
// NUM identity. A friend link tapped in Messages opens Safari and used to bind
// the friendship to an identity the person's real app can never see — "it
// added them to my Safari NUM".
//
// Two faces, one component:
//   · In the BROWSER, holding a parked connection → show the code to carry.
//   · In the APP → offer to type a code in.
//
// Deliberately not automatic: iOS gives us no way to hand a value from Safari
// to the installed app without the person carrying it. Six characters is the
// smallest honest ask.
import { useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { redeemPairCode } from '../../lib/social';
import { t } from '../../lib/i18n';
import { canOfferSubscription } from '../../lib/native';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };

/** Browser side: "here's the code, open NUM." */
export function PairHandoff() {
  const code = useApp((s) => s.pairCode);
  const [copied, setCopied] = useState(false);
  if (!code) return null;
  return (
    <div className="glass" style={{ ...card, border: '1px solid var(--color-accent)' }}>
      <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 700, color: 'var(--color-accent)' }}>{t('ONE STEP LEFT')}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 16, marginTop: 4 }}>{t('Open NUM and enter this code')}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>{t('You’re in the browser right now, and your NUM app keeps its own account. This carries the connection over to where your plans actually live.')}</div>
      <div
        style={{
          margin: '11px 0 9px', padding: '13px 10px', borderRadius: 12, textAlign: 'center',
          background: 'var(--field-bg)', fontFamily: 'var(--font-heading)', fontWeight: 800,
          fontSize: 27, letterSpacing: '.22em',
        }}
      >
        {code}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div
          {...pressable(() => {
            void navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => {});
          })}
          className="press"
          style={{ flex: 1, cursor: 'pointer', textAlign: 'center', borderRadius: 999, padding: '11px 14px', background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '.06em' }}
        >
          {copied ? t('COPIED') : t('COPY CODE')}
        </div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.5 }}>{t('Good for 15 minutes. No NUM app yet? Add this page to your home screen first — then open it and enter the code.')}</div>
    </div>
  );
}

/** App side: type the code in. Collapsed until someone needs it. */
export function PairRedeem() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    const err = await redeemPairCode(code);
    setBusy(false);
    if (err) { setMsg(err); return; }
    setMsg(t('Connected — they’re in your friends now.'));
    setCode('');
    setTimeout(() => { setOpen(false); setMsg(null); }, 2200);
  };

  if (!open) {
    return (
      <div
        {...pressable(() => setOpen(true))}
        className="glass"
        style={{ ...card, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('Have a code from a link?')}</div>
          <div style={{ fontSize: 10.5, color: 'var(--ink-60)', marginTop: 2 }}>{t('Finish a connection that opened in your browser')}</div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', color: 'var(--ink-60)', whiteSpace: 'nowrap' }}>{t('ENTER')}</span>
      </div>
    );
  }

  return (
    <div className="glass" style={card}>
      <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 700, color: 'var(--ink-40)' }}>{t('PAIRING CODE')}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          placeholder={t('ABC123')}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, border: '1px solid var(--ink-12)', background: 'var(--field-bg)',
            borderRadius: 12, padding: '11px 12px', fontSize: 17, fontWeight: 700,
            letterSpacing: '.18em', textAlign: 'center', color: 'var(--ink)',
          }}
        />
        <div
          {...pressable(() => { if (!busy && code.length === 6) void submit(); })}
          className="press"
          style={{
            cursor: code.length === 6 ? 'pointer' : 'default', borderRadius: 999, padding: '11px 16px',
            display: 'flex', alignItems: 'center', fontWeight: 800, fontSize: 11, letterSpacing: '.06em',
            background: code.length === 6 ? 'var(--grad-accent)' : 'var(--ink-12)',
            color: code.length === 6 ? '#fff' : 'var(--ink-60)',
          }}
        >
          {busy ? '…' : 'GO'}
        </div>
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-accent-700)' }}>{msg}</div>}
      <div
        {...pressable(() => { setOpen(false); setMsg(null); })}
        style={{ marginTop: 9, fontSize: 10.5, color: 'var(--ink-40)', cursor: 'pointer' }}
      >
        Not now
      </div>
    </div>
  );
}

/** One import for callers: the right face for where we are. */
export default function PairBridge({ installed }: { installed: boolean }) {
  const code = useApp((s) => s.pairCode);
  const me = useApp((s) => s.me);
  if (!installed) return code ? <PairHandoff /> : null;
  if (!me) return null;
  // No "enter a code" field in the iOS app: App Review 3.1.1 (21 Sep 2026)
  // rejected "code to unlock or enable content", and a reviewer cannot tell a
  // friend-pairing code from a redeem code by looking. Friends still connect
  // there by QR and by link, which need no code at all.
  if (!canOfferSubscription()) return null;
  return <PairRedeem />;
}

/** Used by the profile sheet to clear a stale handoff. */
export const clearPair = () => store.set({ pairCode: null });
