// Seed data — ported verbatim from Concierge.dc.html (NUM v0.8 canonical prototype).
import type { AppState, Booking, Chip, Meeting, MemoryItem, Msg, Txn, WidgetId } from './types';

export const seedTxns: Txn[] = [
  { id: 't1', t: 'Top-up ★1,000', meta: 'Apple Pay · 24 Jul', amt: '+★1,000', dir: 1 },
  { id: 't2', t: 'Full Moon deposit', meta: '★150 · receipt filed · 24 Jul', amt: '−★150', dir: 0 },
];

export const seedMeetings: Meeting[] = [
  { id: 'mtg1', mo: 7, day: 29, time: '16:00', title: 'Investor call — Arta Capital', src: 'GCAL', place: 'Video · Meet', dur: 45 },
  { id: 'mtg2', mo: 7, day: 30, time: '11:30', title: 'Portfolio review', src: 'GCAL', place: 'Video · Meet', dur: 45 },
  { id: 'mtg3', mo: 8, day: 6, time: '09:00', title: 'Board prep', src: 'GCAL', place: 'Video · Meet', dur: 60 },
];

export const seedMemories: MemoryItem[] = [
  { id: 'me1', trip: 'TOKYO', date: 'Wed 22 Apr', time: '10:00', photos: 9, title: 'teamLab Planets', place: 'Toyosu, Tokyo', note: 'Two hours, socks off. You said the water room beat every photo of it.' },
  { id: 'me2', trip: 'TOKYO', date: 'Thu 23 Apr', time: '19:30', photos: 14, title: 'Omakase — Sushi Kanda', place: 'Akasaka, Tokyo', note: 'With Dan. Rated 9/10 — “worth the flight alone”. Standing request available.' },
  { id: 'me3', trip: 'TOKYO', date: 'Fri 24 Apr', time: '21:00', photos: 23, title: 'Golden Gai crawl', place: 'Shinjuku, Tokyo', note: 'Four bars, one karaoke incident.' },
  { id: 'me4', trip: 'LISBON', date: 'Sat 16 May', time: '20:00', photos: 8, title: 'Fado night — Tasca do Chico', place: 'Bairro Alto, Lisbon', note: 'Standing room only. You kept the ticket stub.' },
  { id: 'me5', trip: 'LISBON', date: 'Sun 17 May', time: '12:30', photos: 7, title: 'Time Out Market lunch', place: 'Cais do Sodré, Lisbon', note: 'The custard tarts won. Six boxes came home.' },
];

export const seedChips: Chip[] = [
  { id: 'bill', label: 'Pay my bill — Le Du' },
  { id: 'photos', label: 'Let Num organize my photos' },
  { id: 'dinner', label: 'Dinner on Thursday' },
  { id: 'meet', label: 'Set a meeting with Mei' },
  { id: 'recall', label: 'When was that Tokyo omakase?' },
  { id: 'revert', label: 'Revert the reshuffle' },
  { id: 'ferry', label: '▸ Disruption demo' },
];

export const seedMsgs: Msg[] = [
  { who: 'c', text: 'Morning, Viv. Rain over Bangkok until about 14:00, so I’ve reshuffled today: massage pulled up to 11:00, Grand Palace walk moved to Thursday 09:00 when it’s dry. Nothing else touched — say revert if you’d rather I hadn’t.' },
  { who: 'c', text: 'One thing needs you: the Bang Tao beach club is a hold, not a booking. Confirm by Friday or I release it.', card: { title: 'Beach club — Bang Tao', meta: 'Sat 1 Aug · 10:00 · daybed for two', tag: 'hold' } },
];

export const seedBookings: Booking[] = [
  { id: 'd1', mo: 7, day: 28, time: '19:30', dur: 150, place: 'Silom, Bangkok', title: 'Dinner — Le Du', grp: 'BKK', status: 'confirmed', note: 'Counter seats, tasting menu. Booked under Viv. Table held to 19:45.', cost: '฿4,800 · paid on card' },
  { id: 'm1', mo: 7, day: 28, time: '11:00', dur: 90, place: 'Convent Rd, Silom', title: 'Thai massage — Ruen Nuad', grp: 'BKK', status: 'confirmed', note: 'Pulled up from 16:00 because of the rain window. 90 minutes.', cost: '฿1,200 · pay there' },
  { id: 'b1', mo: 7, day: 29, time: '15:00', dur: 120, place: 'Sathorn pier', title: 'Chao Phraya long-tail + Wat Arun', grp: 'BKK', status: 'confirmed', note: 'Private boat, 2 hrs, from Sathorn pier. Bring the good camera.', cost: '฿2,400 · paid' },
  { id: 'g1', mo: 7, day: 30, time: '09:00', dur: 150, place: 'Old City, Bangkok', title: 'Grand Palace walk', grp: 'BKK', status: 'confirmed', note: 'Moved from Wednesday (rain). Guide: Nok. Dress code applies.', cost: '฿1,800 · paid' },
  { id: 'f1', mo: 7, day: 31, time: '10:40', dur: 85, place: 'BKK T2 · gate closes 10:10', title: 'Flight BKK → HKT', grp: 'BKK', status: 'confirmed', note: 'TG 2205 · seat 4A · I’ll check you in Thursday night.', cost: '฿3,150 · paid' },
  { id: 'bc', mo: 8, day: 1, time: '10:00', dur: 240, place: 'Bang Tao beach, Phuket', title: 'Beach club — Bang Tao', grp: 'HKT', status: 'hold', holdBy: 'FRI', note: 'Daybed for two held, no card taken yet. Confirm by Friday or I release it.', cost: '฿3,000 min spend' },
  { id: 'pp', mo: 8, day: 2, time: '09:00', dur: 120, place: 'Rassada Pier, Phuket', title: 'Ferry — Phuket → Phi Phi', grp: 'HKT', status: 'confirmed', note: 'Andaman Wave · Rassada Pier · returns 16:30.', cost: '฿1,900 return' },
  { id: 'mt', mo: 8, day: 3, time: '18:00', dur: 180, place: 'Bangla Rd, Patong', title: 'Muay Thai — Bangla stadium', grp: 'HKT', status: 'deposit', note: 'Ringside pair. Deposit paid 24 Jul; balance at the door.', cost: '฿2,000 deposit paid' },
  { id: 'f2', mo: 8, day: 5, time: '09:15', dur: 130, place: 'HKT · gate 08:45', title: 'Flight HKT → SIN', grp: 'SIN', status: 'confirmed', note: 'TR 655 · bags checked through.', cost: 'S$168 · paid' },
  { id: 'ng', mo: 8, day: 7, time: '10:00', dur: 210, place: 'St Andrew’s Rd, Singapore', title: 'National Gallery + hawker crawl', grp: 'SIN', status: 'confirmed', note: 'Gallery at 10, Maxwell Centre for lunch with Mei at 12:30.', cost: 'S$40 · paid' },
  { id: 'fm1', mo: 8, day: 14, time: '13:00', dur: 60, place: 'Nathon pier, Samui', title: 'Ferry — Samui → Haad Rin', grp: 'KP', status: 'confirmed', note: 'Booked either side of the party so you’re never stranded.', cost: '฿600' },
  { id: 'fp', mo: 8, day: 14, time: '21:00', dur: 60, place: 'Haad Rin beach', title: 'Full Moon Party — Haad Rin', grp: 'KP', status: 'deposit', note: 'Booked 3 weeks out, deposit paid 24 Jul. Reminder ladder set: check-in 7 Aug, day-before 13 Aug, Live Activity 3 hrs out.', cost: '฿1,500 deposit paid' },
  { id: 'fm2', mo: 8, day: 15, time: '12:00', dur: 60, place: 'Haad Rin pier', title: 'Ferry back — Haad Rin → Samui', grp: 'KP', status: 'confirmed', note: 'Midday boat — you’ll want the sleep.', cost: '฿600' },
];

export const PLAN_GROUPS: Array<[name: string, dates: string, grp: Booking['grp']]> = [
  ['BANGKOK', 'JUL 28 – 31', 'BKK'],
  ['PHUKET', 'JUL 31 – AUG 5', 'HKT'],
  ['SINGAPORE', 'AUG 5 – 8', 'SIN'],
  ['KOH PHANGAN', 'AUG 14 – 15 · THE RETURN', 'KP'],
];

export const MEMORY_GROUPS: Array<[name: MemoryItem['trip'], dates: string]> = [
  ['TOKYO', '22 – 25 APR 2026'],
  ['LISBON', '15 – 18 MAY 2026'],
];


/** Everything both modes share at boot. */
function baseState() {
  return {
    view: 'dash' as const,
    typing: false,
    notifOn: false,
    disr: 'none' as const,
    laLine: '',
    calOpen: false,
    calM: 0 as const,
    selDay: null,
    shareOpen: false,
    shLive: true,
    shHide: true,
    copied: false,
    killed: false,
    expanded: null,
    voice: 0 as const,
    walletOpen: false,
    permOn: false,
    bought: '',
    starMoves: [],
    payOpen: null,
    connectTo: null,
    pairCode: null,
    flightOffers: null,
    flightSearching: false,
    flightError: null,
    errandDraft: null,
    tabOpen: null,
    tabId: null,
    errandsOpen: false,
    errands: [],
    myErrands: [],
    inbox: { connects: [], plans: [], events: [] },
    // Default layout. Num rewrites this as the trip changes — directions only
    // earn a slot when there is somewhere to be.
    widgets: ['next', 'requests', 'directions', 'calendar', 'tripcheck', 'group', 'events', 'wallet', 'connections'] as WidgetId[],
    pushOn: false,
    theme: 'ember' as const,
    businessOpen: false,
    profileOpen: false,
    style: {},
    reactions: {},
    handoff: null,
    connections: { contacts: false, photos: false, calendar: false, crypto: false, email: false, texts: false },
    connDetail: {},
    events: [],
    eventId: null,
    eventOpen: false,
    // The app opens ON the thread — it is still the product. Closing it drops
    // you to the dash, and the floating dot brings it back from anywhere.
    threadOpen: true,
    unread: 0,
    dmOpen: false,
    dmWith: null,
    dmThread: [],
    dmInbox: [],
    dmError: null,
    dmPending: null,
    me: null,
    friends: [],
    contacts: [],
    plans: [],
    planId: null,
    planItems: [],
    planMembers: [],
    planCursor: 0,
    planFeed: [],
    refCode: null,
    inviteToken: null,
    inviteOpen: null,
    partyOpen: false,
  };
}

/** The scripted Viv / SE-Asia demo trip — reachable via the demo chip. */
export function demoState(): AppState {
  return {
    ...baseState(),
    here: null,
    demo: true,
    place: 'Bangkok',
    onboarded: true,
    profile: {},
    stars: 1240,
    photosOn: false,
    billPaid: false,
    txns: seedTxns,
    meetings: seedMeetings,
    memories: seedMemories,
    chips: seedChips,
    msgs: seedMsgs,
    bookings: seedBookings,
  };
}

/** A brand-new user, anywhere in the world: Num asks before assuming. */
export function freshState(): AppState {
  return {
    ...baseState(),
    demo: false,
    place: null,
    here: null,
    onboarded: false,
    profile: {},
    stars: 100, // welcome stars — enough to feel the payrail, not enough to matter
    photosOn: false,
    billPaid: false,
    txns: [{ id: 't0', t: 'Welcome stars ★100', meta: 'on the house', amt: '+★100', dir: 1 }],
    meetings: [],
    memories: [],
    chips: [{ id: 'demo', label: '▸ Show me a live demo trip' }],
    msgs: [
      {
        who: 'c',
        // The first thing anyone reads. It has one job: make them want to
        // reply. Concrete beats grand — "remembers you don't eat shellfish"
        // lands where "your whole trip, handled" does not. Location is NOT
        // asked here; one question at a time, and the name comes first.
        text: 'Hi — I’m Num.\n\nThink of me as the friend who knows the good tables, gets a car to actually turn up, and remembers you don’t eat shellfish. Dinner tonight, a driver at six, a whole weekend for eight — you ask, I’ll sort it.\n\nLet’s start with your name.',
      },
    ],
    bookings: [],
  };
}

// ── persistence — a traveller's trip survives closing the app ──────────────

const STORAGE_KEY = 'num-trip-v1';

/** Fields worth keeping across launches (UI transients stay out). */
export function persistable(s: AppState) {
  const { view, typing, notifOn, calOpen, shareOpen, walletOpen, permOn, voice, expanded, selDay, calM, bought, copied,
    inviteOpen, partyOpen, eventOpen, businessOpen, profileOpen, threadOpen, unread, handoff, payOpen, tabOpen, errandsOpen, errands, myErrands, flightOffers, flightSearching, flightError, errandDraft,
    // Conversations are server truth. A thread restored from localStorage
    // would show messages that may since have been read somewhere else, and
    // unread badges that no longer exist.
    dmOpen, dmWith, dmThread, dmInbox, dmError, dmPending, ...keep } = s;
  // The transcript is the only field that grows without limit, and it is the
  // one that used to push the whole save over quota.
  return { ...keep, msgs: keep.msgs.slice(-MAX_PERSISTED_MSGS) };
}

/**
 * Identity lives in its OWN key, separate from everything else.
 *
 * This is the fix for "it asks who I am every time I open the app". The
 * account used to be one field inside a single large blob that also held the
 * entire chat transcript. Two ways that lost people:
 *
 *   · The transcript grows forever. Once the blob passed the localStorage
 *     quota, setItem threw, the catch swallowed it, and NOTHING was saved from
 *     then on — so the next launch restored a stale blob or none at all.
 *   · A single malformed field made the loader discard the whole object,
 *     identity included.
 *
 * Who you are is a few hundred bytes and must never be at the mercy of either.
 * It is written separately, first, and read back independently.
 */
const IDENTITY_KEY = 'num-identity-v1';

/** Keep the transcript from growing without bound and evicting the account. */
const MAX_PERSISTED_MSGS = 200;

export function saveState(s: AppState): void {
  // The demo is a showroom, not the user's data — never persist it.
  if (s.demo) return;

  // Identity first and on its own, so a full quota can never cost the account.
  try {
    if (s.me) localStorage.setItem(IDENTITY_KEY, JSON.stringify({ me: s.me, place: s.place, onboarded: s.onboarded }));
  } catch {
    /* nothing else to try — private mode blocks writes entirely */
  }

  const body = persistable(s);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(body));
  } catch {
    // Almost always quota. Drop the oldest messages and try once more rather
    // than silently giving up on every future save.
    try {
      const trimmed = { ...body, msgs: Array.isArray(body.msgs) ? body.msgs.slice(-40) : [] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* storage genuinely unavailable — the session still works in memory */
    }
  }
}

export function initialState(): AppState {
  // Identity is read on its own and applied LAST, so a corrupt or missing
  // main blob costs you your chat history and never your account.
  let identity: Partial<AppState> = {};
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.me?.id) identity = { me: parsed.me, place: parsed.place ?? null, onboarded: !!parsed.onboarded };
    }
  } catch {
    /* unreadable identity — fall through to the main blob */
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        // A missing or malformed transcript is not a reason to forget who
        // somebody is. Repair the field instead of discarding the object —
        // and if we know them, do NOT fall back to the cold-start welcome
        // that ends "let's start with your name". Being greeted like a
        // stranger by an app you are signed into is worse than an empty
        // thread, because it reads as though it forgot you.
        const known = identity.me ?? saved.me;
        const msgs = Array.isArray(saved.msgs)
          ? saved.msgs
          : known
            ? [{ who: 'c' as const, text: `Welcome back${known.name ? ', ' + known.name : ''}. Your trip and your people are all still here — what do you need?` }]
            : freshState().msgs;
        return { ...freshState(), ...saved, msgs, ...identity, demo: false };
      }
    }
  } catch {
    // Corrupt or unavailable storage — start clean, but keep the account.
  }
  return { ...freshState(), ...identity };
}
