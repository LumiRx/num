// Flight Watch, from the app's side. The server (worker/flightwatch.mjs) looks
// up, re-checks and pushes; this asks, lists, and turns a snapshot into what
// the card draws: progress along the arc, the sky at the plane, the one line
// that matters right now. Every time on screen is the airline's.
import { store } from './store';
import { apiUrl } from '../lib/apibase';
import { t } from './i18n';

export interface FlightLeg {
  iata: string | null; name: string | null;
  sched: string | null; est: string | null; sched_local: string | null; est_local?: string | null;
  terminal: string | null; gate: string | null; belt?: string | null;
}
export interface FlightSnapshot { number: string; airline: string | null; status: string; dep: FlightLeg; arr: FlightLeg }
export interface FlightWatch { id: string; flight_no: string; date: string; status: 'watching' | 'done' | 'stopped'; flight: FlightSnapshot | null }

const parse = (s: string | null | undefined) => (s ? Date.parse(String(s).replace(' ', 'T')) : NaN);
export const hhmm = (local: string | null | undefined) => (local ? String(local).slice(11, 16) : '—');
const offsetOf = (local: string | null | undefined) => {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(String(local ?? ''));
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};

/** 0 before departure, 1 after arrival, the airline's estimate in between. */
export function progress(f: FlightSnapshot, now = Date.now()): number {
  const dep = parse(f.dep.est ?? f.dep.sched), arr = parse(f.arr.est ?? f.arr.sched);
  if (!Number.isFinite(dep) || !Number.isFinite(arr) || arr <= dep) return 0;
  return Math.max(0, Math.min(1, (now - dep) / (arr - dep)));
}

/** The sky where the plane is: local hour interpolated between the two airports. */
export function sky(f: FlightSnapshot, now = Date.now()): 'dawn' | 'day' | 'dusk' | 'night' {
  const p = progress(f, now);
  const off = offsetOf(f.dep.sched_local) * (1 - p) + offsetOf(f.arr.sched_local) * p;
  const h = ((now / 60000 + off) / 60) % 24;
  if (h >= 5.5 && h < 7.5) return 'dawn';
  if (h >= 7.5 && h < 17.5) return 'day';
  if (h >= 17.5 && h < 19.5) return 'dusk';
  return 'night';
}

export function delayMinutes(f: FlightSnapshot): number {
  const s = parse(f.arr.sched), e = parse(f.arr.est ?? f.arr.sched);
  return Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) / 60000) : 0;
}

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
};

/** The one line that matters now. */
export function headline(f: FlightSnapshot, now = Date.now()): { pill: string; tone: 'ok' | 'late' | 'bad' | 'quiet'; chip: string } {
  const st = f.status.toLowerCase();
  const dep = parse(f.dep.est ?? f.dep.sched), arr = parse(f.arr.est ?? f.arr.sched);
  const late = delayMinutes(f);
  if (/cancel/.test(st)) return { pill: t('Cancelled'), tone: 'bad', chip: t('Ask NUM for the next flights') };
  if (/arrived|landed/.test(st) || (Number.isFinite(arr) && now > arr)) return { pill: t('Landed'), tone: 'ok', chip: f.arr.belt ? `Bags on belt ${f.arr.belt}` : `Landed ${hhmm(f.arr.est_local ?? f.arr.sched_local)}` };
  if (Number.isFinite(dep) && now < dep) {
    const pill = late >= 15 ? `${late} min late` : /boarding/.test(st) ? t('Boarding') : t('On time');
    return { pill, tone: late >= 15 ? 'late' : 'ok', chip: /boarding/.test(st) ? `Boarding${f.dep.gate ? ` at ${f.dep.gate}` : ''}` : `Departs in ${span(dep - now)}` };
  }
  return { pill: late >= 15 ? `${late} min late` : t('In the air'), tone: late >= 15 ? 'late' : 'ok', chip: Number.isFinite(arr) ? `Lands in ${span(arr - now)}` : t('In the air') };
}

export async function refreshFlights(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const res = await fetch(`${apiUrl('/api/flightwatch')}?me=${encodeURIComponent(me.id)}`);
    const body = (await res.json()) as { ok: boolean; watches?: FlightWatch[] };
    if (body.ok) store.set({ flights: body.watches ?? [] });
  } catch { /* the last list stands */ }
}

export async function watchFlight(flightNo: string, date: string): Promise<{ ok: true; watch: FlightWatch } | { ok: false; error: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, error: t('Tell NUM who you are first, so it knows who to ping.') };
  try {
    const res = await fetch(apiUrl('/api/flightwatch'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ me: me.id, flight_no: flightNo, date }) });
    const body = (await res.json()) as { ok: boolean; watch?: FlightWatch; error?: string };
    if (!body.ok || !body.watch) return { ok: false, error: body.error ?? 'Could not start watching that flight.' };
    store.set((s) => ({ flights: [...s.flights.filter((w) => w.id !== body.watch!.id), body.watch!] }));
    return { ok: true, watch: body.watch };
  } catch { return { ok: false, error: t('Offline. Try again in a moment.') }; }
}

export async function stopWatching(id: string): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  store.set((s) => ({ flights: s.flights.filter((w) => w.id !== id) }));
  try { await fetch(apiUrl('/api/flightwatch/stop'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ me: me.id, id }) }); } catch { /* fine */ }
}
