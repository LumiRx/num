// Reading /api/num's answer, whichever shape it arrives in.
//
// Since 18 Sep 2026 the server can answer in two lines of NDJSON when asked
// (Accept: application/x-ndjson): a first line inside a second —
// `{"kind":"ack","ack":"Looking at Sukhumvit for you…"}` — then the answer
// as `{"kind":"final","status":200, …}`. A server that has not been asked, or
// does not know how, answers one JSON object exactly as before. This reads
// both, so the app works against either side of a deploy.
//
// Pure: no store, no fetch. concierge.ts hands it the Response and a callback
// for the first line; worker/ack.mjs is the other end.

export interface AckLine { kind: 'ack'; ack: string; place?: string | null }

const isNdjson = (res: Response) => /application\/x-ndjson/i.test(res.headers.get('content-type') ?? '');

/**
 * Parse one NDJSON line. Returns null for blank or unparseable lines — a torn
 * line at the very end of a stream is noise, not an answer.
 */
export function parseLine(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Fold a stream of text chunks into complete lines. Chunks split lines
 * anywhere, so the tail is carried until its newline arrives.
 */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf('\n')) >= 0) {
      yield carry.slice(0, nl);
      carry = carry.slice(nl + 1);
    }
  }
  carry += dec.decode();
  if (carry.trim()) yield carry;
}

/**
 * The answer, as the rest of concierge.ts has always received it. `onAck`
 * fires at most once, with the first line, as soon as it lands. A `final`
 * line carrying a non-200 status throws `backend <status>` — the same error
 * the single-JSON path throws for a non-ok response.
 */
export async function readNumReply<T>(res: Response, onAck?: (ack: string, place: string | null) => void): Promise<T> {
  if (!isNdjson(res) || !res.body) return (await res.json()) as T;
  let final: Record<string, unknown> | null = null;
  let acked = false;
  for await (const raw of lines(res.body)) {
    const obj = parseLine(raw);
    if (!obj) continue;
    if (obj.kind === 'ack') {
      if (!acked && typeof obj.ack === 'string' && obj.ack) {
        acked = true;
        onAck?.(obj.ack, typeof obj.place === 'string' ? obj.place : null);
      }
      continue;
    }
    if (obj.kind === 'final') { final = obj; break; }
    // An older or foreign shape: a line with a reply is the answer.
    if (typeof obj.reply === 'string') { final = { kind: 'final', status: 200, ...obj }; break; }
  }
  if (!final) throw new Error('backend stream ended without an answer');
  const status = typeof final.status === 'number' ? final.status : 200;
  if (status < 200 || status >= 300) throw new Error('backend ' + status);
  const { kind, status: _s, ...payload } = final;
  void kind; void _s;
  return payload as T;
}
