// The launch presentation for desktop viewports: the real app running inside a
// phone frame on the living aurora ground — the product, not a pitch deck.
// (The internal prototype canvas — poster, demo script, release notes — is
// still available at ?canvas.)
import { useEffect, useState } from 'react';
import IOSDevice from '../device/IOSDevice';
import ConciergeApp from '../app/ConciergeApp';
import LockScreen from './LockScreen';
import { MessageIcon, RouteIcon, WalletIcon } from '../../lib/icons';
import type { IconProps } from '../../lib/icons';

function useViewportWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

const PROMISES: Array<[label: string, Icon: (p?: IconProps) => JSX.Element]> = [
  ['Ask in plain words', MessageIcon],
  ['It books and reshuffles', RouteIcon],
  ['Settle in one tap', WalletIcon],
];

export default function LaunchStage() {
  const width = useViewportWidth();
  const showLock = width >= 1180;

  return (
    <div
      style={{
        minHeight: '100vh',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
        padding: '52px 24px 60px',
        fontFamily: 'var(--font-body)',
        color: 'var(--ink)',
      }}
    >
      <div className="aurora-layer" aria-hidden="true" />

      <header style={{ position: 'relative', zIndex: 1, textAlign: 'center', maxWidth: 620 }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 40, letterSpacing: '-.02em', margin: 0, lineHeight: 1.05 }}>
          Num
        </h1>
        <p style={{ fontSize: 15.5, color: 'var(--ink-60)', margin: '10px 0 0', lineHeight: 1.55 }}>
          Your concierge. One thread, one calendar, zero forms.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 18 }}>
          {PROMISES.map(([label, Icon]) => (
            <span
              key={label}
              className="glass"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 999, padding: '7px 14px', fontSize: 12, fontWeight: 600 }}
            >
              <Icon size={13} style={{ color: 'var(--color-accent)' }} />
              {label}
            </span>
          ))}
        </div>
      </header>

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 44, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
        <IOSDevice width={393} height={852}>
          <ConciergeApp />
        </IOSDevice>
        {showLock && (
          <IOSDevice width={393} height={852} dark>
            <LockScreen />
          </IOSDevice>
        )}
      </div>

      <footer style={{ position: 'relative', zIndex: 1, fontSize: 12, color: 'var(--ink-40)', textAlign: 'center', letterSpacing: '.04em' }}>
        Open on your phone and add it to your home screen for the full app.
      </footer>
    </div>
  );
}
