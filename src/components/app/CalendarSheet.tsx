// Calendar sheet — month grid with plan/meeting dots, the Google Calendar
// footer, and the selected day's visual timeline (lane-packed blocks).
import { useRef } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import {
  monthsFor, calendarCells, dayTimeline, timelineHours, timelineHeight, selDayInfo, sheetBase, grabberStyle,
} from '../../lib/derive';
import type { CalCell } from '../../lib/derive';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from '../../lib/icons';

function DayCell({ d }: { d: CalCell }) {
  if (!d.dayKey) return <div style={{ minHeight: 34 }} />;
  const dots = [
    ...Array.from({ length: d.planDots }, (_, i) => ({ key: 'p' + i, c: 'var(--color-accent)' })),
    ...Array.from({ length: d.meetDots }, (_, i) => ({ key: 'm' + i, c: 'var(--color-text)' })),
  ];
  return (
    <div
      {...pressable(() => store.set({ selDay: d.dayKey }))}
      style={{ minHeight: 34, textAlign: 'center', fontSize: 11.5, cursor: 'pointer' }}
    >
      <span
        style={{
          width: 32, height: 32, margin: '0 auto', borderRadius: 999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: d.sel ? 'var(--grad-accent)' : 'transparent',
          color: d.sel ? '#fff' : d.past ? 'var(--ink-40)' : 'var(--ink)',
          boxShadow: d.sel
            ? '0 3px 10px rgba(236,48,19,.35)'
            : d.today
              ? 'inset 0 0 0 1.5px var(--color-accent)'
              : 'none',
          fontWeight: d.planDots || d.meetDots || d.today ? 700 : 400,
        }}
      >
        {d.n}
      </span>
      <div style={{ display: 'flex', gap: 2, height: 4, marginTop: 2, justifyContent: 'center' }}>
        {dots.map((x) => (
          <span key={x.key} style={{ width: 4, height: 4, borderRadius: 999, background: d.sel ? '#fff' : x.c, flex: 'none' }} />
        ))}
      </div>
    </div>
  );
}

export default function CalendarSheet() {
  const s = useApp((x) => x);
  const M = monthsFor(s.demo)[s.calM];
  const cells = calendarCells(s);
  const events = dayTimeline(s);
  const sel = selDayInfo(s, events.length);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(s.calOpen, ref);
  const close = () => store.set({ calOpen: false });

  return (
    <div ref={ref} className="glass-strong" style={{ ...sheetBase, height: '80%', display: 'flex', flexDirection: 'column', visibility: s.calOpen ? 'visible' : 'hidden', transform: s.calOpen ? 'translateY(0)' : 'translateY(105%)' }}>
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 50px 12px', borderBottom: '1px solid var(--ink-08)' }}>
        <span {...pressable(() => store.set({ calM: 0 }))} aria-label="Previous month" className="glass press" style={{ width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: s.calM === 0 ? 0.25 : 1 }}><ChevronLeftIcon size={16} /></span>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16 }}>{M.t}</span>
        <span {...pressable(() => store.set({ calM: 1 }))} aria-label="Next month" className="glass press" style={{ width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: s.calM === 1 ? 0.25 : 1 }}><ChevronRightIcon size={16} /></span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', padding: '10px 12px 2px', fontSize: 9.5, letterSpacing: '.1em', color: 'var(--color-neutral-500)', textAlign: 'center' }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, padding: '4px 12px 10px' }}>
        {cells.map((d) => <DayCell key={d.key} d={d} />)}
      </div>
      <div style={{ borderTop: '1px solid var(--ink-08)', borderBottom: '1px solid var(--ink-08)', padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,.55)' }}>
        <span style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 9.5, letterSpacing: '.1em', fontWeight: 700, color: 'var(--color-neutral-600)' }}><CalendarIcon size={12} />GOOGLE CALENDAR · CONNECTED · 2-WAY</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 9.5, letterSpacing: '.06em', color: 'var(--color-neutral-600)' }}>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--color-accent)' }} />PLANS</span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--color-text)' }} />MEETINGS</span>
        </span>
      </div>
      <div className="no-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ padding: '12px 16px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15 }}>{sel.label}</span>
            <span style={{ fontSize: 9.5, letterSpacing: '.12em', color: 'var(--color-accent-700)', fontWeight: 700 }}>{sel.city}</span>
          </div>
          <span style={{ fontSize: 9.5, letterSpacing: '.1em', color: 'var(--color-neutral-500)' }}>{sel.count}</span>
        </div>
        {!!s.selDay && events.length === 0 && (
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-neutral-700)', padding: '10px 16px' }}>{sel.emptyText}</div>
        )}
        {events.length > 0 && (
          <div style={{ position: 'relative', height: timelineHeight, margin: '8px 16px 20px' }}>
            {timelineHours().map((h) => (
              <div key={h.label} style={{ position: 'absolute', left: 0, right: 0, top: h.top, borderTop: '1px solid var(--ink-08)', fontSize: 9, color: 'var(--ink-40)' }}>
                <span style={{ position: 'absolute', top: -6, left: 0, background: 'transparent', paddingRight: 4 }}>{h.label}</span>
              </div>
            ))}
            <div style={{ position: 'absolute', left: 34, right: 0, top: 0, bottom: 0 }}>
              {events.map((e) => (
                <div
                  key={e.key}
                  style={{
                    position: 'absolute',
                    left: e.lane * (100 / e.lanes) + '%',
                    width: 'calc(' + 100 / e.lanes + '% - 4px)',
                    top: e.top,
                    height: e.height,
                    borderRadius: 10,
                    background: 'rgba(255,255,255,.82)',
                    border: '1px solid var(--ink-08)',
                    borderLeft: '3px solid ' + (e.kind === 'meet' ? 'var(--ink)' : 'var(--color-accent)'),
                    boxShadow: '0 2px 8px rgba(32,30,29,.07)',
                    padding: '5px 8px',
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 11.5, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                    <span style={e.tag.st}>{e.tag.label}</span>
                  </div>
                  <div style={{ fontSize: 9.5, color: 'var(--color-neutral-600)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.timespan} · {e.place}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
