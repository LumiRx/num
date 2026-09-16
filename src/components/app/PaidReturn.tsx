// COMING BACK FROM STRIPE.
//
// Until now this screen did not exist. Stripe returned a paying member to
// `/?paid=cs_live_…` and nothing read the parameter — so somebody who had just
// been charged $8.98 landed on the ordinary app screen with no acknowledgement
// at all, and no way to tell whether it had worked.
//
// ── THE RACE THIS SCREEN IS BUILT AROUND ─────────────────────────────────
//
// The tier is granted by Stripe's WEBHOOK, not by this redirect, and the two
// race. The browser usually gets back first. So a single check would tell a
// member who just paid that they are on the free plan — the worst possible
// moment to be wrong.
//
// So there are three states and all three are honest:
//
//   upgraded  the server confirms the new tier. Say which one.
//   pending   we waited and it has not landed yet. The payment WENT THROUGH;
//             the account is catching up. Never shown as a failure, because it
//             is not one — Stripe has the money either way.
//   unknown   we could not identify the member at all.
//
// The one thing this screen may never do is claim an upgrade the server has
// not confirmed.
import { useEffect, useState } from 'react';
import { pressable } from '../../lib/a11y';
import { useApp } from '../../lib/store';
import { confirmPaid, clearPaidParam, type Landed } from '../../lib/subscription';

export default function PaidReturn({ was, onDone }: { was: string; onDone: () => void }) {
  const me = useApp((s) => s.me);
  const [landed, setLanded] = useState<Landed | null>(null);

  useEffect(() => {
    let alive = true;
    // Taken off the address bar IMMEDIATELY, not when the sheet closes: a
    // refresh while polling would otherwise start the whole confirmation over.
    clearPaidParam();
    if (!me?.id) { setLanded({ state: 'unknown' }); return () => { alive = false; }; }
    void confirmPaid(me.id, was).then((r) => { if (alive) setLanded(r); });
    return () => { alive = false; };
  }, [me?.id, was]);

  const wrap: React.CSSProperties = {
    position: 'absolute', inset: 0, zIndex: 90, display: 'flex',
    flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: '0 26px', textAlign: 'center',
    background: 'var(--bg, #fff)',
  };

  if (!landed) {
    return (
      <div style={wrap} role="status" aria-live="polite">
        <p style={{ fontSize: 15, color: 'var(--ink-55)' }}>Confirming your payment…</p>
      </div>
    );
  }

  const done = (
    <button
      {...pressable}
      type="button"
      onClick={onDone}
      style={{
        marginTop: 22, height: 46, minWidth: 200, borderRadius: 999, border: 0,
        background: 'var(--color-accent)', color: '#fff', fontWeight: 700, fontSize: 15,
      }}
    >
      Start using Num
    </button>
  );

  if (landed.state === 'upgraded') {
    return (
      <div style={wrap} role="status" aria-live="polite">
        <p style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
          YOU’RE ON {String(landed.name).toUpperCase()}
        </p>
        <h2 style={{ margin: '10px 0 8px', fontSize: 25, letterSpacing: '-.02em' }}>That’s sorted.</h2>
        <p style={{ margin: 0, color: 'var(--ink-55)', fontSize: 14.5, lineHeight: 1.55, maxWidth: 380 }}>
          The ceilings are lifted on your account right now — nothing else to do.
          {landed.renews_at ? ` Renews ${landed.renews_at}.` : ''}
          {' '}You can change or cancel it any time from your profile.
        </p>
        {done}
      </div>
    );
  }

  if (landed.state === 'pending') {
    return (
      <div style={wrap} role="status" aria-live="polite">
        <p style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
          PAYMENT RECEIVED
        </p>
        <h2 style={{ margin: '10px 0 8px', fontSize: 25, letterSpacing: '-.02em' }}>
          Your plan is catching up.
        </h2>
        {/* NOT an error, and it must never read as one. Stripe has the payment;
            the grant arrives on its own webhook a moment behind the redirect. */}
        <p style={{ margin: 0, color: 'var(--ink-55)', fontSize: 14.5, lineHeight: 1.55, maxWidth: 380 }}>
          The payment went through. It sometimes takes a few seconds to show on your
          account — it will be there shortly, and nothing is lost if you close this.
          If it still looks wrong in a few minutes, message us and we will sort it.
        </p>
        {done}
      </div>
    );
  }

  return (
    <div style={wrap} role="status" aria-live="polite">
      <h2 style={{ margin: '0 0 8px', fontSize: 23, letterSpacing: '-.02em' }}>Thanks — that’s gone through.</h2>
      <p style={{ margin: 0, color: 'var(--ink-55)', fontSize: 14.5, lineHeight: 1.55, maxWidth: 380 }}>
        Sign in and your plan will be on your account.
      </p>
      {done}
    </div>
  );
}
