// Mode switch: the desktop canvas shows the full prototype presentation;
// a phone-sized viewport (or ?app) runs the Num app full-bleed as a real app.
import { useEffect, useState } from 'react';
import PrototypeCanvas from './components/canvas/PrototypeCanvas';
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
  if (standalone) {
    return (
      <div style={{ height: '100dvh', overflow: 'hidden' }}>
        <ConciergeApp standalone />
      </div>
    );
  }
  return <PrototypeCanvas />;
}
