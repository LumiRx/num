// Profile: the picture, the identity, and everything the traveller chooses to
// tell Num about themselves.
//
// The avatar is resized to 160px on the device before it is ever sent. That is
// not an optimisation, it is the reason we can store it at all — a raw phone
// photo is 3-5MB and would blow the row, the request and the D1 write limit.
import { store } from './store';
import type { Member } from './types';

const AVATAR_PX = 160;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/social' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `profile ${res.status}`);
  return body as T;
}

/**
 * Save the profile. `bio` also lands in the AI's KNOWN FACTS, which is the
 * whole point — filling this in is how you stop being asked the same question.
 */
export async function saveProfile({ name, bio }: { name?: string; bio?: Record<string, string> }): Promise<Member> {
  const me = store.get().me;
  if (!me) throw new Error('No account yet');
  const out = await api<{ me: Member }>('/me', {
    method: 'POST',
    body: JSON.stringify({ id: me.id, name, bio, verify: false }),
  });
  store.set((s) => ({
    me: out.me,
    // Everything the user typed is a fact Num should already know, so it goes
    // straight into the same profile the model reads. No second source.
    profile: { ...s.profile, ...(bio ?? {}) },
  }));
  return out.me;
}

/** Square-crop and shrink on-device, then store. Never uploads the original. */
export async function uploadAvatar(file: File): Promise<void> {
  const me = store.get().me;
  if (!me) throw new Error('No account yet');
  if (!/^image\//.test(file.type)) throw new Error('That needs to be an image');

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_PX;
      canvas.height = AVATAR_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Cannot process that image'));
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Cannot read that image'));
    };
    img.src = url;
  });

  const out = await api<{ me: Member }>('/me', {
    method: 'POST',
    body: JSON.stringify({ id: me.id, avatar: dataUrl, verify: false }),
  });
  store.set({ me: out.me });
}

// ── business console ───────────────────────────────────────────────────────

export interface OwnedPlace {
  id: string;
  name: string;
  category: string | null;
  dest: string | null;
  area: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviews: number | null;
  photo_url: string | null;
  method: string | null;
  owned_since: string | null;
}

export interface BusinessOverview {
  places: OwnedPlace[];
  events?: Array<{ id: string; title: string; day: string | null; invited: number; yes: number; slug: string }>;
  demand?: Array<{ ts: string; summary: string; status: string }>;
  claimable: boolean;
  hint?: string;
}

export async function businessOverview(): Promise<BusinessOverview | null> {
  const me = store.get().me;
  if (!me) return null;
  try {
    const res = await fetch(`/api/business/overview?me=${encodeURIComponent(me.id)}`);
    if (!res.ok) return null;
    return (await res.json()) as BusinessOverview;
  } catch {
    return null;
  }
}

export async function businessUpdate(placeId: string, patch: { phone?: string; website?: string; area?: string }): Promise<boolean> {
  const me = store.get().me;
  if (!me) return false;
  const res = await fetch('/api/business/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ me: me.id, place_id: placeId, ...patch }),
  });
  return res.ok;
}
