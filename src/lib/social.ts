// The social seam: who you are, who you're connected to, and the plan a group
// builds together. Talks to /api/social/* (worker/social.mjs).
//
// The one rule that makes agent-to-agent sharing safe: nothing crosses between
// two people until BOTH acted — you by sending the invite, them by opening it
// on their own device. Until then a link is 'pending' and carries nothing.
import { store } from './store';
import type { Friend, InviteDraft, Member, PartyPlan, PlanItem, Booking } from './types';

const CLAIM = 'https://num-claim.thatislumi.workers.dev';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/social' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `social ${res.status}`);
  return body as T;
}

/** Stable per-device id — minted once, kept even if the profile is cleared. */
function deviceId(): string {
  let id = localStorage.getItem('num-device-id');
  if (!id) {
    id = 'mem_' + (crypto.randomUUID?.() ?? String(Date.now())).replace(/-/g, '').slice(0, 20);
    localStorage.setItem('num-device-id', id);
  }
  return id;
}

// ── boot ───────────────────────────────────────────────────────────────────

/**
 * Read the referral/invite off the launch URL and hydrate anything we already
 * belong to. Runs once, on app start.
 */
export function bootSocial(): void {
  const q = new URLSearchParams(window.location.search);
  const ref = q.get('ref');
  const token = q.get('i');
  if (ref || token) {
    store.set((s) => ({ refCode: ref ?? s.refCode, inviteToken: token ?? s.inviteToken }));
    // Keep the launch URL clean so a refresh doesn't re-trigger the invite.
    history.replaceState(null, '', window.location.pathname);
  }

  const me = store.get().me;
  if (me) {
    void refreshFriends();
    void refreshPlans();
    void syncPlan();
  } else if (token || ref) {
    // Arrived from a friend's invite but has no account: say so up front rather
    // than silently dropping the referral.
    store.set((s) => ({
      msgs: [
        ...s.msgs,
        {
          who: 'c',
          text: 'You came in on a friend’s invite — nice. Tell me your name and mobile number and I’ll connect you two, so our two Nums can trade reservations, addresses and photos without either of you retyping anything.',
        },
      ],
      chips: [{ id: 'signup', label: 'Set up my Num account' }],
    }));
  }
}

// ── identity ───────────────────────────────────────────────────────────────

interface MeResponse {
  me: Member;
  ref: string;
  link: string;
  verification: { sent: boolean; reason?: string; note?: string } | null;
}

/**
 * Create or update this device's account. A number starts an SMS code where a
 * provider is configured; where none is, the number is saved but explicitly
 * NOT treated as verified — see the note we surface to the user.
 */
export async function signUp(name: string, phone?: string): Promise<MeResponse> {
  const out = await api<MeResponse>('/me', {
    method: 'POST',
    body: JSON.stringify({ id: deviceId(), name, phone, dest: store.get().place }),
  });
  // The "set up my account" prompt has done its job — leave it up and it
  // reads as if nothing happened.
  store.set((s) => ({ me: out.me, chips: s.chips.filter((c) => c.id !== 'signup') }));

  // Attribute the referral that brought them in, then accept the invite that
  // carried it — that second call is what makes the friendship mutual.
  const { refCode, inviteToken } = store.get();
  if (refCode) {
    void fetch(`${CLAIM}/ref/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: refCode, token: inviteToken, signup_id: out.me.id }),
    }).catch(() => {});
  }
  if (inviteToken) await acceptInvite(inviteToken);
  return out;
}

export async function verifyCode(code: string): Promise<boolean> {
  const me = store.get().me;
  if (!me) return false;
  const out = await api<{ ok?: boolean }>('/verify', { method: 'POST', body: JSON.stringify({ id: me.id, code }) });
  if (out.ok) store.set((s) => ({ me: s.me ? { ...s.me, phone_verified: true } : s.me }));
  return !!out.ok;
}

/** Consent, second half: accepting is what turns a link active both ways. */
export async function acceptInvite(token: string): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ friend?: { id: string; name: string }; plan?: { id: string; title: string } }>('/accept', {
      method: 'POST',
      body: JSON.stringify({ me: me.id, token }),
    });
    store.set({ inviteToken: null });
    await refreshFriends();
    if (out.plan) {
      await openPlan(out.plan.id);
      narrate(`You’re in — ${out.plan.title}. ${out.friend?.name ?? 'Your friend'}’s Num and mine are talking now: whatever either side books, the whole group sees it here.`);
    } else if (out.friend) {
      narrate(`Connected with ${out.friend.name}. From here our two Nums can hand each other reservations, addresses and photos without either of you retyping a thing.`);
    }
  } catch (err) {
    console.warn('[social] accept failed', err);
  }
}

// ── friends & contacts ─────────────────────────────────────────────────────

export async function refreshFriends(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ friends: Friend[] }>(`/friends?me=${encodeURIComponent(me.id)}`);
    store.set({ friends: out.friends });
  } catch (err) {
    console.warn('[social] friends failed', err);
  }
}

interface ContactsApi {
  select(props: string[], opts?: { multiple?: boolean }): Promise<Array<{ name?: string[]; tel?: string[] }>>;
}
const contactsApi = (): ContactsApi | null =>
  (navigator as Navigator & { contacts?: ContactsApi }).contacts &&
  'ContactsManager' in window
    ? (navigator as Navigator & { contacts?: ContactsApi }).contacts!
    : null;

export const contactsSupported = (): boolean => !!contactsApi();

/**
 * The picker returns only what the user hand-picks — we never read the address
 * book. Chrome/Android has it; iOS Safari has no API at all, which is why the
 * invite sheet always keeps a manual field.
 */
export async function pickContacts(): Promise<Array<{ name: string; phone?: string }>> {
  const api2 = contactsApi();
  if (!api2) return [];
  try {
    const picked = await api2.select(['name', 'tel'], { multiple: true });
    const mapped = picked
      .map((c) => ({ name: c.name?.[0] ?? '', phone: c.tel?.[0] }))
      .filter((c) => c.name);
    if (mapped.length) {
      store.set((s) => ({
        contacts: [...mapped, ...s.contacts.filter((c) => !mapped.some((m) => m.name === c.name))].slice(0, 200),
      }));
    }
    return mapped;
  } catch {
    return []; // user dismissed the picker
  }
}

const norm = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * "send invite to dre" → who is dre? We match saved contacts and existing
 * friends and hand back candidates; the user confirms before anything is sent,
 * because an invite goes to a real person's phone.
 */
export function matchPeople(name: string): Array<{ name: string; phone?: string }> {
  const q = norm(name);
  if (!q) return [];
  const s = store.get();
  const pool = [
    ...s.contacts,
    ...s.friends.filter((f) => f.name).map((f) => ({ name: f.name, phone: undefined as string | undefined })),
  ];
  const seen = new Set<string>();
  return pool
    .filter((p) => {
      const n = norm(p.name);
      return n === q || n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
    })
    .filter((p) => (seen.has(norm(p.name)) ? false : (seen.add(norm(p.name)), true)))
    .slice(0, 6);
}

/** Open the invite sheet for a named person, pre-resolved where we can. */
export function startInvite(draft: InviteDraft): void {
  const candidates = draft.name ? matchPeople(draft.name) : [];
  store.set({
    inviteOpen: {
      ...draft,
      candidates,
      phone: draft.phone ?? (candidates.length === 1 ? candidates[0].phone : undefined),
      planId: draft.planId ?? store.get().planId,
    },
  });
}

/** Mint the personalised link. Sending stays on the user's own phone. */
export async function mintInvite(name: string, phone?: string, planId?: string | null): Promise<void> {
  const me = store.get().me;
  if (!me) {
    store.set({ inviteOpen: { name, phone, planId } });
    narrate('I need your name and number first — an invite has to come from someone. Tap “Set up my Num account” and I’ll send it straight after.');
    return;
  }
  const minted = await api<InviteDraft['minted']>('/invite', {
    method: 'POST',
    body: JSON.stringify({ from: me.id, to_name: name, to_phone: phone, plan_id: planId ?? store.get().planId }),
  });
  if (name) {
    store.set((s) => ({
      contacts: s.contacts.some((c) => norm(c.name) === norm(name)) ? s.contacts : [...s.contacts, { name, phone }],
    }));
  }
  store.set((s) => ({ inviteOpen: { ...(s.inviteOpen ?? {}), name, phone, planId, minted } }));
  void refreshFriends();
}

/** Hand off to the OS: the invite is sent from the member's own number. */
export async function shareInvite(): Promise<'shared' | 'copied' | 'none'> {
  const minted = store.get().inviteOpen?.minted;
  if (!minted) return 'none';
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (nav.share) {
    try {
      await nav.share({ title: 'Join me on NUM', text: minted.message, url: minted.link });
      return 'shared';
    } catch {
      /* user cancelled — fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(minted.message);
    return 'copied';
  } catch {
    return 'none';
  }
}

// ── plans ──────────────────────────────────────────────────────────────────

function narrate(text: string): void {
  store.set((s) => ({ msgs: [...s.msgs, { who: 'c' as const, text }] }));
}

export async function refreshPlans(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ plans: PartyPlan[] }>(`/plans?me=${encodeURIComponent(me.id)}`);
    store.set((s) => ({ plans: out.plans, planId: s.planId ?? out.plans[0]?.id ?? null }));
  } catch (err) {
    console.warn('[social] plans failed', err);
  }
}

/**
 * A plan needs a title and nothing else — no dates, no reservations. That is
 * the point: the group starts planning, and items firm up into bookings later.
 */
export async function createPlan(title: string, dest?: string | null, startsOn?: string | null): Promise<PartyPlan | null> {
  const me = store.get().me;
  if (!me) {
    narrate('Give me your name and number first and I’ll open the plan under your account, so you can pull friends into it.');
    return null;
  }
  const out = await api<{ plan: PartyPlan }>('/plan', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, title, dest: dest ?? store.get().place, starts_on: startsOn }),
  });
  store.set((s) => ({ plans: [out.plan, ...s.plans], planId: out.plan.id, planItems: [], planCursor: 0 }));
  return out.plan;
}

export async function openPlan(id: string): Promise<void> {
  store.set({ planId: id, planItems: [], planCursor: 0 });
  await syncPlan();
}

export async function addPlanItem(item: Partial<PlanItem>): Promise<PlanItem | null> {
  const me = store.get().me;
  const planId = item.plan_id ?? store.get().planId;
  if (!me || !planId) return null;
  const out = await api<{ item: PlanItem }>('/plan/item', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, plan_id: planId, ...item }),
  });
  store.set((s) => ({ planItems: [...s.planItems.filter((i) => i.id !== out.item.id), out.item] }));
  return out.item;
}

/** Promote an idea to a real reservation once it is actually booked. */
export async function confirmPlanItem(id: string, patch: Partial<PlanItem> = {}): Promise<void> {
  const me = store.get().me;
  const planId = store.get().planId;
  if (!me || !planId) return;
  const out = await api<{ item: PlanItem }>('/plan/item', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, plan_id: planId, id, status: 'confirmed', kind: 'booking', ...patch }),
  });
  store.set((s) => ({ planItems: s.planItems.map((i) => (i.id === out.item.id ? out.item : i)) }));
}

/**
 * The agent-to-agent channel. Everything the other members' Nums did since we
 * last looked comes back as one-line summaries, and this Num says them in the
 * thread — which is what "the AIs talk to each other" actually looks like from
 * inside the app.
 */
export async function syncPlan(): Promise<void> {
  const { me, planId, planCursor } = store.get();
  if (!me || !planId) return;
  try {
    const out = await api<{
      plan: PartyPlan;
      members: Array<{ member_id: string; name: string | null; role: string }>;
      items: PlanItem[];
      events: Array<{ id: number; summary: string; by_name: string | null }>;
      cursor: number;
    }>(`/plan?id=${encodeURIComponent(planId)}&me=${encodeURIComponent(me.id)}&since=${planCursor}`);

    store.set({ planItems: out.items, planMembers: out.members, planCursor: out.cursor });

    if (out.events.length) {
      const lines = out.events.map((e) => '· ' + e.summary).join('\n');
      narrate(
        out.events.length === 1
          ? `${out.events[0].summary} — straight from their Num, already on the group plan.`
          : `Group plan moved while you were away:\n${lines}`,
      );
      // A confirmed group booking belongs on this member's own shelf too.
      out.items
        .filter((i) => i.status === 'confirmed' && i.day)
        .forEach((i) => mirrorToBookings(i));
    }
  } catch (err) {
    console.warn('[social] sync failed', err);
  }
}

/** A confirmed group item becomes a booking on every member's PLAN shelf. */
function mirrorToBookings(item: PlanItem): void {
  const id = 'grp_' + item.id.slice(-8);
  const [y, m, d] = (item.day ?? '').split('-').map(Number);
  if (!m || !d) return;
  const booking: Booking = {
    id,
    mo: m,
    day: d,
    time: item.time ?? '19:00',
    dur: 120,
    place: item.address || item.place || '',
    title: item.title,
    grp: 'BKK',
    status: 'confirmed',
    note: [item.note, item.by_name ? `Added by ${item.by_name} on the group plan.` : null].filter(Boolean).join(' '),
    cost: item.cost ?? '',
    ...(item.photo ? { photo: item.photo } : {}),
  };
  void y;
  store.set((s) => ({
    bookings: s.bookings.some((b) => b.id === id)
      ? s.bookings.map((b) => (b.id === id ? { ...b, ...booking } : b))
      : [...s.bookings, booking],
  }));
}

/**
 * The other direction: a booking this member's Num just made is pushed to the
 * shared plan, so everyone else's Num can announce it on their side.
 */
export async function pushBookingToPlan(b: Booking): Promise<void> {
  const { me, planId } = store.get();
  if (!me || !planId || b.id.startsWith('grp_')) return;
  const day = `2026-${String(b.mo).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
  await addPlanItem({
    kind: 'booking',
    title: b.title,
    place: b.place,
    address: b.place,
    day,
    time: b.time,
    status: b.status === 'confirmed' ? 'confirmed' : b.status === 'hold' ? 'held' : 'proposed',
    cost: b.cost,
    note: b.note,
    photo: b.photo,
  }).catch(() => null);
}

/** Poll while the app is in the foreground; stop when it is backgrounded. */
export function startPlanSync(): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    stop();
    if (!store.get().planId) return;
    timer = setInterval(() => void syncPlan(), 45_000);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const onVis = () => {
    if (document.visibilityState === 'visible') {
      void syncPlan();
      start();
    } else stop();
  };
  document.addEventListener('visibilitychange', onVis);
  start();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVis);
  };
}
