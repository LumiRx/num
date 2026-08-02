// "Put Num on your home screen" — shown only in the browser, never in the app.
//
// Why this earns its space: a browser tab is a worse Num in ways the person
// cannot see. No push, so a plan change never reaches them. Separate storage
// from the installed app, so friends and plans made here land on an identity
// their real app can't see (see PairBridge). And Safari evicts site data, so
// a tab-only user can simply lose their account.
//
// It states the payoff before the instructions, because "Add to Home Screen"
// with no reason given is a step people skip.
import { useEffect, useState } from 'react';
import { pressable } from '../../lib/a11y';

const DISMISS_KEY = 'num-install-dismissed';

type Platform = 'ios' | 'android' | 'desktop';

const detect = (): Platform => {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
};

const STEPS: Record<Platform, string[]> = {
  ios: ['Tap the Share button at the bottom of Safari', 'Choose “Add to Home Screen”', 'Tap Add — Num opens like any other app'],
  android: ['Tap the ⋮ menu in Chrome', 'Choose “Install app” or “Add to Home screen”', 'Confirm — Num opens like any other app'],
  desktop: ['Click the install icon in your address bar', 'Choose Install', 'Num opens in its own window'],
};

export default function InstallPrompt() {
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  const platform = detect();

  useEffect(() => {
    const installed =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (installed) return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch { /* private mode — showing it once is fine */ }
    // Let the page settle before asking for anything.
    const t = setTimeout(() => setShow(true), 1200);
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* fine */ }
  };

  return (
    <div
      className="glass-strong"
      style={{
        position: 'fixed', left: 12, right: 12, bottom: 'max(env(safe-area-inset-bottom), 14px)',
        zIndex: 60, borderRadius: 18, padding: 15, maxWidth: 420, margin: '0 auto',
        boxShadow: '0 12px 40px rgba(0,0,0,.22)',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
            YOU’RE IN A BROWSER
          </div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15.5, marginTop: 4 }}>
            Put Num on your home screen
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
            Installed, Num can reach you when a plan moves or a friend replies. In a tab it can’t —
            and your account lives only as long as the browser keeps it.
          </div>
        </div>
        <div
          {...pressable(dismiss)}
          aria-label="Not now"
          style={{ flex: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'var(--ink-40)', padding: 2 }}
        >
          ×
        </div>
      </div>

      {open && (
        <ol style={{ margin: '11px 0 0', padding: '0 0 0 18px', fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.7 }}>
          {STEPS[platform].map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <div
          {...pressable(() => setOpen((v) => !v))}
          className="press"
          style={{
            flex: 1, cursor: 'pointer', textAlign: 'center', borderRadius: 999, padding: '11px 14px',
            background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '.06em',
          }}
        >
          {open ? 'GOT IT' : 'SHOW ME HOW'}
        </div>
        <div
          {...pressable(dismiss)}
          style={{ cursor: 'pointer', borderRadius: 999, padding: '11px 14px', fontSize: 11, fontWeight: 700, color: 'var(--ink-60)' }}
        >
          Not now
        </div>
      </div>
    </div>
  );
}
