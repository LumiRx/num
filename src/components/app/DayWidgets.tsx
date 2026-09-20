// YOUR DAY — next up, the fortnight, and the trip check.
//
// These three answer one question between them: what am I committed to, and
// does any of it need me? That is the PLAN tab's question, not TODAY's, and
// on 18 Sep 2026 they moved there. TODAY is now the concierge, what is on
// tonight, who is waiting on you and every door NUM opens; PLAN is your own
// calendar and the bookings inside it.
//
// They are exported rather than inlined into PlanView because the server
// still names them in `widgets` and because they are the same three cards
// whichever screen asks for them. DashView keeps their ids mapped — to null —
// so a `widgets` list from an older worker cannot crash the dash.
import { useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { tagOf, monthName } from '../../lib/derive';
import { tripCheck } from '../../lib/prefs';
import { askNum } from '../../lib/concierge';
import { Scene } from '../../lib/scenes';
import { BellIcon, CalendarIcon, CheckIcon, ChevronRightIcon } from '../../lib/icons';
import type { Booking } from '../../lib/types';
import FlightCard from './FlightCard';
import { t } from '../../lib/i18n';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 13 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const h: React.CSSProperties = { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 };
const sortB = (a: Booking, b: Booking) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time);

/**
 * The next thing that actually happens — the single most-wanted fact.
 *
 * `withWatchedFlights` is false on PLAN, where the FLIGHTS section is already
 * on the screen: the watching branch below would otherwise draw the same
 * flight card twice, a few hundred pixels apart, which reads as two flights.
 */
export function NextUp({ withWatchedFlights = true }: { withWatchedFlights?: boolean } = {}) {
  const bookings = useApp((s) => s.bookings);
  const flights = useApp((s) => s.flights);
  const live = bookings.filter((b) => b.status !== 'cancelled').sort(sortB);
  const next = live[0];
  // A watched flight is the one thing everything else waits on, so while
  // NUM is watching one it is NEXT UP, above the first booking.
  if (withWatchedFlights && flights.length) {
    return (
      <div style={{ ...card, padding: 0, background: 'none', border: 0, boxShadow: 'none', display: 'grid', gap: 8 }}>
        <div style={{ ...kicker, padding: '0 2px' }}>{t('NEXT UP · NUM IS WATCHING')}</div>
        {flights.map((w) => <FlightCard key={w.id} w={w} compact />)}
        {next && <NextBooking next={next} />}
      </div>
    );
  }
  if (!next) {
    return (
      <div className="glass" style={card}>
        <div style={kicker}>{t('NEXT UP')}</div>
        <div style={{ ...h, marginTop: 6 }}>{t('Nothing booked yet')}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>{t('Tell NUM where you are and what you feel like — it lands here.')}</div>
      </div>
    );
  }
  return <NextBooking next={next} />;
}

function NextBooking({ next }: { next: Booking }) {
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
        <div style={kicker}>{t('NEXT UP')}</div>
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
export function CalendarStrip() {
  const bookings = useApp((s) => s.bookings);
  const meetings = useApp((s) => s.meetings);
  const today = new Date();
  // THE NEXT WEEK, 18 Sep 2026: seven days (Dre: "it shows 8 days lets just
  // say the next week and have 7 days listed. lets have 5 days and slide for
  // the other two"). Five fill the row — the width is a fifth of the strip
  // less the gaps — and the last two are a slide away, by the page.
  const days = Array.from({ length: 7 }, (_, i) => {
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
        <div style={kicker}>{t('THE NEXT WEEK')}</div>
        <span
          {...pressable(() => store.set((s) => ({ calOpen: true, selDay: s.selDay ?? `${today.getMonth() + 1}-${today.getDate()}` })))}
          style={{ cursor: 'pointer', fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: 'var(--color-accent)', display: 'flex', gap: 4, alignItems: 'center', minHeight: 44, padding: '0 4px', margin: '-12px -4px' }}
        >
          <CalendarIcon size={12} />{' '}{t('FULL CALENDAR')}</span>
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 10, paddingBottom: 2, scrollSnapType: 'x mandatory' }}>
        {days.map((d, i) => {
          const n = busy(d);
          return (
            <div
              key={i}
              {...pressable(() => store.set({ calOpen: true, selDay: `${d.getMonth() + 1}-${d.getDate()}` }))}
              style={{
                cursor: 'pointer', flex: '0 0 calc((100% - 24px) / 5)', scrollSnapAlign: 'start', textAlign: 'center', padding: '8px 0', borderRadius: 12,
                background: n ? 'var(--grad-accent)' : 'var(--field-bg)',
                color: n ? '#fff' : 'var(--ink-60)',
                border: '1px solid ' + (n ? 'transparent' : 'var(--ink-08)'),
              }}
            >
              <div style={{ fontSize: 10, letterSpacing: '.06em', opacity: 0.8 }}>{d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()}</div>
              <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.2 }}>{d.getDate()}</div>
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

/** Trip check — arithmetic done on-device, then handed to NUM to explain. */
export function TripCheck() {
  const state = useApp((s) => s);
  const [open, setOpen] = useState(false);
  const findings = tripCheck(state);
  const clean = findings.length === 1 && /clean|empty/.test(findings[0]);

  return (
    <div className="glass" style={card}>
      <div {...pressable(() => setOpen((v) => !v))} aria-expanded={open} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}>
        <div style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: clean ? 'var(--ok-soft)' : 'var(--accent-12)', color: clean ? 'var(--ok)' : 'var(--color-accent-700)' }}>
          {clean ? <CheckIcon size={15} /> : <BellIcon size={15} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>{t('TRIP CHECK')}</div>
          <div style={{ ...h, marginTop: 3 }}>
            {clean ? t('Nothing needs you') : findings.length === 1 ? t('1 thing to look at') : t('{n} things to look at', { n: findings.length })}
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
            {...pressable(() => { store.set({ threadOpen: true }); void askNum(t('Run a trip check and tell me what needs me.'), { browse: true }); })}
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
