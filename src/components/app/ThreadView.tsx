// THREAD tab — the conversation: messages, cards, typing dots, chips, input bar.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { checkOffer, duration, stillValid, type FlightOffer } from '../../lib/flights';
import { pressable } from '../../lib/a11y';
import { tagOf } from '../../lib/derive';
import { askNum, cleanText, sendChip, openVoice } from '../../lib/concierge';
import { MicIcon, SendIcon, SparklesIcon, XIcon } from '../../lib/icons';
import { Scene } from '../../lib/scenes';
import { REACTIONS, react } from '../../lib/prefs';
import { KIND_LABEL, dismissService, openService } from '../../lib/services';
import type { Msg } from '../../lib/types';

/**
 * Emoji reactions. They rate the *suggestion*, not the message — 😍 means find
 * more like this, 👎 means never offer it again, 🥱 means the answer was too
 * long. It is the cheapest possible feedback channel, which is why people
 * actually use it, and it is what teaches Num this user's taste.
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
 * The hand-off tray. Num has no account with Uber or Grab yet, so it does not
 * pretend to have ordered — it picks the right app for this country and opens
 * it prefilled. One tap, and the honesty is the feature.
 */
/**
 * Live fares, rendered as data.
 *
 * Deliberately NOT prose. Every number here came back from Sabre in this
 * session, and keeping it in its own card is what stops it drifting into the
 * transcript where a later turn might repeat it as though it were still true.
 * The expiry is shown for the same reason — a fare has a shelf life and
 * pretending otherwise is how somebody turns up at a desk with the wrong price.
 */
function FlightTray() {
  const state = useApp((s) => s.flightOffers);
  const busy = useApp((s) => s.flightSearching);
  const error = useApp((s) => s.flightError);
  const [checking, setChecking] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Record<string, string>>({});

  if (busy) {
    return (
      <div className="glass" style={{ margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '11px 12px', fontSize: 12, color: 'var(--ink-60)' }}>
        Checking live fares…
      </div>
    );
  }
  if (error && !state) {
    return (
      <div className="glass" style={{ margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '11px 12px', fontSize: 12, color: 'var(--ink-60)' }}>
        {error}
      </div>
    );
  }
  if (!state?.offers.length) return null;

  const recheck = async (o: FlightOffer) => {
    setChecking(o.id);
    const out = await checkOffer(o, state.query);
    setVerdict((v) => ({ ...v, [o.id]: out.message }));
    setChecking(null);
  };

  return (
    <div className="glass" style={{ margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '11px 12px' }}>
      <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
        LIVE FARES · {state.query.fromCode} → {state.query.toCode}
      </div>
      <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>
        {state.offers.map((o) => {
          const leg = o.legs[0];
          const hops = leg ? [leg.segments[0]?.from, ...leg.segments.map((sg) => sg.to)].filter(Boolean).join(' → ') : '';
          const hidden = o.legs.flatMap((l) => l.segments).flatMap((sg) => sg.hiddenStops ?? []);
          const dead = !stillValid(o);
          return (
            <div key={o.id} style={{ borderRadius: 12, border: '1px solid var(--ink-08)', padding: '9px 11px', opacity: dead ? 0.5 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {o.currency} {o.price}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-40)' }}>
                  {o.validatingCarrier} · {leg?.stops === 0 ? 'non-stop' : `${leg?.stops} stop${leg?.stops === 1 ? '' : 's'}`} · {duration(o.totalDurationInMinutes)}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3 }}>{hops}</div>
              <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 2 }}>
                {leg?.segments.map((sg) => `${sg.marketing} ${sg.departs.slice(11, 16)}`).join(' · ')}
                {leg?.segments[0]?.cabin ? ` · ${leg.segments[0].cabin}` : ''}
              </div>
              {/* A stop the airline does not advertise is the thing travellers
                  find out about at the gate. Always said out loud. */}
              {hidden.length > 0 && (
                <div style={{ fontSize: 10.5, color: 'var(--color-accent-700)', fontWeight: 700, marginTop: 3 }}>
                  Unadvertised stop at {hidden.map((h) => h.airportCode).join(', ')}
                </div>
              )}
              {verdict[o.id] && <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.45 }}>{verdict[o.id]}</div>}
              <div
                {...pressable(() => void recheck(o))}
                style={{
                  cursor: 'pointer', marginTop: 7, borderRadius: 999, padding: '7px 12px', textAlign: 'center',
                  fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em',
                  background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)',
                  opacity: checking === o.id ? 0.55 : 1,
                }}
              >
                {checking === o.id ? 'RE-CHECKING…' : 'IS THIS STILL LIVE?'}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.5 }}>
        Real fares from Sabre. Num can price and re-check these — it can’t buy the ticket, so the purchase is still yours to make.
      </div>
    </div>
  );
}

function ServiceTray() {
  const h = useApp((s) => s.handoff);
  if (!h) return null;
  return (
    <div className="glass" style={{ margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
          {KIND_LABEL[h.kind].toUpperCase()}
        </div>
        <span {...pressable(dismissService)} aria-label="Dismiss" style={{ cursor: 'pointer', color: 'var(--ink-40)' }}>
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
              background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 3px 10px rgba(236,48,19,.28)',
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
          ? 'Num completes this for you.'
          : 'Opens in your own app with the destination already filled in — Num can’t place it for you yet.'}
      </div>
    </div>
  );
}

function MsgBubble({ m, index, rateable }: { m: Msg; index: number; rateable: boolean }) {
  const u = m.who === 'u';
  const ct = m.card ? tagOf(m.card.tag) : null;
  return (
    <div className="msg-in" style={{ display: 'flex', justifyContent: u ? 'flex-end' : 'flex-start', padding: '0 16px' }}>
      <div
        className={u ? undefined : 'glass'}
        style={{
          maxWidth: '82%', fontSize: 13, lineHeight: 1.5, padding: '10px 13px',
          borderRadius: 18,
          ...(u
            ? { borderBottomRightRadius: 6, background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 4px 14px rgba(236,48,19,.25)' }
            : { borderBottomLeftRadius: 6, color: 'var(--ink)' }),
        }}
      >
        <div style={{ whiteSpace: 'pre-line' }}>{u ? m.text : cleanText(m.text)}</div>
        {m.card && ct && (
          <div
            style={{
              marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 11, padding: 10,
              background: 'var(--field-bg)', border: '1px solid var(--ink-08)',
              borderRadius: 'var(--r-md)', boxShadow: '0 4px 12px rgba(32,30,29,.08)', color: 'var(--ink)',
            }}
          >
            {/* A real venue photo earns more room than the icon fallback does. */}
            <Scene title={m.card.title} size={m.card.photo ? 58 : 42} photo={m.card.photo} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.25 }}>{m.card.title}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>{m.card.meta}</div>
              {/* The status pill sits under the text so it never squeezes the title. */}
              <span style={{ ...ct.st, display: 'inline-flex', marginTop: 7 }}>{ct.label}</span>
            </div>
          </div>
        )}
        {/* Only Num's own suggestions are rateable. Rating your own message is
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

// Live-mode capability discovery — a strip of fun starters above the chips.
const DISCOVER: Array<[emoji: string, label: string, prompt: string]> = [
  ['🚗', 'Request a car', 'Get me a car to the airport tomorrow morning'],
  ['🍜', 'Order food', 'Order dinner to my hotel tonight'],
  ['💆', 'Book a massage', 'Book me a massage nearby tomorrow afternoon'],
  ['🍽️', 'Table tonight', 'Book me a great dinner table tonight'],
  ['🎉', 'Club table', 'Get me a table at the best club this weekend'],
  ['₿', 'Check crypto', 'What are bitcoin and ethereum at right now?'],
  ['🤝', 'Meet Num users', 'Set up a meeting with another Num user'],
  ['🛠️', 'Hire help · 5arz', 'I need to hire someone for a small job through 5arz'],
  ['💌', 'Invite a friend', 'Send an invite to a friend so we can plan together'],
  ['🧳', 'Plan with friends', 'Start a group plan I can build with my friends'],
];

export default function ThreadView() {
  // Whole-state subscription on purpose: the design's componentDidUpdate snaps
  // the thread to the bottom after EVERY state change while the thread is
  // visible (sheets opening, notifications, chips), not just on new messages.
  const { msgs, typing, chips, demo } = useApp((s) => s);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  const send = () => {
    const text = draft.trim();
    if (!text || typing) return;
    setDraft('');
    void askNum(text);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return (
    <>
      <div ref={scrollRef} className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '16px 0 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.map((m, i) => (
          <MsgBubble
            key={i}
            m={m}
            index={i}
            // A suggestion is something Num said in ANSWER to something. Until
            // the user has spoken, nothing on screen is a suggestion.
            rateable={m.who === 'c' && msgs.slice(0, i).some((p) => p.who === 'u') && (!!m.card || cleanText(m.text).length > 90)}
          />
        ))}
        {typing && (
          <div className="msg-in" style={{ padding: '0 16px' }}>
            <div className="glass" style={{ display: 'inline-flex', gap: 5, borderRadius: 999, padding: '10px 14px' }}>
              {[0, 0.18, 0.36].map((d) => (
                <span key={d} style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-text)', animation: `tdot 1.1s ${d}s infinite` }} />
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Hard-set composer height: a fixed discover row + fixed chip row +
          fixed input row, so the bar is the same height whether you are typing,
          sending, or dismissing the keyboard. Bottom padding clears the home
          indicator without an extra margin that shifts on rotation. */}
      <div className="glass-bar" style={{ padding: '10px 14px max(env(safe-area-inset-bottom), 14px)', flex: 'none' }}>
        <FlightTray />
        <ServiceTray />
        {!demo && (
          <div className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', height: 42, alignItems: 'center', padding: '0 2px' }}>
            {DISCOVER.map(([emoji, label, prompt]) => (
              <div
                key={label}
                {...pressable(() => { if (!store.get().typing) void askNum(prompt); })}
                className="glass lift"
                style={{ cursor: 'pointer', borderRadius: 999, padding: '7px 12px', fontSize: 11.5, fontWeight: 600, flex: 'none', display: 'flex', gap: 6, alignItems: 'center', ...(typing ? { pointerEvents: 'none' as const, opacity: 0.55 } : {}) }}
              >
                <span aria-hidden="true">{emoji}</span>
                {label}
              </div>
            ))}
          </div>
        )}
        {/* One fixed-height scrolling row, never a wrapping block. Wrapping made
            the bar 1–3 rows tall depending on how many chips the reply carried,
            so sending (which clears the chips) resized the whole composer and
            the thread jumped under it. Height is reserved even when empty. */}
        <div className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', height: 46, alignItems: 'center', padding: '0 2px' }}>
          {chips.map((c) => (
            <div
              key={c.id}
              {...pressable(() => sendChip(c.id, c.label))}
              className="glass lift"
              style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 600, padding: '8px 13px', borderRadius: 999, display: 'flex', alignItems: 'center', gap: 6, flex: 'none', whiteSpace: 'nowrap', ...(typing ? { pointerEvents: 'none' as const, opacity: 0.55 } : {}) }}
            >
              <SparklesIcon size={12} style={{ color: 'var(--color-accent)' }} />
              {c.label}
            </div>
          ))}
        </div>
        {/* Fixed 44px row: the send/mic swap and the input's own growth can
            never change the composer's height. */}
        <div style={{ display: 'flex', gap: 8, height: 44, alignItems: 'center' }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder="Message Num…"
            /* 16px: iOS zooms the page in on focus for anything smaller, and
               that zoom is itself a viewport resize — i.e. a second glitch. */
            style={{ flex: 1, height: 44, borderRadius: 999, border: '1px solid var(--glass-border)', padding: '0 16px', fontSize: 16, color: 'var(--color-text)', background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', minWidth: 0 }}
          />
          {draft.trim() ? (
            <div
              {...pressable(send)}
              aria-label="Send"
              className="press"
              style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.35)', flex: 'none' }}
              title="Send"
            >
              <SendIcon size={17} />
            </div>
          ) : (
            <div
              {...pressable(openVoice)}
              aria-label="Talk to Num"
              className="press"
              style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.35)', flex: 'none' }}
              title="Talk to Num"
            >
              <MicIcon size={17} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
