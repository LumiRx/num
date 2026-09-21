// "Scan a friend" from inside Num.
//
// The one path that works the same for everybody: the scan happens inside
// the Num that holds your account, so the friend lands in YOUR list on the
// spot. Matters most for iPhone home-screen users, whose camera app can only
// ever open Safari (a different Num). See the note at the top of scan.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pressable } from '../../lib/a11y';
import { startScan, type ScanHandle } from '../../lib/scan';

const pill: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, padding: '11px 16px', fontSize: 11.5, fontWeight: 800,
  letterSpacing: '.06em', textAlign: 'center',
};

function Scanner({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [msg, setMsg] = useState('Point your camera at their Num code.');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let handle: ScanHandle | null = null;
    let closed = false;
    if (video.current) {
      void startScan(video.current, {
        found: () => {
          setDone(true);
          setMsg('Added. They’re in your friends now.');
          setTimeout(() => { if (!closed) onClose(); }, 1600);
        },
        error: (m) => setMsg(m),
      }).then((h) => { handle = h; if (closed) h.stop(); });
    }
    return () => { closed = true; handle?.stop(); };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Scan a friend's code"
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'max(env(safe-area-inset-top),16px) 16px max(env(safe-area-inset-bottom),16px)' }}
    >
      <div style={{ position: 'relative', width: 'min(86vw, 360px)', aspectRatio: '1', borderRadius: 22, overflow: 'hidden', background: '#111' }}>
        <video ref={video} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{ position: 'absolute', inset: '14%', border: `3px solid ${done ? '#3ecf8e' : 'rgba(255,255,255,.85)'}`, borderRadius: 18 }} />
      </div>
      <div aria-live="polite" style={{ color: '#fff', fontSize: 14, fontWeight: 600, marginTop: 18, textAlign: 'center', maxWidth: 320, lineHeight: 1.5 }}>
        {msg}
      </div>
      <div {...pressable(onClose)} className="press tap" style={{ ...pill, marginTop: 18, background: 'rgba(255,255,255,.14)', color: '#fff' }}>
        {done ? 'DONE' : 'CANCEL'}
      </div>
    </div>
  );
}

export default function ScanFriend() {
  const [open, setOpen] = useState(false);
  // Stable, so a re-render of the card behind does not restart the camera.
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <div
        {...pressable(() => setOpen(true))}
        className="glass press tap"
        style={{ ...pill, marginTop: 10, width: '100%', boxSizing: 'border-box' }}
      >
        SCAN A FRIEND’S CODE
      </div>
      {open && <Scanner onClose={close} />}
    </>
  );
}
