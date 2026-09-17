// A WAY TO REACH YOU — added after the fact, for the people who never gave one.
//
// On 12 Sep 2026, 107 of NUM's 147 members had no phone and no email on file.
// New sign-ups now have to give one (worker/membercontact.mjs), but the people
// who joined under the old rule are the reason the rule changed, and locking
// them out for a change we made would be punishing them for our decision. So
// they are ASKED, here, and never blocked.
//
// It also does the smaller job it should always have done: an unverified
// channel has somewhere to type the code. Until now a member whose code
// arrived after they closed the sheet had no route back to a code box at all.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { normalisePhone, describePhone } from '../../lib/phone';
import { normaliseEmail } from '../../lib/contact';
import { addContact, verifyCode, resendCode } from '../../lib/social';
import { guestMessage } from '../../lib/saferr';

const kicker: React.CSSProperties = {
  fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)',
};
const field: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)',
  padding: '0 13px', fontSize: 16, background: 'var(--field-bg)', outline: 'none',
  fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const btn: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, padding: '12px 16px', textAlign: 'center',
  fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', minHeight: 44,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

export default function ContactCard() {
  const me = useApp((s) => s.me);
  const asked = useApp((s) => s.contactOpen);
  const box = useRef<HTMLDivElement | null>(null);

  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [emailMode, setEmailMode] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // The thread's nudge sets the flag; this brings the card into view and
  // clears it, so arriving here always shows something happening. Declared
  // above the early return so the hook order never changes — the same rule
  // DangerZone learned the hard way.
  useEffect(() => {
    if (!asked) return;
    store.set({ contactOpen: false });
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [asked]);

  if (!me) return null;

  const hasPhone = !!me.phone;
  const hasEmail = !!me.email;
  const verified = (hasPhone && me.phone_verified) || (hasEmail && me.email_verified);
  // Nothing to ask and nothing to prove — say nothing at all.
  if (verified) return null;

  const phoneInfo = describePhone(phone);
  const missing = !hasPhone && !hasEmail;

  const submit = async () => {
    setNote(null);
    const tidyPhone = phone.trim() ? normalisePhone(phone) : null;
    const tidyEmail = email.trim() ? normaliseEmail(email) : null;
    if (phone.trim() && (!phoneInfo.ok || !tidyPhone)) {
      setNote(phoneInfo.note ?? 'That number doesn’t look complete — check the country code.');
      return;
    }
    if (email.trim() && !tidyEmail) {
      setNote('That address doesn’t look complete — check for a missing @ or a typo in the domain.');
      return;
    }
    if (!tidyPhone && !tidyEmail) {
      setNote('A mobile or an email — either one is fine.');
      return;
    }
    setBusy(true);
    try {
      const out = await addContact(tidyPhone ?? undefined, tidyEmail ?? undefined);
      setSent(!!out.sent);
      setNote(out.note ?? (out.sent
        ? 'Code sent — type it in below.'
        : 'Saved. I could not get a code out just now, so try again in a minute.'));
    } catch (err) {
      setNote(guestMessage(err, 'That didn’t go through.'));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (code.trim().length < 4) { setNote('Type the six digits I sent you.'); return; }
    setBusy(true);
    try {
      const ok = await verifyCode(code.trim());
      setNote(ok ? 'Done — I can reach you now.' : 'That code didn’t match.');
      if (ok) setCode('');
    } catch (err) {
      setNote(guestMessage(err, 'That code didn’t match.'));
    } finally {
      setBusy(false);
    }
  };

  const again = async () => {
    setBusy(true);
    try {
      const out = await resendCode();
      setNote(out.already ? 'Already verified — you are in.' : out.sent ? 'New code on its way.' : 'I could not send another just now.');
    } catch (err) {
      setNote(guestMessage(err, 'Couldn’t send another just now.'));
    } finally {
      setBusy(false);
    }
  };

  // A channel is on file and unproved: all that is missing is the code.
  const proving = !missing || sent;

  return (
    <div ref={box} style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--ink-08)' }}>
      <div style={kicker}>{missing ? 'A WAY TO REACH YOU' : 'FINISH VERIFYING'}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
        {missing
          ? 'I have no number and no email for you, which means I cannot tell you when a booking moves and you cannot get this account back if you change phones.'
          : `Type the code I sent to ${me.phone ?? me.email}. It is what proves the ${me.phone ? 'number' : 'address'} is yours.`}
      </div>

      {missing && (
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {!emailMode ? (
            <>
              <input style={field} placeholder="Mobile number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <div
                {...pressable(() => { setEmailMode(true); setPhone(''); })}
                style={{ fontSize: 11, color: 'var(--ink-40)', cursor: 'pointer', textDecoration: 'underline', minHeight: 44, display: 'flex', alignItems: 'center' }}
              >
                No mobile I can be texted on — use my email instead
              </div>
            </>
          ) : (
            <>
              <input
                style={field} placeholder="Email address" inputMode="email"
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                value={email} onChange={(e) => setEmail(e.target.value)}
              />
              <div
                {...pressable(() => { setEmailMode(false); setEmail(''); })}
                style={{ fontSize: 11, color: 'var(--ink-40)', cursor: 'pointer', textDecoration: 'underline', minHeight: 44, display: 'flex', alignItems: 'center' }}
              >
                Use a mobile number instead
              </div>
            </>
          )}
          <div
            {...pressable(() => { if (!busy) void submit(); })}
            className="press"
            style={{ ...btn, background: 'var(--grad-accent)', color: '#fff' }}
          >
            {busy ? '…' : 'SEND ME A CODE'}
          </div>
        </div>
      )}

      {proving && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            style={{ ...field, flex: 1 }} placeholder="6-digit code" inputMode="numeric"
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <div
            {...pressable(() => { if (!busy) void check(); })}
            className="press"
            style={{ ...btn, padding: '0 18px', background: 'var(--grad-accent)', color: '#fff' }}
          >
            {busy ? '…' : 'CHECK'}
          </div>
        </div>
      )}

      {proving && (
        <div
          {...pressable(() => { if (!busy) void again(); })}
          style={{ fontSize: 11, color: 'var(--ink-40)', cursor: 'pointer', textDecoration: 'underline', marginTop: 8, minHeight: 44, display: 'flex', alignItems: 'center' }}
        >
          I didn’t get it — send another
        </div>
      )}

      {note && <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5, color: 'var(--ink-60)' }}>{note}</div>}
    </div>
  );
}
