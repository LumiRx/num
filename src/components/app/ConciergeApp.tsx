// The Num app screen — header, tab bar, views, sheets and overlays.
// Composition and z-layering match Concierge.dc.html exactly.
import type { KeyboardEvent } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { closeVoice } from '../../lib/concierge';
import { segStyle } from '../../lib/derive';
import { StarIcon, ShareIcon, ChevronDownIcon, MessageIcon, RouteIcon, SparklesIcon } from '../../lib/icons';
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
    <div onKeyDown={onEscape} style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}>
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
        <div {...pressable(() => store.set((s) => ({ calOpen: true, selDay: s.selDay || '7-28' })))} style={{ cursor: 'pointer', padding: '2px 16px 12px' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 21, fontWeight: 700, lineHeight: 1.1 }}>
            Tue 28 Jul · Bangkok <ChevronDownIcon size={15} style={{ color: posterHeader ? '#fff' : 'var(--color-accent)', verticalAlign: 'middle' }} />
          </div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', marginTop: 3, color: posterHeader ? 'rgba(255,255,255,.75)' : 'var(--color-neutral-600)' }}>
            SE ASIA LOOP · 3 CITIES · {nBookings} BOOKINGS
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
      <ShareSheet />
      <WalletSheet />
      <PermissionDialog />
    </div>
  );
}
