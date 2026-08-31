// Sign in with Apple — the button.
//
// GUIDELINE 4.8. App Review rejected 1.0(2) because the app offered a
// third-party login (Google, in the 5arz identity card) with no equivalent
// option that limits collection to name and email, lets the user keep that
// email private, and does not track for advertising. This is that option.
//
// It also fixes something the guideline did not ask about: until now the ONLY
// way into a Num account was an SMS code, and of 129 members exactly 2 have
// ever completed phone verification. This is the first door that does not
// depend on a carrier.
//
// PRESENTATION RULES ARE APPLE'S, NOT OURS. The Human Interface Guidelines
// require the button to be at least as prominent as any other sign-in option,
// to use Apple's wording, and to be legible at the system's own proportions.
// Getting this cosmetically wrong is itself a 4.8 rejection, so the styling
// below is deliberately plain and unbranded-by-us: black fill, white mark,
// full width, system font.
import { useState } from 'react';
import { store, useApp } from '../../lib/store';
import { canSignInWithApple, signInWithApple } from '../../lib/appleAuth';

const AppleMark = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 17 20" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M14.09 10.62c-.02-2.4 1.96-3.55 2.05-3.61-1.12-1.63-2.86-1.86-3.48-1.89-1.48-.15-2.89.87-3.64.87-.75 0-1.91-.85-3.14-.83-1.61.02-3.1.94-3.93 2.38-1.68 2.91-.43 7.21 1.2 9.57.8 1.15 1.75 2.45 3 2.4 1.21-.05 1.66-.78 3.12-.78 1.46 0 1.87.78 3.14.76 1.3-.02 2.12-1.17 2.91-2.33.92-1.34 1.3-2.64 1.32-2.71-.03-.01-2.53-.97-2.55-3.83zM11.7 3.5c.66-.81 1.11-1.93.99-3.05-.95.04-2.11.64-2.8 1.44-.62.71-1.16 1.85-1.02 2.94 1.06.08 2.15-.54 2.83-1.33z"
    />
  </svg>
);

export default function AppleSignIn({ onDone }: { onDone?: () => void }) {
  const me = useApp((s) => s.me);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Hidden entirely off iOS, and hidden once this device already has a
  // signed-in account — a second sign-in button on a signed-in screen is
  // confusing, not reassuring.
  if (!canSignInWithApple()) return null;

  const go = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const out = await signInWithApple(me?.id ?? null);
    setBusy(false);
    if (out.ok) {
      // The server's row is the whole truth about this account, so it
      // REPLACES local state rather than merging into it. Merging would let a
      // stale field from the previous anonymous member survive a sign-in —
      // and the field most likely to survive is the one that matters least to
      // notice and most to get wrong: a phone number from someone else's
      // session on a shared device.
      store.set({ me: out.me });
      onDone?.();
      return;
    }
    // A cancel says nothing. The user closed the sheet on purpose and does not
    // need to be told what they just did.
    if (!out.cancelled) setNote(out.message);
  };

  return (
    <div style={{ margin: '10px 12px' }}>
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        style={{
          width: '100%', minHeight: 48, borderRadius: 12, border: 'none', cursor: 'pointer',
          background: '#000', color: '#fff', display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8, fontSize: 17, fontWeight: 500,
          fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          opacity: busy ? 0.6 : 1, padding: '0 16px',
        }}
      >
        <AppleMark />
        {busy ? 'Signing in…' : 'Sign in with Apple'}
      </button>
      <div style={{ fontSize: 11, color: 'var(--ink-60)', lineHeight: 1.5, marginTop: 7, textAlign: 'center' }}>
        Apple shares only your name and email, and you can hide the email. No code, no waiting for a text.
      </div>
      {note && (
        <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-accent-700)', textAlign: 'center' }}>
          {note}
        </div>
      )}
    </div>
  );
}
