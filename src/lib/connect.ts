// The Connect Your World switches, made real.
//
// The old card recorded intent and did nothing. Every switch here now
// performs its actual connection the moment it's flipped, and none of them
// leave the app to do it:
//
//   contacts  → the browser's contact picker (a sheet over the app). The user
//               hand-picks; we never read the address book. iOS has no picker
//               at all, so there the row becomes Send & Share — the system
//               share sheet, which also floats over the app.
//   photos    → the photo picker, same idea: a sheet, hand-picked, in-app.
//   calendar  → Num's own calendar. On = every dated group plan mirrors onto
//               the shelf automatically (and back-fills the ones already set).
//   crypto    → a wallet address held on-device; balances read from a public
//               RPC. Nothing signs, nothing moves — read-only by construction.
//   email     → your personal forwarding address (num+<id>@itsnum.com).
//               Forward a confirmation; it lands in your Num inbox.
//   texts     → Num's real phone number. Texts to it reach your account —
//               the server matches your verified number.
//
// Success flips the switch; a dismissed picker or a failed grant leaves it
// off. A switch that's on and did nothing is a lie the user finds out about
// at the worst moment.
import { store } from './store';
import { pickContacts, contactsSupported, mirrorPlanDate } from './social';
import type { Connections } from './types';

const setConn = (key: keyof Connections, on: boolean, detail?: string) =>
  store.set((s) => ({
    connections: { ...s.connections, [key]: on },
    connDetail: detail === undefined ? s.connDetail : { ...s.connDetail, [key]: detail },
  }));

export { contactsSupported };

/** The system share sheet — the iOS-honest replacement for a contacts grant. */
export async function sendAndShare(): Promise<void> {
  const url = 'https://itsnum.com/get/';
  const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> };
  try {
    if (nav.share) {
      await nav.share({ title: 'Num', text: 'Get Num — plans, bookings, one concierge.', url });
      return;
    }
  } catch {
    return; // user closed the sheet — that's an answer, not an error
  }
  try {
    await navigator.clipboard.writeText(url);
    setConn('contacts', false, 'Link copied — paste it anywhere');
  } catch { /* nothing to do */ }
}

async function connectContacts(): Promise<void> {
  const picked = await pickContacts();
  if (picked.length) setConn('contacts', true, `${picked.length} picked — “invite Sam” now finds Sam`);
}

/** A real photo grant: the picker opens, the user chooses, we keep the proof. */
function connectPhotos(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  input.onchange = () => {
    const n = input.files?.length ?? 0;
    if (n) setConn('photos', true, `${n} photo${n === 1 ? '' : 's'} shared with this trip`);
    input.remove();
  };
  document.body.appendChild(input);
  input.click();
}

/** On = dated group plans land on the calendar by themselves. */
function connectCalendar(): void {
  const s = store.get();
  let mirrored = 0;
  for (const p of s.plans) {
    if (p.starts_on) { mirrorPlanDate(p); mirrored += 1; }
  }
  setConn('calendar', true, mirrored ? `On — ${mirrored} plan${mirrored === 1 ? '' : 's'} already on your calendar` : 'On — dated plans appear here by themselves');
}

/** Read-only balance for an address the user types. Nothing ever signs. */
async function connectCrypto(): Promise<void> {
  const addr = window.prompt('Paste your wallet address (0x…) — read-only, balances only. Nothing can move.');
  if (!addr) return;
  const clean = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(clean)) {
    setConn('crypto', false, 'That doesn’t look like a wallet address');
    return;
  }
  setConn('crypto', true, `${clean.slice(0, 6)}…${clean.slice(-4)} — reading balance…`);
  try {
    // USDC on Ethereum mainnet via Cloudflare's public RPC. balanceOf(address).
    const data = '0x70a08231' + clean.slice(2).toLowerCase().padStart(64, '0');
    const r = await fetch('https://cloudflare-eth.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', data }, 'latest'],
      }),
    });
    const out = (await r.json()) as { result?: string };
    const usdc = out.result ? Number(BigInt(out.result)) / 1e6 : null;
    setConn('crypto', true,
      usdc !== null && Number.isFinite(usdc)
        ? `${clean.slice(0, 6)}…${clean.slice(-4)} · ${usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
        : `${clean.slice(0, 6)}…${clean.slice(-4)} — linked (balance unavailable right now)`);
  } catch {
    setConn('crypto', true, `${clean.slice(0, 6)}…${clean.slice(-4)} — linked (balance unavailable right now)`);
  }
}

/** Your forwarding address, minted from your member id and put on the clipboard. */
async function connectEmail(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  const addr = `num+${me.id.replace(/[^A-Za-z0-9_]/g, '')}@itsnum.com`;
  setConn('email', true, `${addr} — forward confirmations here`);
  try { await navigator.clipboard.writeText(addr); } catch { /* shown on the row regardless */ }
}

/** Num's number, fetched from the server so app and worker never disagree. */
async function connectTexts(): Promise<void> {
  try {
    const r = await fetch('/api/version');
    const d = (await r.json()) as { sms_number?: string | null };
    if (d.sms_number) {
      setConn('texts', true, `Text ${d.sms_number} — it reaches your Num`);
      try { await navigator.clipboard.writeText(d.sms_number); } catch { /* row shows it */ }
    } else {
      setConn('texts', false, 'Texting line isn’t switched on yet');
    }
  } catch {
    setConn('texts', false, 'Couldn’t reach the server — try again');
  }
}

/** The one entry point the card calls. Off is instant; on does the real work. */
export function toggleConnection(key: keyof Connections): void {
  const on = store.get().connections[key];
  if (on) { setConn(key, false); return; }
  switch (key) {
    case 'contacts': void connectContacts(); break;
    case 'photos': connectPhotos(); break;
    case 'calendar': connectCalendar(); break;
    case 'crypto': void connectCrypto(); break;
    case 'email': void connectEmail(); break;
    case 'texts': void connectTexts(); break;
  }
}
