import { useState } from 'react';
// PLAN tab — bookings grouped by city, expandable rows with note, cost,
// receipt, and the ASK TO CHANGE / SHARE actions.
import { store, useApp } from '../../lib/store';
import { openPlan, setAttendee } from '../../lib/social';
import { pressable } from '../../lib/a11y';
import { tagOf, bookingMetaLine, monthName } from '../../lib/derive';
import { askToChange } from '../../lib/concierge';
import { PLAN_GROUPS } from '../../lib/data';
import { Scene } from '../../lib/scenes';
import { ChevronRightIcon, UsersIcon } from '../../lib/icons';
import type { Booking } from '../../lib/types';

const sortB = (a: Booking, b: Booking) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time);

/**
 * Who is on this reservation.
 *
 * The shared plan item is matched by normalised title, the same way bookings
 * are pushed into the plan — the client-side Booking and the server-side
 * PlanItem are two views of one thing and the title is what ties them.
 *
 * Only shown once a plan exists: attendees are a SHARED concept, and offering
 * to add guests to something nobody else can see would be a lie about what
 * the feature does.
 */
function Attendees({ title }: { title: string }) {
  const item = useApp((s) => {
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    return s.planItems.find((i) => norm(i.title) === norm(title));
  });
  const me = useApp((s) => s.me);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  if (!item) return null;
  const list = item.attendees ?? [];
  const going = item.party_size ?? list.filter((a) => a.rsvp !== 'out').length;

  const change = async (n: string, opts: Parameters<typeof setAttendee>[2]) => {
    setBusy(true);
    await setAttendee(item.id, n, opts);
    setBusy(false);
  };

  const add = async () => {
    if (!name.trim()) return;
    await change(name.trim(), {});
    setName('');
    setAdding(false);
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--ink-08)' }} onClick={(e) => e.stopPropagation()}>
      <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>
        WHO'S COMING · TABLE FOR {going}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
        {list.map((a) => {
          // A member owns their own answer; a plain-name guest is answered for
          // by whoever added them. The UI only offers the tap where the server
          // will actually allow it, so nobody meets a 403 they can see coming.
          const mine = a.member_id ? a.member_id === me?.id : true;
          const out = a.rsvp === 'out';
          const next = a.rsvp === 'going' ? 'maybe' : a.rsvp === 'maybe' ? 'out' : 'going';
          return (
            <span
              key={a.name}
              {...(mine ? pressable(() => void change(a.name, { rsvp: next as 'going' })) : {})}
              title={mine ? 'Tap to change' : `${a.name} answers for themselves`}
              style={{
                borderRadius: 999, padding: '5px 11px', fontSize: 11, fontWeight: 600,
                border: '1px solid var(--ink-12)',
                cursor: mine ? 'pointer' : 'default',
                opacity: busy ? 0.6 : out ? 0.45 : 1,
                textDecoration: out ? 'line-through' : 'none',
                background: a.rsvp === 'going' ? 'var(--field-bg)' : 'transparent',
                color: a.rsvp === 'maybe' ? 'var(--color-accent-700)' : 'var(--ink)',
                // A guest with no Num account is shown lighter rather than
                // annotated — a trailing mark next to a name reads as a typo.
                borderStyle: a.member_id ? 'solid' : 'dashed',
              }}
            >
              {a.name}
              {a.rsvp === 'maybe' ? ' · maybe' : ''}
            </span>
          );
        })}
        {adding ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => (e.key === 'Enter' ? void add() : e.key === 'Escape' ? setAdding(false) : null)}
            onBlur={() => (name.trim() ? void add() : setAdding(false))}
            placeholder="Name"
            style={{
              borderRadius: 999, padding: '5px 11px', fontSize: 11, width: 110,
              border: '1px solid var(--color-accent)', background: 'var(--field-bg)',
              outline: 'none', color: 'var(--color-text)', fontFamily: 'var(--font-body)',
            }}
          />
        ) : (
          <span
            {...pressable(() => setAdding(true))}
            style={{
              borderRadius: 999, padding: '5px 11px', fontSize: 11, fontWeight: 700,
              border: '1px dashed var(--ink-12)', color: 'var(--ink-60)', cursor: 'pointer',
            }}
          >
            + ADD
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 6, lineHeight: 1.45 }}>
        A name with no account still counts toward the table. Anyone who drops out frees their seat.
      </div>
    </div>
  );
}

function BookingRow({ b }: { b: Booking }) {
  const exp = useApp((s) => s.expanded === b.id);
  const demo = useApp((s) => s.demo);
  const tag = tagOf(b);
  const cancelled = b.status === 'cancelled';
  return (
    <div
      {...pressable(() => store.set((s) => ({ expanded: s.expanded === b.id ? null : b.id })))}
      aria-expanded={exp}
      className="glass lift msg-in"
      style={{ cursor: 'pointer', margin: '6px 12px', borderRadius: 'var(--r-lg)', padding: 12 }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Scene title={b.title} photo={b.photo} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3,
              textDecoration: cancelled ? 'line-through' : 'none',
              color: cancelled ? 'var(--ink-40)' : 'var(--ink)',
            }}
          >
            {b.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>{bookingMetaLine(demo, b)}</div>
        </div>
        <span style={tag.st}>{tag.label}</span>
      </div>
      {exp && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--ink-08)' }}>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink)' }}>{b.note}</div>
          <Attendees title={b.title} />
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 4 }}>{b.cost}</div>
          {b.receipt && (
            <div style={{ fontSize: 10, letterSpacing: '.08em', fontWeight: 700, color: 'var(--color-accent-700)', marginTop: 4 }}>
              RECEIPT FILED · {b.receipt}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <span
              {...pressable((e) => { e.stopPropagation(); askToChange(b.title); })}
              className="press"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em',
                background: 'var(--grad-accent)', color: '#fff', cursor: 'pointer',
                boxShadow: '0 3px 12px rgba(236,48,19,.3)',
              }}
            >
              ASK TO CHANGE
            </span>
            <span
              {...pressable((e) => { e.stopPropagation(); store.set({ shareOpen: true }); })}
              className="press"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em',
                background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)', cursor: 'pointer',
              }}
            >
              SHARE
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Demo: the scripted city groups. Real: groups derived from the bookings the
 *  AI creates — grouped by its coined `grp` code, titled by the city in the
 *  first booking's place ("Shibuya, Tokyo" → TOKYO), dated from its range. */
function groupsFor(demo: boolean, bookings: Booking[]) {
  if (demo) {
    return PLAN_GROUPS.map(([name, dates, grp]) => ({
      key: grp,
      name,
      dates,
      items: bookings.filter((b) => b.grp === grp).sort(sortB),
    }));
  }
  const by = new Map<string, Booking[]>();
  for (const b of bookings) {
    const k = b.grp || '·';
    const arr = by.get(k);
    if (arr) arr.push(b);
    else by.set(k, [b]);
  }
  const cityFrom = (place: string, fallback: string) => {
    const tail = place.includes(',') ? place.slice(place.lastIndexOf(',') + 1).trim() : place.trim();
    return (tail || fallback).toUpperCase();
  };
  return [...by.entries()]
    .map(([grp, items]) => {
      items.sort(sortB);
      const first = items[0];
      const last = items[items.length - 1];
      const span =
        first.mo === last.mo && first.day === last.day
          ? `${monthName(first.mo).toUpperCase()} ${first.day}`
          : `${monthName(first.mo).toUpperCase()} ${first.day} – ${monthName(last.mo).toUpperCase()} ${last.day}`;
      return { key: grp, name: cityFrom(first.place ?? '', grp), dates: span, items };
    })
    .sort((a, b) => a.items[0].mo - b.items[0].mo || a.items[0].day - b.items[0].day);
}

/**
 * The group-plan strip, and the ONLY place a new plan starts. It lives here
 * rather than in the header because "start a plan" is a thing you do while
 * looking at the plan, and a second entry point elsewhere is how people end up
 * with two half-built plans.
 */
function PartyStrip() {
  const plans = useApp((s) => s.plans);
  return (
    <div style={{ margin: '12px 12px 4px' }}>
      {/* NEW PLAN stands alone at the top; the plans themselves are listed
          below it as their own tappable rows — a button that also pretends to
          be the current plan was doing two jobs badly. */}
      <div
        {...pressable(() => store.set({ planId: null, partyOpen: true }))}
        className="press"
        style={{
          cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff',
          fontWeight: 700, fontSize: 11.5, letterSpacing: '.06em', padding: '12px 14px', textAlign: 'center',
          boxShadow: '0 4px 14px rgba(236,48,19,.28)',
        }}
      >
        + NEW PLAN
      </div>
      {plans.map((p) => (
        <div
          key={p.id}
          {...pressable(() => { void openPlan(p.id); store.set({ partyOpen: true }); })}
          className="glass lift"
          style={{ cursor: 'pointer', marginTop: 8, borderRadius: 'var(--r-lg)', padding: 12, display: 'flex', gap: 11, alignItems: 'center' }}
        >
          <div style={{ width: 38, height: 38, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <UsersIcon size={17} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5 }}>{p.title}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>
              {p.starts_on ? `${p.starts_on}${p.starts_time ? ` · ${p.starts_time}` : ''} · ` : ''}
              {p.members ?? 1} in · {p.items ?? 0} {p.items === 1 ? 'item' : 'items'} · tap for details & chat
            </div>
          </div>
          <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
        </div>
      ))}
      {plans.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--ink-60)', margin: '10px 4px 0', lineHeight: 1.5 }}>
          No dates and no bookings needed — start a plan, pull friends in, decide together.
        </div>
      )}
    </div>
  );
}

export default function PlanView() {
  const bookings = useApp((s) => s.bookings);
  const demo = useApp((s) => s.demo);
  const groups = groupsFor(demo, bookings);
  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
      {!demo && <PartyStrip />}
      {groups.map(({ key, name, dates, items }) => (
        <div key={key}>
          <div style={{ padding: '18px 18px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14, letterSpacing: '.05em' }}>
              {name}
              <span style={{ display: 'block', width: 28, height: 3, borderRadius: 999, background: 'var(--grad-accent)', marginTop: 3 }} />
            </span>
            <span style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-60)' }}>{dates}</span>
          </div>
          {items.map((b) => (
            <BookingRow key={b.id} b={b} />
          ))}
        </div>
      ))}
      <div style={{ padding: '12px 20px 16px', fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.5, textAlign: 'center' }}>
        {groups.length === 0
          ? 'Nothing planned yet. Tell Num where you are and what you feel like — bookings land here by themselves.'
          : 'Nothing to add here — new plans come from the thread. Ask, and it appears.'}
      </div>
    </div>
  );
}
