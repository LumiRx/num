// DASH — the one screen that answers "what's happening, and what needs me?"
// without opening anything. Next up, the week at a glance, the group, the
// trip check, and the switches for the outside data the user chooses to plug
// in. Everything here is one tap from the thing itself.
import { useEffect, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { tagOf, monthName } from '../../lib/derive';
import { tripCheck } from '../../lib/prefs';
import { askNum } from '../../lib/concierge';
import { listEvents } from '../../lib/events';
import { refreshRequests, respond } from '../../lib/requests';
import { toggleConnection, contactsSupported, sendAndShare } from '../../lib/connect';
import { directionsUrl, nextWithPlace, preferredMaps, trafficUrl } from '../../lib/maps';
import { Scene } from '../../lib/scenes';
import {
  BellIcon, CalendarIcon, CameraIcon, CheckIcon, ChevronRightIcon, MessageIcon,
  SparklesIcon, StarIcon, UsersIcon, WalletIcon,
} from '../../lib/icons';
import type { Booking, Connections, WidgetId } from '../../lib/types';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 13 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const h: React.CSSProperties = { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 };

const sortB = (a: Booking, b: Booking) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time);

/** Shared collapsible shell — the dash is long, and a long dash is a scroll. */
function Collapsible({ title, summary, defaultOpen = false, children }: {
  title: string; summary?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass" style={card}>
      <div {...pressable(() => setOpen((v) => !v))} aria-expanded={open} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>{title}</div>
          {summary && <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 }}>{summary}</div>}
        </div>
        <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)', flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }} />
      </div>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

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
      setNote(err instanceof Error ? err.message : 'That didn’t go through.');
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
        <div style={kicker}>WAITING ON YOU</div>
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
            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 3 }}>
              Their Num asked yours — answer here or in your messages.
            </div>
          )}
          <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
            <Btn label="GOING" primary onClick={() => void act('event', e.token, 'accept')} />
            <Btn label="MAYBE" onClick={() => void act('event', e.token, 'propose')} />
            <Btn label="CAN’T" onClick={() => void act('event', e.token, 'decline')} />
            <Btn label="REPLY" onClick={() => setReplyTo(replyTo === e.token ? null : e.token)} />
          </div>
          {replyTo === e.token && (
            <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>
              <input style={inputStyle} placeholder="A note back to the host…" value={draft} onChange={(ev) => setDraft(ev.target.value)} />
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
              <input style={inputStyle} placeholder="When suits you? e.g. Friday 8pm" value={when} onChange={(ev) => setWhen(ev.target.value)} />
              <input style={inputStyle} placeholder="Add a note (optional)" value={draft} onChange={(ev) => setDraft(ev.target.value)} />
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
 * We hold no Directions API key, so Num opens the route in the maps app they
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
      <div style={kicker}>GETTING THERE</div>
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
          className="press"
          style={{ textDecoration: 'none', borderRadius: 999, padding: '9px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em', background: 'var(--grad-accent)', color: '#fff' }}
        >
          {app === 'apple' ? 'APPLE MAPS' : 'GOOGLE MAPS'}
        </a>
        <a href={trafficUrl(next.place)} target="_blank" rel="noreferrer" className="glass press" style={{ textDecoration: 'none', color: 'var(--ink)', borderRadius: 999, padding: '9px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em' }}>
          TRAFFIC NOW
        </a>
        <span
          {...pressable(() => { store.set({ threadOpen: true }); void askNum(`What time should I leave for ${next.title} at ${next.place}? Account for traffic at that hour.`); })}
          className="glass press"
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

/** The next thing that actually happens — the single most-wanted fact. */
function NextUp() {
  const bookings = useApp((s) => s.bookings);
  const live = bookings.filter((b) => b.status !== 'cancelled').sort(sortB);
  const next = live[0];
  if (!next) {
    return (
      <div className="glass" style={card}>
        <div style={kicker}>NEXT UP</div>
        <div style={{ ...h, marginTop: 6 }}>Nothing booked yet</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>
          Tell Num where you are and what you feel like — it lands here.
        </div>
      </div>
    );
  }
  const tag = tagOf(next);
  return (
    <div
      {...pressable(() => store.set({ view: 'plan', expanded: next.id }))}
      className="glass lift"
      style={{ ...card, cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'flex-start' }}
    >
      <Scene title={next.title} photo={next.photo} />
      {/* The status pill sits UNDER the text, never beside it: hold labels are
          model-written and can run long ("BY tap Grab by 03:20"), which
          squeezed the title into three lines when they shared a row. */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={kicker}>NEXT UP</div>
        <div style={{ ...h, marginTop: 3 }}>{next.title}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>
          {monthName(next.mo)} {next.day} · {next.time}
          {next.place ? ` · ${next.place}` : ''}
        </div>
        <span style={{ ...tag.st, display: 'inline-flex', marginTop: 7 }}>{tag.label}</span>
      </div>
    </div>
  );
}

/** A fortnight of dots — where the days actually have something in them. */
function CalendarStrip() {
  const bookings = useApp((s) => s.bookings);
  const meetings = useApp((s) => s.meetings);
  const today = new Date();
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return d;
  });
  const busy = (d: Date) =>
    bookings.filter((b) => b.status !== 'cancelled' && b.mo === d.getMonth() + 1 && b.day === d.getDate()).length +
    meetings.filter((m) => m.mo === d.getMonth() + 1 && m.day === d.getDate()).length;

  return (
    <div className="glass" style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={kicker}>NEXT TWO WEEKS</div>
        <span
          {...pressable(() => store.set((s) => ({ calOpen: true, selDay: s.selDay ?? `${today.getMonth() + 1}-${today.getDate()}` })))}
          style={{ cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', color: 'var(--color-accent)', display: 'flex', gap: 4, alignItems: 'center' }}
        >
          <CalendarIcon size={12} /> FULL CALENDAR
        </span>
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 10, paddingBottom: 2 }}>
        {days.map((d, i) => {
          const n = busy(d);
          return (
            <div
              key={i}
              {...pressable(() => store.set({ calOpen: true, selDay: `${d.getMonth() + 1}-${d.getDate()}` }))}
              style={{
                cursor: 'pointer', flex: 'none', width: 38, textAlign: 'center', padding: '7px 0', borderRadius: 12,
                background: n ? 'var(--grad-accent)' : 'var(--field-bg)',
                color: n ? '#fff' : 'var(--ink-60)',
                border: '1px solid ' + (n ? 'transparent' : 'var(--ink-08)'),
              }}
            >
              <div style={{ fontSize: 9, letterSpacing: '.06em', opacity: 0.8 }}>{d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()}</div>
              <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.2 }}>{d.getDate()}</div>
              <div style={{ height: 4, marginTop: 2, display: 'flex', gap: 2, justifyContent: 'center' }}>
                {Array.from({ length: Math.min(n, 3) }).map((_, k) => (
                  <span key={k} style={{ width: 3, height: 3, borderRadius: 999, background: n ? 'rgba(255,255,255,.9)' : 'transparent' }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Trip check — arithmetic done on-device, then handed to Num to explain. */
function TripCheck() {
  const state = useApp((s) => s);
  const [open, setOpen] = useState(false);
  const findings = tripCheck(state);
  const clean = findings.length === 1 && /clean|empty/.test(findings[0]);

  return (
    <div className="glass" style={card}>
      <div {...pressable(() => setOpen((v) => !v))} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: clean ? 'rgba(22,140,90,.14)' : 'rgba(236,48,19,.12)', color: clean ? '#0e6b45' : 'var(--color-accent-700)' }}>
          {clean ? <CheckIcon size={15} /> : <BellIcon size={15} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>TRIP CHECK</div>
          <div style={{ ...h, marginTop: 3 }}>
            {clean ? 'Nothing needs you' : `${findings.length} thing${findings.length === 1 ? '' : 's'} to look at`}
          </div>
        </div>
        <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }} />
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--ink-08)' }}>
          {findings.map((f) => (
            <div key={f} style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--ink)', padding: '3px 0' }}>
              · {f}
            </div>
          ))}
          <div
            {...pressable(() => { store.set({ threadOpen: true }); void askNum('Run a trip check and tell me what needs me.'); })}
            className="press"
            style={{ cursor: 'pointer', marginTop: 10, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 11, letterSpacing: '.06em', padding: '10px 14px', textAlign: 'center' }}
          >
            ASK NUM TO SORT IT
          </div>
        </div>
      )}
    </div>
  );
}

const CONNECTIONS: Array<{ key: keyof Connections; label: string; why: string; icon: JSX.Element }> = [
  { key: 'contacts', label: 'Contacts', why: 'so “invite Sam” finds the right Sam', icon: <UsersIcon size={14} /> },
  { key: 'photos', label: 'Photos', why: 'files your trip shots to the right night', icon: <CameraIcon size={14} /> },
  { key: 'calendar', label: 'Calendar', why: 'Num books around what’s already there', icon: <CalendarIcon size={14} /> },
  { key: 'crypto', label: 'Crypto wallet', why: 'balances on this screen, settle bills in USDC', icon: <WalletIcon size={14} /> },
  { key: 'email', label: 'Email', why: 'pulls confirmations in so you never forward one', icon: <MessageIcon size={14} /> },
  { key: 'texts', label: 'Texts', why: 'the venue’s “running late?” reaches Num too', icon: <BellIcon size={14} /> },
];

/**
 * Connections. Each one is off, named, and says what it buys — a permission
 * screen that explains itself is the difference between a grant and a decline.
 * Flipping a switch performs the REAL connection right then (src/lib/connect):
 * pickers open as sheets over the app, addresses are minted, numbers fetched —
 * the user never leaves. iOS has no contacts API at all, so there the contacts
 * row becomes Send & Share, which is the honest version of the same promise.
 */
function ConnectionsCard() {
  const conn = useApp((s) => s.connections);
  const detail = useApp((s) => s.connDetail);
  const on = Object.values(conn).filter(Boolean).length;
  return (
    <Collapsible
      title="CONNECT YOUR WORLD"
      summary={on ? `${on} of ${CONNECTIONS.length} connected` : 'All off — Num asks only when it needs one'}
    >
      <div>
        {CONNECTIONS.map((c) => {
          // No picker on this platform → the row keeps its promise another way.
          if (c.key === 'contacts' && !contactsSupported()) {
            return (
              <div
                key="share"
                {...pressable(() => { void sendAndShare(); })}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--ink-08)' }}
              >
                <span style={{ width: 26, height: 26, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--grad-accent)', color: '#fff' }}>
                  {c.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Send &amp; Share</div>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-60)' }}>invite anyone from the share sheet — you stay right here</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--ink-60)' }}>OPEN</span>
              </div>
            );
          }
          const on = conn[c.key];
          return (
            <div
              key={c.key}
              {...pressable(() => toggleConnection(c.key), 'switch')}
              aria-checked={on}
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--ink-08)' }}
            >
              <span style={{ width: 26, height: 26, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? 'var(--grad-accent)' : 'var(--field-bg)', color: on ? '#fff' : 'var(--ink-60)', border: on ? 'none' : '1px solid var(--ink-08)' }}>
                {c.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.label}</div>
                <div style={{ fontSize: 10.5, color: on && detail[c.key] ? 'var(--ink-80, var(--ink-60))' : 'var(--ink-60)', overflowWrap: 'anywhere' }}>
                  {(on && detail[c.key]) || c.why}
                </div>
              </div>
              <span
                style={{
                  width: 38, height: 22, borderRadius: 999, flex: 'none', padding: 2,
                  background: on ? 'var(--grad-accent)' : 'var(--ink-12)', transition: 'background .2s',
                  display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start',
                }}
              >
                <span style={{ width: 18, height: 18, borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)' }} />
              </span>
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}

export default function DashView() {
  const me = useApp((s) => s.me);
  const widgets = useApp((s) => s.widgets);

  useEffect(() => {
    if (!me) return;
    void listEvents();
    void refreshRequests();
  }, [me?.id]);

  // The dash is a LIST, not a layout. Num rewrites `widgets` as the trip
  // changes, and a widget that has nothing to say returns null and costs a
  // slot rather than a screenful.
  const RENDER: Record<WidgetId, () => JSX.Element | null> = {
    next: () => <NextUp />,
    requests: () => <RequestsWidget />,
    directions: () => <DirectionsWidget />,
    calendar: () => <CalendarStrip />,
    tripcheck: () => <TripCheck />,
    group: () => <GroupCard />,
    events: () => <EventsCard />,
    wallet: () => <WalletCard />,
    connections: () => <ConnectionsCard />,
  };

  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 96 }}>
      {widgets.map((id) => (
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
        <div style={kicker}>GROUP</div>
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
        <div style={kicker}>EVENTS</div>
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
        <div style={kicker}>WALLET</div>
        <div style={{ ...h, marginTop: 3 }}>★{stars.toLocaleString()}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2 }}>Settles bills at the table</div>
      </div>
      <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
    </div>
  );
}
