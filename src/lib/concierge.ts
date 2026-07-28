// The concierge engine — a faithful port of the DCLogic class from
// Concierge.dc.html. Every flow here is scripted demo behavior; the public
// surface (sendChip, openVoice, payBill, buyPack…) is the seam where a real
// agent backend would slot in later.
import { store } from './store';
import type { Booking, Chip, Msg } from './types';

let typingTimer: ReturnType<typeof setTimeout> | undefined;
let boughtTimer: ReturnType<typeof setTimeout> | undefined;
let voiceT1: ReturnType<typeof setTimeout> | undefined;
let voiceT2: ReturnType<typeof setTimeout> | undefined;

function push(m: Msg) {
  store.set((s) => ({ msgs: [...s.msgs, m] }));
}

function reply(items: Msg[], chips?: Chip[] | null, delay = 1000) {
  store.set({ typing: true, chips: [] });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    store.set((s) => ({ typing: false, msgs: [...s.msgs, ...items], chips: chips ?? defChips() }));
  }, delay);
}

function defChips(): Chip[] {
  const s = store.get();
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
  store.set((s) => ({ bookings: [...s.bookings, b] }));
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

export function openVoice() {
  store.set({ voice: 1 });
  voiceT1 = setTimeout(() => store.set({ voice: 2 }), 1400);
  voiceT2 = setTimeout(() => {
    setB('m1', { time: '17:00', note: 'Moved to 17:00 by voice — same room, same therapist.' });
    store.set((s) => ({
      voice: 3,
      msgs: [
        ...s.msgs,
        { who: 'u', text: '“Move my massage to five.” — said aloud' },
        { who: 'c', text: 'Done — Ruen Nuad moved to 17:00. Same room, same therapist, calendar’s updated.' },
      ],
    }));
  }, 3400);
}

export function closeVoice() {
  clearTimeout(voiceT1);
  clearTimeout(voiceT2);
  store.set({ voice: 0 });
}

export function askToChange(title: string) {
  store.set({ view: 'thread' });
  push({ who: 'u', text: 'Change ' + title.replace(/ —.*/, '') });
  setTimeout(() => sendChip('change', ''), 50);
}

export function sendChip(id: string, label: string) {
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
      meetings: [...s.meetings, { id: 'mm', mo: 7, day: thu ? 30 : 31, time: thu ? '15:00' : '09:00', dur: 30, place: 'Video · Num', title: 'Catch-up — Mei', src: 'NUM' as const }],
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
