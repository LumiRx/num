// Calendar sheet — month grid with plan/meeting dots, the Google Calendar
// footer, and the selected day's visual timeline (lane-packed blocks).
import { useRef } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import {
  MONTHS, calendarCells, dayTimeline, timelineHours, timelineHeight, selDayInfo, sheetBase,
} from '../../lib/derive';
import type { CalCell } from '../../lib/derive';

function DayCell({ d }: { d: CalCell }) {
  if (!d.dayKey) return <div style={{ minHeight: 34 }} />;
  const dots = [
    ...Array.from({ length: d.planDots }, (_, i) => ({ key: 'p' + i, c: 'var(--color-accent)' })),
    ...Array.from({ length: d.meetDots }, (_, i) => ({ key: 'm' + i, c: 'var(--color-text)' })),
  ];
  return (
    <div
      {...pressable(() => store.set({ selDay: d.dayKey }))}
      style={{
        minHeight: 34, textAlign: 'center', fontSize: 11.5, cursor: 'pointer', paddingTop: 5,
        background: d.sel ? 'var(--color-accent)' : 'transparent',
        color: d.sel ? '#fff' : d.past ? 'var(--color-neutral-400)' : 'var(--color-text)',
        outline: d.today && !d.sel ? '2px solid var(--color-text)' : 'none',
        fontWeight: d.planDots || d.meetDots || d.today ? 700 : 400,
      }}
    >
      <span>{d.n}</span>
      <div style={{ display: 'flex', gap: 2, height: 4, marginTop: 2, justifyContent: 'center' }}>
        {dots.map((x) => (
          <span key={x.key} style={{ width: 4, height: 4, background: d.sel ? '#fff' : x.c, flex: 'none' }} />
        ))}
      </div>
    </div>
  );
}

export default function CalendarSheet() {
  const s = useApp((x) => x);
  const M = MONTHS[s.calM];
  const cells = calendarCells(s);
  const events = dayTimeline(s);
  const sel = selDayInfo(s, events.length);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(s.calOpen, ref);

  return (
    <div ref={ref} style={{ ...sheetBase, height: '80%', display: 'flex', flexDirection: 'column', visibility: s.calOpen ? 'visible' : 'hidden', transform: s.calOpen ? 'translateY(0)' : 'translateY(105%)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '2px solid var(--color-divider)' }}>
        <span {...pressable(() => store.set({ calM: 0 }))} aria-label="Previous month" style={{ cursor: 'pointer', padding: '2px 8px', fontWeight: 700, opacity: s.calM === 0 ? 0.25 : 1 }}>←</span>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16 }}>{M.t}</span>
        <span {...pressable(() => store.set({ calM: 1 }))} aria-label="Next month" style={{ cursor: 'pointer', padding: '2px 8px', fontWeight: 700, opacity: s.calM === 1 ? 0.25 : 1 }}>→</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', padding: '10px 12px 2px', fontSize: 9.5, letterSpacing: '.1em', color: 'var(--color-neutral-500)', textAlign: 'center' }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, padding: '4px 12px 10px' }}>
        {cells.map((d) => <DayCell key={d.key} d={d} />)}
      </div>
      <div style={{ borderTop: '2px solid var(--color-divider)', padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff' }}>
        <span style={{ fontSize: 9.5, letterSpacing: '.1em', fontWeight: 700, color: 'var(--color-neutral-600)' }}>GOOGLE CALENDAR · CONNECTED · 2-WAY</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 9.5, letterSpacing: '.06em', color: 'var(--color-neutral-600)' }}>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><span style={{ width: 5, height: 5, background: 'var(--color-accent)' }} />PLANS</span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><span style={{ width: 5, height: 5, background: 'var(--color-text)' }} />MEETINGS</span>
        </span>
      </div>
      <div className="no-scrollbar" style={{ borderTop: '2px solid var(--color-divider)', flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
              <div key={h.label} style={{ position: 'absolute', left: 0, right: 0, top: h.top, borderTop: '1px solid var(--color-neutral-200)', fontSize: 9, color: 'var(--color-neutral-500)' }}>
                <span style={{ position: 'absolute', top: -6, left: 0, background: 'var(--color-bg)', paddingRight: 4 }}>{h.label}</span>
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
                    background: '#fff',
                    border: '1px solid var(--color-neutral-300)',
                    borderLeft: '3px solid ' + (e.kind === 'meet' ? 'var(--color-text)' : 'var(--color-accent)'),
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
