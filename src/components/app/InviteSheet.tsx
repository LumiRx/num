// Invite sheet — sign up with a number, pick who you meant, send the invite
// from your own phone, and show the invitee how to keep Num on their home
// screen. Everything that turns one Num user into two happens here.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, CopyIcon, ShareIcon, XIcon } from '../../lib/icons';
import { contactsSupported, mintInvite, pickContacts, shareInvite, signUp, verifyCode, whoIsOnNum } from '../../lib/social';

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const field: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)',
  padding: '0 14px', fontSize: 16, background: 'var(--field-bg)', outline: 'none',
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

/**
 * The install prompt.
 *
 * Two reasons this is big rather than a footnote:
 *
 *   · A PWA that lives in a browser tab is a PWA nobody opens twice. Installed,
 *     it is on the home screen next to everything else they use.
 *   · On iPhone, push notifications ONLY work for an installed app. Every
 *     "your table moved" Num will ever send depends on this one tap.
 *
 * The instructions differ per platform and getting them wrong is worse than
 * omitting them — an iPhone user told to look for "Install app" will hunt for
 * a menu item that does not exist.
 */
function AddToHomeScreen() {
  const installed =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (installed) return null;

  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);

  return (
    <div
      style={{
        marginTop: 18,
        borderRadius: 'var(--r-lg)',
        padding: '18px 16px',
        background: 'var(--field-bg)',
        border: '1px solid var(--ink-12)',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: '.16em', fontWeight: 800, color: 'var(--color-accent)' }}>PUT NUM ON YOUR PHONE</div>
      <div
        style={{
          fontFamily: 'var(--font-heading)',
          fontWeight: 800,
          fontSize: 26,
          lineHeight: 1.2,
          marginTop: 8,
          letterSpacing: '-.01em',
        }}
      >
        {ios ? 'Tap Share, then Add to Home Screen' : 'Tap the menu, then Add to Home Screen'}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-60)', marginTop: 10, lineHeight: 1.55 }}>
        {ios
          ? 'The Share button is at the bottom of Safari — the square with an arrow coming out of it. Scroll down the list and pick “Add to Home Screen”.'
          : 'Open the ⋮ menu at the top right of Chrome and choose “Add to Home screen” or “Install app”.'}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
        It opens full screen, remembers you, and it is the only way Num can reach you when a table moves or a friend replies.
      </div>
    </div>
  );
}

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
  /** null = unknown / no number yet; true = they're already a member. */
  const [onNum, setOnNum] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  // Null until we have heard from the server; false once it has told us there
  // is no SMS provider. Never assumed true — showing a verification step that
  // cannot work is the failure this replaces.
  const [smsOn, setSmsOn] = useState(false);
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

  // The button says what is missing rather than sitting dim and silent, so
  // nobody has to guess which field is the problem.
  const phoneOk = /^\+[1-9][0-9\s()-]{6,}$/.test(phone.trim());
  const ready = !!name.trim() && phoneOk;

  const doSignUp = async () => {
    // Never return silently. A button that looks tappable and does nothing is
    // read as a broken app, not as a validation failure — the person has no
    // way to know their name did not register, so they tap it again, and
    // again, and then leave.
    if (!name.trim()) {
      setAccountNote('I need a name first — just what you want to be called.');
      return;
    }
    // The number is REQUIRED and must carry a country code. It is how friends
    // find you, how an invite carries your name, and how the account is
    // recovered on a new phone — an account without one is a dead end that
    // looks fine until the day it matters.
    if (!phone.trim()) {
      setAccountNote('I need your mobile too — it’s how friends find you and how I reach you if a booking moves.');
      return;
    }
    if (!/^\+[1-9][0-9\s()-]{6,}$/.test(phone.trim())) {
      setAccountNote('Start your number with the country code — +1 for the US, +44 UK, +66 Thailand.');
      return;
    }
    setAccountNote(null);
    setBusy(true);
    try {
      const out = await signUp(name.trim(), phone.trim() || undefined);
      // Honest about what actually happened to the number.
      setSmsOn(!!out.verification?.sent);
      setAccountNote(out.verification?.sent ? 'Code sent — type it in below.' : out.verification?.note ?? null);
      // Cold first run: they came to try the app, not to invite someone. Get
      // out of the way — Num picks the conversation up in the thread. When an
      // invite IS in flight, stay put and carry straight on to it.
      if (!sending) store.set({ inviteOpen: null, threadOpen: true });
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

  // "Sending" means there is an actual invite in flight — a named person or a
  // plan to join. A cold first open is neither.
  const sending = !!(draft.name || draft.phone || draft.planId);
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
          {/* First run and "I'm about to invite someone" are different moments
              and deserve different words — nothing is being sent on a cold open. */}
          {/* This is the first thing anyone is ASKED, and a form that reads
              like a signup form gets closed. Warm heading, one line of why,
              and a button that sounds like a person. */}
          <div style={label}>{sending ? 'YOUR NUM ACCOUNT' : 'HELLO'}</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>
            {sending ? 'Who am I sending this as?' : 'Let’s start with your name'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 5, lineHeight: 1.55 }}>
            {sending
              ? 'Your number is how friends find you and how invites carry your name. It is never shown to anyone you haven’t connected with.'
              : 'So I know what to call you. Your mobile is how friends find you here, and how I reach you if a booking moves — never shown to anyone you haven’t connected with.'}
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <input style={field} placeholder={sending ? 'Your name' : 'What should I call you?'} value={name} onChange={(e) => setName(e.target.value)} />
            <input style={field} placeholder={sending ? 'Mobile (+country code)' : 'Mobile — start with +1, +44, +66…'} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <div
              {...pressable(doSignUp)}
              aria-disabled={busy || !ready}
              style={{ ...primary, opacity: busy || !ready ? 0.5 : 1, cursor: busy ? 'wait' : 'pointer' }}
            >
              {busy
                ? 'ONE SEC…'
                : !name.trim()
                  ? 'YOUR NAME FIRST'
                  : !phone.trim()
                    ? 'AND YOUR MOBILE'
                    : !phoneOk
                      ? 'ADD YOUR COUNTRY CODE'
                      : sending
                        ? 'CREATE MY ACCOUNT'
                        : 'NICE TO MEET YOU'}
            </div>
          </div>
          {accountNote && <div style={{ ...helpText, color: 'var(--color-neutral-700)' }}>{accountNote}</div>}

          {/* Add to home screen. Deliberately large and above the fold on this
              screen, because it is the single step that decides whether Num is
              an app somebody has or a tab they lose. It only shows in a
              browser — once installed, telling someone to install is noise. */}
          <AddToHomeScreen />
        </div>
      ) : (
        <>
          {/* 2 — verify the number, ONLY when SMS is actually switched on.
              It used to show unconditionally: a "6-digit code" box and a CHECK
              button for a code that is never sent, because there is no SMS
              provider. Dead controls are worse than missing ones — people wait
              for a text that will not arrive, then assume the app is broken
              rather than that the feature is not built. `smsOn` is set from
              the sign-up response, which says plainly whether a code went. */}
          {smsOn && !me.phone_verified && me.phone && (
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
                <input
                  style={field}
                  placeholder="Their mobile number (optional)"
                  inputMode="tel"
                  value={toPhone}
                  onChange={(e) => setToPhone(e.target.value)}
                  onBlur={() => {
                    // The moment a plausible number is in the box, find out if
                    // they're already one of us — it changes what the invite
                    // means (instant connect vs "text them the link").
                    const p = toPhone.replace(/[^0-9+]/g, '');
                    if (p.length >= 7) void whoIsOnNum([p]).then((m) => setOnNum(m.get(p) ?? null));
                    else setOnNum(null);
                  }}
                />
                {onNum !== null && (
                  <div
                    style={{
                      fontSize: 11.5, fontWeight: 600, borderRadius: 10, padding: '8px 12px', lineHeight: 1.45,
                      background: onNum ? 'rgba(22,140,90,.12)' : 'rgba(236,48,19,.08)',
                      color: onNum ? '#0e6b45' : 'var(--color-accent-700)',
                    }}
                  >
                    {onNum
                      ? '✓ Already on Num — your invite connects you two instantly, no download needed.'
                      : 'Not on Num yet — create the invite and text it to them; the link sets them up.'}
                  </div>
                )}
                {contactsSupported() && (
                  <div
                    {...pressable(async () => {
                      const picked = await pickContacts();
                      if (picked[0]) {
                        setToName(picked[0].name);
                        setToPhone(picked[0].phone ?? '');
                        const p = (picked[0].phone ?? '').replace(/[^0-9+]/g, '');
                        if (p.length >= 7) void whoIsOnNum([p]).then((m) => setOnNum(m.get(p) ?? null));
                      }
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
              <div style={{ marginTop: 10, padding: 12, borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink)' }}>
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
              <div style={{ marginTop: 16, padding: 13, borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)' }}>
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
