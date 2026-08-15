/**
 * Opening hours, stored in 42 characters.
 *
 * Dre, 11 Aug 2026: "we need to filter to find which businesses are open
 * actually. so we dont waste data. we need a way to store this data very
 * cheaply."
 *
 * ── WHY A BITMASK AND NOT JSON ───────────────────────────────────────────
 *
 * The obvious storage is the schema.org shape a website publishes —
 * openingHoursSpecification, an array of objects with dayOfWeek, opens and
 * closes. It is 300–600 bytes per venue and it has to be JSON.parse'd inside
 * the Worker, per candidate place, on every message, before you can answer
 * the only question anyone actually asks: is it open right now.
 *
 * A week has 168 hours. 168 bits is 21 bytes, 42 hex characters. "Open now"
 * becomes one bit test. Across 90,263 Los Angeles places that is under 4 MB
 * instead of roughly 45 MB, and the read cost per guest message goes from
 * parsing a few dozen JSON blobs to a few dozen integer lookups.
 *
 * Hour granularity, deliberately. Half-hours would double the width to catch
 * venues that open at 11:30, and the mask is not what a guest reads — it is
 * what the FILTER uses. `hours` keeps the human string for display; this is
 * only ever asked "yes or no, right now". An hour marked open means some of
 * that hour is open, which is the correct bias for "should I show this".
 *
 * ── UNPARSEABLE MEANS NULL, NEVER GUESSED ────────────────────────────────
 *
 * OSM's opening_hours grammar is enormous — seasons, weeks, sunset offsets,
 * public holidays, "Mo-Fr 09:00-12:00 open \"by appointment\"". This handles
 * the common subset and returns null for everything else, and null is
 * treated everywhere as "we don't know", never as "closed" and never as
 * "open". Sending somebody to a locked door because a parser guessed is a
 * worse failure than not knowing, and it is the kind of failure a guest
 * remembers.
 */

const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const BYTES = 21; // 168 bits
export const WIDTH = 168;

const empty = () => new Uint8Array(BYTES);
const setBit = (m, i) => { m[i >> 3] |= 0x80 >> (i & 7); };
export const getBit = (m, i) => !!(m[i >> 3] & (0x80 >> (i & 7)));

/** 21 bytes → 42 lowercase hex characters. */
export function toHex(mask) {
  let s = '';
  for (const b of mask) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 42 hex characters → 21 bytes. Anything malformed is null, not zeros. */
export function fromHex(hex) {
  const s = String(hex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{42}$/.test(s)) return null;
  const m = empty();
  for (let i = 0; i < BYTES; i++) m[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return m;
}

/** Mark [from, to) on a day, wrapping past midnight into the next day. */
function mark(mask, day, from, to) {
  // 22:00–02:00 is one continuous shift, not a mistake. Roll it forward.
  const span = to > from ? to - from : 24 - from + to;
  for (let k = 0; k < span; k++) {
    const h = (from + k) % 24;
    const d = (day + Math.floor((from + k) / 24)) % 7;
    setBit(mask, d * 24 + h);
  }
}

const hhmm = (s) => {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] ?? 0);
  if (h > 24 || mi > 59) return null;
  return { h, mi };
};

function daysIn(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const range = /^([a-z]{2})\s*-\s*([a-z]{2})$/.exec(part.trim());
    if (range) {
      const a = DAYS.indexOf(range[1]), b = DAYS.indexOf(range[2]);
      if (a < 0 || b < 0) return null;
      // Fr-Mo is a real and common spec: it wraps the week.
      for (let i = 0; i < 7; i++) { const d = (a + i) % 7; out.add(d); if (d === b) break; }
      continue;
    }
    const one = DAYS.indexOf(part.trim());
    if (one < 0) return null;
    out.add(one);
  }
  return [...out];
}

/**
 * OSM `opening_hours` → mask, or null if we cannot be sure.
 *
 * Supported: 24/7, bare time ranges (every day), day lists and ranges,
 * multiple time ranges per rule, overnight spans, `off`/`closed`, and
 * semicolon-separated rules applied in order so a later `Su off` overrides an
 * earlier `Mo-Su`.
 */
export function parseHours(text) {
  let s = String(text ?? '').toLowerCase().trim();
  if (!s) return null;
  // Quoted comments carry no schedule and break the tokeniser.
  s = s.replace(/"[^"]*"/g, ' ').trim();
  if (!s) return null;
  if (/^(24\/7|24x7|open 24 hours)$/.test(s)) { const m = empty(); m.fill(0xff); return m; }
  // Anything with grammar we do not model is refused outright rather than
  // half-applied — a partial parse is a confident wrong answer.
  if (/(sunrise|sunset|dawn|dusk|week \d|easter|\[|\|\||=>)/.test(s)) return null;

  const mask = empty();
  let matched = 0;
  for (let rule of s.split(';')) {
    rule = rule.replace(/\bph\b\s*(off|closed)?/g, ' ').trim(); // public holidays: not modelled
    if (!rule) continue;
    const closing = /\b(off|closed)\b/.test(rule);
    rule = rule.replace(/\b(off|closed)\b/g, '').trim();

    const dm = /^((?:[a-z]{2}(?:\s*-\s*[a-z]{2})?)(?:\s*,\s*[a-z]{2}(?:\s*-\s*[a-z]{2})?)*)\s*(.*)$/.exec(rule);
    let days = [0, 1, 2, 3, 4, 5, 6];
    let times = rule;
    if (dm && DAYS.includes(dm[1].slice(0, 2))) {
      const d = daysIn(dm[1]);
      if (!d) return null;
      days = d;
      times = dm[2].trim();
    }

    if (closing && !times) {
      for (const d of days) for (let h = 0; h < 24; h++) mask[(d * 24 + h) >> 3] &= ~(0x80 >> ((d * 24 + h) & 7));
      matched++;
      continue;
    }
    if (!times) continue;
    if (/^(24\/7|00:00-24:00)$/.test(times)) { for (const d of days) mark(mask, d, 0, 24); matched++; continue; }

    for (const span of times.split(',')) {
      const t = /^(\d{1,2}:?\d{0,2})\s*-\s*(\d{1,2}:?\d{0,2})$/.exec(span.trim());
      if (!t) return null;
      const a = hhmm(t[1]), b = hhmm(t[2]);
      if (!a || !b) return null;
      // An hour counts as open if ANY of it is open: 11:30 opens the 11 slot,
      // and 22:15 keeps the 22 slot. Right bias for a filter that decides
      // whether to show a place at all.
      const from = a.h % 24;
      const to = b.mi > 0 ? (b.h + 1) % 24 : b.h % 24;
      if (from === to && b.h !== a.h) { for (const d of days) mark(mask, d, 0, 24); }
      else for (const d of days) mark(mask, d, from, to === 0 && b.h === 24 ? 24 : to);
      matched++;
    }
  }
  // An all-zero mask says "never open, any hour of any week". 111 rows in the
  // live directory have `hours` set to the bare string "closed", and a venue
  // that is genuinely never open is not a venue — it is stale data. Treating
  // it as a fact would permanently mark a possibly-trading business shut on
  // evidence that is one word long, so it becomes unknown instead. Real
  // closures are proven by the liveness crawl, not by a leftover string.
  return matched && mask.some((b) => b !== 0) ? mask : null;
}

/** schema.org openingHoursSpecification → mask. Same refusal rules. */
export function parseSchemaHours(spec) {
  const list = Array.isArray(spec) ? spec : spec ? [spec] : [];
  if (!list.length) return null;
  const mask = empty();
  let matched = 0;
  for (const s of list) {
    const dow = [].concat(s?.dayOfWeek ?? []).map((d) => String(d).toLowerCase().replace(/.*\//, '').slice(0, 2));
    const days = dow.length ? dow.map((d) => DAYS.indexOf(d)).filter((i) => i >= 0) : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) continue;
    const a = hhmm(String(s?.opens ?? '')), b = hhmm(String(s?.closes ?? ''));
    if (!a || !b) continue;
    const from = a.h % 24;
    const to = b.mi > 0 ? (b.h + 1) % 24 : b.h % 24;
    for (const d of days) mark(mask, d, from, from === to ? from + 24 : to);
    matched++;
  }
  return matched ? mask : null;
}

/** Local weekday (0 = Monday) and hour in an IANA zone. */
export function localSlot(tz, now = new Date()) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const wd = p.find((x) => x.type === 'weekday')?.value?.toLowerCase().slice(0, 2);
    const hr = Number(p.find((x) => x.type === 'hour')?.value);
    const d = DAYS.indexOf(wd);
    if (d < 0 || !Number.isFinite(hr)) return null;
    return { day: d, hour: hr % 24 };
  } catch {
    return null; // unknown zone → unknown, never assumed
  }
}

/**
 * Is it open right now?
 *
 * @returns true, false, or **null for "we don't know"** — which callers must
 * treat as its own case. Collapsing null to false hides every venue whose
 * hours we never captured (86,465 of 90,263 in Los Angeles today); collapsing
 * it to true sends people to locked doors. It is a third state and it stays a
 * third state.
 */
export function openNow(hex, tz, now = new Date()) {
  const mask = fromHex(hex);
  if (!mask) return null;
  const slot = localSlot(tz, now);
  if (!slot) return null;
  return getBit(mask, slot.day * 24 + slot.hour);
}

/** Hours until close from now, for "closes in 40 minutes" style warnings. */
export function hoursLeft(hex, tz, now = new Date()) {
  const mask = fromHex(hex);
  const slot = localSlot(tz, now);
  if (!mask || !slot) return null;
  let i = slot.day * 24 + slot.hour;
  if (!getBit(mask, i)) return 0;
  let n = 0;
  while (n < WIDTH && getBit(mask, i % WIDTH)) { n++; i++; }
  return n;
}
