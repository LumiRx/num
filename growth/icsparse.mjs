// Reading a calendar somebody else wrote.
//
// A host's client says "here is my trip" and sends an .ics — from Apple
// Calendar, Google, Outlook, a travel agent's system, an airline. This turns
// that into rows. It is deliberately a pure function over a string: no
// database, no network, no clock, so every awkward calendar in the world can
// be turned into a test case in one line.
//
// WHAT IT HANDLES, because real calendars do all of it:
//   · folded lines (RFC 5545 wraps at 75 octets and continues with a space)
//   · escaped text (\, \; \n inside SUMMARY and DESCRIPTION)
//   · DTSTART as a date (all-day), as floating local time, as UTC with Z, and
//     with a TZID parameter
//   · CRLF, LF, and the mixture you get when a file has been through a mail
//     client
//   · VALARM and VTIMEZONE blocks nested inside VEVENT, which must not be read
//     as events or as the event's own fields
//
// WHAT IT DOES NOT DO, said out loud rather than discovered later:
//   · RRULE is NOT expanded. A repeating event is imported as its first
//     occurrence and flagged `repeats`. Expanding recurrence properly needs a
//     timezone database and is a source of wrong dates in every calendar
//     product ever shipped; showing one dated entry and saying "this repeats"
//     is honest, and a wrong date in front of a client is not.
//   · A TZID is recorded, not applied. We keep the local time as written and
//     the zone beside it. Converting without a tz database would be inventing
//     an offset.

export const MAX_EVENTS = 500;

/** Unfold, then split. Order matters: a folded line broken first is two
 *  useless halves. */
export function unfold(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // A continuation is a newline followed by one space or tab.
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/** TEXT values escape commas, semicolons and newlines. Unescaping in the wrong
 *  order turns "\\n" (a literal backslash followed by n) into a newline. */
export function unescapeText(v) {
  let out = '';
  const s = String(v ?? '');
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[i + 1];
    i += 1;
    if (n === 'n' || n === 'N') out += '\n';
    else if (n === undefined) out += '\\';
    else out += n;                 // \, \; \\ and anything else: the character itself
  }
  return out;
}

/** "DTSTART;TZID=Europe/London:20260917T190000" → name, params, value */
export function splitLine(line) {
  const colon = indexOfUnquoted(line, ':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const bits = left.split(';');
  const name = bits.shift().toUpperCase();
  const params = {};
  for (const b of bits) {
    const eq = b.indexOf('=');
    if (eq === -1) continue;
    params[b.slice(0, eq).toUpperCase()] = b.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** A colon inside a quoted parameter is not the separator. Rare, and the one
 *  place a naive indexOf(':') produces a property called DTSTART;TZID="GMT. */
function indexOfUnquoted(s, ch) {
  let q = false;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '"') q = !q;
    else if (s[i] === ch && !q) return i;
  }
  return -1;
}

/**
 * ICS date-time → what we store, which is a string in the shape the rest of
 * this codebase uses: 'YYYY-MM-DD HH:MM:SS', or 'YYYY-MM-DD' for an all-day.
 *
 * A Z time is UTC and kept as UTC. A floating time is kept as written, because
 * that is what it means: 7pm wherever you are.
 */
export function icsDate(value, params = {}) {
  const v = String(value ?? '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { at: `${m[1]}-${m[2]}-${m[3]}`, allDay: true, tz: null, utc: false };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  return {
    at: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`,
    allDay: false,
    tz: params.TZID || null,
    utc: !!m[7],
  };
}

/**
 * The whole file → events.
 *
 * Never throws. A calendar that is half-corrupt should import the half that is
 * readable and say how many it could not read — an import that refuses the
 * file outright sends the host back to their client to ask for another one,
 * which is a conversation nobody wanted to have.
 */
export function parseIcs(text, { max = MAX_EVENTS } = {}) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  let depth = 0;          // how deep inside nested blocks (VALARM, VTIMEZONE)
  let skipped = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const p = splitLine(line);
    if (!p) continue;

    if (p.name === 'BEGIN') {
      const v = p.value.toUpperCase();
      if (v === 'VEVENT' && !cur) { cur = { repeats: false }; depth = 0; continue; }
      if (cur) depth += 1;     // VALARM or VTIMEZONE inside the event
      continue;
    }
    if (p.name === 'END') {
      const v = p.value.toUpperCase();
      if (v === 'VEVENT' && cur && depth === 0) {
        if (cur.title && cur.starts_at) {
          if (events.length < max) events.push(cur);
          else skipped += 1;
        } else {
          // An event with no summary or no start is not something we can put
          // in front of anybody. Counted, not silently dropped.
          skipped += 1;
        }
        cur = null;
        continue;
      }
      if (cur && depth > 0) depth -= 1;
      continue;
    }
    // Anything inside a VALARM belongs to the alarm, not to the event. Without
    // this, an alarm's own TRIGGER and DESCRIPTION overwrite the event's.
    if (!cur || depth > 0) continue;

    switch (p.name) {
      case 'UID': cur.uid = p.value.slice(0, 200); break;
      case 'SUMMARY': cur.title = unescapeText(p.value).slice(0, 200); break;
      case 'DESCRIPTION': cur.detail = unescapeText(p.value).slice(0, 2000); break;
      case 'LOCATION': cur.location = unescapeText(p.value).slice(0, 300); break;
      case 'RRULE': cur.repeats = true; break;
      case 'DTSTART': {
        const d = icsDate(p.value, p.params);
        if (d) { cur.starts_at = d.at; cur.all_day = d.allDay ? 1 : 0; cur.tz = d.tz; cur.utc = d.utc; }
        break;
      }
      case 'DTEND': {
        const d = icsDate(p.value, p.params);
        if (d) cur.ends_at = d.at;
        break;
      }
      default: break;
    }
  }

  return { events, skipped };
}
