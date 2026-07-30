// What a visitor gets:
//   phone-sized viewport (or ?app) → the Num app, full-bleed
//   desktop                        → the app in a phone frame on the launch stage
//   ?canvas                        → the internal prototype canvas (pitch artifact:
//                                    poster, demo script, v0.8 release notes)
import { useEffect, useState } from 'react';
import PrototypeCanvas from './components/canvas/PrototypeCanvas';
import LaunchStage from './components/canvas/LaunchStage';
import ConciergeApp from './components/app/ConciergeApp';
import AdminView from './components/app/AdminView';

function useStandalone(): boolean {
  const forced = new URLSearchParams(window.location.search).has('app');
  const [narrow, setNarrow] = useState(() => window.innerWidth < 720);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return forced || narrow;
}

export default function App() {
  const standalone = useStandalone();
  const showCanvas = new URLSearchParams(window.location.search).has('canvas');

  // Installed-app keyboard handling. The naive version — writing
  // visualViewport.height into --vvh on every resize AND scroll — makes the
  // shell chase the keyboard's open/close animation frame by frame, which is
  // the visible glitch when you hit Send and the keyboard drops.
  //
  // So: two stable states only. Keyboard up => pin the shell to the measured
  // visible height (one value, held). Keyboard down => hand it straight back
  // to 100dvh, a value the browser owns and animates itself. Intermediate
  // frames are ignored, and 'scroll' is not listened to at all (it fires
  // constantly while the keyboard animates and carries no size information).
  useEffect(() => {
    if (!standalone) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const KEYBOARD_MIN = 120; // smaller gaps are browser chrome, not a keyboard
    let pinned = -1;
    let raf = 0;

    const apply = () => {
      raf = 0;
      const visible = Math.round(vv.height);
      const gap = Math.round(window.innerHeight) - visible;
      if (gap > KEYBOARD_MIN) {
        // Only write when the pinned height actually changes, so an animating
        // keyboard doesn't produce a style write (and a relayout) per frame.
        if (Math.abs(visible - pinned) > 2) {
          pinned = visible;
          root.style.setProperty('--vvh', `${visible}px`);
        }
      } else if (pinned !== -1) {
        pinned = -1;
        root.style.setProperty('--vvh', '100dvh');
      }
    };
    const onResize = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    root.style.setProperty('--vvh', '100dvh');
    vv.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', onResize);
      root.style.removeProperty('--vvh');
    };
  }, [standalone]);

  // The operator console. No link points here; the key is verified server-side
  // on every request, so the URL is routing, not authorisation.
  const adminKey = new URLSearchParams(window.location.search).get('admin');
  if (adminKey) return <AdminView adminKey={adminKey} />;

  if (showCanvas) return <PrototypeCanvas />;
  if (standalone) {
    // The shell auto-sizes: full screen on a phone, a framed phone-width
    // column on anything wider — the app never sprawls past its borders.
    return (
      <div className="app-shell-stage">
        <div className="app-shell">
          <ConciergeApp standalone />
        </div>
      </div>
    );
  }
  return <LaunchStage />;
}
