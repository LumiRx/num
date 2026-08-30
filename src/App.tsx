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
import { isNativeApp } from './lib/native';

function useStandalone(): boolean {
  // THE INSTALLED APP IS ALWAYS THE APP. Never the launch stage.
  //
  // This used to be `forced || narrow`, where narrow meant innerWidth < 720.
  // On a phone that is true and everything worked, which is why it survived.
  // On an iPad it is FALSE — and the bundled app has no `?app` in its URL
  // (the origin is capacitor://localhost/), so `forced` is false too. The app
  // fell through to `<LaunchStage />`: a reviewer installing Num on an iPad
  // got the marketing pitch page and no product at all.
  //
  // The target declares iPad, Mac (Designed for iPad) and Apple Vision as
  // supported destinations, every one of them wider than 720, so this was not
  // a corner case — it was three of the four devices Apple could have chosen
  // to review on, and a guaranteed 2.1 rejection on any of them.
  //
  // Viewport width is a fine signal for a BROWSER, where a wide window really
  // does mean "show the marketing site". It is meaningless inside an installed
  // binary: somebody who downloaded the app wants the app at every width.
  const native = isNativeApp();
  const forced = new URLSearchParams(window.location.search).has('app');
  const [narrow, setNarrow] = useState(() => window.innerWidth < 720);
  useEffect(() => {
    if (native) return;
    const onResize = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [native]);
  return native || forced || narrow;
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
    const root = document.documentElement;
    // The document-scroll lock goes on BEFORE the visualViewport guard, and
    // comes off in the same cleanup. It is a different concern from keyboard
    // sizing: sizing needs visualViewport, but "the page must not scroll"
    // holds on any browser, and a shell that can be dragged out from under
    // the status bar is broken whether or not the API exists.
    root.classList.add('num-standalone');
    const vv = window.visualViewport;
    if (!vv) return () => root.classList.remove('num-standalone');
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
      root.classList.remove('num-standalone');
    };
  }, [standalone]);

  // The operator console at /admin (or ?admin). The URL is ROUTING ONLY — it
  // carries no key and never will. Auth is a signed session obtained by posting
  // the key once, held in localStorage, sent as a header.
  const q = new URLSearchParams(window.location.search);
  if (q.has('admin') || window.location.pathname.replace(/\/$/, '') === '/admin') {
    // A key left in an old bookmark is scrubbed from the address bar on sight
    // rather than being honoured.
    if (q.get('admin')) history.replaceState(null, '', window.location.pathname);
    return <AdminView />;
  }

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
