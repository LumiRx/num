// PLAN tab — bookings grouped by city, expandable rows with note, cost,
// receipt, and the ASK TO CHANGE / SHARE actions.
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { tagOf, bookingMetaLine, monthName } from '../../lib/derive';
import { askToChange } from '../../lib/concierge';
import { PLAN_GROUPS } from '../../lib/data';
import { Scene } from '../../lib/scenes';
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
                background: 'rgba(255,255,255,.7)', border: '1px solid var(--ink-12)', color: 'var(--ink)', cursor: 'pointer',
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

export default function PlanView() {
  const bookings = useApp((s) => s.bookings);
  const demo = useApp((s) => s.demo);
  const groups = groupsFor(demo, bookings);
  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
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
