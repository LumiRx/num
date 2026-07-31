// The social seam: who you are, who you're connected to, and the plan a group
// builds together. Talks to /api/social/* (worker/social.mjs).
//
// The one rule that makes agent-to-agent sharing safe: nothing crosses between
// two people until BOTH acted — you by sending the invite, them by opening it
// on their own device. Until then a link is 'pending' and carries nothing.
import { store } from './store';
import { refreshRequests } from './requests';
import { refreshStars } from './stars';
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

  // A scanned pay code. The phone's own camera opened this URL, so by the time
  // we are here the "scanner" has already done its job.
  const payTo = q.get('p');
  if (payTo) {
    store.set({
      payOpen: { to: payTo, amount: Number(q.get('a')) || undefined, note: q.get('n') ?? undefined },
    });
    history.replaceState(null, '', window.location.pathname);
    // Put a name to the code: "Pay them" is not a confirmation.
    void fetch(`/api/social/who?id=${encodeURIComponent(payTo)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => {
        if (w?.name) store.set((st) => ({ payOpen: st.payOpen ? { ...st.payOpen, toName: w.name } : st.payOpen }));
      })
      .catch(() => {});
  }

  // A scanned "connect with me" code. This is the whole point of the QR: the
  // sharer offered, the scanner accepted, so the connection is made now rather
  // than turned into a request somebody has to remember to approve.
  const connectTo = q.get('c');

  if (ref || token || connectTo) {
    store.set((s) => ({
      refCode: ref ?? s.refCode,
      inviteToken: token ?? s.inviteToken,
      connectTo: connectTo ?? s.connectTo,
    }));
    // Keep the launch URL clean so a refresh doesn't re-trigger the invite.
    history.replaceState(null, '', window.location.pathname);
  }

  const me = store.get().me;
  if (me) {
    // Someone who already has an account must never be pushed back through
    // sign-up by opening an invite. They are already themselves; the link only
    // adds a friend or a plan to what they have.
    if (connectTo) void connectByCode(connectTo);
    if (token) void acceptInvite(token);
    void refreshFriends();
    void refreshPlans();
    void syncPlan();
    void refreshRequests();
    void refreshStars();
    return;
  }

  // No account on this device. EVERY first open asks for a name and a number —
  // not just invited ones. Without them Num has no way to connect this person
  // to anybody, and a demo that ends with an anonymous device is a demo we
  // cannot follow up on.
  // The cold-start welcome already ends with "Let's start with your name", so
  // adding another line here asks twice — which reads like the app was not
  // listening to itself. Only the invited path needs its own framing.
  store.set((s) => ({
    msgs:
      token || ref
        ? [
            ...s.msgs,
            {
              who: 'c' as const,
              text: 'Someone you know sent you here, which saves me the sales pitch.\n\nShort version: you ask for things — a table, a car, a whole weekend — and I sort them out. And since your friend is already here, once you’re set up our two sides talk directly. Plans just land; nobody retypes an address.\n\nLet’s start with your name.',
            },
          ]
        : s.msgs,
    chips: [{ id: 'signup', label: 'Tell Num who I am' }],
  }));
  // Put the form in front of them rather than hoping they tap the chip. It
  // lands after the first paint so the app is visibly there behind it.
  setTimeout(() => {
    if (!store.get().me && !store.get().inviteOpen) store.set({ threadOpen: true, inviteOpen: {} });
  }, 900);
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
  // The "add my name & number" prompt has done its job — leave it up and it
  // reads as if nothing happened.
  store.set((s) => ({
    me: out.me,
    chips: s.chips.filter((c) => c.id !== 'signup'),
    msgs: [
      ...s.msgs,
      {
        who: 'c' as const,
        // Acknowledge the person, not the transaction — then ask the one
        // question that unlocks everything else.
        text: `Good to meet you, ${out.me.name ?? 'you'}.${
          out.me.phone ? '\n\nYour number’s tucked away — friends can find you now, and I’ll tell you if anything moves.' : ''
        }\n\nSo, where in the world are you, and where are you headed next?`,
      },
    ],
  }));

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
  const { connectTo } = store.get();
  if (connectTo) await connectByCode(connectTo);
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
/**
 * Act on a scanned "connect with me" code.
 *
 * Quiet when it is a repeat: scanning the same code twice is a normal thing
 * to do by accident, and announcing a connection that already existed makes
 * the app look like it forgot.
 */
export async function connectByCode(memberId: string): Promise<void> {
  const me = store.get().me;
  if (!me || memberId === me.id) {
    store.set({ connectTo: null });
    return;
  }
  try {
    const out = await api<{ friend?: { id: string; name: string }; already?: boolean }>('/connect', {
      method: 'POST',
      body: JSON.stringify({ me: me.id, to: memberId }),
    });
    store.set({ connectTo: null });
    await refreshFriends();
    if (out.friend && !out.already) {
      narrate(`You and ${out.friend.name} are connected. From here our two Nums can pass reservations, addresses and photos straight across — neither of you retypes a thing.`);
    }
  } catch (err) {
    console.warn('[social] connect failed', err);
    store.set({ connectTo: null });
  }
}

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

// ── the invite door ────────────────────────────────────────────────────────
//
// Agent-to-agent invites arrive without the member having typed anything, so
// the member decides who may send them: people they're connected to (the
// default), anyone on Num, or nobody. See worker/permissions.mjs.

export type InvitePolicy = 'friends' | 'public' | 'off';

export interface InvitePrefs {
  invite_policy: InvitePolicy;
  accepting: boolean;
  options?: Array<{ value: InvitePolicy; label: string; detail: string }>;
  note?: string;
}

export async function getInvitePolicy(): Promise<InvitePrefs | null> {
  const me = store.get().me;
  if (!me) return null;
  try {
    return await api<InvitePrefs>(`/prefs?me=${encodeURIComponent(me.id)}`);
  } catch (err) {
    console.warn('[social] prefs failed', err);
    return null;
  }
}

/**
 * Set it either way round: a three-way picker passes a policy, a plain switch
 * passes `accepting` and the last open setting so turning it back on restores
 * what they had rather than opening them to strangers.
 */
export async function setInvitePolicy(
  next: InvitePolicy | { accepting: boolean; previous?: InvitePolicy },
): Promise<InvitePrefs | null> {
  const me = store.get().me;
  if (!me) return null;
  const payload = typeof next === 'string' ? { invite_policy: next } : next;
  return await api<InvitePrefs>('/prefs', { method: 'POST', body: JSON.stringify({ me: me.id, ...payload }) });
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

/**
 * Add, remove, or answer for someone on a reservation.
 *
 * Every call returns the whole attendee list and the recomputed party size,
 * because the server is the only thing entitled to decide either — a client
 * that counts heads locally will eventually disagree with the table the venue
 * is holding.
 */
export async function setAttendee(
  itemId: string,
  name: string,
  opts?: { memberId?: string | null; rsvp?: 'going' | 'maybe' | 'out'; remove?: boolean },
): Promise<{ ok: boolean; message: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Add your name and number first.' };
  try {
    const res = await fetch('/api/social/plan/item/attendees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        me: me.id,
        item_id: itemId,
        name,
        ...(opts?.memberId ? { member_id: opts.memberId } : {}),
        ...(opts?.rsvp ? { rsvp: opts.rsvp } : {}),
        ...(opts?.remove ? { remove: true } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; attendees?: PlanItem['attendees']; party_size?: number };
    if (!res.ok) return { ok: false, message: body.error ?? 'That didn’t go through.' };
    // Patch the item in place rather than re-syncing the whole plan: the
    // answer we just got back IS the truth, and a full sync would make a tap
    // feel slow for no extra correctness.
    store.set((st) => ({
      planItems: st.planItems.map((i) =>
        i.id === itemId ? { ...i, attendees: body.attendees, party_size: body.party_size } : i,
      ),
    }));
    return { ok: true, message: '' };
  } catch {
    return { ok: false, message: 'That didn’t go through.' };
  }
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

/**
 * A shared reservation that CHANGED. The plan item is matched by title, since
 * that is what both sides carry, and the event feed does the telling — a
 * friend who was never told the dinner moved is the failure this prevents.
 */
export async function pushBookingUpdateToPlan(bookingId: string): Promise<void> {
  const { me, planId, bookings, planItems } = store.get();
  if (!me || !planId) return;
  const b = bookings.find((x) => x.id === bookingId);
  if (!b) return;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const item = planItems.find((i) => norm(i.title) === norm(b.title));
  if (!item) return void pushBookingToPlan(b);
  const day = `2026-${String(b.mo).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
  await api('/plan/item', {
    method: 'POST',
    body: JSON.stringify({
      me: me.id,
      plan_id: planId,
      id: item.id,
      day,
      time: b.time,
      place: b.place,
      address: b.place,
      note: b.note,
      cost: b.cost,
      status: b.status === 'confirmed' ? 'confirmed' : b.status === 'cancelled' ? 'cancelled' : b.status === 'hold' ? 'held' : 'proposed',
    }),
  }).catch(() => null);
  await syncPlan();
}

/** Poll while the app is in the foreground; stop when it is backgrounded. */
export function startPlanSync(): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    stop();
    // No `planId` guard: the inbox matters even before you belong to a plan.
    // Requests ride the same clock as the plan sync — a friend's invite should
    // be waiting for you, not something you go looking for.
    timer = setInterval(() => {
      void syncPlan();
      void refreshRequests();
      void refreshStars();
    }, 45_000);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const onVis = () => {
    if (document.visibilityState === 'visible') {
      void syncPlan();
      void refreshRequests();
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
