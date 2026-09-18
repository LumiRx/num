// Share NUM with somebody.
//
// THE QR FIRST, THEN THE PLACES IT CAN GO (18 Sep 2026). "The share button is
// so blocky and ugly and confusing … the QR code is great, the layout needs to
// be better." The code was at the bottom under a big green button, a copy
// row and an X link — three ways to do one thing. Now the code is the top of
// the sheet, because somebody sitting opposite you is the commonest case, and
// under it is a single row of the apps people actually share into.
//
// What each tile does, and which link it carries, lives in
// src/lib/socialshare.ts — this file only draws the list. Every tile is an
// <a href> or a copy; nothing is posted by NUM.
//
// The link comes from lib/links, which uses the CANONICAL host — never
// window.location.origin. Opened from a preview deploy, an origin-derived
// link reads "num-app.thatislumi.workers.dev", which looks like nothing to do
// with NUM and lands the recipient where their account does not exist.
import { useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import QrCard from './QrCard';
import { connectLink, pretty, referralLink } from '../../lib/links';
import { offered, privateText, type Destination, type ShareLinks } from '../../lib/socialshare';
import { t } from '../../lib/i18n';

/** Small, brand-neutral glyphs. The label under each tile is what names the app. */
function Glyph({ id }: { id: Destination['id'] }) {
  const p: React.SVGProps<SVGSVGElement> = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  switch (id) {
    case 'instagram': return <svg {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="3.8" /><circle cx="17.3" cy="6.7" r="0.9" fill="currentColor" stroke="none" /></svg>;
    case 'whatsapp': return <svg {...p}><path d="M4 20l1.3-3.9A8 8 0 1 1 8.2 19z" /><path d="M9 9.5c.3 2.2 2.5 4.4 4.7 4.7l1.3-1.3 1.8.9c-.4 1.6-1.6 2-3 1.6-2.9-.9-5.3-3.3-6.2-6.2-.4-1.4 0-2.6 1.6-3l.9 1.8z" /></svg>;
    case 'messages': return <svg {...p}><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V16A2.5 2.5 0 0 1 4 13.5z" /></svg>;
    case 'x': return <svg {...p} strokeWidth={2.2}><path d="M5 4l14 16M19 4L5 20" /></svg>;
    case 'facebook': return <svg {...p}><path d="M14 8h2.5V4.5H14A3.5 3.5 0 0 0 10.5 8v2.5H8V14h2.5v6H14v-6h2.5l.5-3.5H14V8z" /></svg>;
    case 'copy': return <svg {...p}><path d="M10 14a4 4 0 0 1 0-5.7l2.3-2.3a4 4 0 0 1 5.7 5.7l-1.2 1.2" /><path d="M14 10a4 4 0 0 1 0 5.7l-2.3 2.3a4 4 0 0 1-5.7-5.7l1.2-1.2" /></svg>;
    default: return <svg {...p}><circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>;
  }
}

export default function ShareSheet() {
  const open = useApp((s) => s.shareOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);
  const [said, setSaid] = useState<string | null>(null);

  if (!open) return null;
  const close = () => store.set({ shareOpen: false });

  const links: ShareLinks | null = me ? {
    connect: connectLink(me.id, me.ref),
    referral: me.ref ? referralLink(me.ref) : null,
    line: me.name
      ? `It’s ${me.name}. I use NUM as my concierge — one thread that books dinner, cars, tables, whole weekends. Here’s my invite:`
      : 'NUM is a concierge in one thread — dinner, cars, tables, whole weekends.',
  } : null;

  const say = (m: string) => { setSaid(m); setTimeout(() => setSaid(null), 2600); };
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  };

  const go = async (d: Destination) => {
    if (!links) return;
    if (d.kind === 'copy') { say((await copyText(d.clip!(links))) ? t('Link copied.') : t('Couldn’t copy — the link is below to read.')); return; }
    if (d.kind === 'system') {
      const nav = navigator as Navigator & { share?: (x: ShareData) => Promise<void> };
      if (nav.share) {
        // URL passed separately from text — iOS only builds a link preview
        // when the url field is its own thing.
        try { await nav.share({ title: 'Join me on NUM', text: links.line, url: links.connect }); } catch { /* cancelled */ }
      } else {
        say((await copyText(privateText(links))) ? t('Copied — paste it anywhere.') : t('Couldn’t copy.'));
      }
      return;
    }
    if (d.kind === 'copy-then-open') {
      const ok = await copyText(d.clip!(links));
      say(ok ? t(d.after ?? 'Copied.') : t('Couldn’t copy the caption — the link is below.'));
      // The open happens on the <a> itself (below) so an installed PWA, which
      // blocks programmatic popups, still gets a real navigation.
    }
  };

  const tile: React.CSSProperties = {
    display: 'grid', justifyItems: 'center', gap: 6, cursor: 'pointer', textDecoration: 'none', color: 'var(--ink)',
  };
  const disc: React.CSSProperties = {
    width: 52, height: 52, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--field-bg)', border: '1px solid var(--ink-12)',
  };
  const label: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '.02em', color: 'var(--ink-60)', textAlign: 'center' };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t('Share NUM')}
      className="glass-strong no-scrollbar"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(92%, calc(100% - var(--sat, 0px) - 8px))', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label={t('Close')} className="glass press tap" style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>

      <div style={{ padding: '14px 16px 18px' }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>{t('SHARE NUM')}</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, marginTop: 5, lineHeight: 1.15 }}>{t('Give someone a concierge')}</div>

        {!me ? (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--ink-60)', marginTop: 10, lineHeight: 1.55 }}>{t('Add your name first so the invite comes from someone — an anonymous link is one nobody taps.')}</div>
            <div {...pressable(() => store.set({ shareOpen: false, inviteOpen: {} }))} className="press" style={{ cursor: 'pointer', marginTop: 14, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center' }}>
              {t('SIGN IN')}
            </div>
          </>
        ) : (
          <>
            {/* THE CODE, FIRST. Somebody across the table scans it and is
                connected on the spot — no typing, no waiting for a text to
                land somewhere with no signal. */}
            <div style={{ marginTop: 12 }}>
              <QrCard />
            </div>

            {/* ONE ROW OF WHERE IT CAN GO. Which link each carries — connect
                for a friend, referral for a public post — is decided in
                lib/socialshare.ts, not here. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px 8px', marginTop: 18 }}>
              {offered(links!).map((d) => {
                const href = d.href && links ? d.href(links) : undefined;
                const inner = (
                  <>
                    <span className="press" style={disc}><Glyph id={d.id} /></span>
                    <span style={label}>{t(d.label)}</span>
                  </>
                );
                return href ? (
                  <a key={d.id} href={href} target="_blank" rel="noopener noreferrer" className="tap" style={tile} onClick={() => { void go(d); }}>
                    {inner}
                  </a>
                ) : (
                  <div key={d.id} {...pressable(() => { void go(d); })} className="tap" style={tile}>
                    {inner}
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 14, borderRadius: 999, border: '1px solid var(--ink-12)', padding: '10px 14px', fontSize: 11, color: 'var(--ink-60)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', background: 'var(--field-bg)', textAlign: 'center' }}>
              {pretty(links!.connect)}
            </div>
            <div style={{ minHeight: 18, marginTop: 8, fontSize: 11.5, color: 'var(--color-accent-700)', fontWeight: 600, textAlign: 'center' }}>{said ?? ''}</div>

            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', lineHeight: 1.55 }}>
              {t('A friend who opens your link is connected to you and credited to you. A public post carries a link that credits you and connects nobody — so a stranger scrolling past can’t attach themselves to your account.')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
