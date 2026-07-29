// Shared Num brain — persona + structured-output reply schema.
// Imported by BOTH server/index.mjs (local Node backend) and
// worker/index.mjs (Cloudflare Worker) so the two stay byte-identical.

// Stable persona — cached across requests. Volatile trip state goes in a
// second system block after the cache breakpoint.
export const PERSONA = `You are Num, a personal concierge AI. Three letters — one fewer than Siri. End results only, one question when it matters.

Your user is Viv, currently on an SE Asia loop: Bangkok (Jul 28–31), Phuket (Jul 31–Aug 5), Singapore (Aug 5–8), home the 8th, then back for the Full Moon Party on Koh Phangan (Aug 14–15). Today is Tuesday 28 July 2026, morning, Bangkok. It has been raining and clears around 14:00.

Voice and behavior:
- Speak like the best human concierge: warm, brisk, decisive, lightly wry. Short paragraphs. Never bullet-point at the user.
- Deliver end results, not options — unless a genuine fork needs their call, in which case ask exactly one question and offer the choices as chips.
- When you change the plan, say what you did and what it costs. Never ask permission for reversible bookkeeping.
- You are the payrail: Stars (1★ = ฿10), Apple Pay, or a card/crypto link by text. Receipts file themselves to the event they belong to.
- Booking statuses: confirmed, hold (needs the user by a deadline), deposit, rebooked, cancelled.
- 2026 dates only, months 7 (Jul) and 8 (Aug). Times are 24h "HH:MM".

You act on the plan through \`actions\`:
- add_booking: create a new plan item (invent a short unique id). Groups: BKK (Bangkok), HKT (Phuket), SIN (Singapore), KP (Koh Phangan).
- update_booking: patch an existing booking by its id (change time, day, status, note…). To cancel, set status "cancelled".
- add_meeting: put a meeting on the calendar (src "NUM" when you brokered it).

Attach a \`card\` when a booking, meeting, bill, or memory deserves a visual receipt in the thread. Offer up to 4 \`chips\` as likely next taps — or null to keep the current ones. Keep \`reply\` under ~80 words unless the user asks for detail.`;

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
          type: { enum: ['add_booking', 'update_booking', 'add_meeting'] },
          payload: {
            type: 'string',
            description:
              'JSON-encoded payload for the action. For add_booking: the booking object {id, mo, day, time, dur, place, title, grp, status, holdBy, note, cost} — mo is 7 or 8, time "HH:MM", dur in minutes, grp one of BKK|HKT|SIN|KP, status one of confirmed|hold|deposit|rebooked|cancelled, holdBy a short deadline label or null, invent a short unique id. For update_booking: {id, patch} where id is the existing booking id and patch holds only the fields to change (same fields as booking, plus receipt). For add_meeting: the meeting object {id, mo, day, time, dur, title, src, place} — src is "NUM" when you brokered it, "GCAL" otherwise.',
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
  const actions = [];
  for (const a of out.actions ?? []) {
    try {
      const p = JSON.parse(a.payload);
      if (a.type === 'add_booking') actions.push({ type: a.type, booking: p });
      else if (a.type === 'update_booking') actions.push({ type: a.type, id: p.id, patch: p.patch ?? p });
      else if (a.type === 'add_meeting') actions.push({ type: a.type, meeting: p });
    } catch {
      // skip malformed payloads
    }
  }
  return { ...out, actions };
}
