// Full-screen overlays: the ferry-disruption push banner, the photos
// permission dialog, and the voice interaction layer.
import { useApp } from '../../lib/store';
import { closeVoice, permAllow, permDeny } from '../../lib/concierge';

export function NotifBanner() {
  const on = useApp((s) => s.notifOn);
  if (!on) return null;
  return (
    <div style={{ position: 'absolute', top: 8, left: 10, right: 10, background: 'var(--color-text)', color: '#fff', padding: '11px 13px', zIndex: 40, boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--color-accent-300)', fontWeight: 700 }}>ANDAMAN WAVE FERRIES · NOW</div>
      <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.4 }}>Service alert: 09:00 Phuket → Phi Phi on 2 Aug is cancelled (weather).</div>
    </div>
  );
}

export function PermissionDialog() {
  const on = useApp((s) => s.permOn);
  if (!on) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.45)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 34px' }}>
      <div style={{ background: 'var(--color-bg)', border: '2px solid var(--color-text)', width: '100%' }}>
        <div style={{ padding: '16px 16px 12px' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, lineHeight: 1.35 }}>“Num” would like to access your photos</div>
          <div style={{ fontSize: 11.5, color: 'var(--color-neutral-700)', marginTop: 6, lineHeight: 1.5 }}>
            To pair photos with your reservations by time and place, and file them to your memories. Nothing is shared without your say-so.
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '2px solid var(--color-text)' }}>
          <div onClick={permDeny} style={{ flex: 1, padding: '11px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', cursor: 'pointer', color: 'var(--color-neutral-600)' }}>
            DON’T ALLOW
          </div>
          <div onClick={permAllow} style={{ flex: 1, padding: '11px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', cursor: 'pointer', background: 'var(--color-accent)', color: '#fff' }}>
            ALLOW
          </div>
        </div>
      </div>
    </div>
  );
}

export function VoiceOverlay() {
  const voice = useApp((s) => s.voice);
  if (voice === 0) return null;
  const label = ['', 'LISTENING', 'ON IT…', 'DONE'][voice] || '';
  const text = voice === 2 ? '“Move my massage to five.”' : voice === 3 ? 'Massage moved to 17:00 — calendar updated, nothing else touched.' : '';
  return (
    <div
      onClick={closeVoice}
      style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.93)', zIndex: 80, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 22px 70px', color: '#fff', cursor: 'pointer' }}
    >
      <div style={{ fontSize: 10, letterSpacing: '.18em', color: 'var(--color-accent-300)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 23, fontWeight: 700, lineHeight: 1.25, marginTop: 10, minHeight: 64 }}>{text}</div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', height: 30, marginTop: 16 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            style={{
              width: 5, height: 28, transformOrigin: 'bottom',
              background: voice === 3 ? 'var(--color-accent-300)' : 'var(--color-accent)',
              animation: voice === 3 ? 'none' : `vbar .9s ${i * 0.12}s infinite ease-in-out`,
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.45)', marginTop: 18, letterSpacing: '.08em' }}>TAP ANYWHERE TO DISMISS</div>
    </div>
  );
}
