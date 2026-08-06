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
 * The same five promises as the /watch/ landing page, word for word.
 *
 * Deliberately duplicated rather than paraphrased: two pages that ad traffic
 * can land on must make the identical promise, or the product a visitor was
 * sold depends on which link they happened to click.
 */
const FEATURES: Array<[emoji: string, title: string, body: string]> = [
  ['🍴', 'Ask in plain words', '“Dinner for four tonight, somewhere with a view” — Num finds it, checks it, books it.'],
  ['🚗', 'Cars that actually turn up', 'Airport pickups, drivers for the day, a ride home at 2am — sorted from one message.'],
  ['👥', 'Plan together', 'Pull your friends in. Everyone sees the plan, nobody retypes an address, the group decides once.'],
  ['⭐', 'Split anything', 'Open a tab for the night out. Everyone pays for exactly what they were in on.'],
  ['🔔', 'It thinks ahead', 'Rain coming before your beach day? A table to reconfirm? Num tells you before you ask.'],
];

/**
 * Install steps, matched to the device actually reading them.
 *
 * Same wording as InstallPrompt.tsx — a visitor who sees the floating prompt
 * and then reads this section must not be given two different sets of
 * instructions for the same three taps.
 */
type Platform = 'ios' | 'android' | 'desktop';
const detectPlatform = (): Platform => {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
};
const INSTALL: Record<Platform, { heading: string; steps: string[] }> = {
  ios: {
    heading: 'Add Num to your home screen',
    steps: ['Tap the Share button at the bottom of Safari', 'Choose “Add to Home Screen”', 'Tap Add — Num opens like any other app'],
  },
  android: {
    heading: 'Add Num to your home screen',
    steps: ['Tap the ⋮ menu in Chrome', 'Choose “Install app” or “Add to Home screen”', 'Confirm — Num opens like any other app'],
  },
  desktop: {
    heading: 'Put Num on your phone',
    steps: [
      'Open app.itsnum.com in your phone’s browser',
      'Tap Share (iPhone) or the ⋮ menu (Android), then “Add to Home Screen”',
      'Open it from your home screen — it behaves like any other app',
    ],
  },
};

const NAV: Array<[label: string, href: string]> = [
  ['How it works', 'https://itsnum.com/how-it-works/'],
  ['Perks', 'https://itsnum.com/perks/'],
  ['For business', 'https://itsnum.com/business/'],
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
  // Read once on mount: the platform cannot change mid-visit, and calling
  // navigator during render would make this component non-deterministic.
  const [platform] = useState(detectPlatform);
  const install = INSTALL[platform];
  const onPhone = platform !== 'desktop';

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

      {/* Navigation. The old page had none: someone who landed here from an ad
          and wanted to know who we are had no way out except the back button,
          which on a paid click means leaving. */}
      <nav
        style={{
          position: 'relative', zIndex: 2, width: '100%', maxWidth: 1040,
          display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
          marginBottom: 6, fontSize: 14,
        }}
      >
        <a
          href="https://itsnum.com/"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'var(--ink)', fontWeight: 700 }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 3, background: 'var(--color-accent)' }} aria-hidden="true" />
          NUM <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--ink-40)' }}>travel concierge</span>
        </a>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {NAV.map(([label, href]) => (
            <a key={label} href={href} style={{ textDecoration: 'none', color: 'var(--ink-60)', fontWeight: 500 }}>
              {label}
            </a>
          ))}
        </span>
      </nav>

      {/* A friend link opened in the browser instead of the app. Show the code
          to carry across, above everything — it is why they are here. */}
      <div style={{ position: 'relative', zIndex: 2, width: '100%', maxWidth: 420 }}>
        <PairHandoff />
      </div>

      <header style={{ position: 'relative', zIndex: 1, textAlign: 'center', maxWidth: 780 }}>
        <span
          style={{
            display: 'inline-block', fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5,
            fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase',
            color: 'var(--color-accent)', marginBottom: 14,
          }}
        >
          Num · Phuket
        </span>

        {/* The one line the whole page rests on.
            clamp() rather than a fixed size: this has to read as a headline on
            a 1440px laptop AND on a 360px phone, and a fixed 44px was neither.
            Concrete over clever — "a table, a car, a whole day" is what people
            actually ask for, and naming it does more work than an adjective. */}
        <h1
          style={{
            fontFamily: 'var(--font-heading)', fontWeight: 800,
            fontSize: 'clamp(38px, 6.2vw, 68px)', letterSpacing: '-.03em',
            margin: 0, lineHeight: 1.02,
          }}
        >
          Ask for anything.
          <br />
          <span style={{ color: 'var(--color-accent)' }}>Num sorts it.</span>
        </h1>

        <p style={{ fontSize: 'clamp(16px, 1.7vw, 19px)', color: 'var(--ink-60)', margin: '18px auto 0', lineHeight: 1.55, maxWidth: 560 }}>
          Dinner tonight, a driver at six, a whole weekend for eight. Text it in plain
          words and your concierge handles the rest — no forms, no phone calls,
          no forty browser tabs.
        </p>

        {/* The primary action depends on the device, because "add to your home
            screen" is impossible advice on a laptop and the most valuable thing
            a phone visitor can do. Getting this backwards is how a landing page
            asks people for something they cannot give. */}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 30 }}>
          {onPhone ? (
            <>
              <a
                href="#on-your-phone"
                style={{
                  display: 'inline-block', textDecoration: 'none', borderRadius: 999,
                  padding: '17px 34px', fontWeight: 700, fontSize: 17, color: '#fff',
                  background: 'linear-gradient(135deg,#ff6a3d,#ec3013)',
                  boxShadow: '0 12px 30px rgba(236,48,19,.38)',
                }}
              >
                Add Num to my home screen
              </a>
              <a
                href={withSearch('/?app=1')}
                className="glass"
                style={{
                  display: 'inline-block', textDecoration: 'none', borderRadius: 999,
                  padding: '17px 28px', fontWeight: 600, fontSize: 16, color: 'var(--ink)',
                }}
              >
                Try it first
              </a>
            </>
          ) : (
            <>
              <a
                href={withSearch('/?app=1')}
                style={{
                  display: 'inline-block', textDecoration: 'none', borderRadius: 999,
                  padding: '17px 34px', fontWeight: 700, fontSize: 17, color: '#fff',
                  background: 'linear-gradient(135deg,#ff6a3d,#ec3013)',
                  boxShadow: '0 12px 30px rgba(236,48,19,.38)',
                }}
              >
                Open Num
              </a>
              <a
                href="#on-your-phone"
                className="glass"
                style={{
                  display: 'inline-block', textDecoration: 'none', borderRadius: 999,
                  padding: '17px 28px', fontWeight: 600, fontSize: 16, color: 'var(--ink)',
                }}
              >
                Put it on my phone
              </a>
            </>
          )}
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--ink-40)', margin: '14px 0 0' }}>
          Free · no app store · about ten seconds to set up
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
      {/* SCROLL, NOT CAPTURE.
          These frames contain the real ConciergeApp, which has its own
          scrollable thread — and they sit dead centre of the viewport, exactly
          where a cursor lands. With pointer events live, the wheel scrolled the
          app inside the frame and the page appeared frozen; three separate
          "the page won't scroll" reports were all this, not the CSS.
          The frames are a showcase here: the way in is the Open Num button, so
          they are inert and the wheel always belongs to the page. */}
      <div
        style={{
          position: 'relative', zIndex: 1, display: 'flex', gap: 40,
          alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap',
          pointerEvents: 'none', userSelect: 'none',
        }}
        aria-hidden="true"
      >
        <IOSDevice width={frameW} height={frameH}>
          <ConciergeApp />
        </IOSDevice>
        {showLock && (
          <IOSDevice width={frameW} height={frameH} dark>
            <LockScreen />
          </IOSDevice>
        )}
      </div>

      {/* What it actually does. Below the phone on purpose: the mockup earns
          the attention, the words tell you what you are looking at. */}
      <section style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 900 }}>
        <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: 22, letterSpacing: '-.015em', textAlign: 'center', margin: '0 0 20px' }}>
          What Num does
        </h2>
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(270px,1fr))' }}>
          {FEATURES.map(([emoji, title, body]) => (
            <div
              key={title}
              className="glass"
              style={{ display: 'flex', gap: 14, alignItems: 'flex-start', borderRadius: 18, padding: '16px 18px' }}
            >
              <span
                aria-hidden="true"
                style={{
                  flex: 'none', width: 38, height: 38, borderRadius: 12, fontSize: 18,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'linear-gradient(135deg,#ffe9e2,#ffd9cd)',
                }}
              >
                {emoji}
              </span>
              <span>
                <b style={{ display: 'block', fontSize: 15, marginBottom: 3 }}>{title}</b>
                <span style={{ fontSize: 13.5, color: 'var(--ink-60)', lineHeight: 1.55 }}>{body}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* The handoff. Num is a home-screen app; the steps differ per device and
          giving an iPhone user Android instructions is the same as giving them
          none. Wording matches InstallPrompt.tsx so the floating prompt and
          this section never disagree. */}
      <section
        id="on-your-phone"
        className="glass"
        style={{
          position: 'relative', zIndex: 1, maxWidth: 560, width: '100%',
          borderRadius: 20, padding: '22px 24px', textAlign: 'left', scrollMarginTop: 24,
        }}
      >
        <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: 18, margin: '0 0 10px', letterSpacing: '-.01em' }}>
          {install.heading}
        </h2>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14.5, lineHeight: 1.75, color: 'var(--ink-60)' }}>
          {install.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <p style={{ fontSize: 13, color: 'var(--ink-40)', margin: '14px 0 0' }}>
          No app store, nothing to download. Num is a website that keeps your thread,
          so it works the moment you open it — adding it to your home screen just
          makes it open like an app.
        </p>
      </section>

      <footer
        style={{
          position: 'relative', zIndex: 1, fontSize: 12.5, color: 'var(--ink-40)',
          textAlign: 'center', display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center',
        }}
      >
        <a href="https://itsnum.com/" style={{ color: 'inherit' }}>itsnum.com</a>
        <a href="https://itsnum.com/how-it-works/" style={{ color: 'inherit' }}>How it works</a>
        <a href="https://itsnum.com/business/" style={{ color: 'inherit' }}>For business</a>
        <a href="https://itsnum.com/privacy/" style={{ color: 'inherit' }}>Privacy</a>
        <a href="https://itsnum.com/terms/" style={{ color: 'inherit' }}>Terms</a>
        <span>NUM by 5arz</span>
      </footer>
    </div>
  );
}
