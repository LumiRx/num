// PLAN tab — bookings grouped by city, expandable rows with note, cost,
// receipt, and the ASK TO CHANGE / SHARE actions.
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { tagOf, bookingMetaLine, monthName } from '../../lib/derive';
import { askToChange } from '../../lib/concierge';
import { PLAN_GROUPS } from '../../lib/data';
import { Scene } from '../../lib/scenes';
import { ChevronRightIcon, UsersIcon } from '../../lib/icons';
import type { Booking } from '../../lib/types';

const sortB = (a: Booking, b: Booking) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time);

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
  const plan = useApp((s) => s.plans.find((p) => p.id === s.planId) ?? null);
  const plans = useApp((s) => s.plans);
  const members = useApp((s) => s.planMembers.length);
  const items = useApp((s) => s.planItems);
  const ideas = items.filter((i) => i.status === 'idea' || i.status === 'proposed').length;
  return (
    <div className="glass lift" style={{ margin: '12px 12px 4px', borderRadius: 'var(--r-lg)', padding: 12 }}>
      <div
        {...pressable(() => store.set({ partyOpen: true }))}
        style={{ cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'center' }}
      >
        <div style={{ width: 38, height: 38, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <UsersIcon size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5 }}>{plan ? plan.title : 'Plan it with friends'}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>
            {plan
              ? `${members || 1} in · ${ideas} ${ideas === 1 ? 'idea' : 'ideas'} · ${items.length - ideas} booked`
              : plans.length
                ? `${plans.length} plan${plans.length === 1 ? '' : 's'} — open one, or start another`
                : 'No dates and no bookings needed — add those together later'}
          </div>
        </div>
        <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
      </div>
      <div
        {...pressable(() => store.set({ planId: null, partyOpen: true }))}
        className="press"
        style={{
          cursor: 'pointer', marginTop: 11, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff',
          fontWeight: 700, fontSize: 11.5, letterSpacing: '.06em', padding: '11px 14px', textAlign: 'center',
          boxShadow: '0 4px 14px rgba(236,48,19,.28)',
        }}
      >
        + NEW PLAN
      </div>
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
