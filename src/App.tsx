// What a visitor gets:
//   any viewport, any browser → the Num app. Phones full-bleed, wider screens
//                               centred at a readable measure (glass.css).
//   ?stage                    → the launch pitch page, kept for the investor
//                               material and reachable on purpose only.
//   ?canvas                   → the internal prototype canvas (pitch artifact:
//                               poster, demo script, v0.8 release notes)
import { useEffect } from 'react';
import PrototypeCanvas from './components/canvas/PrototypeCanvas';
import LaunchStage from './components/canvas/LaunchStage';
import ConciergeApp from './components/app/ConciergeApp';
import AdminView from './components/app/AdminView';
import { isNativeApp } from './lib/native';

function useStandalone(): boolean {
  // DESKTOP GETS THE APP. 16 Sep 2026.
  //
  // This used to be `native || forced || narrow`, where narrow meant
  // innerWidth < 720 — so any browser window 720px or wider was handed
  // <LaunchStage />, the marketing pitch, instead of the product.
  //
  // On 16 Sep the X flight made that expensive in a way that was finally
  // measurable. 136 people clicked through in a day; 133 of them were US
  // desktop. Every one arrived at app.itsnum.com, was shown a page describing
  // an app they could not open, and left. Zero asked Num anything. The ad was
  // fine and the audience was fine — the door was locked.
  //
  // A width test is a reasonable proxy for "is this a phone" and a terrible
  // proxy for "does this person want the product". Somebody who clicked an ad
  // for a concierge wants the concierge, at whatever width their window
  // happens to be. The same mistaken proxy already cost us every iPad (the
  // installed binary has no `?app` in its URL and iPads are all wider than
  // 720), which is why `native` had to be bolted on in front of it.
  //
  // So the default flips: this surface IS the app. The launch stage is still
  // here and still reachable at `?stage` — it is a good pitch page and the
  // investor material links to it — it is simply no longer what a stranger
  // gets by accident.
  //
  // ── AND THE RESIZE LISTENER IS GONE ────────────────────────────────────
  //
  // `narrow` was state, recomputed on every resize. Dragging a window or
  // rotating an iPad across 720px tore down the entire app mid-session and
  // replaced it with the marketing site — which is exactly what Dre hit while
  // signing up on an iPad and described as the screen "glitching out".
  // Nothing here depends on width any more, so there is nothing to listen to,
  // and the app can no longer swap itself out from under someone.
  //
  // Width still decides LAYOUT, in glass.css, where it belongs: a media query
  // can widen a column without unmounting the product.
  const native = isNativeApp();
  const params = new URLSearchParams(window.location.search);
  const forced = params.has('app');
  const stage = params.has('stage');
  return native || forced || !stage;
}

export default function App() {
  const standalone = useStandalone();
  const showCanvas = new URLSearchParams(window.location.search).has('canvas');

  // Installed-app keyboard handling. The naive version — writing
  // visualViewport.height on every resize AND scroll — makes the shell chase
  // the keyboard's open/close animation frame by frame, which is the visible
  // glitch when you hit Send and the keyboard drops.
  //
  // So: two stable states only. Keyboard up => pin ONE measured value and
  // hold it. Keyboard down => hand sizing straight back to the browser.
  // Intermediate frames are ignored, and 'scroll' is not listened to at all
  // (it fires constantly while the keyboard animates and carries no size
  // information).
  //
  // ── 14 SEP 2026: WHAT IS PUBLISHED CHANGED, AND IT MATTERS ─────────────
  //
  // This used to publish --vvh, the VISIBLE HEIGHT, and glass.css sized the
  // shell to it. The input landed above the keyboard, correctly — and the
  // strip of page below the shrunken shell showed `html, body`, which is
  // painted #14100e for the desktop launch stage. A black band appeared and
  // vanished under the keyboard on every tap, on the plan-name field and
  // everywhere else with an input.
  //
  // Now it publishes --kb, the KEYBOARD HEIGHT, and the shell absorbs it as
  // padding while staying exactly one viewport tall. Nothing about the
  // measurement changed; what changed is that the number describes the thing
  // being subtracted rather than the thing left over, which is what let the
  // CSS keep the ground on screen. A variable named for what it measures is
  // harder to use wrongly than one named for a result.
  useEffect(() => {
    if (!standalone) return;
    const root = document.documentElement;
    // THE INSTALLED APP IS NOT A BROWSER WINDOW.
    //
    // glass.css frames the shell as a 440px phone-shaped column on a dark
    // stage above 520px wide. In a desktop BROWSER that is right — it is the
    // launch stage, the app shown in a phone. Inside an installed iPad binary
    // it is a mockup of a phone floating on black, which is what App Review
    // photographed on an iPad Air M3.
    //
    // This is the same mistake as the old `innerWidth < 720` test in
    // useStandalone, in a different file: a viewport-width rule that is
    // correct for a browser and meaningless inside an app somebody
    // downloaded. Marking the document lets the CSS tell the two apart
    // instead of guessing from width.
    if (isNativeApp()) root.classList.add('num-native');
    // The document-scroll lock goes on BEFORE the visualViewport guard, and
    // comes off in the same cleanup. It is a different concern from keyboard
    // sizing: sizing needs visualViewport, but "the page must not scroll"
    // holds on any browser, and a shell that can be dragged out from under
    // the status bar is broken whether or not the API exists.
    root.classList.add('num-standalone');
    const vv = window.visualViewport;
    if (!vv) return () => { root.classList.remove('num-standalone'); root.classList.remove('num-native'); };
    const KEYBOARD_MIN = 120; // smaller gaps are browser chrome, not a keyboard
    let pinned = -1;
    let raf = 0;

    const apply = () => {
      raf = 0;
      // The gap between the layout viewport and the visible one IS the
      // keyboard. Below KEYBOARD_MIN it is browser chrome — a toolbar
      // collapsing, a URL bar — and padding the shell for that would make the
      // app twitch while somebody scrolls.
      const gap = Math.round(window.innerHeight) - Math.round(vv.height);
      if (gap > KEYBOARD_MIN) {
        // Only write when the pinned height actually changes, so an animating
        // keyboard doesn't produce a style write (and a relayout) per frame.
        if (Math.abs(gap - pinned) > 2) {
          pinned = gap;
          root.style.setProperty('--kb', `${gap}px`);
        }
      } else if (pinned !== -1) {
        pinned = -1;
        // 0px, not removeProperty: the CSS fallback is 0px either way, and
        // setting it keeps the transition from a measured value to zero on a
        // property that has always existed rather than one that blinks out.
        root.style.setProperty('--kb', '0px');
      }
    };
    const onResize = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    root.style.setProperty('--kb', '0px');
    vv.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', onResize);
      root.style.removeProperty('--kb');
      root.classList.remove('num-standalone');
      root.classList.remove('num-native');
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
