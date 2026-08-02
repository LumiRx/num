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
import { useEffect, useState } from 'react';
import { store, useApp } from '../../lib/store';

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
    const r = await fetch('/api/version');
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

  useEffect(() => {
    void fetchClientId().then(setClientId);
  }, []);

  useEffect(() => {
    if (!clientId || done || !me) return;
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
          setBusy(true);
          setOutcome(null);
          try {
            const r = await fetch('/api/social/verify/5arz', {
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
