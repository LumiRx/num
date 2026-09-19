// The NUM app screen — header, tab bar, views, sheets and overlays.
// Composition and z-layering match Concierge.dc.html exactly.
import { useEffect } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { closeVoice } from '../../lib/concierge';
import { monthsFor, segStyle } from '../../lib/derive';
import { bootSocial, startPlanSync } from '../../lib/social';
import { startBookSync } from '../../lib/bookdesk';
import { startReminderSync } from '../../lib/reminders';
import { cardsOf } from '../../lib/invites';
import { bootDm, closeDmThread, refreshDmInbox, startDmSync } from '../../lib/dm';
import { restoreTab } from '../../lib/tabs';
import { serveIdentityToWorker } from '../../lib/push';
import { StarIcon, ShareIcon, ChevronDownIcon, MessageIcon, RouteIcon, SparklesIcon, XIcon, LayoutIcon, UserIcon, UsersIcon } from '../../lib/icons';
import { applyTheme } from '../../lib/themes';
import { applyTextSize } from '../../lib/textsize';
import ThreadView from './ThreadView';
import DashView from './DashView';
import ProfileView from './ProfileView';
import PlanView from './PlanView';
import MemoryView from './MemoryView';
import CalendarSheet from './CalendarSheet';
import ShareSheet from './ShareSheet';
import ShareToSheet from './ShareToSheet';
import WalletSheet from './WalletSheet';
import BusinessSheet from './BusinessSheet';
import ScoutSheet from './ScoutSheet';
import EventSheet from './EventSheet';
import PaySheet from './PaySheet';
import BillSheet from './BillSheet';
import { bootBill } from '../../lib/bill';
import { resumeResearch } from '../../lib/research';
import PassengerSheet from './PassengerSheet';
import TabSheet from './TabSheet';
import ErrandSheet from './ErrandSheet';
import DiscoverSheet from './DiscoverSheet';
import PlaceSheet from './PlaceSheet';
import FlightWatchSheet from './FlightWatchSheet';
import FeaturePage from './FeaturePage';
import EventDetailSheet from './EventDetailSheet';
import NightlifeSheet from './NightlifeSheet';
import BookSheet from './BookSheet';
import TravelSheet from './TravelSheet';
import InviteSheet from './InviteSheet';
import ResearchSheet from './ResearchSheet';
import PartySheet from './PartySheet';
import DmSheet from './DmSheet';
import { NotifBanner, PermissionDialog, VoiceOverlay } from './Overlays';
import InstallPrompt from './InstallPrompt';
import { fmtDate, loadLang, pickLang, t, useI18nTick } from '../../lib/i18n';

export default function ConciergeApp({ posterHeader = false, standalone = false }: { posterHeader?: boolean; standalone?: boolean }) {
  const view = useApp((s) => s.view);
  // The PLAN badge: invites and plans waiting on an answer, minus what this
  // phone has muted (InviteRail.cardsOf is the one definition of "waiting").
  const inviteCount = useApp((s) => (s.me ? cardsOf(s.inbox, s.mutedInvites ?? [], { newsToo: false }).length : 0));
  const stars = useApp((s) => s.stars);
  const planId = useApp((s) => s.planId);
  const nBookings = useApp((s) => s.bookings.filter((b) => b.status !== 'cancelled').length);
  const sheetOpen = useApp((s) => s.calOpen || s.shareOpen || s.walletOpen || s.partyOpen || s.eventOpen || s.businessOpen || !!s.payOpen || s.passengerOpen || !!s.inviteOpen || !!s.tabOpen || s.errandsOpen || !!s.discoverOpen || s.placeOpen || s.flightWatchOpen || !!s.featureOpen || !!s.eventView || s.nightlifeOpen);
  const party = useApp((s) => s.planMembers.length);
  const demo = useApp((s) => s.demo);
  const place = useApp((s) => s.place);
  const threadOpen = useApp((s) => s.threadOpen);
  const profileOpen = useApp((s) => s.profileOpen);
  const dmOpen = useApp((s) => s.dmOpen);
  const me = useApp((s) => s.me);
  const unread = useApp((s) => s.unread);
  const typing = useApp((s) => s.typing);
  // One number across every conversation — the header badge answers "does
  // anybody want me", and the per-person counts live inside.
  const dmUnread = useApp((s) => s.dmInbox.reduce((n, p) => n + p.unread, 0));

  // Demo: the scripted date/loop. Real: today anywhere on Earth, plus wherever
  // the user told NUM they are — or the ask, until they have.
  const today = fmtDate(new Date());
  const title = demo ? 'Tue 28 Jul · Bangkok' : place ? `${today} · ${place}` : `${today} · ${t('Where to?')}`;
  const subhead = demo
    ? `SE ASIA LOOP · 3 CITIES · ${nBookings} BOOKINGS`
    : place
      ? `${nBookings === 1 ? t('1 BOOKING') : t('{n} BOOKINGS', { n: nBookings })} · ${t('NUM IS ON IT')}`
      : t('TELL NUM WHERE YOU ARE');

  const closeSheets = () => store.set({ calOpen: false, shareOpen: false, walletOpen: false, partyOpen: false, eventOpen: false, businessOpen: false, inviteOpen: null, payOpen: null, passengerOpen: false, tabOpen: null, errandsOpen: false, discoverOpen: null, placeOpen: false, flightWatchOpen: false, featureOpen: null, eventView: null, nightlifeOpen: false });

  const overlayOpen = useApp((s) => s.calOpen || s.shareOpen || s.walletOpen || s.partyOpen || s.eventOpen || s.businessOpen || !!s.payOpen || s.passengerOpen || !!s.inviteOpen || !!s.tabOpen || s.errandsOpen || !!s.discoverOpen || s.placeOpen || s.flightWatchOpen || !!s.featureOpen || !!s.eventView || s.nightlifeOpen || s.researchOpen || s.voice > 0);

  // Pick up a referral/invite off the launch URL, then keep the shared plan in
  // step while the app is in the foreground — that polling loop is how the
  // other members' agents reach this one.
  useEffect(() => {
    // Before bootSocial: it strips the query string once it has read its own
    // params, so a `?dm=` arriving alongside a referral would be lost.
    bootDm();
    bootBill();
    // A research run outlives the app: it takes a minute, the guest may close
    // NUM, and a push brings them back. Picking the watch up on boot is what
    // makes "you can close this" true rather than a promise.
    resumeResearch();
    bootSocial();
    void restoreTab();
    void refreshDmInbox();
    // A push wakes the service worker, which has no localStorage — it asks the
    // page who is signed in, and this answers.
    serveIdentityToWorker();
    const stopPlan = startPlanSync();
    const stopDm = startDmSync();
    // A venue's CONFIRM lands on the diary and in the thread whichever screen
    // is open — not only while the booking sheet is (lib/bookdesk.ts).
    const stopBook = startBookSync(45_000);
    // A reminder said to NUM lands in the thread at its hour while the app is
    // open, and on the calendar meanwhile (lib/reminders.ts).
    const stopRem = startReminderSync(45_000);
    return () => {
      stopPlan();
      stopDm();
      stopBook();
      stopRem();
    };
  }, []);

  // The theme is persisted state, so it has to be re-applied to <html> on every
  // launch — the attribute itself does not survive a reload.
  const theme = useApp((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  // Same again for text size (lib/textsize.ts): a data-text attribute that
  // glass.css turns into a zoom on .num-root below.
  const textSize = useApp((s) => s.textSize);
  useEffect(() => {
    applyTextSize(textSize);
  }, [textSize]);

  // The reader's language: chosen in Profile, else the phone's. The map
  // arrives (from cache, then the network) and the tree below re-keys, so
  // every t() reads the new map without each component subscribing.
  const i18nTick = useI18nTick();
  useEffect(() => { void loadLang(pickLang()); }, []);

  // The system back button/gesture must close what's open, never quit the
  // app: opening an overlay pushes one history entry; popping it (Android
  // back, iOS edge-swipe, browser back) closes the overlay. If the overlay
  // is closed some other way (X, backdrop, Escape), the entry is consumed
  // silently so the next back-press behaves normally.
  useEffect(() => {
    if (!overlayOpen) return;
    // LET GO OF THE FIELD FIRST (18 Sep 2026).
    //
    // App.tsx publishes the keyboard height as --kb and the shell absorbs it,
    // so a sheet's maxHeight is a percentage of what is left ABOVE the
    // keyboard. Open a sheet while a text field still holds focus and that
    // ceiling is computed against a shrunken shell: the sheet arrives with no
    // visible height and the tap looks like it did nothing. It was reported
    // twice in one morning — Enter in the composer, then "Surprise me" — and
    // both were the same arithmetic, so the blur belongs here, once, for
    // every sheet rather than on each door that remembers.
    try {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) el.blur();
    } catch { /* no document: tests */ }
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
      store.set({ calOpen: false, shareOpen: false, walletOpen: false, partyOpen: false, eventOpen: false, businessOpen: false, inviteOpen: null, payOpen: null, passengerOpen: false, tabOpen: null, errandsOpen: false, discoverOpen: null, placeOpen: false, flightWatchOpen: false, featureOpen: null, eventView: null, nightlifeOpen: false });
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
    if (s.calOpen || s.shareOpen || s.walletOpen || s.partyOpen || s.eventOpen || s.businessOpen || s.inviteOpen || s.payOpen || s.passengerOpen || s.tabOpen || s.errandsOpen || s.discoverOpen || s.placeOpen || s.flightWatchOpen || s.featureOpen || s.eventView || s.nightlifeOpen) closeSheets();
    // Messages are two levels deep: Escape backs out of the conversation
    // first, and only closes the surface once you are on the people list.
    else if (s.dmWith) closeDmThread();
    else if (s.dmOpen) store.set({ dmOpen: false });
    else if (s.profileOpen) store.set({ profileOpen: false });
    else if (s.threadOpen) store.set({ threadOpen: false });
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
    <div key={i18nTick} className="num-root" onKeyDown={onEscape} onScroll={holdFrame} style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}>
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
          <div style={{ fontSize: 11, letterSpacing: '.16em', fontWeight: 700, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>NUM{' '}<span style={{ fontWeight: 400, opacity: 0.55 }}>· TEXT IT. IT’S BOOKED.</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {me && <div
              {...pressable(() => store.set({ walletOpen: true }))}
              aria-label={t('Stars wallet')}
              className="glass press"
              style={{ cursor: 'pointer', borderRadius: 999, padding: '5px 10px', display: 'flex', gap: 5, alignItems: 'center', fontWeight: 700, fontSize: 11 }}
              title={t('Stars wallet')}
            >
              <StarIcon size={13} /> {stars.toLocaleString()}
            </div>}
            {/* Messages sit beside YOU, not in the tab bar and not behind the
                dot. The dot is NUM; this is other people, and conflating the
                two would make "who am I talking to" a question. Hidden until
                there is an account, since there is nobody to message without
                one. */}
            {me && (
              <div
                {...pressable(() => store.set({ dmOpen: true, dmWith: null, dmThread: [] }))}
                aria-label={dmUnread ? `Messages, ${dmUnread} new` : t('Messages')}
                className="glass press"
                style={{ cursor: 'pointer', width: 32, height: 32, borderRadius: 999, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                title={t('Messages')}
              >
                <UsersIcon size={15} />
                {dmUnread > 0 && (
                  <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {dmUnread}
                  </span>
                )}
              </div>
            )}
            {/* ── THE WORD "SIGN IN", WHERE A STRANGER LOOKS FOR IT ──────────
                App Review rejected build 1.0(8) on Guideline 2.1 with one
                question: "Where is the sign-in page?" They reviewed on an
                iPad Air and they were right to ask. A search of the whole
                rendered app for "sign in", "log in", "sign up" or "account"
                returned exactly one match — "SET UP MY ACCOUNT" — inside a
                sheet that was closed. Nothing on screen used the words.

                Ask-first is still the product: 0.8.323 deliberately stopped
                forcing the account sheet on launch, and the concierge is
                fully usable without an account. But "don't force it" was
                turned into "don't mention it", and every door we did have was
                labelled in our own voice — INTRODUCE YOURSELF, SET UP MY
                ACCOUNT, Tell NUM who I am — none of which is the phrase a
                person scanning for a way in is looking for.

                So when there is no account, the header says Sign in, in those
                words, and goes straight to the sheet that carries Sign in
                with Apple and the phone code. It replaces the anonymous
                avatar circle rather than sitting beside it, because two ways
                in is the same problem wearing a hat. */}
            {!me && (
              <div
                {...pressable(() => store.set({ inviteOpen: {} }))}
                aria-label={t('Sign in')}
                className="glass press"
                style={{
                  // 44px, not the 30px this first shipped as — caught by
                  // taptargets.test.mjs. Apple's own HIG puts the floor at
                  // 44pt, and the one control App Review is looking for is a
                  // poor place to be under it.
                  cursor: 'pointer', borderRadius: 999, padding: '0 16px', minHeight: 44,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 11.5, letterSpacing: '.06em', whiteSpace: 'nowrap',
                }}
                title={t('Sign in')}
              >
                {t('Sign in')}
              </div>
            )}
            {/* YOU sits here rather than in the tab bar: it is a place you visit
                occasionally, not one of the three things the app is for. */}
            {me && <div
              {...pressable(() => store.set({ profileOpen: true }))}
              aria-label={t('Your profile')}
              className="glass press"
              style={{
                cursor: 'pointer', width: 32, height: 32, borderRadius: 999, position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                background: me?.avatar ? `center/cover url(${me.avatar})` : undefined,
              }}
              title={t('Your profile')}
            >
              {!me?.avatar && (me?.name ? (
                <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 13 }}>{me.name[0].toUpperCase()}</span>
              ) : (
                <UserIcon size={15} />
              ))}
              {party > 1 && (
                <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {party}
                </span>
              )}
            </div>}
            {planId && <div
              {...pressable(() => store.set({ shareOpen: true, copied: false }))}
              aria-label={t('Share plan')}
              className="glass press"
              style={{ cursor: 'pointer', width: 32, height: 32, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title={t('Share plan')}
            >
              <ShareIcon size={15} />
            </div>}
          </div>
        </div>
        {/* "Where to?" opens the place sheet; a known place opens the calendar.
            The chevron used to open the calendar in both cases, so the one
            control a first-timer needed (say where you are) did not exist
            (audit B3, 17 Sep). */}
        <div {...pressable(() => { if (!store.get().place && !store.get().demo) { store.set({ placeOpen: true }); return; } store.set((s) => { const M = monthsFor(s.demo)[0]; return { calOpen: true, selDay: s.selDay || `${M.mo}-${M.todayDay ?? 1}` }; }); })} style={{ cursor: 'pointer', padding: '2px 16px 12px' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: title.length > 26 ? 18 : 21, fontWeight: 700, lineHeight: 1.1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span> <ChevronDownIcon size={15} style={{ flex: 'none', color: posterHeader ? '#fff' : 'var(--color-accent)', verticalAlign: 'middle' }} />
          </div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', marginTop: 3, color: posterHeader ? 'var(--field-bg)' : 'var(--color-neutral-600)' }}>
            {subhead}
          </div>
        </div>
      </div>

      {/* tab bar — floating glass segmented control */}
      {/* THREAD left the tab bar — it is the floating dot now, reachable from
          every screen instead of being one of three equal places to be. */}
      <div role="tablist" className="glass" style={{ display: 'flex', margin: '10px 10px 2px', borderRadius: 999, padding: 4, position: 'relative', zIndex: 2 }}>
        <div {...pressable(() => store.set({ view: 'dash' }), 'tab')} aria-selected={view === 'dash'} style={segStyle(view === 'dash')}><LayoutIcon size={13} />{t('TODAY')}</div>
        <div {...pressable(() => store.set({ view: 'plan' }), 'tab')} aria-selected={view === 'plan'} style={{ ...segStyle(view === 'plan'), position: 'relative' }}>
          <RouteIcon size={13} />{t('PLAN')}
          {/* Open invites and plans that need your answer — the count on the
              rail at the top of PLAN, so it can be seen from any tab. */}
          {inviteCount > 0 && (
            <span aria-label={t('{n} waiting on you', { n: inviteCount })} style={{ position: 'absolute', top: 4, right: 8, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: view === 'plan' ? '#fff' : 'var(--grad-accent)', color: view === 'plan' ? 'var(--color-accent-700)' : '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{inviteCount}</span>
          )}
        </div>
        <div {...pressable(() => store.set({ view: 'mem' }), 'tab')} aria-selected={view === 'mem'} style={segStyle(view === 'mem')}><SparklesIcon size={13} />{t('MEMORY')}</div>
      </div>

      {/* views float above the aurora ground; wrapper mirrors the root's flex column */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        {/* Keyed on the view so a tab change remounts this wrapper and the new
            screen rises in (320ms, 12px) instead of blinking into place. The
            wrapper mirrors the flex column above so nothing inside reflows. */}
        <div key={view} className="rise-in" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {view === 'dash' && <DashView />}
          {view === 'plan' && <PlanView />}
          {view === 'mem' && <MemoryView />}
        </div>
      </div>

      {/* The thread, as a sheet over whatever you were looking at. It keeps the
          conversation one tap from everywhere instead of a place you navigate
          to and lose your place from. */}
      <div
        role="dialog"
        aria-label={t('Thread with NUM')}
        aria-hidden={!threadOpen}
        style={{
          position: 'absolute', inset: 0, zIndex: 45, display: 'flex', flexDirection: 'column',
          background: 'var(--color-bg, #faf7f4)',
          visibility: threadOpen ? 'visible' : 'hidden',
          transform: threadOpen ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform .34s cubic-bezier(.32,.72,.29,.99), visibility .34s',
        }}
      >
        <div className="aurora-layer" aria-hidden="true" />
        {/* THE SAFE AREA IS NOT OPTIONAL HERE.
            This header had a flat `padding: '12px ...'` while the profile
            header two blocks down already used
            `max(env(safe-area-inset-top), 12px)`. On any iPhone with a notch
            or Dynamic Island that put the close button up under the status
            bar, where the thumb has to reach past the top edge of the screen
            to hit it — Dre, 9 Sep 2026: "the x is to high its hard to push
            with the top of the phone".
            Every full-screen overlay in this file must use the same padding
            expression. If you add another, copy this line. */}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'max(env(safe-area-inset-top), 12px) 16px 6px' }}>
          <div style={{ fontSize: 11, letterSpacing: '.16em', fontWeight: 800, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('THREAD')}{' '}<span style={{ fontWeight: 400, opacity: 0.5 }}>· {t('ASK ANYTHING')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* ── AND HERE, BECAUSE THIS IS THE SCREEN THE APP OPENS ON ─────
                The app's own header carries a Sign in button, and for three
                App Store reviews running it may as well not have existed: the
                default state of this app is `threadOpen: true`, and this
                panel is position:absolute at z-index 45 directly over that
                header. Measured on the iPad Air App Review used,
                document.elementFromPoint on the centre of the Sign in button
                returned this panel, in both orientations.

                That is the whole of it. Build 2 was rejected for Sign in with
                Apple and Delete My Account being unreachable — both live on
                Profile, which is reached from the header. Build 8 was
                rejected with "Where is the sign-in page?". Three findings,
                one cause: nobody could see the top of the app, because the
                product opens on top of it.

                Fixing the default would be the other repair, and it is the
                wrong one — opening on the thread is deliberate and correct,
                the thread IS the product. So the door appears on whichever
                surface is in front. */}
            {!me && (
              <div
                {...pressable(() => store.set({ inviteOpen: {} }))}
                aria-label={t('Sign in')}
                className="glass press"
                style={{
                  cursor: 'pointer', borderRadius: 999, padding: '0 16px', minHeight: 44,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 11.5, letterSpacing: '.06em', whiteSpace: 'nowrap',
                }}
                title={t('Sign in')}
              >
                {t('Sign in')}
              </div>
            )}
            <div
              {...pressable(() => store.set({ threadOpen: false }))}
              aria-label={t('Close thread')}
              className="glass press"
              style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <XIcon size={15} />
            </div>
          </div>
        </div>
        {/* Mounted only while open: the thread auto-scrolls on every state
            change, and doing that behind a closed overlay is wasted work. */}
        {threadOpen && <ThreadView />}
      </div>

      {/* YOU — a full overlay, because it is a long form and a sheet would
          spend half the screen on the sheet's own chrome. */}
      <div
        role="dialog"
        aria-label={t('Your profile')}
        aria-hidden={!profileOpen}
        style={{
          position: 'absolute', inset: 0, zIndex: 46, display: 'flex', flexDirection: 'column',
          background: 'var(--color-bg, #faf7f4)',
          visibility: profileOpen ? 'visible' : 'hidden',
          transform: profileOpen ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform .34s cubic-bezier(.32,.72,.29,.99), visibility .34s',
        }}
      >
        <div className="aurora-layer" aria-hidden="true" />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'max(env(safe-area-inset-top), 12px) 16px 6px' }}>
          <div style={{ fontSize: 11, letterSpacing: '.16em', fontWeight: 800 }}>{t('YOU')}{' '}<span style={{ fontWeight: 400, opacity: 0.5 }}>· WHAT NUM KNOWS</span>
          </div>
          <div
            {...pressable(() => store.set({ profileOpen: false }))}
            aria-label={t('Close profile')}
            className="glass press"
            style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <XIcon size={15} />
          </div>
        </div>
        {profileOpen && <ProfileView />}
      </div>

      <DmSheet />

      {/* the dot */}
      {!threadOpen && !profileOpen && !dmOpen && (
        <div
          {...pressable(() => store.set({ threadOpen: true, unread: 0 }))}
          aria-label={unread ? `Open thread, ${unread} new` : t('Open thread')}
          className="press rise-in glow"
          style={{
            position: 'absolute', right: 16, bottom: 'max(env(safe-area-inset-bottom), 16px)', zIndex: 40,
            height: 54, padding: '0 20px 0 16px', borderRadius: 999, cursor: 'pointer',
            background: 'var(--grad-accent)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14, letterSpacing: '.01em',
          }}
        >
          <MessageIcon size={20} />
          <span>{t('Ask NUM')}</span>
          {(unread > 0 || typing) && (
            <span
              style={{
                position: 'absolute', top: 2, right: 2, minWidth: 18, height: 18, padding: '0 4px', borderRadius: 999,
                background: '#fff', color: 'var(--color-accent)', fontSize: 10, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.18)',
              }}
            >
              {typing ? '…' : unread}
            </span>
          )}
        </div>
      )}

      <VoiceOverlay />
      <NotifBanner />

      {/* "Put NUM on your home screen" — on the surface that can actually do
          it. `standalone` here means "this IS the app screen", which is the
          phone path; the desktop launch page renders its own copy alongside
          the marketing frame, so gating on it avoids two cards at once.
          InstallPrompt itself still refuses to appear inside the native build
          or an already-installed PWA, so this cannot nag someone who is done.
          It is held back while a SHEET is up — the name gate is one of them,
          and covering the question we most need answered would trade a signup
          for an install, which is a bad trade in both directions.

          It is NOT held back for the thread. The thread is where people
          actually live in this app; suppressing there would mean suppressing
          almost always, which is the bug this mount exists to fix. The card
          sits at z-60, above the thread's z-45, lifted clear of both the
          composer and the floating dot. */}
      {standalone && (
        <InstallPrompt
          anchor="absolute"
          lift={78}
          suppressed={overlayOpen || profileOpen || dmOpen}
        />
      )}

      {/* sheet backdrop — mouse convenience only; keyboard users close sheets with Escape (root onKeyDown) */}
      <div
        aria-hidden="true"
        onClick={closeSheets}
        style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.35)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 50, opacity: sheetOpen ? 1 : 0, pointerEvents: sheetOpen ? 'auto' : 'none', transition: 'opacity .3s' }}
      />

      <CalendarSheet />
      <PartySheet />
      <EventSheet />
      <BusinessSheet />
      <ScoutSheet />
      <PaySheet />
      <BillSheet />
      <PassengerSheet />
      <TabSheet />
      <ErrandSheet />
      <DiscoverSheet />
      <PlaceSheet />
      <FlightWatchSheet />
      <FeaturePage />
      <EventDetailSheet />
      <NightlifeSheet />
      <BookSheet />
      <TravelSheet />
      <InviteSheet />
      <ResearchSheet />
      <ShareSheet />
      {/* Mounted after ShareSheet on purpose: the two can both be open in a
          confused moment, and this one is the more specific answer. */}
      <ShareToSheet />
      <WalletSheet />
      <PermissionDialog />
    </div>
  );
}
