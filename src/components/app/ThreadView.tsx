// THREAD tab — the conversation: messages, cards, typing dots, chips, input bar.
import PickCards from './PickCards';
import { PairHandoff } from './PairBridge';
import { useEffect, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { apiUrl } from '../../lib/apibase';
import {
  bookHandoff, checkOffer, duration, heldFor, legWindow, offerSummary, stillValid, stopsLabel,
  type BookHandoff, type FlightOffer,
} from '../../lib/flights';
import { openShareCard } from '../../lib/sharecard';
import { pressable } from '../../lib/a11y';
import { useStickyBottom } from '../../lib/stickyscroll';
import { tagOf } from '../../lib/derive';
import { askNum, cleanText, sendChip, openVoice } from '../../lib/concierge';
import { openPlan } from '../../lib/social';
import { openDiscover } from '../../lib/discover';
import FlightCard from './FlightCard';
import FlightTray from './FlightTray';
import { refreshFlights } from '../../lib/flightwatch';
import { isSaved, saveOffer } from '../../lib/savedflights';
import { MicIcon, SendIcon, SparklesIcon, XIcon } from '../../lib/icons';
import { Scene } from '../../lib/scenes';
import { REACTIONS, react } from '../../lib/prefs';
import { KIND_LABEL, dismissService, openService } from '../../lib/services';
import type { Msg } from '../../lib/types';
import { T, t, currentLang } from '../../lib/i18n';
import { BANNER } from '../../lib/outage';
import { dropKeyboard, gateOpen, mayAsk } from '../../lib/gate';
import { canOfferSubscription } from '../../lib/native';
import { openPlans, shouldNudge, useTier } from '../../lib/tier';

/** A fare card action: tall enough for a thumb, calm enough to sit three abreast. */
const fareBtn: React.CSSProperties = {
  cursor: 'pointer', minHeight: 40, borderRadius: 999, padding: '0 10px', display: 'grid', placeItems: 'center',
  fontSize: 12, fontWeight: 700, letterSpacing: '.02em',
  background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)',
};

/** One starter chip, shared by the fixed pair and the destination's own. */
const starterChip: React.CSSProperties = {
  // 40px in a 44px row: a thumb-sized chip that still reads as a chip.
  cursor: 'pointer', borderRadius: 999, padding: '0 14px', minHeight: 40, fontSize: 12, fontWeight: 600, flex: 'none',
  display: 'flex', alignItems: 'center', whiteSpace: 'nowrap',
};

/**
 * Emoji reactions. They rate the *suggestion*, not the message — 😍 means find
 * more like this, 👎 means never offer it again, 🥱 means the answer was too
 * long. It is the cheapest possible feedback channel, which is why people
 * actually use it, and it is what teaches NUM this user's taste.
 */
function Reactions({ index, subject }: { index: number; subject: string }) {
  const chosen = useApp((s) => s.reactions[index]);
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
      {REACTIONS.map((r) => {
        const on = chosen === r.id;
        return (
          <span
            key={r.id}
            {...pressable(() => react(index, r.id, subject))}
            aria-label={r.label}
            aria-pressed={on}
            title={r.label}
            className="press"
            style={{
              cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '5px 7px', borderRadius: 999,
              background: on ? 'var(--grad-accent)' : 'var(--field-bg)',
              border: '1px solid ' + (on ? 'transparent' : 'var(--ink-08)'),
              filter: chosen && !on ? 'grayscale(1) opacity(.45)' : 'none',
              transition: 'filter .2s, background .2s',
            }}
          >
            {r.emoji}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The hand-off tray. NUM has no account with Uber or Grab yet, so it does not
 * pretend to have ordered — it picks the right app for this country and opens
 * it prefilled. One tap, and the honesty is the feature.
 */

function ServiceTray() {
  const h = useApp((s) => s.handoff);
  if (!h) return null;
  return (
    /* Capped for the same reason as the fares tray above: `note` is free text
       from the server and the options row is however many the handoff has.
       Smaller cap because this one is a prompt, not a list to compare. */
    <div
      className="glass"
      style={{
        margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '10px 12px',
        maxHeight: 'var(--tray-max-service)', overflowY: 'auto',
        overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
          {KIND_LABEL[h.kind].toUpperCase()}
        </div>
        <span {...pressable(dismissService)} aria-label={t('Dismiss')} style={{ cursor: 'pointer', color: 'var(--ink-40)' }}>
          <XIcon size={13} />
        </span>
      </div>
      {h.note && <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.45 }}>{h.note}</div>}
      <div className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', marginTop: 8 }}>
        {h.options.map((o) => (
          <div
            key={o.id}
            {...pressable(() => openService(o))}
            className="press"
            style={{
              cursor: 'pointer', flex: 'none', borderRadius: 999, padding: '9px 14px', fontSize: 11.5, fontWeight: 700,
              background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 3px 10px var(--accent-30)',
              display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap',
            }}
          >
            {o.name}
            {o.note && <span style={{ fontWeight: 500, opacity: 0.8 }}>· {o.note}</span>}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 7, lineHeight: 1.5 }}>
        {h.mode === 'connected'
          ? 'NUM completes this for you.'
          : 'Opens in your own app with the destination already filled in — NUM can’t place it for you yet.'}
      </div>
    </div>
  );
}

/**
 * One quiet line under a landed booking. Renders nothing until the tier is
 * known (so a Plus member never sees it flash), nothing on a paid tier, and
 * nothing at all on iOS. Tapping opens the wallet, where the plan ladder lives.
 */
function UpgradeNudge() {
  const tier = useTier();
  if (!shouldNudge(tier, canOfferSubscription())) return null;
  return (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.35 }}>
      {/* Literals, not the constants: the i18n catalogue scanner only sees
          t('…'). tier.test.mjs pins these to NUDGE / NUDGE_CTA in tier.ts. */}
      <span style={{ flex: 1, minWidth: 0 }}>{t('Want more room? Plus and Pro lift the ceilings.')}</span>
      <button
        type="button"
        {...pressable(openPlans)}
        aria-label={t('See plans')}
        style={{
          cursor: 'pointer', flex: '0 0 auto', minHeight: 32, padding: '0 12px', borderRadius: 999,
          background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)',
          fontSize: 11.5, fontWeight: 700, letterSpacing: '.02em', fontFamily: 'inherit',
        }}
      >
        {t('See plans')}
      </button>
    </div>
  );
}

function MsgBubble({ m, index, rateable, continues }: { m: Msg; index: number; rateable: boolean; continues?: boolean }) {
  const u = m.who === 'u';
  const ct = m.card ? tagOf(m.card.tag) : null;
  // A bubble that is only a grid of places goes edge to edge of the column:
  // two picture cards need the width, and a glass frame around a glass grid
  // is a frame around a frame.
  const gridOnly = !u && !!m.picks?.length && !cleanText(m.text).trim() && !m.card;
  return (
    // The parts of one turn sit close (continues): they are one answer, not
    // three. The 10px the list gives every bubble drops to 4 between them.
    <div className="msg-in" style={{ display: 'flex', justifyContent: u ? 'flex-end' : 'flex-start', padding: '0 16px', marginTop: continues ? -6 : undefined }}>
      <div
        className={u || gridOnly ? undefined : 'glass'}
        style={gridOnly ? { width: '100%', maxWidth: '100%' } : {
          // 13px was set for density; this is a READING surface. NUM's replies
          // run several sentences, often on a phone, often outdoors, often by
          // someone tired at the end of a travel day. 15.5/1.62 is the size
          // people actually read prose at — the extra millimetre costs a line
          // of scroll and buys not squinting.
          // A bubble carrying place cards takes the column: two picture cards
          // in 84% of a phone are two thumbnails with three-word names.
          maxWidth: m.picks?.length ? '100%' : '84%', fontSize: 15.5, lineHeight: 1.62, padding: '12px 15px',
          fontFamily: 'var(--font-read)',
          letterSpacing: '.005em',
          borderRadius: 18,
          ...(u
            ? { borderBottomRightRadius: 6, background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 4px 14px var(--accent-30)' }
            : { borderBottomLeftRadius: 6, color: 'var(--ink)' }),
        }}
      >
        {gridOnly ? null : <div style={{ whiteSpace: 'pre-line' }}>{u ? m.text : t(cleanText(m.text))}</div>}
        {/* Recommended places, each with a real link. Rendered as cards rather
            than prose since 3 Sep 2026 — see PickCards.tsx for why. */}
        {!u && m.picks?.length ? <PickCards picks={m.picks} msgIndex={index} /> : null}
        {m.card && ct && (
          <div
            {...pressable(() => {
              // A card in the thread is a doorway, not a picture. If a group
              // plan is live, tapping lands on the shared plan screen — items,
              // votes, and the group chat — which is where "we can all look
              // at it" actually happens.
              const pid = store.get().planId ?? store.get().plans[0]?.id ?? null;
              if (pid) { void openPlan(pid); store.set({ partyOpen: true }); }
            })}
            style={{
              cursor: 'pointer',
              marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 11, padding: 10,
              background: 'var(--field-bg)', border: '1px solid var(--ink-08)',
              borderRadius: 'var(--r-md)', boxShadow: '0 4px 12px var(--ink-08)', color: 'var(--ink)',
            }}
          >
            {/* A real venue photo earns more room than the icon fallback does. */}
            <Scene title={m.card.title} size={m.card.photo ? 58 : 42} photo={m.card.photo} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.25 }}>{m.card.title}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>{m.card.meta}</div>
              {/* The status pill sits under the text so it never squeezes the title. */}
              {/* A landed booking's pill pops once — the one moment in the
                  thread that deserves a flourish. Every other status sits still. */}
              <span className={m.card.tag === 'confirmed' ? 'check-pop' : undefined} style={{ ...ct.st, display: 'inline-flex', marginTop: 7 }}>{ct.label}</span>
            </div>
          </div>
        )}
        {/* The moment after a booking lands is the one honest place to mention
            the paid plans: the member just saw NUM do the thing. It is one
            line, free tier only, and never on iOS (canOfferSubscription is the
            single gate — see native.ts). It promises nothing about fees or
            travel perks; the plan sheet states what the tiers actually are. */}
        {!u && m.card && (m.card.tag === 'confirmed' || m.card.tag === 'hold' || m.card.tag === 'deposit') && (
          <UpgradeNudge />
        )}
        {/* Only NUM's own suggestions are rateable. Rating your own message is
            nonsense; rating an acknowledgement is noise; and rating the
            onboarding questions — which is what a pure length test did — makes
            the app look like it wants applause for saying hello. */}
        {!u && rateable && (
          <Reactions index={index} subject={m.card?.title ?? cleanText(m.text).slice(0, 70)} />
        )}
      </div>
    </div>
  );
}

// Live-mode capability discovery — a strip of starters above the chips.
//
// These used to be ten hard-coded prompts, identical in every city: "Club
// table" and "Check crypto" shipped to a guest in a town with neither. A
// suggestion that cannot be fulfilled is worse than no suggestion, because it
// is the first thing a new guest taps and the next screen breaks the promise.
//
// The list now comes from /api/suggest, which derives it from the places the
// directory actually holds in this destination (worker/suggest.mjs). It costs
// one indexed read and no tokens, and it self-populates: a new city starts
// offering coffee the moment its cafés land, with no deploy.
//
// FALLBACK stays here deliberately. A guest whose network drops, or whose
// destination is not known yet, must still see what NUM can do — an empty
// strip teaches a brand-new user that NUM does nothing. Every line in it is a
// capability that is true everywhere, independent of any local directory.
type Starter = { emoji: string; label: string; prompt: string };

const FALLBACK: Starter[] = [
  { emoji: '🚗', label: T('Car to the airport'), prompt: 'Get me a car to the airport tomorrow morning' },
  { emoji: '🍽️', label: T('Dinner tonight'), prompt: 'Where should we eat tonight?' },
  { emoji: '✈️', label: T('Find a flight'), prompt: 'What flights are there to Bangkok on Friday?' },
  { emoji: '🧳', label: T('Plan with friends'), prompt: 'Start a group plan I can build with my friends' },
];

/**
 * The starters for wherever the guest is, plus the one rotating line that
 * shows off something they have not tried.
 *
 * Never throws and never blocks the thread: on any failure the guest keeps the
 * universal fallback, which is a worse strip and a working app.
 */
function useSuggestions(dest: string | null, meId: string | null) {
  const [starters, setStarters] = useState<Starter[]>(FALLBACK);
  const [rotating, setRotating] = useState<string | null>(null);
  // NUM speaking first: one line about what THIS member has coming up, from
  // worker/briefing.mjs. Null for guests and for members with nothing dated.
  const [briefing, setBriefing] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      const q = new URLSearchParams();
      if (dest) q.set('dest', dest);
      if (currentLang() !== 'en') q.set('lang', currentLang());
      if (meId) {
        q.set('me', meId);
        try { q.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* server default */ }
      }
      const qs = q.toString();
      fetch(apiUrl(`/api/suggest${qs ? `?${qs}` : ''}`))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!live || !j) return;
          if (Array.isArray(j.starters) && j.starters.length) setStarters(j.starters);
          setRotating(typeof j.rotating === 'string' ? j.rotating : null);
          setBriefing(typeof j.briefing === 'string' && j.briefing ? j.briefing : null);
        })
        .catch(() => { /* the fallback is already on screen */ });
    };
    load();
    // The server rotates its showcase line on a 90s window; re-reading on the
    // same cadence is what makes the line feel alive without any client state.
    const t = setInterval(load, 90_000);
    return () => { live = false; clearInterval(t); };
  }, [dest, meId]);

  return { starters, rotating, briefing };
}

/**
 * The typing pill, with something to read once the wait is real. Dots alone
 * say "working"; after four seconds a person wants to know on what, and
 * after twelve they want to know it has not died. The lines are about the
 * checking NUM does — real places, real listings — because that is what the
 * time is for, and saying so is the difference between slow and careful.
 */
function Thinking() {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  // The server's own first line for this turn — "Looking at Sukhumvit for
  // you…" — arrives inside a second (worker/ack.mjs) and outranks the timed
  // lines until the wait is long enough that "still on it" matters more.
  const ack = useApp((s) => s.thinkingLine);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const secs = (now - since) / 1000;
  const line = secs >= 12 ? t('Still on it — checking the real listings, not guessing.')
    : ack ? ack
    : secs >= 4 ? t('Checking places that are actually open…')
    : null;
  return (
    <div className="msg-in" style={{ padding: '0 16px', display: 'grid', gap: 6, justifyItems: 'start' }}>
      <div className="glass thinking" style={{ display: 'inline-flex', gap: 5, borderRadius: 999, padding: '10px 14px' }}>
        {[0, 0.18, 0.36].map((d) => (
          <span key={d} style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-text)', animation: `tdot 1.1s ${d}s infinite` }} />
        ))}
      </div>
      {line && <div className="rise-in" style={{ fontSize: 11.5, color: 'var(--ink-40)', paddingLeft: 4 }}>{line}</div>}
    </div>
  );
}

export default function ThreadView() {
  // Whole-state subscription on purpose: the thread has to redraw for sheets,
  // notifications and chips, not only for new messages.
  //
  // ── WHAT THAT COST, AND THE BUG IT CAUSED ─────────────────────────────
  // 13 Sep 2026: "we had someone looking at flights and the screen got stuck
  // scrolling." It was not stuck. It was being dragged.
  //
  // This subscription redraws on ANY store change anywhere in the app, and
  // the effect below used to be `useEffect(() => { el.scrollTop =
  // el.scrollHeight; })` — no dependency array, so it ran after every one of
  // those redraws and slammed the thread to the bottom each time.
  //
  // NUM polls constantly: the booking desk every 15s, errands every 15s, the
  // party plan every 8s, suggestions every 90s, DMs, autoupdate. So somebody
  // reading a list of flight fares — a tall block, several offers, exactly the
  // thing you scroll back through to compare — was thrown to the bottom every
  // few seconds by a timer that had nothing to do with them.
  //
  // The fix is the standard one and it is about intent: follow the bottom
  // only while the reader is ALREADY there. The moment they scroll up they
  // have said "I am reading this", and nothing may move them until they ask.
  const { msgs, typing, chips, demo, place, me, outage } = useApp((s) => s);
  const flights = useApp((s) => s.flights);
  useEffect(() => { if (me) void refreshFlights(); }, [me]);
  // One implementation, shared with DmSheet — see src/lib/stickyscroll.ts for
  // the flight-results bug that produced it.
  const { ref: scrollRef, onScroll, behind, toLatest } = useStickyBottom<HTMLDivElement>();
  const [draft, setDraft] = useState('');
  // The DISPLAY name is all the app has ever held; the server resolves it to
  // a destination (worker/suggest.mjs resolveDest). Reading a `.slug` off this
  // string here is the bug that would have made this feature look alive while
  // always serving the generic fallback.
  const { starters, rotating, briefing } = useSuggestions(place ?? null, me?.id ?? null);

  const send = () => {
    const text = draft.trim();
    // `typing` from render can be one tick stale; the store cannot. Clearing
    // the composer for a send that askNum will then refuse destroys the
    // guest's words with nothing on screen to show for it.
    if (!text || store.get().typing) return;
    // NOT REACHABLE YET → the words stay in the box (18 Sep 2026).
    //
    // askNum would hold this text and replay it after verifying, which is
    // right for a starter chip or a feature page, where there is nothing on
    // screen to keep. Here there IS: clearing the composer and popping a
    // sheet takes a person's sentence away and asks them to trust that it
    // came back. Leaving it in the box, behind the sheet they are about to
    // fill in, is the version that needs no trust — and one more tap sends
    // exactly what they can still see.
    // mayAsk, not canSend: the first answer is free, so an unproved stranger
    // with a question still unspent goes straight through to NUM.
    if (!mayAsk()) { dropKeyboard(); store.set({ inviteOpen: {} }); return; }
    setDraft('');
    void askNum(text);
  };

  return (
    <>
      {/* A friend's link opened here with no account yet. The browser opens
          straight into the thread, so the card has to live HERE, and above
          the scroll, not in it: the thread sticks to its newest message and
          would slide the button out of sight. Shown only on the landing page
          behind the thread, it was invisible, and "it took me into the chat
          and never added them" was the result (21 Sep 2026). */}
      <div style={{ flex: 'none' }}><PairHandoff /></div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="no-scrollbar"
        style={{
          flex: 1, overflowY: 'auto', padding: '16px 0 8px',
          display: 'flex', flexDirection: 'column', gap: 10,
          // Keeps a flick inside the thread instead of handing it to the page
          // behind, which on iOS is what makes a scroll feel like it "catches".
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {/* ── WHEN IT IS OURS, SAY SO AT THE TOP ────────────────────────
            A guest whose question just failed will retype it. If the fault
            is ours they will retype it into the same wall, and the only
            thing they can change is their network — so they change their
            network, on roaming data, in a city they do not know. This sits
            above the thread so the answer is there before the second try.
            Shown ONLY for the two states we can actually stand behind
            (lib/outage.ts BANNER); `unreachable` gets no banner, because a
            banner asserting an outage we cannot prove is the same lie
            pointing the other way. */}
        {outage && BANNER[outage] && (
          <div
            role="status"
            className="glass"
            style={{
              margin: '0 12px 4px', borderRadius: 14, padding: '10px 13px',
              fontSize: 12.5, lineHeight: 1.45, fontWeight: 600,
              color: 'var(--warn)', display: 'flex', gap: 8, alignItems: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: 'none' }}>
              <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M10 6v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="10" cy="14.2" r="1.1" fill="currentColor" />
            </svg>
            <span>{t(BANNER[outage]!)}</span>
          </div>
        )}
        {/* A watched flight lives at the top of the thread while it is live —
            the one thing that moves everything else. */}
        {flights.length > 0 && (
          <div style={{ padding: '0 12px', display: 'grid', gap: 8 }}>
            {flights.map((w) => <FlightCard key={w.id} w={w} />)}
          </div>
        )}
        {msgs.map((m, i) => (
          <MsgBubble
            key={i}
            m={m}
            index={i}
            continues={m.who === 'c' && !!m.part && m.part !== 'lead' && msgs[i - 1]?.who === 'c' && !!msgs[i - 1]?.part}
            // A suggestion is something NUM said in ANSWER to something. Until
            // the user has spoken, nothing on screen is a suggestion. The
            // parts of one turn are rated once, on the last of them.
            rateable={m.who === 'c' && msgs.slice(0, i).some((p) => p.who === 'u') && (!!m.card || cleanText(m.text).length > 90 || !!m.picks?.length) && !(m.part && msgs[i + 1]?.who === 'c' && msgs[i + 1]?.part && msgs[i + 1]?.part !== 'lead')}
          />
        ))}
        {typing && <Thinking />}
      </div>

      {/* ── THE WAY BACK ────────────────────────────────────────────────
          Shown only when the reader has scrolled up AND something new has
          arrived below them. Without it, "we will not move you" turns into
          "you are stranded" — they scroll up to compare two fares, NUM
          answers, and nothing on screen says so.

          Positioned over the thread rather than in the composer so it cannot
          change the composer's fixed height, which the block below depends
          on. */}
      {behind && (
        <div style={{ position: 'relative', height: 0 }}>
          <div
            {...pressable(toLatest)}
            style={{
              position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
              zIndex: 3, cursor: 'pointer', borderRadius: 999, minHeight: 36,
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
              background: 'var(--grad-accent)', color: '#fff',
              fontSize: 11, fontWeight: 800, letterSpacing: '.06em',
              boxShadow: '0 6px 18px rgba(0,0,0,.18)', whiteSpace: 'nowrap',
            }}
          >
            NEW BELOW ↓
          </div>
        </div>
      )}

      {/* Hard-set composer height: a fixed discover row + fixed chip row +
          fixed input row, so the bar is the same height whether you are typing,
          sending, or dismissing the keyboard. Bottom padding clears the home
          indicator without an extra margin that shifts on rotation. */}
      <div className="glass-bar" style={{ padding: '10px 14px max(env(safe-area-inset-bottom), 14px)', flex: 'none' }}>
        <FlightTray />
        <ServiceTray />
        {/* One line, changing every 90s, showing a thing NUM can do that this
            guest has probably not tried. Only ever claims a capability the
            destination can actually serve — see worker/suggest.mjs. */}
        {/* NUM speaks first. When the member has a plan coming up this line
            outranks the showcase, stays visible deeper into the thread, and
            reads as a sentence from NUM rather than a feature hint. */}
        {!demo && briefing && msgs.length < 12 && (
          <div style={{ padding: '0 4px 7px', fontSize: 12.5, lineHeight: 1.4, fontWeight: 600 }}>
            <SparklesIcon size={12} style={{ color: 'var(--color-accent)', verticalAlign: '-1px', marginRight: 5 }} />
            {briefing}
          </div>
        )}
        {!demo && !briefing && rotating && msgs.length < 6 && (
          <div style={{ padding: '0 4px 7px', fontSize: 11.5, lineHeight: 1.35, opacity: 0.62, fontWeight: 500 }}>
            <SparklesIcon size={11} style={{ color: 'var(--color-accent)', verticalAlign: '-1px', marginRight: 5 }} />
            {rotating}
          </div>
        )}
        {/* ONE ROW, NO EMOJI, NO SECOND LINE (18 Sep 2026).
            There were two rows here — NUM's reply chips above the fixed
            starters — and each chip carried a leading emoji. On a 375px phone
            that was ~88px of composer spent on decoration, with "Tell NUM who
            I am" stranded alone on its own line. Now everything a tap can
            start lives in a single scrolling row: what NUM just offered comes
            first, because it is about the thing on screen, then the four
            fixed doors, then the destination's own starters. Slide for the
            rest.

            The height stays fixed and the row is rendered even when empty,
            for the reason the old comment gave: chips clear on send, and a
            row that collapses resizes the composer and jumps the thread. */}
        <div className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', height: 44, alignItems: 'center', padding: '0 2px' }}>
          {chips.map((c) => (
            <div
              key={c.id}
              {...pressable(() => sendChip(c.id, c.label))}
              className="glass lift chip-in glow-soft"
              style={{ ...starterChip, ...(typing ? { pointerEvents: 'none' as const, opacity: 0.55 } : {}) }}
            >
              {t(c.label)}
            </div>
          ))}
          {!demo && (
            <>
              {/* The four fixed doors: the box for people who know what they
                  want, the dice for people who don't, deep research for the
                  long answer (its own sheet — it takes a minute and pings when
                  it lands), and the flight watcher. None sends a message. */}
              {[[T('Surprise me'), 'suggest'], [T('Search'), 'search'], [T('Look into it'), 'research'], [T('Watch my flight'), 'flight']].map(([label, tab]) => (
                <div
                  key={label}
                  {...pressable(() => {
                    if (tab === 'flight') { store.set({ flightWatchOpen: true }); return; }
                    if (tab === 'research') { store.set({ researchOpen: true }); return; }
                    openDiscover(tab as 'search' | 'suggest');
                  })}
                  className="glass lift"
                  style={starterChip}
                >
                  {t(label)}
                </div>
              ))}
              {starters.map(({ label, prompt }) => (
                <div
                  key={label}
                  {...pressable(() => { if (!store.get().typing) void askNum(prompt); })}
                  className="glass lift"
                  style={{ ...starterChip, ...(typing ? { pointerEvents: 'none' as const, opacity: 0.55 } : {}) }}
                >
                  {t(label)}
                </div>
              ))}
            </>
          )}
        </div>
        {/* SAID BEFORE IT IS FELT (18 Sep 2026). Sending needs a number or an
            address NUM can answer to — see lib/gate.ts for why. A person who
            learns that from a sheet appearing after they pressed send has
            been interrupted; a person who reads it above an empty box is
            being told the rules of the place. The box still takes their
            words, and the words survive the sheet. */}
        {/* Shown once the free answer is spent, not before: telling somebody
            the rules of the place before they have asked anything is the toll
            that emptied the funnel. */}
        {!gateOpen(me, msgs) && (
          <div
            {...pressable(() => store.set({ inviteOpen: {} }))}
            className="tap"
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 8px' }}
          >
            <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-60)' }}>
              {t('NUM has to be able to answer you back.')}
            </div>
            <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', color: 'var(--color-accent)' }}>{t('VERIFY')}</span>
          </div>
        )}
        {/* Fixed 44px row: the send/mic swap and the input's own growth can
            never change the composer's height. */}
        <div style={{ display: 'flex', gap: 8, height: 44, alignItems: 'center' }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder={t('Message NUM…')}
            /* The iOS return key reads "send" instead of "return", which is
               the only affordance telling a guest that enter submits. */
            enterKeyHint="send"
            /* 16px: iOS zooms the page in on focus for anything smaller, and
               that zoom is itself a viewport resize — i.e. a second glitch. */
            style={{ flex: 1, height: 44, borderRadius: 999, border: '1px solid var(--glass-border)', padding: '0 16px', fontSize: 16, color: 'var(--color-text)', background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-read)', minWidth: 0 }}
          />
          {draft.trim() ? (
            <div
              {...pressable(send)}
              aria-label={t('Send')}
              className="press glow"
              style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}
              title={t('Send')}
            >
              <SendIcon size={17} />
            </div>
          ) : (
            <div
              {...pressable(() => openVoice())}
              aria-label={t('Talk to NUM')}
              className="press glow"
              style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}
              title={t('Talk to NUM')}
            >
              <MicIcon size={17} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
