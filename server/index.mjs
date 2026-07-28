// NUM AI backend — a minimal Node server that gives Num a real brain.
//
// POST /api/num
//   body:    { messages: [{role: "user"|"assistant", content: string}], state: {...} }
//   returns: { reply, card, chips, actions }
//
// The frontend applies `actions` to its store, so the UI stays the single
// source of truth for trip state. Auth: the SDK reads ANTHROPIC_API_KEY (or an
// `ant auth login` profile) from the environment — no key ever reaches the
// browser.
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

const PORT = Number(process.env.NUM_AI_PORT) || 8787;
const MODEL = 'claude-opus-5';

const client = new Anthropic();

// Stable persona — cached across requests. Volatile trip state goes in a
// second system block after the cache breakpoint.
const PERSONA = `You are Num, a personal concierge AI. Three letters — one fewer than Siri. End results only, one question when it matters.

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

const REPLY_SCHEMA = {
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

async function askNum(messages, state) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current trip state (source of truth — reference ids exactly):\n' + JSON.stringify(state) },
    ],
    output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { reply: 'I can’t help with that one — anything else on the trip?', card: null, chips: null, actions: [] };
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'POST' || req.url !== '/api/num') {
    return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { messages, state } = JSON.parse(body);
    const result = await askNum(messages, state);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (err) {
    console.error('[num-ai]', err);
    const status = err?.status === 401 ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ error: err?.message ?? 'unknown error' }),
    );
  }
});

server.listen(PORT, () => {
  console.log(`NUM AI listening on http://localhost:${PORT} (model: ${MODEL})`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('note: ANTHROPIC_API_KEY not set — requests will fail until a credential is available.');
  }
});
