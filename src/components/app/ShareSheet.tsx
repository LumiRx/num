// Share Num with somebody, with your referral carried in the link.
//
// This used to be a share-the-plan sheet full of demo scaffolding — a
// hardcoded "Viv's SE Asia loop" and a concierge.travel URL that pointed
// nowhere. Sharing a PLAN already has a home: the invite flow, which mints a
// real token and can attach a specific plan. What was missing is the ordinary
// thing — handing Num to a friend.
//
// Two details decide whether this works:
//
//   · The link comes from lib/links, which uses the CANONICAL host — never
//     window.location.origin. Opened from a preview deploy, an origin-derived
//     link reads "num-app.thatislumi.workers.dev", which looks like nothing to
//     do with Num and lands the recipient where their account does not exist.
//   · The referral code rides along, so whoever taps it is attributed to the
//     person who shared it. A share with no attribution is one nobody can be
//     thanked for.
import { useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, CopyIcon, XIcon } from '../../lib/icons';
import QrCard from './QrCard';
import { pretty, referralLink } from '../../lib/links';

export default function ShareSheet() {
  const open = useApp((s) => s.shareOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);
  const [copied, setCopied] = useState(false);

  if (!open) return null;
  const close = () => store.set({ shareOpen: false });

  // Canonical host, short path. Short because a shared link gets read aloud,
  // screenshotted and typed back in by hand.
  const link = me?.ref ? referralLink(me.ref) : 'https://app.itsnum.com';

  const message = me?.name
    ? `It's ${me.name}. I use NUM as my concierge — one thread that books dinner, cars, tables, whole weekends. Here's my invite: ${link}`
    : `NUM is a concierge in one thread — dinner, cars, tables, whole weekends. ${link}`;

  const flash = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        // URL passed separately from text — iOS only builds a link preview
        // when the url field is its own thing.
        await nav.share({ title: 'Join me on NUM', text: message, url: link });
        return;
      } catch {
        /* cancelled, or the sheet is unavailable — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(message);
      flash();
    } catch {
      /* clipboard blocked — the link is on screen to read */
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      flash();
    } catch {
      /* nothing to do — the link is visible above */
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      className="glass-strong"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: '88%', overflowY: 'auto' }}
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

      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>SHARE NUM</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>Give someone a concierge</div>
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.55 }}>
          Your link is in here. When they join you’re connected — whatever either of you books, the other’s Num can see it.
        </div>

        {!me ? (
          <>
            <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 14, lineHeight: 1.55 }}>
              Add your name first so the invite comes from someone — an anonymous link is one nobody taps.
            </div>
            <div
              {...pressable(() => store.set({ shareOpen: false, inviteOpen: {} }))}
              style={{ cursor: 'pointer', marginTop: 14, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center' }}
            >
              INTRODUCE YOURSELF
            </div>
          </>
        ) : (
          <>
            <div
              {...pressable(share)}
              className="press"
              style={{ cursor: 'pointer', marginTop: 16, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '14px 16px', textAlign: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.3)' }}
            >
              SHARE MY INVITE
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <div style={{ flex: 1, borderRadius: 999, border: '1px solid var(--ink-12)', padding: '10px 14px', fontSize: 11, color: 'var(--ink-60)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', background: 'var(--field-bg)' }}>
                {pretty(link)}
              </div>
              <div
                {...pressable(copy)}
                className="press"
                style={{ cursor: 'pointer', borderRadius: 999, border: '1px solid var(--ink-12)', color: 'var(--ink)', fontWeight: 700, fontSize: 11, letterSpacing: '.08em', padding: '10px 14px', display: 'flex', gap: 6, alignItems: 'center', background: 'var(--field-bg)', whiteSpace: 'nowrap' }}
              >
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                {copied ? 'COPIED' : 'COPY'}
              </div>
            </div>

            {/* The same invite as a code. Somebody sitting opposite you scans
                it and is connected on the spot — no typing, no waiting for a
                text to arrive somewhere with no signal. */}
            <div style={{ marginTop: 18 }}>
              <QrCard />
            </div>

            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 14, lineHeight: 1.55 }}>
              Anyone who joins on your link is credited to you. If they already have Num it just connects the two of you — it won’t make them sign in again.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
