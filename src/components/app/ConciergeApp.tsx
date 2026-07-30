// The Num app screen — header, tab bar, views, sheets and overlays.
// Composition and z-layering match Concierge.dc.html exactly.
import { useEffect } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { closeVoice } from '../../lib/concierge';
import { monthsFor, segStyle } from '../../lib/derive';
import { bootSocial, startPlanSync } from '../../lib/social';
import { StarIcon, ShareIcon, ChevronDownIcon, MessageIcon, RouteIcon, SparklesIcon, UsersIcon } from '../../lib/icons';
import ThreadView from './ThreadView';
import PlanView from './PlanView';
import MemoryView from './MemoryView';
import CalendarSheet from './CalendarSheet';
import ShareSheet from './ShareSheet';
import WalletSheet from './WalletSheet';
import InviteSheet from './InviteSheet';
import PartySheet from './PartySheet';
import { NotifBanner, PermissionDialog, VoiceOverlay } from './Overlays';

export default function ConciergeApp({ posterHeader = false, standalone = false }: { posterHeader?: boolean; standalone?: boolean }) {
  const view = useApp((s) => s.view);
  const stars = useApp((s) => s.stars);
  const nBookings = useApp((s) => s.bookings.filter((b) => b.status !== 'cancelled').length);
  const sheetOpen = useApp((s) => s.calOpen || s.shareOpen || s.walletOpen || s.partyOpen || !!s.inviteOpen);
  const party = useApp((s) => s.planMembers.length);
  const demo = useApp((s) => s.demo);
  const place = useApp((s) => s.place);

  // Demo: the scripted date/loop. Real: today anywhere on Earth, plus wherever
  // the user told Num they are — or the ask, until they have.
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const title = demo ? 'Tue 28 Jul · Bangkok' : place ? `${today} · ${place}` : `${today} · Where to?`;
  const subhead = demo
    ? `SE ASIA LOOP · 3 CITIES · ${nBookings} BOOKINGS`
    : place
      ? `${nBookings === 1 ? '1 BOOKING' : nBookings + ' BOOKINGS'} · NUM IS ON IT`
      : 'TELL NUM WHERE YOU ARE & WHERE YOU’RE HEADED';

  const closeSheets = () => store.set({ calOpen: false, shareOpen: false, walletOpen: false, partyOpen: false, inviteOpen: null });

  const overlayOpen = useApp((s) => s.calOpen || s.shareOpen || s.walletOpen || s.partyOpen || !!s.inviteOpen || s.voice > 0);

  // Pick up a referral/invite off the launch URL, then keep the shared plan in
  // step while the app is in the foreground — that polling loop is how the
  // other members' agents reach this one.
  useEffect(() => {
    bootSocial();
    return startPlanSync();
  }, []);

  // The system back button/gesture must close what's open, never quit the
  // app: opening an overlay pushes one history entry; popping it (Android
  // back, iOS edge-swipe, browser back) closes the overlay. If the overlay
  // is closed some other way (X, backdrop, Escape), the entry is consumed
  // silently so the next back-press behaves normally.
  useEffect(() => {
    if (!overlayOpen) return;
    let popped = false;
    const pushedAt = Date.now();
    history.pushState({ numOverlay: true }, '');
    const onPop = () => {
      // A pop landing almost immediately after our push is not the user — it's
      // the previous overlay's cleanup back() arriving late (history traversal
      // is async and can be throttled). Restore the entry and stay open;
      // otherwise closing one sheet and quickly opening another slams the
      // second one shut.
      if (Date.now() - pushedAt < 350) {
        history.pushState({ numOverlay: true }, '');
        return;
      }
      popped = true;
      store.set({ calOpen: false, shareOpen: false, walletOpen: false, partyOpen: false, inviteOpen: null });
      if (store.get().voice) closeVoice();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!popped && history.state?.numOverlay) history.back();
    };
  }, [overlayOpen]);

  // Escape dismisses sheets and the voice overlay — the keyboard counterpart
  // of tapping the backdrop. The permission dialog still needs an explicit choice.
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const s = store.get();
    if (s.calOpen || s.shareOpen || s.walletOpen || s.partyOpen || s.inviteOpen) closeSheets();
    if (s.voice) closeVoice();
  };

  // The app frame must never scroll. It is overflow:hidden, but a browser will
  // still scroll a hidden container programmatically to reveal a focused
  // element — focusing a field in a sheet that is mid-slide shoved the entire
  // UI up by ~370px and left a black band where the app used to be. Snapping
  // back on scroll covers every path into it: taps, keyboard focus, autofill,
  // find-in-page. (Our own focus() calls already pass preventScroll.)
  const holdFrame = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop || el.scrollLeft) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  };

  return (
    <div onKeyDown={onEscape} onScroll={holdFrame} style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}>
      {/* living ground — aurora blobs drift behind all content */}
      <div className="aurora-layer" aria-hidden="true" />
      {/* header — floating glass panel */}
      <div
        className="glass"
        style={{
          position: 'relative',
          zIndex: 2,
          margin: '0 8px',
          borderRadius: '0 0 var(--r-lg) var(--r-lg)',
          borderTop: 'none',
          background: posterHeader ? 'var(--grad-accent)' : undefined,
          color: posterHeader ? '#fff' : 'var(--ink)',
        }}
      >
        {/* 62px clears the device frame's overlaid status bar; full-bleed the browser chrome already holds it */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: standalone ? 'max(env(safe-area-inset-top), 16px) 16px 0' : '62px 16px 0' }}>
          <div style={{ fontSize: 11, letterSpacing: '.16em', fontWeight: 700 }}>
            NUM <span style={{ fontWeight: 400, opacity: 0.55 }}>· YOUR CONCIERGE</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              {...pressable(() => store.set({ walletOpen: true }))}
              aria-label="Stars wallet"
              className="glass press"
              style={{ cursor: 'pointer', borderRadius: 999, padding: '5px 10px', display: 'flex', gap: 5, alignItems: 'center', fontWeight: 700, fontSize: 11 }}
              title="Stars wallet"
            >
              <StarIcon size={13} /> {stars.toLocaleString()}
            </div>
            <div
              {...pressable(() => store.set({ partyOpen: true }))}
              aria-label="Group plan"
              className="glass press"
              style={{ cursor: 'pointer', width: 32, height: 32, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
              title="Group plan"
            >
              <UsersIcon size={15} />
              {party > 1 && (
                <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {party}
                </span>
              )}
            </div>
            <div
              {...pressable(() => store.set({ shareOpen: true, copied: false }))}
              aria-label="Share plan"
              className="glass press"
              style={{ cursor: 'pointer', width: 32, height: 32, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title="Share plan"
            >
              <ShareIcon size={15} />
            </div>
          </div>
        </div>
        <div {...pressable(() => store.set((s) => { const M = monthsFor(s.demo)[0]; return { calOpen: true, selDay: s.selDay || `${M.mo}-${M.todayDay ?? 1}` }; }))} style={{ cursor: 'pointer', padding: '2px 16px 12px' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 21, fontWeight: 700, lineHeight: 1.1 }}>
            {title} <ChevronDownIcon size={15} style={{ color: posterHeader ? '#fff' : 'var(--color-accent)', verticalAlign: 'middle' }} />
          </div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', marginTop: 3, color: posterHeader ? 'rgba(255,255,255,.75)' : 'var(--color-neutral-600)' }}>
            {subhead}
          </div>
        </div>
      </div>

      {/* tab bar — floating glass segmented control */}
      <div role="tablist" className="glass" style={{ display: 'flex', margin: '10px 10px 2px', borderRadius: 999, padding: 4, position: 'relative', zIndex: 2 }}>
        <div {...pressable(() => store.set({ view: 'thread' }), 'tab')} aria-selected={view === 'thread'} style={segStyle(view === 'thread')}><MessageIcon size={13} />THREAD</div>
        <div {...pressable(() => store.set({ view: 'plan' }), 'tab')} aria-selected={view === 'plan'} style={segStyle(view === 'plan')}><RouteIcon size={13} />PLAN</div>
        <div {...pressable(() => store.set({ view: 'mem' }), 'tab')} aria-selected={view === 'mem'} style={segStyle(view === 'mem')}><SparklesIcon size={13} />MEMORY</div>
      </div>

      {/* views float above the aurora ground; wrapper mirrors the root's flex column */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        {view === 'thread' && <ThreadView />}
        {view === 'plan' && <PlanView />}
        {view === 'mem' && <MemoryView />}
      </div>

      <VoiceOverlay />
      <NotifBanner />

      {/* sheet backdrop — mouse convenience only; keyboard users close sheets with Escape (root onKeyDown) */}
      <div
        aria-hidden="true"
        onClick={closeSheets}
        style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.35)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 50, opacity: sheetOpen ? 1 : 0, pointerEvents: sheetOpen ? 'auto' : 'none', transition: 'opacity .3s' }}
      />

      <CalendarSheet />
      <PartySheet />
      <InviteSheet />
      <ShareSheet />
      <WalletSheet />
      <PermissionDialog />
    </div>
  );
}
