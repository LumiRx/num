// "Put Num on your home screen" — shown only in the browser, never in the app.
//
// Why this earns its space: a browser tab is a worse Num in ways the person
// cannot see. No push, so a plan change never reaches them. Separate storage
// from the installed app, so friends and plans made here land on an identity
// their real app can't see (see PairBridge). And Safari evicts site data, so
// a tab-only user can simply lose their account.
//
// It states the payoff before the instructions, because "Add to Home Screen"
// with no reason given is a step people skip.
import { useEffect, useState } from 'react';
import { pressable } from '../../lib/a11y';
import { store } from '../../lib/store';

const DISMISS_KEY = 'num-install-dismissed';

type Platform = 'ios' | 'android' | 'desktop';

const detect = (): Platform => {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
};

const STEPS: Record<Platform, string[]> = {
  ios: ['Tap the Share button at the bottom of Safari', 'Choose “Add to Home Screen”', 'Tap Add — Num opens like any other app'],
  android: ['Tap the ⋮ menu in Chrome', 'Choose “Install app” or “Add to Home screen”', 'Confirm — Num opens like any other app'],
  desktop: ['Click the install icon in your address bar', 'Choose Install', 'Num opens in its own window'],
};

import { canOfferInstall, escapeCard, isStandalone } from '../../lib/native';

/**
 * ── WHERE THIS RENDERS ────────────────────────────────────────────────────
 *
 * Until 25 Aug 2026 the answer was "LaunchStage only", and LaunchStage is the
 * DESKTOP page: App.tsx sends any viewport under 720px straight to
 * ConciergeApp. So the one surface that could actually install Num — a phone
 * in a browser, which is very nearly all of our traffic — was the one surface
 * that never saw this card. We were asking desktops to add Num to a home
 * screen they do not have, and asking phones nothing at all.
 *
 * It now mounts on both. The props exist because the two surfaces differ in
 * ways the card cannot guess:
 *
 *   suppressed — the app has sheets and overlays (the name gate among them).
 *                A fixed card at z-60 would land on top of the very question
 *                we need answered. Suppressing RENDER rather than unmounting
 *                keeps the dwell timer honest across a sheet opening.
 *   anchor     — inside the app shell the card belongs in the shell's own
 *                stacking context, next to the thread dot, not pinned to the
 *                browser viewport behind it.
 *   lift       — clears that dot.
 */
export default function InstallPrompt({
  suppressed = false,
  anchor = 'fixed',
  lift = 0,
}: { suppressed?: boolean; anchor?: 'fixed' | 'absolute'; lift?: number } = {}) {
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const platform = detect();
  // In an in-app browser this is a DIFFERENT card with different words. The
  // install steps below are Safari's and Chrome's; inside Reddit or Instagram
  // neither menu exists, and showing them there is what we did wrong until
  // 24 Aug 2026 — 19 people tapped "open in my browser" as their first action
  // on the page rather than follow instructions that could not be followed.
  const escape = escapeCard();
  // Android's native install sheet, captured by the shell before React
  // mounted (see index.html). When present, the primary button installs in
  // ONE TAP instead of teaching a three-step dance. iOS never has it —
  // Apple exposes no API — so the steps remain the whole story there.
  const [native, setNative] = useState<boolean>(() => Boolean((window as any).__numInstall));
  useEffect(() => {
    const on = () => setNative(true);
    const done = () => { setNative(false); setShow(false); };
    window.addEventListener('num-installable', on);
    window.addEventListener('num-installed', done);
    return () => { window.removeEventListener('num-installable', on); window.removeEventListener('num-installed', done); };
  }, []);
  const nativeInstall = async () => {
    const e = (window as any).__numInstall;
    if (!e) { setOpen(true); return; }
    (window as any).__numInstall = null;
    setNative(false);
    try {
      e.prompt();
      const c = await e.userChoice;
      if (c?.outcome === 'accepted') setShow(false);
      else setOpen(true); // declined the sheet — offer the manual road
    } catch { setOpen(true); }
  };

  useEffect(() => {
    // Inside the app-store build there is nothing to install — the prompt
    // would be asking someone already in the app to get the app.
    if (!canOfferInstall()) return;
    if (isStandalone()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch { /* private mode — showing it once is fine */ }

    // ── WHEN to ask ───────────────────────────────────────────────────────
    //
    // It used to be 1.2 seconds. That is a stranger asking for commitment
    // before saying anything useful, and on 24 Aug the numbers agreed: of the
    // first seven arrivals we could measure, seven did nothing at all.
    //
    // Now the card waits for a sign the person is actually reading — a scroll,
    // a tap, or fifteen seconds of dwell, whichever lands first. Someone who
    // bounces in four seconds was never going to install; asking them only
    // spends the one impression we get.
    //
    // ── THE ESCAPE CARD WAITS FOR THE FIRST MESSAGE ─────────────────────
    //
    // It used to show the instant the page loaded, on the reasoning that it
    // was a warning rather than a request: this browser cannot keep your
    // account. That reasoning EXPIRED when accounts became portable. An
    // account now belongs to a verified phone number, not to this webview's
    // storage — sign in from anywhere and it follows. So there is nothing
    // urgent to warn about, and interrupting a stranger before Num has said
    // anything useful spends the one impression we get on a scolding.
    //
    // Num works perfectly well inside Instagram. Let them use it. The offer
    // to put it on a home screen makes sense AFTER they have asked something
    // and got a real answer back — at which point it is an upgrade rather
    // than a toll gate.
    if (escape) {
      const asked = () => store.get().msgs.some((m) => m.who === 'u');
      if (asked()) { setShow(true); return; }
      const stop = store.subscribe(() => { if (asked()) { setShow(true); stop(); } });
      return () => { stop(); };
    }

    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      setShow(true);
      cleanup();
    };
    const onScroll = () => { if (window.scrollY > 120) fire(); };
    const cleanup = () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerdown', fire);
      clearTimeout(dwell);
    };
    const dwell = setTimeout(fire, 15000);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerdown', fire, { once: true });
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!show || suppressed) return null;

  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* fine */ }
  };

  // ── Inside someone else's browser ──────────────────────────────────────
  //
  // Different card, different job. There is nothing to install from in here,
  // so this offers the one thing that helps: the address, on their clipboard,
  // ready to paste into a real browser. No "Add to Home Screen" language at
  // all — that menu does not exist in a web view and naming it is what sent
  // people looking for a Share button that was not there.
  if (escape) {
    return (
      <div
        className="glass-strong"
        style={{
          position: anchor, left: 12, right: 12, bottom: `calc(max(env(safe-area-inset-bottom), 14px) + ${lift}px)`,
          zIndex: 60, borderRadius: 18, padding: 15, maxWidth: 420, margin: '0 auto',
          boxShadow: '0 12px 40px rgba(0,0,0,.22)',
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
              {escape.eyebrow}
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15.5, marginTop: 4 }}>
              {escape.heading}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
              {escape.body}
            </div>
          </div>
          <div
            {...pressable(dismiss)}
            aria-label="Dismiss"
            style={{ flex: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'var(--ink-40)', padding: 2 }}
          >
            ×
          </div>
        </div>

        <ol style={{ margin: '11px 0 0', padding: '0 0 0 18px', fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.7 }}>
          {escape.steps.map((s: string) => <li key={s}>{s}</li>)}
        </ol>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <div
            {...pressable(() => {
              // A web view cannot be told to hand a URL to the system browser,
              // so the clipboard is the whole mechanism. If even that is
              // blocked the steps above still stand on their own.
              const url = 'https://app.itsnum.com/';
              void navigator.clipboard?.writeText(url).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            })}
            className="press"
            style={{
              flex: 1, cursor: 'pointer', textAlign: 'center', borderRadius: 999, padding: '11px 14px',
              background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '.06em',
            }}
          >
            {copied ? 'LINK COPIED' : 'COPY THE LINK'}
          </div>
          <div
            {...pressable(dismiss)}
            style={{ cursor: 'pointer', borderRadius: 999, padding: '11px 14px', fontSize: 11, fontWeight: 700, color: 'var(--ink-60)' }}
          >
            Later
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="glass-strong"
      style={{
        position: anchor, left: 12, right: 12, bottom: `calc(max(env(safe-area-inset-bottom), 14px) + ${lift}px)`,
        zIndex: 60, borderRadius: 18, padding: 15, maxWidth: 420, margin: '0 auto',
        boxShadow: '0 12px 40px rgba(0,0,0,.22)',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
            YOU’RE IN A BROWSER
          </div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15.5, marginTop: 4 }}>
            Put Num on your home screen
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
            Installed, Num can reach you when a plan moves or a friend replies. In a tab it can’t —
            and your account lives only as long as the browser keeps it.
          </div>
        </div>
        <div
          {...pressable(dismiss)}
          aria-label="Not now"
          style={{ flex: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'var(--ink-40)', padding: 2 }}
        >
          ×
        </div>
      </div>

      {open && (
        <ol style={{ margin: '11px 0 0', padding: '0 0 0 18px', fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.7 }}>
          {STEPS[platform].map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <div
          {...pressable(() => { if (native && !open) void nativeInstall(); else setOpen((v) => !v); })}
          className="press"
          style={{
            flex: 1, cursor: 'pointer', textAlign: 'center', borderRadius: 999, padding: '11px 14px',
            background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '.06em',
          }}
        >
          {native && !open ? 'ADD — ONE TAP' : open ? 'GOT IT' : 'SHOW ME HOW'}
        </div>
        <div
          {...pressable(dismiss)}
          style={{ cursor: 'pointer', borderRadius: 999, padding: '11px 14px', fontSize: 11, fontWeight: 700, color: 'var(--ink-60)' }}
        >
          Not now
        </div>
      </div>
    </div>
  );
}
