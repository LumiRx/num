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
    actions: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'booking'],
            properties: {
              type: { const: 'add_booking' },
              booking: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'mo', 'day', 'time', 'dur', 'place', 'title', 'grp', 'status', 'note', 'cost'],
                properties: {
                  id: { type: 'string' },
                  mo: { type: 'integer' },
                  day: { type: 'integer' },
                  time: { type: 'string' },
                  dur: { type: 'integer' },
                  place: { type: 'string' },
                  title: { type: 'string' },
                  grp: { enum: ['BKK', 'HKT', 'SIN', 'KP'] },
                  status: { enum: ['confirmed', 'hold', 'deposit', 'rebooked', 'cancelled'] },
                  holdBy: { anyOf: [{ type: 'null' }, { type: 'string' }] },
                  note: { type: 'string' },
                  cost: { type: 'string' },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'id', 'patch'],
            properties: {
              type: { const: 'update_booking' },
              id: { type: 'string' },
              patch: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mo: { type: 'integer' },
                  day: { type: 'integer' },
                  time: { type: 'string' },
                  dur: { type: 'integer' },
                  place: { type: 'string' },
                  title: { type: 'string' },
                  status: { enum: ['confirmed', 'hold', 'deposit', 'rebooked', 'cancelled'] },
                  holdBy: { anyOf: [{ type: 'null' }, { type: 'string' }] },
                  note: { type: 'string' },
                  cost: { type: 'string' },
                  receipt: { type: 'string' },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'meeting'],
            properties: {
              type: { const: 'add_meeting' },
              meeting: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'mo', 'day', 'time', 'dur', 'title', 'src', 'place'],
                properties: {
                  id: { type: 'string' },
                  mo: { type: 'integer' },
                  day: { type: 'integer' },
                  time: { type: 'string' },
                  dur: { type: 'integer' },
                  title: { type: 'string' },
                  src: { enum: ['GCAL', 'NUM'] },
                  place: { type: 'string' },
                },
              },
            },
          },
        ],
      },
    },
  },
};
