// The Num app screen — header, tab bar, views, sheets and overlays.
// Composition and z-layering match Concierge.dc.html exactly.
import type { KeyboardEvent } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { closeVoice } from '../../lib/concierge';
import { segStyle } from '../../lib/derive';
import ThreadView from './ThreadView';
import PlanView from './PlanView';
import MemoryView from './MemoryView';
import CalendarSheet from './CalendarSheet';
import ShareSheet from './ShareSheet';
import WalletSheet from './WalletSheet';
import { NotifBanner, PermissionDialog, VoiceOverlay } from './Overlays';

export default function ConciergeApp({ posterHeader = false, standalone = false }: { posterHeader?: boolean; standalone?: boolean }) {
  const view = useApp((s) => s.view);
  const stars = useApp((s) => s.stars);
  const nBookings = useApp((s) => s.bookings.filter((b) => b.status !== 'cancelled').length);
  const sheetOpen = useApp((s) => s.calOpen || s.shareOpen || s.walletOpen);

  const closeSheets = () => store.set({ calOpen: false, shareOpen: false, walletOpen: false });

  // Escape dismisses sheets and the voice overlay — the keyboard counterpart
  // of tapping the backdrop. The permission dialog still needs an explicit choice.
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const s = store.get();
    if (s.calOpen || s.shareOpen || s.walletOpen) closeSheets();
    if (s.voice) closeVoice();
  };

  return (
    <div onKeyDown={onEscape} style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', background: 'var(--color-bg)', fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}>
      {/* header */}
      <div style={{ borderBottom: '2px solid var(--color-divider)', background: posterHeader ? 'var(--color-accent)' : 'var(--color-bg)', color: posterHeader ? '#fff' : 'var(--color-text)' }}>
        {/* 62px clears the device frame's overlaid status bar; full-bleed the browser chrome already holds it */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: standalone ? 'max(env(safe-area-inset-top), 16px) 16px 0' : '62px 16px 0' }}>
          <div style={{ fontSize: 11, letterSpacing: '.16em', fontWeight: 700 }}>
            NUM <span style={{ fontWeight: 400, opacity: 0.55 }}>· YOUR CONCIERGE</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              {...pressable(() => store.set({ walletOpen: true }))}
              aria-label="Stars wallet"
              style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', border: '2px solid currentColor', padding: '3px 8px' }}
              title="Stars wallet"
            >
              ★ {stars.toLocaleString()}
            </div>
            <div {...pressable(() => store.set({ shareOpen: true, copied: false }))} aria-label="Share plan" style={{ cursor: 'pointer', padding: 4, display: 'flex' }} title="Share plan">
              <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
              </svg>
            </div>
          </div>
        </div>
        <div {...pressable(() => store.set((s) => ({ calOpen: true, selDay: s.selDay || '7-28' })))} style={{ cursor: 'pointer', padding: '2px 16px 12px' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 21, fontWeight: 700, lineHeight: 1.1 }}>
            Tue 28 Jul · Bangkok <span style={{ fontSize: 13, color: posterHeader ? '#fff' : 'var(--color-accent)' }}>▾</span>
          </div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', marginTop: 3, color: posterHeader ? 'rgba(255,255,255,.75)' : 'var(--color-neutral-600)' }}>
            SE ASIA LOOP · 3 CITIES · {nBookings} BOOKINGS
          </div>
        </div>
      </div>

      {/* tab bar */}
      <div role="tablist" style={{ display: 'flex', borderBottom: '2px solid var(--color-divider)' }}>
        <div {...pressable(() => store.set({ view: 'thread' }), 'tab')} aria-selected={view === 'thread'} style={segStyle(view === 'thread')}>THREAD</div>
        <div {...pressable(() => store.set({ view: 'plan' }), 'tab')} aria-selected={view === 'plan'} style={segStyle(view === 'plan')}>PLAN</div>
        <div {...pressable(() => store.set({ view: 'mem' }), 'tab')} aria-selected={view === 'mem'} style={segStyle(view === 'mem')}>MEMORY</div>
      </div>

      {view === 'thread' && <ThreadView />}
      {view === 'plan' && <PlanView />}
      {view === 'mem' && <MemoryView />}

      <VoiceOverlay />
      <NotifBanner />

      {/* sheet backdrop — mouse convenience only; keyboard users close sheets with Escape (root onKeyDown) */}
      <div
        aria-hidden="true"
        onClick={closeSheets}
        style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.4)', zIndex: 50, opacity: sheetOpen ? 1 : 0, pointerEvents: sheetOpen ? 'auto' : 'none', transition: 'opacity .3s' }}
      />

      <CalendarSheet />
      <ShareSheet />
      <WalletSheet />
      <PermissionDialog />
    </div>
  );
}
