// Pure derivation helpers ported from Concierge.dc.html renderVals() —
// tag styling, date formatting, calendar cells, and the day-timeline lane layout.
import type { CSSProperties } from 'react';
import type { AppState, Booking, BookingStatus, Meeting, TagKind } from './types';
import { selKey, withLine } from './agenda';

export interface Tag {
  label: string;
  st: CSSProperties;
}

// Liquid NUM: soft rounded pills, tinted per status — lively but quiet.
const tagBase: CSSProperties = {
  fontSize: 8.5,
  letterSpacing: '.07em',
  fontWeight: 700,
  padding: '3px 8px',
  borderRadius: 999,
  whiteSpace: 'nowrap',
  flex: 'none',
};

export function tagOf(b: Booking | TagKind): Tag {
  const status: TagKind = typeof b === 'string' ? b : b.status;
  const holdBy = typeof b === 'string' ? undefined : b.holdBy;
  const map: Record<TagKind, Tag> = {
    confirmed: { label: 'CONFIRMED', st: { ...tagBase, background: 'rgba(56,161,105,.14)', color: '#1f7a48', border: '1px solid rgba(56,161,105,.25)' } },
    hold: { label: 'HOLD' + (holdBy ? ' · BY ' + holdBy : ''), st: { ...tagBase, background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 2px 8px rgba(236,48,19,.3)' } },
    deposit: { label: 'DEPOSIT PAID', st: { ...tagBase, background: 'rgba(214,158,46,.16)', color: '#9a6a12', border: '1px solid rgba(214,158,46,.3)' } },
    rebooked: { label: 'REBOOKED', st: { ...tagBase, background: 'var(--grad-ink)', color: '#fff' } },
    cancelled: { label: 'CANCELLED', st: { ...tagBase, background: 'var(--ink-08)', color: 'var(--ink-40)' } },
    meeting: { label: 'MEETING · SYNCED', st: { ...tagBase, background: 'rgba(71,85,105,.12)', color: '#3b4a5f', border: '1px solid rgba(71,85,105,.22)' } },
    memory: { label: 'MEMORY', st: { ...tagBase, background: 'rgba(161,140,209,.16)', color: '#6b4fa8', border: '1px solid rgba(161,140,209,.3)' } },
    bill: { label: 'BILL · DUE', st: { ...tagBase, background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 2px 8px rgba(236,48,19,.3)' } },
    paid: { label: 'PAID', st: { ...tagBase, background: 'var(--grad-ink)', color: '#fff' } },
    shared: { label: 'SHARED', st: { ...tagBase, background: 'var(--grad-ink)', color: '#fff' } },
  };
  return map[status] ?? map.confirmed;
}

export const mtgTag: CSSProperties = {
  ...tagBase,
  background: 'rgba(71,85,105,.12)',
  color: '#3b4a5f',
  border: '1px solid rgba(71,85,105,.22)',
};

export const memTag: CSSProperties = {
  ...tagBase,
  background: 'rgba(161,140,209,.16)',
  color: '#6b4fa8',
  border: '1px solid rgba(161,140,209,.3)',
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/** The demo trip lives in a fixed Jul/Aug 2026; real trips live in the actual
 *  current + next month, anywhere in the world. */
const DEMO_YEAR = 2026;

function yearFor(demo: boolean, mo: number): number {
  if (demo) return DEMO_YEAR;
  const now = new Date();
  // mo is current or next calendar month; December wraps into next January.
  return now.getMonth() === 11 && mo === 1 ? now.getFullYear() + 1 : now.getFullYear();
}

/** Weekday short name, demo-aware ('Tue' for demo 7/28). */
export function wd(demo: boolean, mo: number, day: number): string {
  return new Date(yearFor(demo, mo), mo - 1, day).toLocaleDateString('en-GB', { weekday: 'short' });
}

export function monthName(mo: number): string {
  return MONTH_SHORT[mo - 1] ?? '';
}

export function bookingMetaLine(demo: boolean, b: Booking): string {
  return wd(demo, b.mo, b.day) + ' ' + b.day + ' ' + monthName(b.mo) + ' · ' + b.time + (b.place ? ' · ' + b.place : '');
}

// ── Calendar ────────────────────────────────────────────────────────────────

export interface MonthDef {
  t: string;
  mo: number;
  days: number;
  lead: number; // blank cells before day 1 (Monday-first grid)
  todayDay: number | null;
}

function monthDef(y: number, mo: number, todayDay: number | null): MonthDef {
  return {
    t: `${MONTH_LONG[mo - 1]} ${y}`,
    mo,
    days: new Date(y, mo, 0).getDate(),
    lead: (new Date(y, mo - 1, 1).getDay() + 6) % 7,
    todayDay,
  };
}

/** The two months the calendar shows. Demo: the scripted Jul/Aug 2026 with
 *  "today" pinned to the 28th. Real: the user's actual current + next month. */
export function monthsFor(demo: boolean): MonthDef[] {
  if (demo) return [monthDef(DEMO_YEAR, 7, 28), monthDef(DEMO_YEAR, 8, null)];
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const next = mo === 12 ? monthDef(y + 1, 1, null) : monthDef(y, mo + 1, null);
  return [monthDef(y, mo, now.getDate()), next];
}

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
  const M = monthsFor(s.demo)[s.calM];
  const byDay: Record<string, number> = {};
  s.bookings.forEach((b) => {
    if (b.status !== 'cancelled') {
      const k = b.mo + '-' + b.day;
      byDay[k] = (byDay[k] || 0) + 1;
    }
  });
  // Friends' plans and events you're going to put a dot on the day too —
  // a day that looks empty in the grid and has three friends' dinners on it
  // is the calendar lying. Mirrored bookings are already counted above.
  for (const i of s.agenda?.items ?? []) {
    if (s.bookings.some((b) => b.id === 'grp_' + i.id.slice(-8))) continue;
    const k = selKey(i.day);
    byDay[k] = (byDay[k] || 0) + 1;
  }
  for (const e of s.agenda?.events ?? []) {
    const k = selKey(e.day);
    byDay[k] = (byDay[k] || 0) + 1;
  }
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
      today: M.todayDay !== null && d === M.todayDay,
      past: M.todayDay !== null && d < M.todayDay,
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
  kind: 'plan' | 'meet' | 'group' | 'event';
  title: string;
  place: string;
  timespan: string;
  tag: Tag;
  lane: number;
  lanes: number;
  top: number;
  height: number;
  /** Who it's with — "Sam, Viv +2" for a plan item, "6 going" for an event. */
  who?: string;
  /** The plan it belongs to, for the coloured tag and the tap. */
  planId?: string;
  planTitle?: string;
}

/**
 * The other plans' things and the events on this day (lib/agenda.ts), shaped
 * like the diary's own entries. A plan item that is ALREADY on the diary as a
 * mirrored booking (grp_<tail of item id>, or tbl_<request id> for a venue-
 * confirmed table) is dropped here, so a shared dinner draws once — with the
 * people — rather than twice.
 */
function agendaOnDay(s: AppState, selDay: string) {
  const ag = s.agenda;
  if (!ag) return { items: [] as Array<Booking & { kind: 'group'; who: string; planId: string; planTitle: string }>, events: [] as Array<Booking & { kind: 'event'; who: string }>, shadowed: new Set<string>() };
  const meId = s.me?.id ?? null;
  const shadowed = new Set<string>();
  const items = ag.items
    .filter((i) => selKey(i.day) === selDay && i.time)
    .map((i) => {
      shadowed.add('grp_' + i.id.slice(-8));
      if (i.id.startsWith('itm_tbl_')) shadowed.add('tbl_' + i.id.slice('itm_tbl_'.length));
      const [, m, d] = i.day.split('-').map(Number);
      return {
        id: 'ag_' + i.id, mo: m, day: d, time: i.time as string, dur: 90, place: i.address || i.place || '', title: i.title,
        grp: 'BKK' as const, status: (i.status === 'confirmed' ? 'confirmed' : 'hold') as BookingStatus, note: '', cost: '',
        kind: 'group' as const, who: withLine(i.with, meId), planId: i.plan_id, planTitle: i.plan_title,
      };
    });
  const events = ag.events
    .filter((e) => selKey(e.day) === selDay && e.time)
    .map((e) => {
      const [, m, d] = e.day.split('-').map(Number);
      return {
        id: 'ev_' + e.id, mo: m, day: d, time: e.time as string, dur: 150, place: e.address || e.place || '', title: e.title,
        grp: 'BKK' as const, status: 'confirmed' as BookingStatus, note: '', cost: '',
        kind: 'event' as const, who: e.my_part === 'host' ? `${e.going} going · you host` : `${e.host_name || 'a friend'} hosts · ${e.going} going`,
      };
    });
  return { items, events, shadowed };
}

const toMin = (t: string) => {
  const p = t.split(':');
  return +p[0] * 60 + +p[1];
};

const fmtM = (m: number) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

export function dayTimeline(s: AppState): TimelineEvent[] {
  if (!s.selDay) return [];
  const ag = agendaOnDay(s, s.selDay);
  const dayEvs = [
    ...s.bookings
      .filter((b) => b.mo + '-' + b.day === s.selDay && b.status !== 'cancelled' && !ag.shadowed.has(b.id))
      .map((b) => ({ ...b, kind: 'plan' as const, dur: b.dur || 90, who: undefined as string | undefined, planId: undefined as string | undefined, planTitle: undefined as string | undefined })),
    ...s.meetings
      .filter((m) => m.mo + '-' + m.day === s.selDay)
      .map((m) => ({ ...m, kind: 'meet' as const, dur: m.dur || 45, who: undefined as string | undefined, planId: undefined as string | undefined, planTitle: undefined as string | undefined })),
    ...ag.items.map((i) => ({ ...i })),
    ...ag.events.map((e) => ({ ...e, planId: undefined as string | undefined, planTitle: undefined as string | undefined })),
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
        : e.kind === 'event'
          ? { label: 'EVENT', st: mtgTag }
          : e.kind === 'group'
            // The plan's name, quietly — the card is about the thing, the tag
            // says which plan it belongs to. Never the loud HOLD gradient.
            ? { label: (e.planTitle ?? 'PLAN').toUpperCase().slice(0, 14), st: { ...mtgTag, background: 'rgba(14,164,131,.12)', color: 'var(--color-accent-700)', border: '1px solid rgba(14,164,131,.22)', maxWidth: '48%', overflow: 'hidden', textOverflow: 'ellipsis', flex: 'none' } }
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
      height: Math.max((e._e - e._s) * TL_PPM, e.who ? 46 : 34),
      who: e.who,
      planId: e.planId,
      planTitle: e.planTitle,
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
  const months = monthsFor(s.demo);
  const cur = months[0];
  const selPast = !!parts && cur.todayDay !== null && +parts[0] === cur.mo && +parts[1] < cur.todayDay;
  // The demo trip's scripted itinerary; a real trip shows the user's place.
  const demoCityOf = (mo: number, d: number) =>
    mo === 7
      ? d < 31 ? 'BANGKOK' : 'BANGKOK → PHUKET'
      : d < 5 ? 'PHUKET'
      : d === 5 ? 'PHUKET → SINGAPORE'
      : d <= 8 ? 'SINGAPORE'
      : d === 14 || d === 15 ? 'KOH PHANGAN'
      : '';
  const city = !parts || selPast ? '' : s.demo ? demoCityOf(+parts[0], +parts[1]) : (s.place ?? '').toUpperCase();
  return {
    label: parts
      ? (wd(s.demo, +parts[0], +parts[1]) + ' ' + parts[1] + ' ' + monthName(+parts[0])).toUpperCase()
      : 'TAP A DAY',
    city,
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
  if (s.demo) return { tag: 'TONIGHT', line: 'Dinner — Le Du', meta: '19:30 · counter seats · table held to 19:45', pulse: false, red: false };
  // Real trip: surface the next upcoming booking, or a quiet idle card.
  const next = [...s.bookings]
    .filter((b) => b.status !== 'cancelled')
    .sort((a, b) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time))[0];
  return next
    ? { tag: 'NEXT UP', line: next.title, meta: `${wd(false, next.mo, next.day)} ${next.day} ${monthName(next.mo)} · ${next.time}${next.place ? ' · ' + next.place : ''}`, pulse: false, red: false }
    : { tag: 'READY', line: 'NUM is watching your trip', meta: 'Nothing needs you right now', pulse: false, red: false };
}

// ── Shared sheet/segment styles ─────────────────────────────────────────────

// Sheets rise as rounded glass panels; pair with className="glass-strong".
export const sheetBase: CSSProperties = {
  position: 'absolute',
  left: 6,
  right: 6,
  bottom: 0,
  borderRadius: 'var(--r-xl) var(--r-xl) 0 0',
  overflow: 'hidden',
  zIndex: 60,
  // The home indicator sits ON the bottom 34pt of the screen, and every sheet
  // is pinned to bottom: 0 of a viewport-fit=cover web view. Without this the
  // last control in the sheet — which on the sign-up sheet is the button that
  // creates the account — is half under the bar that swipes you out of the
  // app. Padding rather than `bottom`, so the glass still reaches the true
  // edge and only the CONTENT is held clear.
  // max(): on a device with no home indicator --sab is 0px and a sheet whose
  // last row touches the frame looks unfinished, so keep a floor of 10px.
  paddingBottom: 'max(var(--sab, 0px), 10px)',
  // Focusing an input inside a scrolling sheet makes the browser scroll it
  // into view flush against the container edge, which on a short sheet means
  // the field lands under its own padding. Ask for a margin on both ends.
  scrollPaddingBottom: 16,
  scrollPaddingTop: 12,
  // A sheet may never grow into the status bar. Every call site sets its own
  // maxHeight as a percentage of the shell, which is fine when the keyboard
  // is down — and still fine when it is up, because --kb pads the shell so a
  // percentage is taken of the space actually left above the keyboard. This
  // is the ceiling that survives both: never taller than the shell minus the
  // notch and a hairline of breathing room.
  maxHeight: 'calc(100% - var(--sat, 0px) - 8px)',
  // visibility rides the same clock so a closed sheet leaves the
  // accessibility tree after the slide-out instead of lingering off-screen
  // One spring for every sheet (motion pack, 17 Sep): 320 ms, overshoot-free.
  transition: 'transform .32s cubic-bezier(.3,1,.4,1), visibility .32s',
};

/** The drag-handle grabber every sheet shows at its top. */
export const grabberStyle: CSSProperties = {
  width: 40,
  height: 4.5,
  borderRadius: 999,
  background: 'var(--ink-12)',
  margin: '8px auto 2px',
  flex: 'none',
};

export const segStyle = (on: boolean): CSSProperties => ({
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  // 44px — Apple's floor for a tap target, and the bar is the most-tapped
  // thing on the screen (18 Sep 2026 audit: it measured 35px).
  minHeight: 44,
  padding: '0 4px',
  fontSize: 11,
  letterSpacing: '.1em',
  fontWeight: 700,
  cursor: 'pointer',
  borderRadius: 999,
  background: on ? 'var(--grad-accent)' : 'transparent',
  color: on ? '#fff' : 'var(--ink-60)',
  boxShadow: on ? '0 3px 12px rgba(236,48,19,.3)' : 'none',
  transition: 'background .25s ease, color .25s ease, box-shadow .25s ease',
});

export const checkboxStyle = (on: boolean): CSSProperties => ({
  width: 24,
  height: 24,
  borderRadius: 8,
  border: on ? 'none' : '1.5px solid var(--ink-12)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: on ? 'var(--grad-accent)' : 'rgba(255,255,255,.7)',
  color: '#fff',
  flex: 'none',
  boxShadow: on ? '0 2px 8px rgba(236,48,19,.3)' : 'none',
  transition: 'background .2s ease, box-shadow .2s ease',
});
