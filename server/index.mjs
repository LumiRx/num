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
import { PERSONA, REPLY_SCHEMA, normalizeReply } from '../worker/prompt.mjs';

const PORT = Number(process.env.NUM_AI_PORT) || 8787;
const MODEL = 'claude-opus-5';

const client = new Anthropic();

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
  return normalizeReply(JSON.parse(text));
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
