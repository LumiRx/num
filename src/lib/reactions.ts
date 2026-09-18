// The other half of a reaction: telling the team.
//
// prefs.ts folds a tap into THIS guest's style profile and always has. This
// file sends the same tap to /api/react so it can be read by lane, brain and
// place on the admin dashboard. Fire-and-forget by design: the guest's tap
// has already counted on their phone, and a feedback channel that could
// break the thread would be a feedback channel people learn to avoid.
import { store } from './store';
import { anonId } from './anon';
import { currentLang } from './i18n';
import { apiUrl } from './apibase';
import type { Reaction } from './types';

/** The question that produced message `index` — the nearest guest line above it. */
function askedBefore(index: number): string {
  const msgs = store.get().msgs;
  for (let i = index - 1; i >= 0; i--) if (msgs[i]?.who === 'u') return msgs[i].text;
  return '';
}

export function sendReaction(index: number, reaction: Reaction, subject: string): void {
  try {
    const s = store.get();
    const msg = s.msgs[index];
    if (!msg || msg.who !== 'c') return;
    const body = {
      index,
      reaction,
      subject: subject.slice(0, 120),
      asked: askedBefore(index).slice(0, 300),
      reply: (msg.text ?? '').slice(0, 300),
      place: s.place ?? null,
      turn: msg.turn ?? null,
      member: s.me?.id ?? null,
      anon: anonId(),
      lang: currentLang(),
    };
    void fetch(apiUrl('/api/react'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* counted on the phone already */ });
  } catch { /* never let feedback break the thread */ }
}
