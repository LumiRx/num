// Seed data — ported verbatim from Concierge.dc.html (NUM v0.8 canonical prototype).
import { T } from './i18nmark';
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
  { id: 'photos', label: 'Let NUM organize my photos' },
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
    thinkingLine: null,
    featureOpen: null,
    eventView: null,
    savedFlights: [],
    notifOn: false,
    disr: 'none' as const,
    laLine: '',
    calOpen: false,
    calM: 0 as const,
    selDay: null,
    shareOpen: false,
    shareCard: null,
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
    billOpen: null,
    passengerOpen: false,
    connectTo: null,
    pairCode: null,
    flightOffers: null,
    flightSearching: false,
    flightError: null,
    errandDraft: null,
    bookDraft: null,
    bookRequests: [],
    travelDraft: null,
    travelReferrals: [],
    tabOpen: null,
    tabId: null,
    discoverOpen: null,
    placeOpen: false,
    flightWatchOpen: false,
    flightWatchPrefill: null,
    flights: [],
    errandsOpen: false,
    errands: [],
    myErrands: [],
    inbox: { connects: [], plans: [], events: [] },
    // Default layout. NUM rewrites this as the trip changes — directions only
    // earn a slot when there is somewhere to be.
    widgets: ['next', 'tonight', 'requests', 'directions', 'calendar', 'tripcheck', 'group', 'events', 'wallet', 'connections'] as WidgetId[],
    pushOn: false,
    theme: 'auto' as const,
    lang: null,
    i18nTick: 0,
    businessOpen: false,
    scoutOpen: false,
    deleteOpen: false,
    contactOpen: false,
    profileOpen: false,
    style: {},
    reactions: {},
    handoff: null,
    connections: { contacts: false, photos: false, calendar: false, crypto: false, email: false, texts: false },
    connDetail: {},
    events: [],
    eventId: null,
    eventOpen: false,
    // Deep research. `research` survives a reload so a run started before the
    // app was closed can be picked up again — see resumeResearch().
    researchOpen: false,
    research: null,
    researchBusy: false,
    researchError: null,
    researchLeft: null,
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
    activity: [],
    meetings: seedMeetings,
    memories: seedMemories,
    chips: seedChips,
    msgs: seedMsgs,
    bookings: seedBookings,
  };
}

/** A brand-new user, anywhere in the world: NUM asks before assuming. */
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
    activity: [],
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
        text: T('Hi, I’m NUM. Tell me what you want, in any language. I’ll find three real places and book the one you pick.\n\nLet’s start with your name.'),
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
    inviteOpen, partyOpen, eventOpen, businessOpen, scoutOpen, profileOpen, threadOpen, unread, handoff, payOpen, billOpen, passengerOpen, tabOpen, discoverOpen, placeOpen, flightWatchOpen, flightWatchPrefill, flights, errandsOpen, errands, myErrands, flightOffers, flightSearching, flightError, errandDraft,
    // The turn in flight and the page that is open are this launch's business only.
    // savedFlights is NOT here: a fare somebody kept must survive closing the app.
    thinkingLine, featureOpen, eventView,
    // A table request restored from localStorage would show "waiting on the
    // venue" for a venue that answered yesterday. It is server truth and it is
    // re-read on open; a proposal nobody sent is not worth surviving a reload.
    bookDraft, bookRequests,
    i18nTick,
    // Same reasoning for the travel pair: a referral restored from
    // localStorage would show "waiting on the agency" for an agency that
    // quoted yesterday, and a handoff nobody sent is not worth a reload.
    travelDraft, travelReferrals,
    // Conversations are server truth. A thread restored from localStorage
    // would show messages that may since have been read somewhere else, and
    // unread badges that no longer exist.
    dmOpen, dmWith, dmThread, dmInbox, dmError, dmPending,
    // The request inbox is server truth too, re-read on open by
    // refreshRequests — and it was the one required-shape field still being
    // saved. See the crash note in repairShapes below: a malformed inbox in
    // localStorage took the whole app down on every launch, and no amount of
    // fixing the network path could reach a value already on the device.
    inbox, ...keep } = s;
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

/**
 * Put back the shapes the app is entitled to assume.
 *
 * ── THE CRASH THIS EXISTS FOR ────────────────────────────────────────────
 *
 * 15 Sep 2026, on an iPhone, while adding somebody:
 *
 *   undefined is not an object (evaluating 'e.connects.length')
 *
 * `requests.ts` already normalises the inbox as it arrives from the server,
 * and has done since 9 Sep. The crash kept happening anyway, because there
 * were TWO boundaries and only one was guarded: `initialState` spreads the
 * saved blob straight over the defaults, so a malformed inbox written to
 * localStorage BEFORE that fix is restored on every launch, untouched, for as
 * long as the app is installed.
 *
 * That is the nasty shape of this bug. The fix shipped, the crash continued,
 * and the only escape for somebody already holding a bad value was deleting
 * the app — which is the one thing you cannot ask of a user who is mid-signup.
 *
 * So restore repairs rather than trusts. `msgs` was already repaired here for
 * the same reason; this generalises it to every field whose shape the UI is
 * allowed to assume, and it runs whether or not the field is still persisted —
 * old blobs on old devices outlive the code that wrote them.
 */
/**
 * Every array the restore path will straighten out.
 *
 * Two groups, and the second is the interesting one.
 *
 * SAVED TODAY — everything persistable() lets through. restore.test.mjs
 * regenerates this set from types.ts and fails if one is missing, so adding an
 * array to the store cannot quietly reintroduce the crash.
 *
 * NO LONGER SAVED — fields persistable() now excludes, kept here on purpose.
 * They were saved by older builds, and the inbox crash is precisely what
 * happens when you assume a field you stopped writing has stopped existing:
 * `inbox` was excluded from persistence AND still sitting in localStorage on
 * every phone that had ever run the old code. Removing a name from this list
 * only becomes safe once no installed build could still be carrying it, which
 * is a date nobody can know. So they stay.
 */
export const REPAIRED_ARRAYS = [
  // saved today
  'msgs', 'picks', 'loved', 'rejected', 'lengths', 'options', 'widgets', 'events',
  'friends', 'plans', 'planItems', 'planFeed', 'txns', 'meetings', 'memories',
  'chips', 'bookings',
  // written by older builds, still out there on somebody's phone
  'errands', 'myErrands', 'bookRequests', 'travelReferrals', 'flightOffers',
  // 18 Sep 2026: fares the guest chose to keep.
  'savedFlights',
] as const;

export function repairShapes(saved: Record<string, unknown>): Record<string, unknown> {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const out = { ...saved };

  // Three arrays, always — the exact guarantee DashView reads without asking.
  const inbox = (out.inbox ?? {}) as Record<string, unknown>;
  out.inbox = {
    connects: arr(inbox.connects),
    plans: arr(inbox.plans),
    events: arr(inbox.events),
  };

  // EVERY persisted array field. Not a hand-picked few.
  //
  // The first version of this listed six, chosen by looking at the crash that
  // prompted it. A sweep of AppState against persistable() then found SIXTEEN
  // MORE saved arrays with no repair — picks, plans, bookings, friends, txns,
  // memories and the rest. Each one is the identical bug: a non-array in
  // localStorage, a .map or .length on it, and an app that crashes on every
  // launch until it is deleted.
  //
  // restore.test.mjs regenerates this list from types.ts and persistable() and
  // fails if a saved array is missing from it, so adding a new array field to
  // the store cannot quietly reintroduce the crash.
  for (const k of REPAIRED_ARRAYS) {
    if (k in out) out[k] = arr(out[k]);
  }

  // The colour themes of the summer are gone; whatever a phone saved
  // (ember, midnight, bloom…) becomes Auto — the one look, light or dark.
  if ('theme' in out && !['auto', 'verified', 'verified-dark'].includes(String(out.theme))) out.theme = 'auto';

  // A widget added after a phone first saved its list would otherwise never
  // appear there. Tonight slots in right under NEXT UP, where it was designed
  // to sit; a list the person has reordered keeps their order.
  if (Array.isArray(out.widgets) && !(out.widgets as unknown[]).includes('tonight')) {
    const w = out.widgets as string[];
    const at = w.indexOf('next');
    w.splice(at < 0 ? 0 : at + 1, 0, 'tonight');
  }

  return out;
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
        // repairShapes runs over the SAVED blob, before it is spread — so a
        // bad value cannot reach the state at all, rather than being fixed up
        // afterwards by whoever happens to read it next.
        return { ...freshState(), ...repairShapes(saved), msgs, ...identity, demo: false };
      }
    }
  } catch {
    // Corrupt or unavailable storage — start clean, but keep the account.
  }
  return { ...freshState(), ...identity };
}
