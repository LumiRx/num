// Full-screen overlays: the ferry-disruption push banner, the photos
// permission dialog, and the voice interaction layer.
import { useRef } from 'react';
import { useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { closeVoice, permAllow, permDeny } from '../../lib/concierge';
import { BellIcon } from '../../lib/icons';

export function NotifBanner() {
  const on = useApp((s) => s.notifOn);
  if (!on) return null;
  return (
    <div className="glass-dark msg-in" style={{ position: 'absolute', top: 10, left: 12, right: 12, borderRadius: 'var(--r-md)', color: '#fff', padding: '11px 13px', zIndex: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <BellIcon size={14} style={{ color: 'var(--color-accent-300)' }} />
        <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--color-accent-300)', fontWeight: 700 }}>ANDAMAN WAVE FERRIES · NOW</div>
      </div>
      <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.4 }}>Service alert: 09:00 Phuket → Phi Phi on 2 Aug is cancelled (weather).</div>
    </div>
  );
}

export function PermissionDialog() {
  const on = useApp((s) => s.permOn);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(on, ref);
  if (!on) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.4)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 34px' }}>
      <div ref={ref} role="dialog" aria-modal="true" className="glass-strong" style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden', width: '100%' }}>
        <div style={{ padding: '16px 16px 12px' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, lineHeight: 1.35 }}>“Num” would like to access your photos</div>
          <div style={{ fontSize: 11.5, color: 'var(--color-neutral-700)', marginTop: 6, lineHeight: 1.5 }}>
            To pair photos with your reservations by time and place, and file them to your memories. Nothing is shared without your say-so.
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--ink-08)' }}>
          <div {...pressable(permDeny)} style={{ flex: 1, padding: '11px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', cursor: 'pointer', color: 'var(--ink-60)' }}>
            DON’T ALLOW
          </div>
          <div {...pressable(permAllow)} className="press" style={{ flex: 1, padding: '11px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', cursor: 'pointer', background: 'var(--grad-accent)', color: '#fff' }}>
            ALLOW
          </div>
        </div>
      </div>
    </div>
  );
}

export function VoiceOverlay() {
  const voice = useApp((s) => s.voice);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(voice !== 0, ref);
  if (voice === 0) return null;
  const label = ['', 'LISTENING', 'ON IT…', 'DONE'][voice] || '';
  const text = voice === 2 ? '“Move my massage to five.”' : voice === 3 ? 'Massage moved to 17:00 — calendar updated, nothing else touched.' : '';
  return (
    <div
      ref={ref}
      {...pressable(closeVoice)}
      aria-label="Dismiss voice"
      style={{ position: 'absolute', inset: 0, background: 'rgba(20,18,17,.72)', backdropFilter: 'blur(14px) saturate(1.4)', WebkitBackdropFilter: 'blur(14px) saturate(1.4)', zIndex: 80, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 22px 70px', color: '#fff', cursor: 'pointer' }}
    >
      <div style={{ fontSize: 10, letterSpacing: '.18em', color: 'var(--color-accent-300)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 23, fontWeight: 700, lineHeight: 1.25, marginTop: 10, minHeight: 64 }}>{text}</div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', height: 30, marginTop: 16 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            style={{
              width: 5, height: 28, transformOrigin: 'bottom', borderRadius: 999,
              background: voice === 3 ? 'var(--color-accent-300)' : 'var(--grad-accent)',
              animation: voice === 3 ? 'none' : `vbar .9s ${i * 0.12}s infinite ease-in-out`,
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.45)', marginTop: 18, letterSpacing: '.08em' }}>TAP ANYWHERE TO DISMISS</div>
    </div>
  );
}
