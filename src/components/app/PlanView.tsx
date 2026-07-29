// PLAN tab — bookings grouped by city, expandable rows with note, cost,
// receipt, and the ASK TO CHANGE / SHARE actions.
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { tagOf, bookingMetaLine } from '../../lib/derive';
import { askToChange } from '../../lib/concierge';
import { PLAN_GROUPS } from '../../lib/data';
import type { Booking } from '../../lib/types';

const sortB = (a: Booking, b: Booking) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time);

function BookingRow({ b }: { b: Booking }) {
  const exp = useApp((s) => s.expanded === b.id);
  const tag = tagOf(b);
  const cancelled = b.status === 'cancelled';
  return (
    <div
      {...pressable(() => store.set((s) => ({ expanded: s.expanded === b.id ? null : b.id })))}
      aria-expanded={exp}
      className="hov-neutral-100"
      style={{ cursor: 'pointer', borderBottom: '1px solid var(--color-neutral-300)', padding: '11px 16px' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <div
          style={{
            fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3,
            textDecoration: cancelled ? 'line-through' : 'none',
            color: cancelled ? 'var(--color-neutral-500)' : 'var(--color-text)',
          }}
        >
          {b.title}
        </div>
        <span style={tag.st}>{tag.label}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', marginTop: 3 }}>{bookingMetaLine(b)}</div>
      {exp && (
        <div style={{ marginTop: 9, borderLeft: '2px solid var(--color-accent)', paddingLeft: 10 }}>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-neutral-800)' }}>{b.note}</div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', marginTop: 4 }}>{b.cost}</div>
          {b.receipt && (
            <div style={{ fontSize: 10, letterSpacing: '.08em', fontWeight: 700, color: 'var(--color-accent-700)', marginTop: 4 }}>
              RECEIPT FILED · {b.receipt}
            </div>
          )}
          <div style={{ display: 'flex', gap: 14, marginTop: 9 }}>
            <span
              {...pressable((e) => { e.stopPropagation(); askToChange(b.title); })}
              style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)', cursor: 'pointer' }}
            >
              ASK TO CHANGE
            </span>
            <span
              {...pressable((e) => { e.stopPropagation(); store.set({ shareOpen: true }); })}
              style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)', cursor: 'pointer' }}
            >
              SHARE
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlanView() {
  const bookings = useApp((s) => s.bookings);
  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
      {PLAN_GROUPS.map(([name, dates, grp]) => (
        <div key={grp}>
          <div style={{ padding: '16px 16px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '2px solid var(--color-text)' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15, letterSpacing: '.06em' }}>{name}</span>
            <span style={{ fontSize: 10.5, letterSpacing: '.1em', color: 'var(--color-neutral-600)' }}>{dates}</span>
          </div>
          {bookings.filter((b) => b.grp === grp).sort(sortB).map((b) => (
            <BookingRow key={b.id} b={b} />
          ))}
        </div>
      ))}
      <div style={{ padding: '14px 16px', fontSize: 11.5, color: 'var(--color-neutral-600)', lineHeight: 1.5 }}>
        Nothing to add here — new plans come from the thread. Ask, and it appears.
      </div>
    </div>
  );
}
