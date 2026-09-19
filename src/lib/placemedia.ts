// A pick's picture and socials, filled in after the answer has rendered.
//
// The answer arrives with what the directory row already knows (a photo for
// one place in a thousand). The cards draw at once; this asks
// /api/places/media for the rest and merges what comes back into the same
// message, so the grid fills in as the venues' own pages are read. Asked once
// per place per launch — a site with nothing is not asked on every render.
import { store } from './store';
import { apiUrl } from './apibase';
import type { Pick } from './types';

type Media = { photo?: string | null; photo_attr?: string | null; instagram?: string | null; tiktok?: string | null; facebook?: string | null };

const asked = new Set<string>();

/** Picks that still have something to learn: no photo, or no socials known. */
export function needsMedia(p: Pick): boolean {
  return !!p.id && !asked.has(p.id) && (!p.photo || (!p.instagram && !p.tiktok && !p.facebook));
}

export async function fillMedia(msgIndex: number): Promise<void> {
  const msg = store.get().msgs[msgIndex];
  const ids = (msg?.picks ?? []).filter(needsMedia).map((p) => p.id as string).slice(0, 8);
  if (!ids.length) return;
  for (const id of ids) asked.add(id);
  let media: Record<string, Media> = {};
  try {
    const res = await fetch(apiUrl('/api/places/media?ids=' + encodeURIComponent(ids.join(','))));
    if (!res.ok) return;
    const body = (await res.json()) as { ok?: boolean; media?: Record<string, Media> };
    media = body.media ?? {};
  } catch { return; }
  if (!Object.keys(media).length) return;
  store.set((s) => ({
    msgs: s.msgs.map((m, i) => {
      if (i !== msgIndex || !m.picks) return m;
      return {
        ...m,
        picks: m.picks.map((p) => {
          const got = p.id ? media[p.id] : null;
          if (!got) return p;
          return {
            ...p,
            photo: p.photo ?? got.photo ?? null,
            photo_attr: p.photo ? p.photo_attr ?? null : got.photo_attr ?? null,
            instagram: p.instagram ?? got.instagram ?? null,
            tiktok: p.tiktok ?? got.tiktok ?? null,
            facebook: p.facebook ?? got.facebook ?? null,
          };
        }),
      };
    }),
  }));
}
