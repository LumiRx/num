// What a desktop visitor sees. Phones (<720px) get the real app — see
// useStandalone() in App.tsx — so this page's only job is to convince someone
// at a laptop and then get Num onto their phone.
// (The internal prototype canvas — poster, demo script, release notes — is
// still available at ?canvas.)
//
// ── WHY THIS WAS REBUILT ──────────────────────────────────────────────────
//
// The previous version centred two 852px-tall phone frames inside a container
// with `overflow: hidden` and `justifyContent: center`. On any laptop shorter
// than the frames, they were clipped at the fold, the page could not scroll to
// reveal them, and there was no button anywhere — the only call to action was
// a line of grey footer text. A visitor from a paid ad landed on a poster of
// the product with no way into it and no way down the page.
//
// Three rules now hold:
//
//   · THE PAGE SCROLLS. No `overflow: hidden` on a container whose children
//     are taller than a laptop viewport. That one property was the bug.
//   · THERE IS A BUTTON ABOVE THE MOCKUPS. Someone who has already decided
//     should never have to scroll past a screenshot to act.
//   · THE DESKTOP → PHONE HANDOFF IS EXPLICIT. Num lives on a phone home
//     screen; a laptop visitor needs telling how to get it there.
import { useEffect, useState } from 'react';
import IOSDevice from '../device/IOSDevice';
import ConciergeApp from '../app/ConciergeApp';
import LockScreen from './LockScreen';
import { MessageIcon, RouteIcon, WalletIcon } from '../../lib/icons';
import type { IconProps } from '../../lib/icons';
import { PairHandoff } from '../app/PairBridge';
import InstallPrompt from '../app/InstallPrompt';

function useViewportWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

const PROMISES: Array<[label: string, Icon: (p?: IconProps) => JSX.Element]> = [
  ['Ask in plain words', MessageIcon],
  ['It books and reshuffles', RouteIcon],
  ['Settle in one tap', WalletIcon],
];

/**
 * Keep whatever brought them here.
 *
 * Campaign tags arrive in the URL and lib/social.ts captures them on first
 * load, but in-page links must carry them too — otherwise a visitor who clicks
 * through and later returns arrives untagged. Cheap to preserve, impossible to
 * reconstruct afterwards.
 */
function withSearch(path: string): string {
  const qs = window.location.search;
  if (!qs) return path;
  return path + (path.includes('?') ? '&' + qs.slice(1) : qs);
}

export default function LaunchStage() {
  const width = useViewportWidth();
  const showLock = width >= 1180;
  // Below this the two frames stop fitting side by side; one honestly-sized
  // frame beats two clipped ones.
  const frameW = width < 900 ? 340 : 393;
  const frameH = Math.round(frameW * (852 / 393));

  return (
    <div
      style={{
        minHeight: '100vh',
        position: 'relative',
        // NOT hidden. The children are taller than most laptop viewports and
        // hiding the overflow is what turned this page into a dead end.
        overflowX: 'clip',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 28,
        padding: '44px 24px 72px',
        fontFamily: 'var(--font-body)',
        color: 'var(--ink)',
      }}
    >
      <div className="aurora-layer" aria-hidden="true" />
      <InstallPrompt />

      {/* A friend link opened in the browser instead of the app. Show the code
          to carry across, above everything — it is why they are here. */}
      <div style={{ position: 'relative', zIndex: 2, width: '100%', maxWidth: 420 }}>
        <PairHandoff />
      </div>

      <header style={{ position: 'relative', zIndex: 1, textAlign: 'center', maxWidth: 640 }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 44, letterSpacing: '-.02em', margin: 0, lineHeight: 1.05 }}>
          Num
        </h1>
        <p style={{ fontSize: 16.5, color: 'var(--ink-60)', margin: '12px 0 0', lineHeight: 1.55 }}>
          Your concierge in Phuket. Ask in plain words — a table, a car, a whole day — and Num sorts it.
        </p>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 26 }}>
          <a
            href={withSearch('/?app=1')}
            style={{
              display: 'inline-block', textDecoration: 'none', borderRadius: 999,
              padding: '15px 32px', fontWeight: 700, fontSize: 16, color: '#fff',
              background: 'linear-gradient(135deg,#ff6a3d,#ec3013)',
              boxShadow: '0 10px 26px rgba(236,48,19,.35)',
            }}
          >
            Open Num
          </a>
          <a
            href="#on-your-phone"
            className="glass"
            style={{
              display: 'inline-block', textDecoration: 'none', borderRadius: 999,
              padding: '15px 26px', fontWeight: 600, fontSize: 15, color: 'var(--ink)',
            }}
          >
            Put it on my phone
          </a>
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-40)', margin: '12px 0 0' }}>
          Free · no app store · works in about ten seconds
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 22 }}>
          {PROMISES.map(([label, Icon]) => (
            <span
              key={label}
              className="glass"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 999, padding: '7px 14px', fontSize: 12, fontWeight: 600 }}
            >
              <Icon size={13} style={{ color: 'var(--color-accent)' }} />
              {label}
            </span>
          ))}
        </div>
      </header>

      {/* Live product, not a screenshot — the left frame is the real
          ConciergeApp and answers for real. */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 40, alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap' }}>
        <IOSDevice width={frameW} height={frameH}>
          <ConciergeApp />
        </IOSDevice>
        {showLock && (
          <IOSDevice width={frameW} height={frameH} dark>
            <LockScreen />
          </IOSDevice>
        )}
      </div>

      {/* The handoff, in words. Num is a home-screen app and a laptop visitor
          cannot install it from here — telling them beats leaving them to
          guess, which is what the old footer line did. */}
      <section
        id="on-your-phone"
        className="glass"
        style={{
          position: 'relative', zIndex: 1, maxWidth: 560, width: '100%',
          borderRadius: 20, padding: '22px 24px', textAlign: 'left', scrollMarginTop: 24,
        }}
      >
        <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: 18, margin: '0 0 10px', letterSpacing: '-.01em' }}>
          Put Num on your phone
        </h2>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14.5, lineHeight: 1.75, color: 'var(--ink-60)' }}>
          <li>Open <b style={{ color: 'var(--ink)' }}>app.itsnum.com</b> in your phone’s browser.</li>
          <li>Tap <b style={{ color: 'var(--ink)' }}>Share</b>, then <b style={{ color: 'var(--ink)' }}>Add to Home Screen</b>.</li>
          <li>Open it from your home screen — it behaves like any other app.</li>
        </ol>
        <p style={{ fontSize: 13, color: 'var(--ink-40)', margin: '14px 0 0' }}>
          No app store, nothing to install. Num is a website that keeps your thread,
          so it works the moment you open it.
        </p>
      </section>

      <footer style={{ position: 'relative', zIndex: 1, fontSize: 12, color: 'var(--ink-40)', textAlign: 'center', letterSpacing: '.04em' }}>
        NUM by 5arz · <a href="https://itsnum.com/" style={{ color: 'inherit' }}>itsnum.com</a>
      </footer>
    </div>
  );
}
