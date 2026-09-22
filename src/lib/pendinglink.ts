// A friend add that has not landed yet, kept until it does.
//
// Scanning someone's code, or tapping their link, is a promise: "you two are
// friends now". Before 21 Sep 2026 that promise lived only in memory. A
// scanner who was not signed in yet, who had to install the app first, who
// lost signal, or whose page reloaded, lost the friend add without a word.
//
// So the intent is written down the moment it arrives and crossed off only
// when the server confirms it. Thirty days is long enough to cover "I will
// download it tonight" and short enough that a stale scan cannot surprise
// somebody next season.

export type PendingLink = { c?: string | null; i?: string | null; at: number };

const KEY = 'num-pending-link';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

const clean = (v: string | null | undefined): string | null =>
  v && SAFE.test(v) ? v : null;

export function savePendingLink(next: { c?: string | null; i?: string | null }, now = Date.now()): void {
  const c = clean(next.c);
  const i = clean(next.i);
  if (!c && !i) return;
  try {
    const prev = readPendingLink(now);
    localStorage.setItem(KEY, JSON.stringify({ c: c ?? prev?.c ?? null, i: i ?? prev?.i ?? null, at: now }));
  } catch { /* private mode: the in-memory copy still carries it this session */ }
}

export function readPendingLink(now = Date.now()): PendingLink | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingLink;
    if (!p || typeof p.at !== 'number' || now - p.at > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    const c = clean(p.c);
    const i = clean(p.i);
    return c || i ? { c, i, at: p.at } : null;
  } catch {
    return null;
  }
}

export function clearPendingLink(): void {
  try { localStorage.removeItem(KEY); } catch { /* fine */ }
}

/**
 * The link an app was opened with, in the shape the web boot already reads.
 *
 * A universal link hands the native app the ORIGINAL address, `/c/mem_x`,
 * because iOS opens the app instead of loading the page, so the Worker's
 * redirect to `/?c=mem_x` never happens. Both shapes land here as one answer.
 */
export function linkParams(raw: string): { c: string | null; i: string | null; ref: string | null } {
  let u: URL;
  try { u = new URL(raw); } catch { return { c: null, i: null, ref: null }; }
  const q = new URLSearchParams(u.search);
  const short = /^\/(r|i|c)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(u.pathname);
  if (short) q.set(({ r: 'ref', i: 'i', c: 'c' } as const)[short[1] as 'r' | 'i' | 'c'], short[2]);
  return { c: clean(q.get('c')), i: clean(q.get('i')), ref: q.get('ref')?.slice(0, 40) ?? null };
}
