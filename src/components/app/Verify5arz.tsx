// Verify with 5arz — Gap 2 from Viv's 08-01 status: the endpoint has been live
// in production with nothing calling it (1 of 74 members linked).
//
// Dark until configured: the whole block renders nothing unless /api/version
// serves a google_client_id, which happens only once GOOGLE_CLIENT_ID is set
// on the worker (Gap 1 — Viv/Duke hold the value). Same switch guards the
// worker's audience check, so client and server can never disagree.
//
// Flow: Google Identity Services one-tap/button → ID token → POST
// /api/social/verify/5arz {me, google_id_token} → four outcomes, each rendered
// honestly. On success the server marks identity_verified server-side; we
// reflect it immediately and it survives reload via the normal profile load.
import { webEvent, webEventOnce } from '../../lib/track';
import { useEffect, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { apiUrl } from '../../lib/apibase';
import { nativePlatform } from '../../lib/native';

declare global {
  interface Window {
    google?: { accounts?: { id?: { initialize: (o: object) => void; renderButton: (el: HTMLElement, o: object) => void } } };
  }
}

type Outcome =
  | { kind: 'verified' }
  | { kind: 'no_5arz_account' | 'not_verified_there' | 'already_linked' | 'error'; message: string };

async function fetchClientId(): Promise<string | null> {
  try {
    const r = await fetch(apiUrl('/api/version'));
    const d = await r.json();
    return d?.google_client_id ?? null;
  } catch {
    return null;
  }
}

export default function Verify5arz() {
  const me = useApp((s) => s.me);
  const [clientId, setClientId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const done = !!(me as { identity_verified?: number } | null)?.identity_verified || outcome?.kind === 'verified';

  // GUIDELINE 4.8 AND 4.0 — WHY THIS BLOCK IS DARK ON iOS.
  //
  // App Review rejected 1.0(2) on two counts that are both this component:
  //
  //   4.8 Login Services — "the app uses a third-party login service but does
  //       not offer an equivalent login option" that limits collection to name
  //       and email, lets the user keep the email private, and does not track
  //       for ads. The reviewer's screenshot shows this card's "Continue with
  //       Google" button.
  //   4.0 Design — "the user is taken to the default web browser to sign in",
  //       which is what Google Identity Services does inside a WKWebView, and
  //       what the "Have a code from a link? Finish a connection that opened in
  //       your browser" row below it exists to paper over.
  //
  // Sign in with Apple now satisfies 4.8 as a first-class login (see
  // AppleSignIn.tsx). This card stays hidden on iOS regardless, because 4.0 is
  // about leaving the app and no amount of alternative login fixes that.
  //
  // It is untouched on web and Android, where the 5arz link is the point and
  // nothing leaves the app in a way Apple's rules govern. 5arz linking on iOS
  // is done on the web at 5arz.com and then flows back through the normal
  // profile load.
  const iosBuild = nativePlatform() === 'ios';

  useEffect(() => {
    if (iosBuild) return;
    void fetchClientId().then(setClientId);
  }, [iosBuild]);

  // THE WALL METRIC'S DENOMINATOR. Nine nightly editions reported "linked: 0"
  // against a "shown" of NOT MEASURED, because nothing recorded that this
  // card was ever put in front of someone. "Never saw the ask" and "saw it
  // and declined" were one number and mean opposite things. Once per device:
  // a rate needs people, not renders.
  useEffect(() => {
    if (iosBuild || !clientId || done || !me) return;
    webEventOnce('consent-5arz-shown', 'consent_prompt_shown', '5arz');
  }, [iosBuild, clientId, done, me]);

  useEffect(() => {
    if (iosBuild || !clientId || done || !me) return;
    // GIS script is loaded lazily and only when the feature is actually on —
    // no third-party JS on the page for users who never see this section.
    const ensure = () =>
      new Promise<void>((res) => {
        if (window.google?.accounts?.id) return res();
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = () => res();
        document.head.appendChild(s);
      });
    void ensure().then(() => {
      const g = window.google?.accounts?.id;
      const host = document.getElementById('g5arz-btn');
      if (!g || !host) return;
      g.initialize({
        client_id: clientId,
        callback: async (resp: { credential?: string }) => {
          if (!resp.credential) return;
          webEvent('consent_prompt_engaged', '5arz');
          setBusy(true);
          setOutcome(null);
          try {
            const r = await fetch(apiUrl('/api/social/verify/5arz'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ me: me.id, google_id_token: resp.credential }),
            });
            const d = await r.json();
            if (d?.verified) {
              setOutcome({ kind: 'verified' });
              store.set((s) => ({ me: s.me ? { ...s.me, identity_verified: 1 } : s.me }));
            } else {
              const kind = (['no_5arz_account', 'not_verified_there', 'already_linked'] as const).find(
                (k) => k === d?.reason,
              ) ?? 'error';
              setOutcome({
                kind,
                message:
                  d?.message ??
                  (kind === 'no_5arz_account'
                    ? 'No 5arz account uses that Google sign-in. Verify on 5arz first, then link here.'
                    : kind === 'not_verified_there'
                    ? 'That 5arz account exists but isn’t verified yet — finish verification on 5arz, then come back.'
                    : d?.error ?? 'That didn’t go through — try again in a moment.'),
              });
            }
          } catch {
            setOutcome({ kind: 'error', message: 'That didn’t go through — try again in a moment.' });
          } finally {
            setBusy(false);
          }
        },
      });
      // GIS renders at a fixed pixel width, so it must be told the card's
      // width or it either overflows the phone or floats undersized. 400 is
      // Google's documented maximum.
      const width = Math.min(400, Math.max(200, Math.round(host.getBoundingClientRect().width) || 280));
      g.renderButton(host, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width });
    });
  }, [clientId, done, me?.id]);

  // On iOS the SIGN-IN half of this card is gone (4.8 / 4.0 above), but a
  // member who linked their 5arz identity elsewhere should still see that it
  // IS linked — a status line is not a login service, and hiding it would make
  // a verified traveller look unverified on their own phone.
  if (iosBuild) {
    if (!done || !me) return null;
    return (
      <div className="glass" style={{ margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 700, color: 'var(--ink-40)' }}>IDENTITY · 5ARZ</div>
        <div style={{ marginTop: 7, fontSize: 12, fontWeight: 700, color: '#0e6b45' }}>
          ✓ Verified human — linked to your 5arz identity. Friends see this next to your name.
        </div>
      </div>
    );
  }

  // Feature dark (no client id yet) or no account on this device: render nothing.
  if (!clientId || !me) return null;

  // Its own card, matching the rest of the profile stack. It used to be the
  // third child of the identity flex row, where it overprinted the name.
  return (
    <div className="glass" style={{ margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 700, color: 'var(--ink-40)' }}>IDENTITY · 5ARZ</div>
      {done ? (
        <div style={{ marginTop: 7, fontSize: 12, fontWeight: 700, color: '#0e6b45' }}>
          ✓ Verified human — linked to your 5arz identity. Friends see this next to your name.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', lineHeight: 1.5, margin: '6px 0 9px' }}>
            Already verified on 5arz? Link it — sign in with the same Google account and Num carries the
            “verified human” badge. One 5arz identity links to one Num account, ever.
          </div>
          <div id="g5arz-btn" style={{ opacity: busy ? 0.5 : 1, display: 'flex', justifyContent: 'center', maxWidth: '100%', overflow: 'hidden' }} />
          {outcome && 'message' in outcome && (
            <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-accent-700)' }}>
              {outcome.message}
            </div>
          )}
        </>
      )}
    </div>
  );
}
