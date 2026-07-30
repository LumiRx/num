// Invite sheet — sign up with a number, pick who you meant, send the invite
// from your own phone, and show the invitee how to keep Num on their home
// screen. Everything that turns one Num user into two happens here.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, CopyIcon, ShareIcon, XIcon } from '../../lib/icons';
import { contactsSupported, mintInvite, pickContacts, shareInvite, signUp, verifyCode } from '../../lib/social';

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const field: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)',
  padding: '0 14px', fontSize: 16, background: 'rgba(255,255,255,.75)', outline: 'none',
  fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff',
  fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '12px 16px',
  display: 'flex', gap: 7, alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 4px 14px rgba(236,48,19,.3)',
};
const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const helpText: React.CSSProperties = { fontSize: 10.5, color: 'var(--color-neutral-500)', lineHeight: 1.55, marginTop: 10 };

export default function InviteSheet() {
  const draft = useApp((s) => s.inviteOpen);
  const me = useApp((s) => s.me);
  const open = !!draft;
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [toName, setToName] = useState('');
  const [toPhone, setToPhone] = useState('');
  const [code, setCode] = useState('');
  // Two independent notices: one about the account/number, one about the
  // invite. Sharing a single `note` printed the SMS message under both.
  const [accountNote, setAccountNote] = useState<string | null>(null);
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<'shared' | 'copied' | null>(null);

  // Each time the sheet opens, seed the fields from whatever Num already
  // resolved — a name said in chat, a phone from a picked contact.
  useEffect(() => {
    if (!draft) return;
    setToName(draft.name ?? '');
    setToPhone(draft.phone ?? '');
    setSent(null);
    setInviteNote(null);
  }, [draft?.name, draft?.phone, !!draft]);

  if (!draft) return null;
  const close = () => store.set({ inviteOpen: null });

  const doSignUp = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const out = await signUp(name.trim(), phone.trim() || undefined);
      // Honest about what actually happened to the number.
      setAccountNote(out.verification?.sent ? 'Code sent — type it in below.' : out.verification?.note ?? null);
    } catch (err) {
      setAccountNote(err instanceof Error ? err.message : 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  };

  const doVerify = async () => {
    setBusy(true);
    try {
      setAccountNote((await verifyCode(code.trim())) ? 'Number verified.' : 'That code didn’t match.');
    } catch (err) {
      setAccountNote(err instanceof Error ? err.message : 'That code didn’t match.');
    } finally {
      setBusy(false);
    }
  };

  const doMint = async () => {
    if (!toName.trim() && !toPhone.trim()) return;
    setBusy(true);
    try {
      await mintInvite(toName.trim(), toPhone.trim() || undefined, draft.planId);
    } catch (err) {
      setInviteNote(err instanceof Error ? err.message : 'Couldn’t create that invite.');
    } finally {
      setBusy(false);
    }
  };

  const minted = draft.minted;
  const steps = minted ? (isIOS() ? minted.install_steps.ios : minted.install_steps.android) : [];

  return (
    <div
      ref={ref}
      className="glass-strong"
      style={{ ...sheetBase, visibility: open ? 'visible' : 'hidden', transform: open ? 'translateY(0)' : 'translateY(105%)', maxHeight: '86%', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>

      {/* 1 — you need an account before you can invite anyone. */}
      {!me ? (
        <div style={{ padding: 16 }}>
          <div style={label}>YOUR NUM ACCOUNT</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>Who am I sending this as?</div>
          <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 3, lineHeight: 1.5 }}>
            Your number is how friends find you and how invites carry your name. It is never shown to anyone you haven’t connected with.
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <input style={field} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
            <input style={field} placeholder="Mobile number (+country code)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <div {...pressable(doSignUp)} style={{ ...primary, opacity: busy || !name.trim() ? 0.6 : 1 }}>
              {busy ? 'ONE SEC…' : 'CREATE MY ACCOUNT'}
            </div>
          </div>
          {accountNote && <div style={{ ...helpText, color: 'var(--color-neutral-700)' }}>{accountNote}</div>}
        </div>
      ) : (
        <>
          {/* 2 — verify the number, when SMS is switched on. */}
          {!me.phone_verified && me.phone && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink-08)' }}>
              <div style={label}>VERIFY YOUR NUMBER</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input style={{ ...field, flex: 1 }} placeholder="6-digit code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
                <div {...pressable(doVerify)} style={{ ...primary, padding: '12px 18px' }}>CHECK</div>
              </div>
              {accountNote && <div style={helpText}>{accountNote}</div>}
            </div>
          )}

          {/* 3 — who is this going to? */}
          {!minted ? (
            <div style={{ padding: 16 }}>
              <div style={label}>{draft.planId ? 'INVITE TO THE PLAN' : 'INVITE A FRIEND'}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>
                {draft.name ? `Send ${draft.name} an invite` : 'Who are we bringing in?'}
              </div>

              {!!draft.candidates?.length && (
                <>
                  <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 6 }}>
                    I found {draft.candidates.length === 1 ? 'one match' : `${draft.candidates.length} matches`} — tap the right one so it goes to the right person.
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                    {draft.candidates.map((c) => (
                      <div
                        key={c.name + (c.phone ?? '')}
                        {...pressable(() => { setToName(c.name); setToPhone(c.phone ?? ''); })}
                        className="glass lift"
                        style={{ cursor: 'pointer', borderRadius: 999, padding: '8px 13px', fontSize: 11.5, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}
                      >
                        {toName === c.name && <CheckIcon size={12} />} {c.name}
                        {c.phone && <span style={{ opacity: 0.5 }}>· {c.phone.slice(-4).padStart(6, '•')}</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                <input style={field} placeholder="Their name" value={toName} onChange={(e) => setToName(e.target.value)} />
                <input style={field} placeholder="Their mobile number (optional)" inputMode="tel" value={toPhone} onChange={(e) => setToPhone(e.target.value)} />
                {contactsSupported() && (
                  <div
                    {...pressable(async () => {
                      const picked = await pickContacts();
                      if (picked[0]) { setToName(picked[0].name); setToPhone(picked[0].phone ?? ''); }
                    })}
                    className="glass press"
                    style={{ cursor: 'pointer', borderRadius: 999, padding: '11px 16px', fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textAlign: 'center' }}
                  >
                    PICK FROM CONTACTS
                  </div>
                )}
                <div {...pressable(doMint)} style={{ ...primary, opacity: busy || (!toName.trim() && !toPhone.trim()) ? 0.6 : 1 }}>
                  {busy ? 'ONE SEC…' : 'CREATE THE INVITE'}
                </div>
              </div>
              <div style={helpText}>
                {contactsSupported()
                  ? 'The picker only ever returns the person you tap — Num never reads your address book.'
                  : 'This browser has no contacts API, so type the name. Nothing is read from your phone.'}
              </div>
              {inviteNote && <div style={{ ...helpText, color: 'var(--color-accent-700)' }}>{inviteNote}</div>}
            </div>
          ) : (
            /* 4 — ready to send, from the member's own phone. */
            <div style={{ padding: 16 }}>
              <div style={label}>READY TO SEND</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>
                {draft.name ? `${draft.name}’s invite is ready` : 'Your invite is ready'}
              </div>
              <div style={{ marginTop: 10, padding: 12, borderRadius: 'var(--r-md)', background: 'rgba(255,255,255,.8)', border: '1px solid var(--ink-08)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink)' }}>
                {minted.message}
              </div>

              <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                <div {...pressable(async () => setSent(((await shareInvite()) === 'shared' ? 'shared' : 'copied')))} style={primary}>
                  <ShareIcon size={14} /> {sent === 'shared' ? 'SENT' : sent === 'copied' ? 'COPIED — PASTE IT TO THEM' : 'SEND IT'}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <a href={minted.sms_url} className="glass press" style={{ flex: 1, textAlign: 'center', textDecoration: 'none', color: 'var(--ink)', borderRadius: 999, padding: '11px 12px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em' }}>
                    TEXT IT
                  </a>
                  <a href={minted.whatsapp_url} target="_blank" rel="noreferrer" className="glass press" style={{ flex: 1, textAlign: 'center', textDecoration: 'none', color: 'var(--ink)', borderRadius: 999, padding: '11px 12px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em' }}>
                    WHATSAPP
                  </a>
                  <div
                    {...pressable(() => { void navigator.clipboard?.writeText(minted.link); setSent('copied'); })}
                    className="glass press"
                    style={{ cursor: 'pointer', borderRadius: 999, padding: '11px 14px', display: 'flex', alignItems: 'center' }}
                    aria-label="Copy link"
                  >
                    <CopyIcon size={14} />
                  </div>
                </div>
              </div>

              {/* The part people actually forget: keeping it on the home screen. */}
              <div style={{ marginTop: 16, padding: 13, borderRadius: 'var(--r-md)', background: 'rgba(255,255,255,.65)', border: '1px solid var(--ink-08)' }}>
                <div style={{ ...label, color: 'var(--ink-60)' }}>WHAT THEY’LL DO — {isIOS() ? 'IPHONE' : 'ANDROID'}</div>
                <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.7, color: 'var(--color-neutral-700)' }}>
                  {steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <div style={{ ...helpText, marginTop: 8 }}>
                  Their invite carries your referral code, so the moment they join it counts to you — and the two Nums connect on their own.
                </div>
              </div>

              <div
                {...pressable(() => store.set((s) => ({ inviteOpen: { planId: s.inviteOpen?.planId ?? null } })))}
                style={{ marginTop: 14, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)', cursor: 'pointer' }}
              >
                INVITE SOMEONE ELSE
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
