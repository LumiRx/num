// The concierge engine — a faithful port of the DCLogic class from
// Concierge.dc.html. Every flow here is scripted demo behavior; the public
// surface (sendChip, openVoice, payBill, buyPack…) is the seam where a real
// agent backend would slot in later.
import { store } from './store';
import { demoState } from './data';
import { addPlanItem, createPlan, pushBookingToPlan, pushBookingUpdateToPlan, startInvite, syncPlan } from './social';
import { offerService } from './services';
import { runFlightSearch, type FlightQuery } from './flights';
import { createEvent } from './events';
import { observeUserMessage, styleForRequest, tripCheck } from './prefs';
import type { ServiceHandoff, AppState } from './types';
import type { Booking, Chip, Meeting, Msg } from './types';

let boughtTimer: ReturnType<typeof setTimeout> | undefined;
let voiceT1: ReturnType<typeof setTimeout> | undefined;
let voiceT2: ReturnType<typeof setTimeout> | undefined;

function push(m: Msg) {
  store.set((s) => ({ msgs: [...s.msgs, m] }));
}

function reply(items: Msg[], chips?: Chip[] | null, delay = 1000) {
  store.set({ typing: true, chips: [] });
  // One independent timer per reply, as in the design — overlapping flows
  // must both deliver; cancelling a pending timer would swallow its messages.
  setTimeout(() => {
    store.set((s) => ({ typing: false, msgs: [...s.msgs, ...items], chips: chips ?? defChips() }));
  }, delay);
}

function defChips(): Chip[] {
  const s = store.get();
  // The scripted flows are the DEMO trip. A real traveller's chips come from
  // the AI's replies; between turns we offer nothing rather than Viv's script.
  if (!s.demo) return [];
  const c: Chip[] = [];
  if (!s.billPaid) c.push({ id: 'bill', label: 'Pay my bill — Le Du' });
  if (!s.photosOn) c.push({ id: 'photos', label: 'Let Num organize my photos' });
  return [
    ...c,
    { id: 'dinner', label: 'Dinner on Thursday' },
    { id: 'meet', label: 'Set a meeting with Mei' },
    { id: 'recall', label: 'When was that Tokyo omakase?' },
    { id: 'ferry', label: '▸ Disruption demo' },
  ];
}

function setB(id: string, patch: Partial<Booking>) {
  store.set((s) => ({ bookings: s.bookings.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
}

function addB(b: Booking) {
  // Upsert by id: scripted flows reuse fixed ids ('dn', 'pp2'), and re-running
  // a flow must replace its earlier result, not stack a duplicate React key.
  store.set((s) => ({
    bookings: s.bookings.some((x) => x.id === b.id)
      ? s.bookings.map((x) => (x.id === b.id ? b : x))
      : [...s.bookings, b],
  }));
}

function payBill(how: string) {
  setB('d1', { receipt: '#LD-2841 · ' + how });
  store.set((s) => ({
    billPaid: true,
    stars: how === '★529' ? s.stars - 529 : s.stars,
    txns: [
      { id: 'tx' + Date.now(), t: 'Bill — Le Du', meta: how + ' · receipt filed · tonight', amt: how === '★529' ? '−★529' : '−฿5,290', dir: 0 as const },
      ...s.txns,
    ],
  }));
}

export function buyPack(n: number, price: string) {
  store.set((s) => ({
    stars: s.stars + n,
    bought: 'Added ★' + n.toLocaleString() + ' — ' + price + ', done.',
    txns: [
      { id: 'tx' + Date.now(), t: 'Top-up ★' + n.toLocaleString(), meta: price + ' · just now', amt: '+★' + n.toLocaleString(), dir: 1 as const },
      ...s.txns,
    ],
  }));
  clearTimeout(boughtTimer);
  boughtTimer = setTimeout(() => store.set({ bought: '' }), 3200);
}

/* REAL voice, replacing the scripted demo that used to live here (fake timers,
 * a fake "massage moved" — it looked alive and listened to nothing, which is
 * worse than no mic at all). The backend has been ready the whole time:
 * POST raw audio to /api/voice/transcribe → Whisper, ~99 languages,
 * auto-detected. Tap the mic to talk, tap again to send.
 */
let rec: MediaRecorder | null = null;
let recStream: MediaStream | null = null;
let recChunks: Blob[] = [];
let recCap: ReturnType<typeof setTimeout> | null = null;

export async function openVoice() {
  if (rec) return closeVoice(); // second tap while recording = stop & send
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    push({ who: 'c', text: 'I need microphone access for that — allow it in your browser settings and tap the mic again.' });
    return;
  }
  // Safari records mp4/aac, everyone else webm/opus; Whisper eats both.
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
  recChunks = [];
  rec = new MediaRecorder(recStream, { mimeType: mime });
  rec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  rec.onstop = () => void submitVoice();
  rec.start();
  store.set({ voice: 1 });
  // A stuck recorder is the only thing that talks for a minute straight.
  recCap = setTimeout(() => closeVoice(), 45_000);
}

export function closeVoice() {
  clearTimeout(voiceT1);
  clearTimeout(voiceT2);
  if (recCap) { clearTimeout(recCap); recCap = null; }
  if (rec && rec.state !== 'inactive') {
    store.set({ voice: 2 }); // "thinking" while we transcribe
    rec.stop();              // onstop → submitVoice()
  } else {
    store.set({ voice: 0 });
  }
}

async function submitVoice() {
  const blob = new Blob(recChunks, { type: rec?.mimeType || 'audio/webm' });
  rec = null;
  recStream?.getTracks().forEach((t) => t.stop());
  recStream = null;
  recChunks = [];
  try {
    if (blob.size < 1500) { store.set({ voice: 0 }); return; } // a tap, not speech
    const r = await fetch('/api/voice/transcribe', { method: 'POST', body: blob });
    const d = await r.json();
    const text = (d?.text ?? d?.transcript ?? '').trim();
    store.set({ voice: 0 });
    if (text) void askNum(text);
    else push({ who: 'c', text: 'I couldn’t make that out — try again a little closer to the mic?' });
  } catch {
    store.set({ voice: 0 });
    push({ who: 'c', text: 'The transcription hiccuped — say it once more?' });
  }
}

export function askToChange(title: string) {
  store.set({ view: 'thread' });
  push({ who: 'u', text: 'Change ' + title.replace(/ —.*/, '') });
  setTimeout(() => sendChip('change', ''), 50);
}

export function sendChip(id: string, label: string) {
  // Enter the showroom: swap the whole state for Viv's scripted SE-Asia trip.
  if (id === 'demo') {
    const demo = demoState();
    store.replace({
      ...demo,
      msgs: [
        { who: 'c', text: 'Stepping into the demo — this is Viv, mid-way through an SE-Asia loop, so you can see a full trip in flight. Try the chips below; your own thread is untouched and one refresh brings it back.' },
        ...demo.msgs,
      ],
    });
    return;
  }

  // Account + invite chips are handled on the device, not by the model: they
  // open a sheet rather than costing a turn.
  if (id === 'signup') {
    store.set({ inviteOpen: {} });
    return;
  }
  if (id === 'invite') {
    startInvite({});
    return;
  }
  if (id === 'party') {
    store.set({ partyOpen: true });
    return;
  }
  if (id === 'event') {
    store.set({ eventOpen: true });
    return;
  }

  // Live AI mode: chips come from the AI's replies with arbitrary ids, so the
  // scripted branch chain below can't answer them — route through the brain.
  if (!store.get().demo) {
    if (!label || store.get().typing) return;
    void askNum(label);
    return;
  }

  if (id !== 'ferry' && label) push({ who: 'u', text: label });

  if (id === 'dinner') {
    reply(
      [{ who: 'c', text: 'Two Thursdays on this trip — you’re in Bangkok on the 30th and Singapore on the 6th. Which one?' }],
      [
        { id: 'thuBkk', label: 'Bangkok · Thu 30' },
        { id: 'thuSin', label: 'Singapore · Thu 6' },
      ],
    );
  } else if (id === 'thuBkk') {
    addB({ id: 'dn', mo: 7, day: 30, time: '20:00', dur: 150, place: 'Old Town, Bangkok', title: 'Dinner — Potong', grp: 'BKK', status: 'hold', holdBy: 'NOON WED', note: 'Chef’s counter, 5 courses. Held without a card. It’s a 15-min walk from your Grand Palace finish.', cost: '฿6,400 tasting' });
    reply(
      [{ who: 'c', text: 'Held. Potong, chef’s counter, Thursday 20:00 — it sits nicely after your Grand Palace morning. Confirm by noon Wednesday or I let it go.', card: { title: 'Dinner — Potong', meta: 'Thu 30 Jul · 20:00 · chef’s counter', tag: 'hold' } }],
      [
        { id: 'confirmDn', label: 'Confirm it' },
        { id: 'week', label: 'What’s my week?' },
        { id: 'ferry', label: '▸ Disruption demo' },
      ],
      1300,
    );
  } else if (id === 'thuSin') {
    addB({ id: 'dn', mo: 8, day: 6, time: '20:00', dur: 150, place: 'Dempsey Hill, Singapore', title: 'Dinner — Burnt Ends', grp: 'SIN', status: 'hold', holdBy: 'MON', note: 'Counter seats. Held via the chef’s office — confirm by Monday.', cost: 'S$220 pp' });
    reply(
      [{ who: 'c', text: 'Held. Burnt Ends, counter seats, Thursday 20:00 — you land the day before, so no rush from the airport. Confirm by Monday or I let it go.', card: { title: 'Dinner — Burnt Ends', meta: 'Thu 6 Aug · 20:00 · counter', tag: 'hold' } }],
      [
        { id: 'confirmDn', label: 'Confirm it' },
        { id: 'week', label: 'What’s my week?' },
        { id: 'ferry', label: '▸ Disruption demo' },
      ],
      1300,
    );
  } else if (id === 'confirmDn') {
    setB('dn', { status: 'confirmed', holdBy: null });
    reply([{ who: 'c', text: 'Confirmed — it’s on your plan and the calendar, and the shared view just updated for anyone watching.' }]);
  } else if (id === 'week') {
    reply([{ who: 'c', text: 'Bangkok till Friday, fly to Phuket the 31st, Singapore on the 5th, home the 8th — then back for the Full Moon Party on the 14th, deposit already paid.\n\nTwo things need you: the Bang Tao daybed (confirm by Friday) and nothing else. I’ll start the Full Moon reminder ladder on the 7th.' }]);
  } else if (id === 'revert') {
    setB('m1', { time: '16:00', note: 'Back to the original 16:00 slot, as asked.' });
    setB('g1', { day: 29, time: '09:00', note: 'Back to Wednesday morning, as asked. Umbrella recommended.' });
    reply([{ who: 'c', text: 'Reverted — massage back to 16:00, Grand Palace back to Wednesday morning. The rain is now officially your problem.' }]);
  } else if (id === 'ferry') {
    store.set({ notifOn: true, disr: 'active', chips: [] });
    setTimeout(() => store.set({ notifOn: false }), 4200);
    setTimeout(() => {
      store.set((s) => ({
        msgs: [
          ...s.msgs,
          { who: 'c', text: 'Your Phi Phi ferry on the 2nd just got cancelled — weather. Before you ask: two ways out, both hold your 16:30 return.\n\n① 11:30 ferry, same operator — free move, you lose the quiet morning beach.\n② 09:15 speedboat — +฿1,400, 45 minutes, in before the crowds.' },
        ],
        chips: [
          { id: 'reFerry', label: 'Take the 11:30 ferry' },
          { id: 'reSpeed', label: '09:15 speedboat' },
        ],
      }));
    }, 1600);
  } else if (id === 'reFerry') {
    setB('pp', { status: 'cancelled' });
    addB({ id: 'pp2', mo: 8, day: 2, time: '11:30', dur: 120, place: 'Rassada Pier, Phuket', title: 'Ferry — Phuket → Phi Phi', grp: 'HKT', status: 'rebooked', note: 'Same operator, moved free of charge. Return unchanged at 16:30.', cost: '฿0 change fee' });
    store.set({ disr: 'rebooked', laLine: 'Ferry 11:30 · Rassada Pier' });
    reply([{ who: 'c', text: 'Done — you’re on the 11:30, no charge, return unchanged. I told the Phi Phi lunch spot you’ll be 90 minutes later; they’re fine.', card: { title: 'Ferry — Phuket → Phi Phi', meta: 'Sun 2 Aug · 11:30 · Rassada Pier', tag: 'rebooked' } }], null, 1300);
  } else if (id === 'reSpeed') {
    setB('pp', { status: 'cancelled' });
    addB({ id: 'pp2', mo: 8, day: 2, time: '09:15', dur: 45, place: 'Rassada VIP jetty', title: 'Speedboat — Phuket → Phi Phi', grp: 'HKT', status: 'rebooked', note: 'VIP jetty at Rassada. 45 minutes. Refund on the ferry is already processing.', cost: '+฿1,400 on card' });
    store.set({ disr: 'rebooked', laLine: 'Speedboat 09:15 · VIP jetty' });
    reply([{ who: 'c', text: 'Booked the 09:15 speedboat — ฿1,400 on the card, and you’ll beat the ferry crowds by two hours. Ferry refund is processing.', card: { title: 'Speedboat — Phuket → Phi Phi', meta: 'Sun 2 Aug · 09:15 · Rassada VIP jetty', tag: 'rebooked' } }], null, 1300);
  } else if (id === 'meet') {
    reply(
      [{ who: 'c', text: 'Mei’s on Num, so I asked her agent directly — no texting back and forth. You’re both clear Thursday 15:00 or Friday 09:00. Friday you fly at 10:40, so I’d take Thursday. Which?' }],
      [
        { id: 'meetThu', label: 'Thursday 15:00' },
        { id: 'meetFri', label: 'Friday 09:00 anyway' },
      ],
      1200,
    );
  } else if (id === 'meetThu' || id === 'meetFri') {
    const thu = id === 'meetThu';
    store.set((s) => ({
      meetings: [...s.meetings.filter((m) => m.id !== 'mm'), { id: 'mm', mo: 7, day: thu ? 30 : 31, time: thu ? '15:00' : '09:00', dur: 30, place: 'Video · Num', title: 'Catch-up — Mei', src: 'NUM' as const }],
    }));
    reply(
      [{
        who: 'c',
        text: thu
          ? 'Set — Thursday 15:00, 30 minutes, video link attached. It’s already on Mei’s calendar too: Num keeps both copies in step, so if either of you moves it, everyone moves.'
          : 'Set — Friday 09:00 with a hard stop at 09:45, because you fly at 10:40 and I’m not risking it. It’s on Mei’s calendar too, and both copies stay in step.',
        card: { title: 'Catch-up — Mei', meta: (thu ? 'Thu 30 Jul · 15:00' : 'Fri 31 Jul · 09:00') + ' · video · on both calendars', tag: 'meeting' },
      }],
      null,
      1300,
    );
  } else if (id === 'photos') {
    store.set({ permOn: true, chips: [] });
  } else if (id === 'shareSet') {
    reply([{ who: 'c', text: 'Sent — approval on record. Dan now holds the same memory on his own shelf: same night, his own copy, and his shots can join yours. Nothing else from your library moved.', card: { title: 'Sushi Kanda — 14 photos', meta: 'Shared with Dan · lives in both memories', tag: 'shared' } }]);
  } else if (id === 'bill') {
    reply(
      [{ who: 'c', text: 'Le Du just sent the bill through — it’s already assigned to you, table 6. ฿5,290 with service. How do you want it gone?', card: { title: 'Bill — Le Du', meta: '฿5,290 · incl. service · table 6 · tonight', tag: 'bill' } }],
      [
        { id: 'payStars', label: 'Pay with Stars — ★529' },
        { id: 'payApple', label: 'Apple Pay' },
        { id: 'payLink', label: 'Card / crypto link' },
      ],
      1100,
    );
  } else if (id === 'payStars') {
    payBill('★529');
    reply([{ who: 'c', text: 'Paid — ★529 off your balance. Receipt’s filed to tonight’s dinner; the table is settled before you stand up.', card: { title: 'Dinner — Le Du', meta: 'PAID ★529 · receipt #LD-2841', tag: 'paid' } }], null, 900);
  } else if (id === 'payApple') {
    payBill('Apple Pay');
    reply([{ who: 'c', text: 'Done with Apple Pay — ฿5,290. Receipt’s filed to the dinner. Next time, stars settle it without the face-scan.', card: { title: 'Dinner — Le Du', meta: 'PAID · Apple Pay · receipt #LD-2841', tag: 'paid' } }], null, 900);
  } else if (id === 'payLink') {
    reply([{ who: 'c', text: 'Link sent by text — card or USDC, either lands on this same bill.' }], [], 900);
    setTimeout(() => {
      payBill('crypto');
      store.set((s) => ({
        msgs: [...s.msgs, { who: 'c', text: 'Paid — the crypto cleared. Receipt’s filed to the dinner.', card: { title: 'Dinner — Le Du', meta: 'PAID · USDC · receipt #LD-2841', tag: 'paid' } }],
        chips: defChips(),
      }));
    }, 3400);
  } else if (id === 'recall') {
    reply(
      [{ who: 'c', text: '23 April — Sushi Kanda, Akasaka, with Dan. You rated it 9/10 and said “worth the flight alone”.', card: { title: 'Omakase — Sushi Kanda', meta: 'Thu 23 Apr · 19:30 · Akasaka, Tokyo', tag: 'memory' } }],
      [
        { id: 'standing', label: 'Get me seats next time' },
        { id: 'week', label: 'What’s my week?' },
      ],
      1200,
    );
  } else if (id === 'standing') {
    reply([{ who: 'c', text: 'Saved as a standing request. The moment a Tokyo trip lands on your calendar, I chase seats before you ask.' }]);
  } else if (id === 'change') {
    reply([{ who: 'c', text: 'Tell me what to change — time, party size, or scrap it. I’ll handle the venue.' }]);
  }
}

export function permAllow() {
  store.set({ permOn: false, photosOn: true });
  reply(
    [{ who: 'c', text: 'Access granted. I matched 61 photos to five memories by when and where they were taken — Sushi Kanda got 14, Golden Gai got 23. They’re filed on the MEMORY shelf, not scattered in a feed.' }],
    [
      { id: 'shareSet', label: 'Send Dan the Sushi Kanda set' },
      { id: 'recall', label: 'When was that Tokyo omakase?' },
      { id: 'ferry', label: '▸ Disruption demo' },
    ],
    1400,
  );
}

export function permDeny() {
  store.set({ permOn: false });
  reply([{ who: 'c', text: 'No problem — your photos stay yours. Say the word anytime.' }], null, 600);
}

// ── NUM AI — the real brain ─────────────────────────────────────────────────
// Free-typed messages go to the backend in server/index.mjs (Claude Opus 5),
// which returns a reply plus actions the store applies. Scripted chip flows
// above remain untouched — the demo still works with the server off.

interface NumAction {
  type:
    | 'add_booking' | 'update_booking' | 'add_meeting' | 'remember' | 'invite'
    | 'plan_create' | 'plan_add' | 'service' | 'create_event'
    | 'errand' | 'flight_search';
  booking?: Booking;
  errand?: AppState['errandDraft'];
  search?: FlightQuery;
  id?: string;
  patch?: Partial<Booking>;
  meeting?: Meeting;
  key?: string;
  value?: string;
  /** invite */
  name?: string;
  phone?: string | null;
  /** plan_create */
  title?: string;
  dest?: string | null;
  starts_on?: string | null;
  /** plan_add */
  item?: Record<string, string | null>;
  /** service — options are resolved server-side from the user's country */
  kind?: ServiceHandoff['kind'];
  query?: string | null;
  to?: string | null;
  note?: string | null;
  mode?: 'connected' | 'handoff';
  options?: ServiceHandoff['options'];
  /** create_event */
  day?: string | null;
  time?: string | null;
  place?: string | null;
  address?: string | null;
  dress?: string | null;
  /** create_event — the people to ask, by name. Resolved server-side. */
  ask?: string[];
}

interface NumReply {
  reply: string;
  card: Msg['card'] | null;
  chips: Chip[] | null;
  actions: NumAction[];
  /** Where the server resolved the user to be (drives the header). */
  place?: string | null;
}

function applyAction(a: NumAction) {
  if (a.type === 'add_booking' && a.booking) {
    addB(a.booking);
    // If a group plan is open, the other members' Nums hear about it too —
    // that is the whole promise of connecting two accounts.
    void pushBookingToPlan(a.booking);
  } else if (a.type === 'update_booking' && a.id && a.patch) {
    setB(a.id, a.patch);
    // A change to a shared reservation is exactly what the others need to hear
    // about — a moved dinner nobody was told about is worse than no dinner.
    void pushBookingUpdateToPlan(a.id);
  }
  else if (a.type === 'add_meeting' && a.meeting) {
    store.set((s) => ({ meetings: [...s.meetings.filter((m) => m.id !== a.meeting!.id), a.meeting!] }));
  } else if (a.type === 'remember' && a.key && a.value) {
    store.set((s) => ({ profile: { ...s.profile, [a.key!]: a.value! } }));
  } else if (a.type === 'invite') {
    // Never sent silently: the sheet confirms WHO before anything goes out.
    startInvite({ name: a.name, phone: a.phone ?? undefined });
  } else if (a.type === 'plan_create' && a.title) {
    void createPlan(a.title, a.dest, a.starts_on).then((plan) => {
      if (plan) store.set({ partyOpen: true });
    });
  } else if (a.type === 'plan_add' && a.item?.title) {
    void addPlanItem({
      title: String(a.item.title),
      kind: 'idea',
      status: (a.item.status as 'idea' | 'proposed' | 'held' | 'confirmed') ?? 'idea',
      day: a.item.day ?? null,
      time: a.item.time ?? null,
      place: a.item.place ?? null,
      note: a.item.note ?? null,
    }).then(() => syncPlan());
  } else if (a.type === 'errand' && a.errand?.title) {
    // The model PROPOSES an errand; it never posts one. Posting moves Stars
    // into escrow immediately, and an agent that can spend someone's balance
    // because a sentence sounded like a request is a liability. The sheet
    // opens pre-filled and the person taps the button that names the number.
    store.set({ errandsOpen: true, errandDraft: a.errand });
  } else if (a.type === 'flight_search' && a.search?.fromCode) {
    void runFlightSearch(a.search);
  } else if (a.type === 'service' && a.kind && a.options?.length) {
    offerService({ kind: a.kind, mode: a.mode ?? 'handoff', note: a.note, to: a.to, query: a.query, options: a.options });
  } else if (a.type === 'create_event' && a.title) {
    void createEvent({
      title: a.title,
      day: a.day ?? null,
      time: a.time ?? null,
      place: a.place ?? null,
      address: a.address ?? null,
      dress: a.dress ?? null,
      note: a.note ?? null,
      // Named guests go with the event, so the people already on Num are asked
      // in the same round trip that creates it.
      ask: a.ask ?? [],
    });
  }
}

/**
 * Last line of defense against structured-output artifacts leaking into a
 * concierge bubble: strip leading/trailing JSON-ish fragments ("reply:",
 * ", chips: null…") and python-style {'role': …} history blocks.
 */
export function cleanText(t: string): string {
  let out = t.replace(/^[^A-Za-z]*(?:reply|chips|actions|card)['"]?\s*:\s*(?:null|\[\]|\{)?[^A-Za-z]*/, '');
  const tail = /(?:,\s*)?['"]?(?:chips|actions|card|role)['"]?\s*:\s*/.exec(out);
  if (tail && tail.index > 0) out = out.slice(0, tail.index);
  out = out.replace(/\{\s*['"]role['"][\s\S]*?(?:\}|$)/g, '');
  return out.replace(/[^\S\n]{2,}/g, ' ').trim();
}

/** Send a free-typed message to the real NUM AI backend. */
export async function askNum(text: string) {
  // A reply is already in flight — a double-tap must not double-send.
  if (store.get().typing) return;
  observeUserMessage(text);
  push({ who: 'u', text });
  // A new question retires the last provider tray — it belonged to the old one.
  store.set({ typing: true, chips: [], handoff: null });

  const s = store.get();
  const messages = s.msgs.map((m) => ({
    role: m.who === 'u' ? ('user' as const) : ('assistant' as const),
    content: m.text + (m.card ? `\n[card: ${m.card.title} · ${m.card.meta} · ${m.card.tag}]` : ''),
  }));
  const state = {
    stars: s.stars,
    billPaid: s.billPaid,
    photosOn: s.photosOn,
    bookings: s.bookings,
    meetings: s.meetings,
    memories: s.memories,
    profile: s.profile,
    // The server's lane router only trusts the cheap model once onboarding
    // settled a place — without this field it always pays for the big lane.
    onboarded: s.onboarded,
    // How they like to be answered, learned from their own reactions.
    style: styleForRequest(s),
    // The group listening in, if there is one.
    ...(s.planId ? { party: { title: s.plans.find((p) => p.id === s.planId)?.title, members: s.planMembers.length || 1 } } : {}),
    // Clashes and expiring holds are arithmetic — we do them, the model
    // decides which ones matter and how to say it.
    ...(/trip check|am i ready|check my trip|what needs me/i.test(text) ? { tripCheck: tripCheck(s) } : {}),
  };

  try {
    const res = await fetch('/api/num', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, state, place: s.place }),
    });
    if (!res.ok) throw new Error('backend ' + res.status);
    const out: NumReply = await res.json();
    out.actions?.forEach(applyAction);
    // The card's photo belongs to the booking it describes — match by title so
    // the PLAN shelf shows the same picture the chat card did.
    if (out.card?.photo) {
      const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const cardN = norm(out.card.title);
      store.set((s2) => ({
        bookings: s2.bookings.map((b) => {
          if (b.photo) return b;
          const bn = norm(b.title);
          return bn.length > 3 && (cardN.includes(bn) || bn.includes(cardN)) ? { ...b, photo: out.card!.photo } : b;
        }),
      }));
    }
    store.set((prev) => ({
      typing: false,
      // Unread only counts while the thread is closed — the dot carries it.
      unread: prev.threadOpen ? 0 : prev.unread + 1,
      msgs: [...prev.msgs, { who: 'c', text: out.reply, ...(out.card ? { card: out.card } : {}) }],
      chips: out.chips ?? defChips(),
      // The server resolves location against the shared destination database;
      // once it knows where we are, the header follows and onboarding is done.
      ...(out.place ? { place: out.place, onboarded: true } : {}),
    }));
  } catch (err) {
    console.error('[num-ai]', err);
    store.set((prev) => ({
      typing: false,
      msgs: [
        ...prev.msgs,
        {
          who: 'c',
          // Never blame the guest for the kitchen. This fires when the request
          // did not leave the device at all, so it is the one case where the
          // connection genuinely is the cause — and it still reads as ours.
          text: 'I didn’t manage to get that — looks like we’ve dropped the line. I’ll be right here when it’s back; just send it again.',
        },
      ],
      chips: defChips(),
    }));
  }
}
