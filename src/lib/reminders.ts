// REMINDERS (19 Sep 2026). "Remind me at six to call the hotel."
//
// Said or typed, the sentence is read HERE, on the phone, and the server is
// handed a time. Deterministic on purpose: a reminder that fires at the wrong
// hour because a model guessed is worse than one that asks. Anything this
// parser cannot read with confidence is not a reminder — it goes to NUM as a
// question like any other sentence, and NUM can ask.
//
// What lands: a row on the server (worker/reminders.mjs) that the cron sends
// by push at the time; a card in the thread now ("heard: …") so a mishearing
// is caught; a block on your day in the calendar; and, when the app is open
// at the hour, a line in the thread as well (startReminderSync).
import { store } from './store';
import { apiUrl } from './apibase';
import type { Msg } from './types';

export interface Reminder {
  id: string;
  text: string;
  /** UTC ISO. */
  due_at: string;
  plan_id: string | null;
  item_id: string | null;
  source: 'voice' | 'text';
  sent_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl('/api/reminders') + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `reminders ${res.status}`);
  return body as T;
}

export async function refreshReminders(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ reminders: Reminder[] }>(`/?me=${encodeURIComponent(me.id)}`);
    store.set({ reminders: Array.isArray(out.reminders) ? out.reminders : [] });
  } catch (err) {
    console.warn('[reminders]', err);
  }
}

export async function addReminder(text: string, due: Date, source: 'voice' | 'text', link: { plan_id?: string | null; item_id?: string | null } = {}): Promise<Reminder> {
  const me = store.get().me;
  if (!me) throw new Error('Add your name first.');
  const out = await api<{ reminder: Reminder }>('/', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, text, due_at: due.toISOString(), source, plan_id: link.plan_id ?? null, item_id: link.item_id ?? null }),
  });
  store.set((s) => ({ reminders: [...(s.reminders ?? []).filter((r) => r.id !== out.reminder.id), out.reminder].sort((a, b) => a.due_at.localeCompare(b.due_at)) }));
  return out.reminder;
}

export async function cancelReminder(id: string): Promise<boolean> {
  const me = store.get().me;
  if (!me) return false;
  const out = await api<{ cancelled: boolean }>('/cancel', { method: 'POST', body: JSON.stringify({ me: me.id, id }) });
  store.set((s) => ({ reminders: (s.reminders ?? []).filter((r) => r.id !== id) }));
  return out.cancelled;
}

// ── reading the sentence ───────────────────────────────────────────────────

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  a: 1, an: 1, half: 0.5, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, 'forty-five': 45,
};
const num = (s: string): number | null => {
  const t = s.toLowerCase().replace(/\s+/g, '');
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return WORDS[t] ?? null;
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The lead-in that makes a sentence a reminder at all. */
const LEAD = /^\s*(?:hey\s+num[,!]?\s*|num[,!]?\s*)?(?:can you\s+|could you\s+|please\s+)?(?:remind me|set (?:me )?a reminder|reminder(?: for me)?)\b[,:]?\s*/i;

export interface ParsedReminder { text: string; due: Date; heard: string }

/**
 * "remind me at six to call the hotel" → { text: 'call the hotel', due: today/tomorrow 18:00 }
 *
 * Time forms understood: "at 6", "at 6pm", "at 6:30", "at 18:00", "at noon",
 * "at midnight", "in 20 minutes", "in 2 hours", "in half an hour",
 * "tomorrow (at 9)", "tonight", "this evening", "this afternoon", "on
 * friday (at 7)", "friday". A bare hour ("at 6") with no am/pm is read as the
 * NEXT such hour: 6 said at 15:00 is 18:00; 6 said at 20:00 is 06:00 tomorrow.
 * A time already gone today rolls to tomorrow. No time → null: NUM asks.
 */
export function parseReminder(input: string, now = new Date()): ParsedReminder | null {
  const m = LEAD.exec(input);
  if (!m) return null;
  let rest = input.slice(m[0].length).trim();
  if (!rest) return null;

  const due = new Date(now);
  due.setSeconds(0, 0);
  let dateSet = false;
  let timeSet = false;
  let namedDay = false;
  let relative = false;

  const take = (re: RegExp, fn: (mm: RegExpExecArray) => void) => {
    const mm = re.exec(rest);
    if (!mm) return false;
    fn(mm);
    rest = (rest.slice(0, mm.index) + ' ' + rest.slice(mm.index + mm[0].length)).replace(/\s{2,}/g, ' ').trim();
    return true;
  };

  // "in 20 minutes" / "in 2 hours" / "in half an hour" / "in an hour"
  take(/\bin\s+(half an|an?|\d+(?:\.\d+)?|[a-z]+(?:-[a-z]+)?)\s*(minutes?|mins?|hours?|hrs?|h|m)\b/i, (mm) => {
    const n = mm[1].toLowerCase().startsWith('half') ? 0.5 : num(mm[1]);
    if (n == null) return;
    const unit = mm[2].toLowerCase();
    const ms = /^h/.test(unit) ? n * 3600e3 : n * 60e3;
    due.setTime(now.getTime() + ms);
    due.setSeconds(0, 0);
    dateSet = true; timeSet = true; relative = true;
  });

  // Day words
  if (!relative) {
    take(/\b(day after tomorrow)\b/i, () => { due.setDate(due.getDate() + 2); dateSet = true; });
    take(/\btomorrow\b/i, () => { if (!dateSet) { due.setDate(due.getDate() + 1); dateSet = true; } });
    take(/\b(?:on\s+|this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i, (mm) => {
      const want = DAYS.indexOf(mm[1].toLowerCase());
      let delta = (want - due.getDay() + 7) % 7;
      if (/\bnext\b/i.test(mm[0]) && delta === 0) delta = 7;
      due.setDate(due.getDate() + delta);
      dateSet = true; namedDay = true;
    });
    // Parts of the day set a default hour; an explicit "at" below overrides.
    take(/\b(tonight|this evening)\b/i, () => { due.setHours(20, 0, 0, 0); timeSet = true; });
    take(/\b(this afternoon)\b/i, () => { due.setHours(15, 0, 0, 0); timeSet = true; });
    take(/\b(this morning|in the morning|morning)\b/i, () => { due.setHours(9, 0, 0, 0); timeSet = true; });
    take(/\bat\s+(noon|midday)\b/i, () => { due.setHours(12, 0, 0, 0); timeSet = true; });
    take(/\bat\s+midnight\b/i, () => { due.setHours(24, 0, 0, 0); timeSet = true; });

    // "at 6", "at 6pm", "at 6:30", "at 18:00", "at six", "6pm" (bare, with meridiem)
    take(/\b(?:at\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i, (mm) => {
      let h = num(mm[1]) ?? 0; const mi = mm[2] ? Number(mm[2]) : 0;
      const pm = /^p/i.test(mm[3]);
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
      due.setHours(h, mi, 0, 0); timeSet = true;
    }) || take(/\bat\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\b/i, (mm) => {
      const h = num(mm[1]) ?? 0; const mi = mm[2] ? Number(mm[2]) : 0;
      if (h > 23 || mi > 59) return;
      // 24-hour clock when written so ("at 18:00"); a bare hour is the next
      // such hour on a 12-hour clock.
      if (h > 12) due.setHours(h, mi, 0, 0);
      else {
        due.setHours(h, mi, 0, 0);
        if (!dateSet && due.getTime() <= now.getTime()) {
          const later = new Date(due); later.setHours(h + 12, mi, 0, 0);
          if (h < 12 && later.getTime() > now.getTime()) due.setTime(later.getTime());
        }
      }
      timeSet = true;
    });
  }

  if (!timeSet) return null;

  // A time that has already gone rolls forward: to tomorrow, or to the same
  // weekday next week when a day was named ("friday at 7", said Friday at 9).
  if (!relative && due.getTime() <= now.getTime()) due.setDate(due.getDate() + (namedDay ? 7 : 1));

  // What is left is the message. "to call the hotel" → "call the hotel".
  let text = rest.replace(/^(?:[\s:,–—-]+|(?:to|that|about|for)\s+)+/i, '').replace(/\s+(?:please|thanks?)\.?$/i, '').replace(/[.!?\s]+$/, '').trim();
  if (!text) text = 'your reminder';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text, due, heard: input.trim() };
}

/** "Fri 6:00 pm" / "tomorrow 9:00 am" / "in 20 min" — how the confirmation reads it back. */
export function whenLine(due: Date, now = new Date()): string {
  const ms = due.getTime() - now.getTime();
  if (ms > 0 && ms < 60 * 60e3) return `in ${Math.max(1, Math.round(ms / 60e3))} min`;
  const sameDay = due.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const day = sameDay ? 'today' : due.toDateString() === tomorrow.toDateString() ? 'tomorrow'
    : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][due.getDay()]} ${due.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][due.getMonth()]}`;
  let h = due.getHours(); const mi = String(due.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
  return `${day} ${h}:${mi} ${ap}`;
}

/** "tell the group I'm running late" → "I'm running late" (or null). */
export function parseTellGroup(input: string): string | null {
  const m = /^\s*(?:hey\s+num[,!]?\s*|num[,!]?\s*)?(?:tell|let)\s+(?:the\s+)?(?:group|plan|everyone|the others|them)\s+(?:know\s+)?(?:that\s+)?(.+)$/i.exec(input);
  if (!m) return null;
  const text = m[1].trim().replace(/[.!?\s]+$/, '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

// ── landing a due reminder while the app is open ───────────────────────────

/**
 * The push covers a closed app; this covers an open one. Every 45 s: any
 * reminder whose time has come and that this phone has not yet shown becomes
 * one line in the thread. `remindersShown` is persisted, so a reload never
 * repeats one.
 */
export function landDueReminders(now = Date.now()): void {
  const s = store.get();
  const shown = new Set(s.remindersShown ?? []);
  const due = (s.reminders ?? []).filter((r) => !r.cancelled_at && Date.parse(r.due_at) <= now && !shown.has(r.id));
  if (!due.length) return;
  const msgs: Msg[] = due.map((r) => ({ who: 'c' as const, text: `Reminder: ${r.text}`, card: { title: r.text, meta: whenLine(new Date(r.due_at), new Date(now)), tag: 'reminder' } }));
  store.set((st) => ({
    msgs: [...st.msgs, ...msgs],
    remindersShown: [...shown, ...due.map((r) => r.id)].slice(-200),
    unread: st.threadOpen ? st.unread : st.unread + msgs.length,
  }));
}

export function startReminderSync(everyMs = 45_000): () => void {
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    void refreshReminders().then(() => landDueReminders());
  };
  tick();
  const timer = setInterval(tick, everyMs);
  document.addEventListener('visibilitychange', tick);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
}
