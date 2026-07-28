// Pure derivation helpers ported from Concierge.dc.html renderVals() —
// tag styling, date formatting, calendar cells, and the day-timeline lane layout.
import type { CSSProperties } from 'react';
import type { AppState, Booking, Meeting, TagKind } from './types';

export interface Tag {
  label: string;
  st: CSSProperties;
}

const tagBase: CSSProperties = {
  fontSize: 8,
  letterSpacing: '.08em',
  fontWeight: 700,
  padding: '2px 5px',
  whiteSpace: 'nowrap',
  flex: 'none',
};

export function tagOf(b: Booking | TagKind): Tag {
  const status: TagKind = typeof b === 'string' ? b : b.status;
  const holdBy = typeof b === 'string' ? undefined : b.holdBy;
  const map: Record<TagKind, Tag> = {
    confirmed: { label: 'CONFIRMED', st: { ...tagBase, border: '2px solid var(--color-text)', color: 'var(--color-text)' } },
    hold: { label: 'HOLD' + (holdBy ? ' · BY ' + holdBy : ''), st: { ...tagBase, background: 'var(--color-accent)', color: '#fff' } },
    deposit: { label: 'DEPOSIT PAID', st: { ...tagBase, background: 'var(--color-accent-100)', color: 'var(--color-accent-700)', border: '2px solid var(--color-accent-300)' } },
    rebooked: { label: 'REBOOKED', st: { ...tagBase, background: 'var(--color-text)', color: '#fff' } },
    cancelled: { label: 'CANCELLED', st: { ...tagBase, border: '2px solid var(--color-neutral-400)', color: 'var(--color-neutral-500)' } },
    meeting: { label: 'MEETING · SYNCED', st: { ...tagBase, border: '2px solid var(--color-text)', color: 'var(--color-text)', background: '#fff' } },
    memory: { label: 'MEMORY', st: { ...tagBase, border: '2px solid var(--color-neutral-400)', color: 'var(--color-neutral-600)' } },
    bill: { label: 'BILL · DUE', st: { ...tagBase, background: 'var(--color-accent)', color: '#fff' } },
    paid: { label: 'PAID', st: { ...tagBase, background: 'var(--color-text)', color: '#fff' } },
    shared: { label: 'SHARED', st: { ...tagBase, background: 'var(--color-text)', color: '#fff' } },
  };
  return map[status] ?? map.confirmed;
}

export const mtgTag: CSSProperties = {
  ...tagBase,
  border: '2px solid var(--color-text)',
  color: 'var(--color-text)',
  background: '#fff',
};

export const memTag: CSSProperties = {
  ...tagBase,
  border: '2px solid var(--color-neutral-400)',
  color: 'var(--color-neutral-600)',
};

/** Weekday short name for a 2026 date, e.g. wd(7, 28) === 'Tue'. */
export function wd(mo: number, day: number): string {
  return new Date(2026, mo - 1, day).toLocaleDateString('en-GB', { weekday: 'short' });
}

export function monthName(mo: number): string {
  return mo === 7 ? 'Jul' : 'Aug';
}

export function bookingMetaLine(b: Booking): string {
  return wd(b.mo, b.day) + ' ' + b.day + ' ' + monthName(b.mo) + ' · ' + b.time + (b.place ? ' · ' + b.place : '');
}

// ── Calendar ────────────────────────────────────────────────────────────────

export interface MonthDef {
  t: string;
  mo: number;
  days: number;
  lead: number; // blank cells before day 1 (Monday-first grid)
}

export const MONTHS: MonthDef[] = [
  { t: 'JULY 2026', mo: 7, days: 31, lead: 2 },
  { t: 'AUGUST 2026', mo: 8, days: 31, lead: 5 },
];

export interface CalCell {
  key: string;
  n: string;
  dayKey: string | null; // 'mo-day' or null for lead blanks
  planDots: number;
  meetDots: number;
  sel: boolean;
  today: boolean;
  past: boolean;
}

export function calendarCells(s: AppState): CalCell[] {
  const M = MONTHS[s.calM];
  const byDay: Record<string, number> = {};
  s.bookings.forEach((b) => {
    if (b.status !== 'cancelled') {
      const k = b.mo + '-' + b.day;
      byDay[k] = (byDay[k] || 0) + 1;
    }
  });
  const byMeet: Record<string, number> = {};
  s.meetings.forEach((m) => {
    const k = m.mo + '-' + m.day;
    byMeet[k] = (byMeet[k] || 0) + 1;
  });
  const cells: CalCell[] = [];
  for (let i = 0; i < M.lead; i++) {
    cells.push({ key: 'lead' + i, n: '', dayKey: null, planDots: 0, meetDots: 0, sel: false, today: false, past: false });
  }
  for (let d = 1; d <= M.days; d++) {
    const k = M.mo + '-' + d;
    cells.push({
      key: k,
      n: String(d),
      dayKey: k,
      planDots: Math.min(byDay[k] || 0, 3),
      meetDots: Math.min(byMeet[k] || 0, 2),
      sel: s.selDay === k,
      today: M.mo === 7 && d === 28,
      past: M.mo === 7 && d < 28,
    });
  }
  return cells;
}

// ── Day timeline (lane layout) ──────────────────────────────────────────────

export const TL_START = 8 * 60;
export const TL_END = 23 * 60;
export const TL_PPM = 0.6; // pixels per minute

export interface TimelineEvent {
  key: string;
  kind: 'plan' | 'meet';
  title: string;
  place: string;
  timespan: string;
  tag: Tag;
  lane: number;
  lanes: number;
  top: number;
  height: number;
}

const toMin = (t: string) => {
  const p = t.split(':');
  return +p[0] * 60 + +p[1];
};

const fmtM = (m: number) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

export function dayTimeline(s: AppState): TimelineEvent[] {
  if (!s.selDay) return [];
  const dayEvs = [
    ...s.bookings
      .filter((b) => b.mo + '-' + b.day === s.selDay && b.status !== 'cancelled')
      .map((b) => ({ ...b, kind: 'plan' as const, dur: b.dur || 90 })),
    ...s.meetings
      .filter((m) => m.mo + '-' + m.day === s.selDay)
      .map((m) => ({ ...m, kind: 'meet' as const, dur: m.dur || 45 })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  // Greedy lane packing: place each event in the first lane free at its start.
  const lanes: number[] = [];
  const laid = dayEvs.map((e) => {
    const st = Math.max(toMin(e.time), TL_START);
    const en = Math.min(st + e.dur, TL_END);
    let li = lanes.findIndex((x) => x <= st);
    if (li < 0) {
      li = lanes.length;
      lanes.push(0);
    }
    lanes[li] = en;
    return { ...e, _s: st, _e: en, lane: li };
  });
  const nL = Math.max(lanes.length, 1);

  return laid.map((e) => {
    const tag: Tag =
      e.kind === 'meet'
        ? { label: (e as Meeting & { kind: 'meet' }).src === 'NUM' ? 'NUM' : 'GCAL', st: mtgTag }
        : tagOf(e as Booking);
    return {
      key: e.id,
      kind: e.kind,
      title: e.title,
      place: e.place || '',
      timespan: e.time + '–' + fmtM(e._e),
      tag,
      lane: e.lane,
      lanes: nL,
      top: (e._s - TL_START) * TL_PPM,
      height: Math.max((e._e - e._s) * TL_PPM, 34),
    };
  });
}

export function timelineHours(): Array<{ label: string; top: number }> {
  const out: Array<{ label: string; top: number }> = [];
  for (let h = 8; h <= 22; h += 2) out.push({ label: String(h).padStart(2, '0'), top: (h * 60 - TL_START) * TL_PPM });
  return out;
}

export const timelineHeight = (TL_END - TL_START) * TL_PPM + 20;

// ── Selected-day header ─────────────────────────────────────────────────────

export function selDayInfo(s: AppState, eventCount: number) {
  const parts = s.selDay ? s.selDay.split('-') : null;
  const selPast = !!parts && +parts[0] === 7 && +parts[1] < 28;
  const cityOf = (mo: number, d: number) =>
    mo === 7
      ? d < 31 ? 'BANGKOK' : 'BANGKOK → PHUKET'
      : d < 5 ? 'PHUKET'
      : d === 5 ? 'PHUKET → SINGAPORE'
      : d <= 8 ? 'SINGAPORE'
      : d === 14 || d === 15 ? 'KOH PHANGAN'
      : '';
  return {
    label: parts ? (wd(+parts[0], +parts[1]) + ' ' + parts[1] + ' ' + (+parts[0] === 7 ? 'JUL' : 'AUG')).toUpperCase() : 'TAP A DAY',
    city: parts && !selPast ? cityOf(+parts[0], +parts[1]) : '',
    count: parts ? (eventCount === 1 ? '1 THING' : eventCount + ' THINGS') : '',
    emptyText: selPast
      ? 'Nothing kept from this day — older days live under MEMORY.'
      : 'Nothing here yet. Ask me and it’ll appear — there’s no booking form, and that’s the point.',
  };
}

// ── Live Activity (lock screen) ─────────────────────────────────────────────

export interface LiveActivity {
  tag: string;
  line: string;
  meta: string;
  pulse: boolean;
  red: boolean;
}

export function liveActivity(s: AppState): LiveActivity {
  if (s.disr === 'active') return { tag: 'DISRUPTION', line: 'Phi Phi ferry cancelled', meta: 'Two rebook options in your thread', pulse: true, red: true };
  if (s.disr === 'rebooked') return { tag: 'REBOOKED', line: 'Phi Phi — sorted', meta: (s.laLine || '') + ' · return 16:30 unchanged', pulse: false, red: false };
  return { tag: 'TONIGHT', line: 'Dinner — Le Du', meta: '19:30 · counter seats · table held to 19:45', pulse: false, red: false };
}

// ── Shared sheet/segment styles ─────────────────────────────────────────────

export const sheetBase: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  background: 'var(--color-bg)',
  borderTop: '2px solid var(--color-text)',
  zIndex: 60,
  // visibility rides the same clock so a closed sheet leaves the
  // accessibility tree after the slide-out instead of lingering off-screen
  transition: 'transform .32s cubic-bezier(.32,.72,.29,.99), visibility .32s',
};

export const segStyle = (on: boolean): CSSProperties => ({
  flex: 1,
  textAlign: 'center',
  padding: '9px 0',
  fontSize: 11,
  letterSpacing: '.12em',
  fontWeight: 700,
  cursor: 'pointer',
  background: on ? 'var(--color-text)' : 'transparent',
  color: on ? '#fff' : 'var(--color-neutral-600)',
});

export const checkboxStyle = (on: boolean): CSSProperties => ({
  width: 22,
  height: 22,
  border: '2px solid var(--color-text)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 700,
  background: on ? 'var(--color-text)' : '#fff',
  color: '#fff',
  flex: 'none',
});
