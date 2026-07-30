// What a visitor gets:
//   phone-sized viewport (or ?app) → the Num app, full-bleed
//   desktop                        → the app in a phone frame on the launch stage
//   ?canvas                        → the internal prototype canvas (pitch artifact:
//                                    poster, demo script, v0.8 release notes)
import { useEffect, useState } from 'react';
import PrototypeCanvas from './components/canvas/PrototypeCanvas';
import LaunchStage from './components/canvas/LaunchStage';
import ConciergeApp from './components/app/ConciergeApp';

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

  // Installed-app keyboard fix: the on-screen keyboard shrinks the visual
  // viewport but not 100dvh, hiding the input. Track the real height in --vvh
  // so the shell resizes with the keyboard.
  useEffect(() => {
    if (!standalone) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    set();
    vv.addEventListener('resize', set);
    vv.addEventListener('scroll', set);
    return () => {
      vv.removeEventListener('resize', set);
      vv.removeEventListener('scroll', set);
    };
  }, [standalone]);

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
