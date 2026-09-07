// Calendar files for the things Num confirmed — a table, a plan, an event.
//
// The server builds the .ics (worker/calendar.mjs): floating local times,
// bearer-safe headers, nothing guessed. This only knows the address. The
// member id is the bearer, the same convention as /api/booking/mine.
import { apiUrl } from './apibase';

export type CalendarKind = 'booking' | 'plan' | 'event';

export function calendarUrl(kind: CalendarKind, id: string, me: string): string {
  return `${apiUrl(`/api/calendar/${kind}.ics`)}?id=${encodeURIComponent(id)}&me=${encodeURIComponent(me)}`;
}
