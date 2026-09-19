/**
 * ADD A PHOTO OF A PLACE — the member side of worker/placephotos.mjs.
 *
 * Dre, 18 Sep: "we want users to submit images when they visit … we offer
 * .01 per verified image of a location. we can make that small print. we
 * need to use 5arz to prove the location."
 *
 * The button appears on a place card only when the phone's fix puts the
 * member within ~200 m of it (HERE_KM), because a photo of a restaurant from
 * across town is not what the shelf needs. The camera opens straight away
 * (capture="environment"); the fix at that moment travels with the upload as
 * the proof, and the server — never this file — decides what it was worth.
 *
 * Sending needs the same verified contact as sending a message: an
 * unverified member gets the sign-in sheet, not a silent failure.
 */
import { store } from './store';
import { apiUrl } from './apibase';
import { canSend, dropKeyboard } from './gate';
import { fixPosition } from './whereami';
import { t } from './i18n';
import type { Msg } from './types';
import { T } from './i18nmark';

/** How close "at the place" is. Same order as the server's NEAR_KM (150 m) with room for a phone's fix. */
export const HERE_KM = 0.2;

/** The small print, said once, exactly as the server pays. */
export const SMALL_PRINT = T('Photos taken at the place earn 1¢ each once approved — paid as ★1 per 100, up to 3 per place a month. NUM checks every photo before it goes up.');

export const atThePlace = (distanceKm: number | null | undefined): boolean =>
  distanceKm != null && Number.isFinite(distanceKm) && distanceKm <= HERE_KM;

/** The server's place id is the number; the rail prefixes it. */
export const placeIdOf = (railId: string): string => railId.replace(/^pl_/, '');

const push = (m: Msg) => store.set((s) => ({ msgs: [...s.msgs, m] }));

/** Open the camera for one place. Resolves when the upload has been answered (or the picker was dismissed). */
export function addPhoto(item: { id: string; title: string }): Promise<void> {
  const me = store.get().me;
  if (!canSend(me) || !me?.id) {
    dropKeyboard();
    store.set({ inviteOpen: {} });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = () => { input.remove(); resolve(); };
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return done();
      await send(item, file, me.id);
      done();
    };
    // Cancelled pickers fire no event on some browsers; clean up on focus return.
    window.addEventListener('focus', () => setTimeout(() => { if (!input.files?.length) done(); }, 800), { once: true });
    input.click();
  });
}

async function send(item: { id: string; title: string }, file: File, meId: string): Promise<void> {
  const fix = store.get().here ?? (await fixPosition(true));
  const q = new URLSearchParams({ me: meId, place: placeIdOf(item.id) });
  if (fix) { q.set('lat', String(fix.lat)); q.set('lng', String(fix.lng)); }
  store.set({ threadOpen: true });
  push({ who: 'u', text: t('A photo of {place}', { place: item.title }) });
  try {
    const r = await fetch(apiUrl(`/api/photos/upload?${q}`), {
      method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file,
    });
    const d = await r.json().catch(() => ({} as Record<string, unknown>)) as { note?: string; message?: string; error?: string; duplicate?: boolean };
    if (r.status === 403 && d.error === 'verify_to_send') { store.set({ inviteOpen: {} }); return; }
    if (d.duplicate) { push({ who: 'c', text: t('You’ve already sent me that one — it’s in the queue.') }); return; }
    push({ who: 'c', text: d.note ?? d.message ?? (r.ok ? t('Got it — thank you.') : t('That one didn’t go through. Try again in a moment.')) });
  } catch {
    push({ who: 'c', text: t('That one didn’t go through. Try again in a moment.') });
  }
}
