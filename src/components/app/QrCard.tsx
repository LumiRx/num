// Your codes. Two of them, because they answer two different questions:
// "connect with me" and "pay me". Both are plain https links, so any phone's
// camera opens them — no scanner, no app on the other side.
import { useMemo, useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { qrSvg } from '../../lib/qr';
import { connectLink, payLink } from '../../lib/stars';
import { shareNative } from '../../lib/services';
import { CopyIcon, ShareIcon } from '../../lib/icons';

function Qr({ value }: { value: string }) {
  // Rendered as an SVG string: it scales to any screen without blurring and
  // costs no network request, which matters when someone is scanning it with
  // one bar of signal.
  const svg = useMemo(() => qrSvg(value, { size: 208, dark: 'var(--ink)', light: 'transparent' }), [value]);
  return (
    <div
      style={{ display: 'flex', justifyContent: 'center', padding: 14, background: 'var(--field-bg)', borderRadius: 'var(--r-md)', border: '1px solid var(--ink-08)' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default function QrCard() {
  const me = useApp((s) => s.me);
  const [tab, setTab] = useState<'connect' | 'pay'>('connect');
  const [amount, setAmount] = useState('');
  const [copied, setCopied] = useState(false);
  if (!me) return null;

  const value = tab === 'connect' ? connectLink(me.ref, me.id) : payLink(me.id, Number(amount) || undefined);
  const label = tab === 'connect' ? 'Scan to connect with me' : amount ? `Scan to pay me ★${Number(amount).toLocaleString()}` : 'Scan to pay me';

  const Tab = ({ id, text }: { id: 'connect' | 'pay'; text: string }) => (
    <span
      {...pressable(() => setTab(id))}
      aria-selected={tab === id}
      style={{
        cursor: 'pointer', flex: 1, textAlign: 'center', padding: '8px 10px', borderRadius: 999,
        fontSize: 11, fontWeight: 800, letterSpacing: '.06em',
        background: tab === id ? 'var(--grad-accent)' : 'transparent',
        color: tab === id ? '#fff' : 'var(--ink-60)',
      }}
    >
      {text}
    </span>
  );

  return (
    <div>
      <div className="glass" style={{ display: 'flex', gap: 4, borderRadius: 999, padding: 4 }}>
        <Tab id="connect" text="CONNECT" />
        <Tab id="pay" text="GET PAID" />
      </div>

      <div style={{ marginTop: 12 }}>
        <Qr value={value} />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 8, textAlign: 'center', lineHeight: 1.5 }}>{label}</div>

      {tab === 'pay' && (
        <input
          style={{ width: '100%', height: 42, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 13px', fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)', marginTop: 10 }}
          inputMode="numeric"
          placeholder="Ask for a set amount (optional)"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <div
          {...pressable(() => void shareNative({ title: tab === 'connect' ? 'Connect with me on Num' : 'Pay me on Num', text: label, url: value }))}
          style={{ cursor: 'pointer', flex: 1, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 11.5, letterSpacing: '.06em', padding: '11px 14px', textAlign: 'center', display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}
        >
          <ShareIcon size={13} /> SHARE
        </div>
        <div
          {...pressable(() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); })}
          className="glass press"
          style={{ cursor: 'pointer', borderRadius: 999, padding: '11px 16px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', display: 'flex', gap: 6, alignItems: 'center' }}
        >
          <CopyIcon size={13} /> {copied ? 'COPIED' : 'COPY'}
        </div>
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
        {tab === 'connect'
          ? 'Anyone who scans this connects to you and your invite counts as your referral.'
          : 'Print it, tape it to the dashboard, or just hold up your phone. They scan, confirm the amount, and the Stars land here.'}
      </div>
    </div>
  );
}
