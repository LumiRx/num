// Lock screen — clock plus the Concierge Live Activity, which tracks the
// thread (tonight's dinner → disruption → rebooked).
import { useMemo } from 'react';
import { store, useApp } from '../../lib/store';
import { liveActivity } from '../../lib/derive';

export default function LockScreen() {
  // Subscribe to the primitives the Live Activity depends on; deriving the
  // object inside the selector would re-render forever (fresh identity).
  const disr = useApp((s) => s.disr);
  const laLine = useApp((s) => s.laLine);
  const la = useMemo(() => liveActivity(store.get()), [disr, laLine]);
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg,#111 0%,#1c1a19 60%,#26211f 100%)', color: '#fff', position: 'relative' }}>
      <div style={{ textAlign: 'center', marginTop: 64 }}>
        <div style={{ fontSize: 15, fontWeight: 600, opacity: 0.85 }}>Tuesday 28 July</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 78, fontWeight: 700, lineHeight: 1, marginTop: 2 }}>09:41</div>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ margin: '0 14px 96px', background: '#000', padding: '14px 16px', borderLeft: '4px solid var(--color-accent)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 9.5, letterSpacing: '.16em', fontWeight: 700, color: 'var(--color-accent-300)' }}>CONCIERGE · LIVE</span>
          <span
            style={{
              fontSize: 9, letterSpacing: '.1em', fontWeight: 700, padding: '3px 6px',
              background: la.red ? 'var(--color-accent)' : 'rgba(255,255,255,.14)',
              color: '#fff',
              animation: la.pulse ? 'lapulse 1.4s infinite' : 'none',
            }}
          >
            {la.tag}
          </span>
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16, marginTop: 8, lineHeight: 1.25 }}>{la.line}</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,.65)', marginTop: 4 }}>{la.meta}</div>
      </div>
    </div>
  );
}
