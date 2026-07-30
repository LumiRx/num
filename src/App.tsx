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

  if (showCanvas) return <PrototypeCanvas />;
  if (standalone) {
    return (
      <div style={{ height: '100dvh', overflow: 'hidden' }}>
        <ConciergeApp standalone />
      </div>
    );
  }
  return <LaunchStage />;
}
