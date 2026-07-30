// Shared Num brain — persona + structured-output reply schema.
// Imported by BOTH server/index.mjs (local Node backend) and
// worker/index.mjs (Cloudflare Worker) so the two stay byte-identical.

// Stable persona — cached across requests, so it contains NOTHING volatile:
// no dates, no city, no user name. Everything situational (who, where, when,
// verified partners) arrives in later system blocks built per-request.
export const PERSONA = `You are Num, a personal concierge AI. Three letters — one fewer than Siri. End results only, one question when it matters. Your users can be anywhere on Earth.

Voice and behavior:
- Speak like the best human concierge: warm, brisk, decisive, lightly wry. Short paragraphs. Never bullet-point at the user.
- Deliver end results, not options — unless a genuine fork needs their call, in which case ask exactly one question and offer the choices as chips.
- When you change the plan, say what you did and what it costs. Never ask permission for reversible bookkeeping.
- You are the payrail: Stars, Apple Pay, or a card/crypto link by text. 1★ ≈ US$0.30; quote costs in the LOCAL currency of wherever the booking is, with a stars equivalent when you charge. Receipts file themselves to the event they belong to.
- Booking statuses: confirmed, hold (needs the user by a deadline), deposit, rebooked, cancelled. Times are 24h "HH:MM" in the booking's local timezone.

Location — never assume it:
- If you do not yet know where the user IS and where they are GOING, that is your first job: ask warmly (both can be one question). Do not recommend, book, or guess a city until they tell you or the context below states it.
- A "VERIFIED NEARBY PARTNERS" block below your context means real, currently-operating places from Num's own database, ranked by quality and distance — prefer them and use their details exactly. NEVER invent an address, phone number, price, or opening hours. With no partner data, recommend from general knowledge, name real well-known places only, and skip street-level specifics you cannot know.

You act on the plan through \`actions\`:
- add_booking: create a new plan item (invent a short unique id). \`grp\` is a short uppercase code you coin for the city (e.g. TYO for Tokyo, PAR for Paris) — reuse the same code for the same city so bookings group together.
- update_booking: patch an existing booking by its id (change time, day, status, note…). To cancel, set status "cancelled".
- add_meeting: put a meeting on the calendar (src "NUM" when you brokered it).
- Dates: \`mo\` is the calendar month number (1–12) and \`day\` the day of month, in the trip's local dates. Only schedule within the current or next calendar month (the app's calendar shows exactly those two); for anything further out, say you'll hold it and note it in the reply instead.

What you can and cannot do — never fake a capability:
- You CAN: research and recommend real places, hold and reshuffle plan items, track meetings and receipts in this app, and settle demo bills through the Stars payrail.
- You CANNOT yet: take real payments or issue real tickets, contact venues or airlines, message other people, connect external calendars/photo libraries (outside the demo), or arrange anything that needs a human partner on the ground.
- When the user asks for something beyond your reach: tell them, in your own warm words, "give me a second — let me reach out to the team", and emit ONE feature_request action (summary = exactly what they asked for, suggestion = the solution you would build or the best workaround). Mention that it's been flagged to the Num team's dashboard. Then ALWAYS still give them the most useful thing you CAN do right now — a recommendation, a held plan item, a phone number, the manual steps. Flagged never means abandoned, and never pretend it already worked.

Memory: the KNOWN FACTS block in your context lists things the user already told you. NEVER ask again for anything listed there — reference it naturally instead. Whenever the user reveals a lasting fact, emit a remember action for it. If KNOWN FACTS already answers your next question, skip the question and act.

Attach a \`card\` when a booking, meeting, bill, or memory deserves a visual receipt in the thread. Offer up to 4 \`chips\` as likely next taps — or null to keep the current ones. Keep \`reply\` under ~80 words unless the user asks for detail.`;

/**
 * The per-request context block: today's date, the resolved location (if any),
 * a verified-partner list and destination guide from the shared D1 the LINE
 * concierge uses. Everything here sits AFTER the cache breakpoint.
 */
export function contextBlock({ now = new Date(), place = null, partners = [], guide = null, profile = {} } = {}) {
  const lines = [];
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: place?.tz || 'UTC' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: place?.tz || 'UTC' });
  lines.push(`Today is ${dateStr}, ${timeStr}${place?.tz ? ` local time in ${place.name}` : ' UTC'}.`);
  if (place?.name) {
    lines.push(
      `The user's current destination: ${place.label ? `${place.label}, ` : ''}${place.name}${place.country ? ', ' + place.country : ''}${place.precise ? ' (exact position known — "near me" means walking distance)' : ''}.` +
        (place.inferred
          ? ' NOTE: this came from their connection, not from them (VPNs and roaming lie). Recommend freely, but do NOT create any booking action this turn — first weave one light confirmation into your reply ("You’re in ' +
            place.name +
            ', right?"); book once they confirm.'
          : ''),
    );
  } else {
    lines.push('The user has NOT yet said where they are or where they are going — find out first.');
  }
  if (partners.length) {
    lines.push(
      'VERIFIED NEARBY PARTNERS (real places from Num’s database — prefer these, details are exact):\n' +
        partners
          .map(
            (b) =>
              `- ${b.name}${b.name_local && b.name_local !== b.name ? ` (${b.name_local})` : ''} — ${b.category}${b.area ? `, ${b.area}` : ''}${b.km != null ? `, ${b.km < 1 ? Math.round(b.km * 1000) + ' m' : b.km + ' km'} away` : ''}${b.rating ? `, ${b.rating}★ (${b.reviews} reviews)` : ''}${b.phone ? `, ${b.phone}` : ''}`,
          )
          .join('\n'),
    );
  }
  if (guide) lines.push(`Destination notes:\n${guide}`);
  const facts = Object.entries(profile ?? {});
  if (facts.length) {
    lines.push('KNOWN FACTS (already established — never re-ask):\n' + facts.map(([k, v]) => `- ${k}: ${v}`).join('\n'));
  }
  return lines.join('\n\n');
}

export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'card', 'chips', 'actions'],
  properties: {
    reply: { type: 'string', description: "Num's message to the user" },
    card: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'meta', 'tag'],
          properties: {
            title: { type: 'string' },
            meta: { type: 'string' },
            tag: { enum: ['confirmed', 'hold', 'deposit', 'rebooked', 'cancelled', 'meeting', 'memory', 'bill', 'paid', 'shared'] },
          },
        },
      ],
    },
    chips: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: { id: { type: 'string' }, label: { type: 'string' } },
          },
        },
      ],
    },
    // Actions carry a JSON-encoded payload string instead of nested typed
    // objects: Anthropic's structured-output grammar compiler times out on
    // schemas with many-key strict objects ("Grammar compilation timed out"),
    // and a string field costs the grammar nothing. normalizeReply() below
    // parses payloads server-side, so the frontend contract is unchanged.
    actions: {
      type: 'array',
      description: 'Plan mutations to apply, in order. Each action is {type, payload} where payload is a JSON-encoded string.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'payload'],
        properties: {
          type: { enum: ['add_booking', 'update_booking', 'add_meeting', 'feature_request', 'remember'] },
          payload: {
            type: 'string',
            description:
              'JSON-encoded payload for the action. For add_booking: the booking object {id, mo, day, time, dur, place, title, grp, status, holdBy, note, cost} — mo is the calendar month number (1-12), time "HH:MM", dur in minutes, grp the short uppercase city code, status one of confirmed|hold|deposit|rebooked|cancelled, holdBy a short deadline label or null, cost a DISPLAY STRING with currency (e.g. "~€18 · pay there", never a bare number), invent a short unique id. For update_booking: {id, patch} where id is the existing booking id and patch holds only the fields to change (same fields as booking, plus receipt). For add_meeting: the meeting object {id, mo, day, time, dur, title, src, place} — src is "NUM" when you brokered it, "GCAL" otherwise. For feature_request (something the user wants that you cannot do yet): {summary, suggestion} — summary is what they asked for in one sentence, suggestion is the solution you would build or the best current workaround. For remember: {key, value} — a lasting fact the user just told you (keys like name, home_city, current_city, destination, trip_dates, party_size, hotel, dietary, vibe_prefs); emit one remember action per fact, every time the user reveals one.',
          },
        },
      },
    },
  },
};

// Map the wire shape ({type, payload}) back to the frontend contract
// ({type, booking} / {type, id, patch} / {type, meeting}). Malformed payloads
// are dropped rather than failing the whole reply.
export function normalizeReply(out) {
  // Payloads are model-written JSON, unvalidated by the grammar — coerce the
  // display fields the app renders so a stray number never reaches the UI raw.
  const asStr = (v) => (v == null ? v : typeof v === 'string' ? v : String(v));
  const fixBooking = (b) => b && { ...b, cost: asStr(b.cost), note: asStr(b.note), place: asStr(b.place), title: asStr(b.title) };
  const actions = [];
  for (const a of out.actions ?? []) {
    try {
      const p = JSON.parse(a.payload);
      if (a.type === 'add_booking') actions.push({ type: a.type, booking: fixBooking(p) });
      else if (a.type === 'update_booking') actions.push({ type: a.type, id: p.id, patch: fixBooking(p.patch ?? p) });
      else if (a.type === 'add_meeting') actions.push({ type: a.type, meeting: p });
      else if (a.type === 'feature_request') actions.push({ type: a.type, summary: asStr(p.summary) ?? '', suggestion: asStr(p.suggestion) ?? '' });
      else if (a.type === 'remember') {
        const key = asStr(p.key);
        const value = asStr(p.value);
        if (key && value) actions.push({ type: 'remember', key, value });
      }
    } catch {
      // skip malformed payloads
    }
  }
  return { ...out, actions };
}
