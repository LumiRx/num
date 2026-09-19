// YOUR DAY, ACROSS EVERY PLAN (19 Sep 2026).
//
// The calendar used to draw only what this phone knew: its own bookings and
// meetings. A day with three friends' plans on it looked empty. This reads,
// from the server, everything dated on every plan the member is on — with
// who is IN on each — plus the events they are going to or hosting, for the
// three weeks around today, and hands it to dayTimeline (derive.ts).
import { store } from './store';
import { apiUrl } from './apibase';

export interface AgendaPerson { member_id: string; name: string | null; sure: boolean }
export interface AgendaItem {
  id: string; plan_id: string; plan_title: string; title: string; day: string; time: string | null;
  status: string; kind: string; place: string | null; address: string | null; cost_minor: number | null; currency: string | null;
  with: AgendaPerson[];
}
export interface AgendaEvent {
  id: string; title: string; day: string; time: string | null; place: string | null; address: string | null;
  host_id: string; host_name: string | null; going: number; my_part: 'host' | 'guest';
}
export interface Agenda { items: AgendaItem[]; events: AgendaEvent[]; from: string; to: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Three weeks around today: yesterday through +21 days. */
export function agendaWindow(now = new Date()): { from: string; to: string } {
  const a = new Date(now); a.setDate(a.getDate() - 1);
  const b = new Date(now); b.setDate(b.getDate() + 21);
  return { from: iso(a), to: iso(b) };
}

export async function refreshAgenda(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  const { from, to } = agendaWindow();
  try {
    const res = await fetch(apiUrl('/api/social') + `/agenda?me=${encodeURIComponent(me.id)}&from=${from}&to=${to}`);
    if (!res.ok) return;
    const out = (await res.json()) as { items?: AgendaItem[]; events?: AgendaEvent[] };
    store.set({ agenda: { items: Array.isArray(out.items) ? out.items : [], events: Array.isArray(out.events) ? out.events : [], from, to } });
  } catch (err) {
    console.warn('[agenda]', err);
  }
}

/** "M-D" the way selDay spells a day, from YYYY-MM-DD. */
export const selKey = (day: string): string => {
  const [, m, d] = day.split('-').map(Number);
  return `${m}-${d}`;
};

/** "Sam, Viv +2" — the people on a plan item's card; unsure ones in brackets. */
export function withLine(people: AgendaPerson[], meId: string | null, max = 3): string {
  const others = people.filter((p) => p.member_id !== meId);
  const names = others.map((p) => (p.sure ? (p.name || 'a friend') : `(${p.name || 'a friend'})`));
  const head = names.slice(0, max).join(', ');
  const rest = names.length - max;
  return rest > 0 ? `${head} +${rest}` : head;
}
