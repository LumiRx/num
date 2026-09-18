// DASH — the one screen that answers "what's happening, and what needs me?"
// without opening anything. The week at a glance first, then what is next,
// what is on tonight, who is waiting on you and the trip check. Everything
// here is one tap from the thing itself.
//
// What NUM may reach — contacts, photos, calendar, wallet, mail, texts — used
// to sit at the bottom of this screen. Nobody grants those twice, so from
// 18 Sep 2026 they live in Settings (ConnectionsCard.tsx) and this screen is
// only ever about today.
import { useEffect, useState } from 'react';
import FeatureGrid from './FeatureGrid';
import { store, useApp } from '../../lib/store';
import FlightCard from './FlightCard';
import TonightStrip from './TonightStrip';
import { pressable } from '../../lib/a11y';
import { tagOf, monthName } from '../../lib/derive';
import { tripCheck } from '../../lib/prefs';
import { askNum } from '../../lib/concierge';
import { listEvents } from '../../lib/events';
import { refreshRequests, respond } from '../../lib/requests';
import { directionsUrl, nextWithPlace, preferredMaps, trafficUrl } from '../../lib/maps';
import { Scene } from '../../lib/scenes';
import {
  BellIcon, CalendarIcon, CheckIcon, ChevronRightIcon,
  SparklesIcon, StarIcon, UsersIcon,
} from '../../lib/icons';
import type { Booking, WidgetId } from '../../lib/types';
import { guestMessage } from '../../lib/saferr';
import { T, t } from '../../lib/i18n';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 13 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const h: React.CSSProperties = { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 };

const sortB = (a: Booking, b: Booking) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time);

/** Shared collapsible shell — the dash is long, and a long dash is a scroll. */

/**
 * REQUESTS — what friends are waiting on. A connection request, a plan that
 * moved, a dinner invite: answered here in a tap rather than by finding the
 * original text and clicking a link.
 */
function RequestsWidget() {
  const inbox = useApp((s) => s.inbox);
  const me = useApp((s) => s.me);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [when, setWhen] = useState('');

  const act = async (kind: 'connect' | 'plan' | 'event', id: string, action: 'accept' | 'decline' | 'propose' | 'message', extra = {}) => {
    setBusy(id);
    try {
      setNote(await respond(kind, id, action, extra));
      setReplyTo(null);
      setDraft('');
      setWhen('');
    } catch (err) {
      setNote(guestMessage(err, 'That didn’t go through.'));
    } finally {
      setBusy(null);
    }
  };

  const pending = inbox.connects.length + inbox.events.length;
  if (!me || (!pending && !inbox.plans.some((p) => p.latest))) return null;

  const Btn = ({ label, onClick, primary: p }: { label: string; onClick: () => void; primary?: boolean }) => (
    <span
      {...pressable(onClick)}
      className={p ? 'press' : 'glass press'}
      style={{
        cursor: 'pointer', borderRadius: 999, padding: '8px 13px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
        ...(p ? { background: 'var(--grad-accent)', color: '#fff' } : { color: 'var(--ink)' }),
      }}
    >
      {label}
    </span>
  );

  return (
    <div className="glass" style={{ ...card, borderLeft: pending ? '3px solid var(--color-accent)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={kicker}>{t('WAITING ON YOU')}</div>
        {pending > 0 && (
          <span style={{ background: 'var(--grad-accent)', color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 999, padding: '2px 7px' }}>{pending}</span>
        )}
      </div>

      {inbox.connects.map((c) => (
        <div key={c.id} style={{ marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--ink-08)' }}>
          <div style={{ ...h }}>{c.from_name ?? 'A friend'} wants to connect</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>
            {c.plan_title ? `And bring you into “${c.plan_title}”` : 'Once you’re connected your two Nums can trade plans directly'}
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
            <Btn label={busy === c.id ? '…' : 'ACCEPT'} primary onClick={() => void act('connect', c.id, 'accept')} />
            <Btn label="NOT NOW" onClick={() => void act('connect', c.id, 'decline')} />
          </div>
        </div>
      ))}

      {inbox.events.map((e) => (
        <div key={e.token} style={{ marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--ink-08)' }}>
          <div style={{ ...h }}>{e.host_name ?? 'Someone'} invited you — {e.title}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>
            {[e.day, e.time, e.place].filter(Boolean).join(' · ') || 'details to come'}
          </div>
          {/* Where the question came from. An invite that arrived with nobody
              texting you is a surprising thing, and saying so once is cheaper
              than leaving people to wonder how it got here. */}
          {e.via === 'agent' && (
            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 3 }}>{t('Their NUM asked yours — answer here or in your messages.')}</div>
          )}
          <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
            <Btn label="GOING" primary onClick={() => void act('event', e.token, 'accept')} />
            <Btn label="MAYBE" onClick={() => void act('event', e.token, 'propose')} />
            <Btn label="CAN’T" onClick={() => void act('event', e.token, 'decline')} />
            <Btn label="REPLY" onClick={() => setReplyTo(replyTo === e.token ? null : e.token)} />
          </div>
          {replyTo === e.token && (
            <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>
              <input style={inputStyle} placeholder={t('A note back to the host…')} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
              <Btn label="SEND" primary onClick={() => void act('event', e.token, 'accept', { message: draft })} />
            </div>
          )}
        </div>
      ))}

      {inbox.plans.filter((p) => p.latest).map((p) => (
        <div key={p.id} style={{ marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--ink-08)' }}>
          <div style={{ ...h }}>{p.title}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 }}>{p.latest}</div>
          <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
            <Btn label="I’M IN" primary onClick={() => void act('plan', p.id, 'accept')} />
            <Btn label="ANOTHER TIME" onClick={() => setReplyTo(replyTo === p.id ? null : p.id)} />
            <Btn label="CAN’T" onClick={() => void act('plan', p.id, 'decline')} />
            <Btn label="INVITE MORE" onClick={() => store.set({ planId: p.id, partyOpen: true })} />
          </div>
          {replyTo === p.id && (
            <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>
              <input style={inputStyle} placeholder={t('When suits you? e.g. Friday 8pm')} value={when} onChange={(ev) => setWhen(ev.target.value)} />
              <input style={inputStyle} placeholder={t('Add a note (optional)')} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
              <Btn label="SUGGEST IT" primary onClick={() => void act('plan', p.id, 'propose', { time: when, message: draft })} />
            </div>
          )}
        </div>
      ))}

      {note && <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 10 }}>{note}</div>}
    </div>
  );
}

/**
 * DIRECTIONS — the only useful question about a route is what time to leave.
 * We hold no Directions API key, so NUM opens the route in the maps app they
 * already use rather than inventing a live traffic figure; the leave-by advice
 * comes from the thread, where the transport specialist reasons about the
 * actual traffic pattern of that city at that hour.
 */
function DirectionsWidget() {
  const bookings = useApp((s) => s.bookings);
  const meetings = useApp((s) => s.meetings);
  const next = nextWithPlace(bookings, meetings);
  if (!next) return null;
  const app = preferredMaps();
  const mins = Math.round((next.when.getTime() - Date.now()) / 60000);
  const soon = mins > 0 && mins < 240;

  return (
    <div className="glass" style={card}>
      <div style={kicker}>{t('GETTING THERE')}</div>
      <div style={{ ...h, marginTop: 4 }}>{next.title}</div>
      <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 }}>
        {next.place}
        {soon ? ` · in ${mins < 60 ? `${mins} min` : `${Math.round(mins / 60)}h`}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
        <a
          href={directionsUrl(next.place, { arriveBy: next.when })}
          target="_blank"
          rel="noreferrer"
          className="press tap"
          style={{ textDecoration: 'none', borderRadius: 999, padding: '9px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em', background: 'var(--grad-accent)', color: '#fff' }}
        >
          {app === 'apple' ? 'APPLE MAPS' : 'GOOGLE MAPS'}
        </a>
        <a href={trafficUrl(next.place)} target="_blank" rel="noreferrer" className="glass press tap" style={{ textDecoration: 'none', color: 'var(--ink)', borderRadius: 999, padding: '9px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em' }}>{t('TRAFFIC NOW')}</a>
        <span
          {...pressable(() => { store.set({ threadOpen: true }); void askNum(`What time should I leave for ${next.title} at ${next.place}? Account for traffic at that hour.`); })}
          className="glass press tap"
          style={{ cursor: 'pointer', borderRadius: 999, padding: '9px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em' }}
        >
          WHEN DO I LEAVE?
        </span>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 40, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 12px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};

export default function DashView() {
  const me = useApp((s) => s.me);
  const widgets = useApp((s) => s.widgets);

  useEffect(() => {
    if (!me) return;
    void listEvents();
    void refreshRequests();
  }, [me?.id]);

  // The dash is a LIST, not a layout. NUM rewrites `widgets` as the trip
  // changes, and a widget that has nothing to say returns null and costs a
  // slot rather than a screenful.
  const RENDER: Record<WidgetId, () => JSX.Element | null> = {
    // NEXT UP, the fortnight and the trip check moved to PLAN on 18 Sep 2026
    // (DayWidgets.tsx) — your own calendar belongs with your bookings, not in
    // the same scroll as tonight's suggestions. The ids stay mapped because
    // the server still sends them.
    next: () => null,
    tonight: () => <TonightStrip />,
    requests: () => <RequestsWidget />,
    directions: () => <DirectionsWidget />,
    calendar: () => null,
    tripcheck: () => null,
    group: () => <GroupCard />,
    events: () => <EventsCard />,
    wallet: () => <WalletCard />,
    // CONNECT YOUR WORLD lives in Settings now (ConnectionsCard.tsx). The id
    // stays in the map because the server still sends `widgets` and an
    // unknown key would be a crash; here it simply costs nothing.
    connections: () => null,
  };

  // ── NOW, THEN EVERYTHING ────────────────────────────────────────────────
  //
  // 18 Sep 2026. The list above is what NUM knows about THIS day, and it
  // stays on top — but it was also the only way onto the screen, so flights,
  // charter, a runner or a massage were reachable only by knowing to type
  // the words. Below the day sits every feature as a cover with a button
  // (FeatureGrid). Group, events and wallet moved off the list and into the
  // grid — the same door, no longer shown twice.
  //
  // WHAT IS AROUND YOU, NOT YOUR DIARY (18 Sep 2026). Next up, the fortnight
  // and the trip check moved to PLAN — a diary belongs with the bookings in
  // it. What is left here is what is happening near you and what needs an
  // answer: tonight, the requests inbox, live directions, then every door.
  //
  // Order comes from the server: `widgets` is NUM's own running order and it
  // earns that, since a delayed flight climbs it. This array only says which
  // of them belong above the grid.
  const NOW: WidgetId[] = ['tonight', 'requests', 'directions'];
  const AFTER: WidgetId[] = [];
  const now = widgets.filter((id) => NOW.includes(id));
  const after = widgets.filter((id) => AFTER.includes(id));

  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 96 }}>
      {now.map((id) => (
        <div key={id}>{RENDER[id]?.() ?? null}</div>
      ))}
      <FeatureGrid />
      {after.map((id) => (
        <div key={id}>{RENDER[id]?.() ?? null}</div>
      ))}
    </div>
  );
}

function GroupCard() {
  const plan = useApp((s) => s.plans.find((p) => p.id === s.planId) ?? null);
  const partySize = useApp((s) => s.planMembers.length);
  return (
    <div
      {...pressable(() => store.set({ view: 'plan' }))}
      className="glass lift"
      style={{ ...card, cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'center' }}
    >
      <div style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <UsersIcon size={15} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={kicker}>{t('GROUP')}</div>
        <div style={{ ...h, marginTop: 3 }}>{plan ? plan.title : 'Plan it with friends'}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2 }}>
          {plan ? `${partySize || 1} in · everything syncs both ways` : 'Start one on the PLAN tab — no dates or bookings needed'}
        </div>
      </div>
      <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
    </div>
  );
}

function EventsCard() {
  const events = useApp((s) => s.events);
  return (
    <div
      {...pressable(() => store.set({ eventOpen: true }))}
      className="glass lift"
      style={{ ...card, cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'center' }}
    >
      <div style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <SparklesIcon size={15} style={{ color: 'var(--color-accent)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={kicker}>{t('EVENTS')}</div>
        <div style={{ ...h, marginTop: 3 }}>{events.length ? events[0].title : 'Host something'}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2 }}>
          {events.length ? `${events[0].yes ?? 0} of ${events[0].invited ?? 0} coming · RSVP by text` : 'Guests RSVP from one text — no app on their side'}
        </div>
      </div>
      <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
    </div>
  );
}

function WalletCard() {
  const stars = useApp((s) => s.stars);
  return (
    <div
      {...pressable(() => store.set({ walletOpen: true }))}
      className="glass lift"
      style={{ ...card, cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'center' }}
    >
      <div style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <StarIcon size={15} style={{ color: 'var(--color-accent)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={kicker}>{t('WALLET')}</div>
        <div style={{ ...h, marginTop: 3 }}>★{stars.toLocaleString()}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2 }}>{t('Settles bills at the table')}</div>
      </div>
      <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
    </div>
  );
}
