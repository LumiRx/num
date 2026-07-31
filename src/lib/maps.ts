// Directions, and the only question that actually matters about them: what
// time do I need to leave?
//
// We hold no Directions API key, so Num does not invent a live traffic figure.
// What it does instead is honest and, for a traveller, usually enough: open the
// route in the maps app they already use with the arrival time set, and reason
// out loud about the local traffic pattern (the ride specialist is good at
// this) so they get a leave-by time rather than a distance.
import type { Booking } from './types';

export type MapsApp = 'apple' | 'google';

/** Apple Maps on Apple hardware, Google everywhere else. */
export function preferredMaps(): MapsApp {
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod|Macintosh/.test(ua) && !/CriOS|Chrome/.test(ua);
  return apple ? 'apple' : 'google';
}

/**
 * A directions link. `arriveBy` is passed where the platform supports it —
 * Google honours it on transit and shows a traffic-aware ETA for driving.
 */
export function directionsUrl(destination: string, opts: { app?: MapsApp; mode?: 'driving' | 'walking' | 'transit'; arriveBy?: Date } = {}): string {
  const app = opts.app ?? preferredMaps();
  const dest = encodeURIComponent(destination);
  const mode = opts.mode ?? 'driving';
  if (app === 'apple') {
    // dirflg: d driving, w walking, r transit
    const flag = mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : 'd';
    return `https://maps.apple.com/?daddr=${dest}&dirflg=${flag}`;
  }
  const arrive = opts.arriveBy ? `&arrival_time=${Math.floor(opts.arriveBy.getTime() / 1000)}` : '';
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=${mode}${arrive}`;
}

/** Live traffic view around the destination — the "is it bad right now" check. */
export const trafficUrl = (destination: string): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destination)}&layer=traffic`;

/** The next thing with a real place attached — what a directions widget is for. */
export function nextWithPlace(bookings: Booking[], meetings: Array<{ mo: number; day: number; time: string; title: string; place: string }>): {
  title: string; place: string; when: Date; kind: 'booking' | 'meeting';
} | null {
  const now = new Date();
  const year = now.getFullYear();
  const toDate = (mo: number, day: number, time: string) => {
    const [h, m] = (time ?? '00:00').split(':').map(Number);
    return new Date(year, (mo || 1) - 1, day || 1, h || 0, m || 0);
  };
  const all = [
    ...bookings.filter((b) => b.status !== 'cancelled' && b.place).map((b) => ({ title: b.title, place: b.place, when: toDate(b.mo, b.day, b.time), kind: 'booking' as const })),
    ...meetings.filter((m) => m.place).map((m) => ({ title: m.title, place: m.place, when: toDate(m.mo, m.day, m.time), kind: 'meeting' as const })),
  ]
    .filter((x) => x.when.getTime() > now.getTime() - 3600_000)
    .sort((a, b) => a.when.getTime() - b.when.getTime());
  return all[0] ?? null;
}
