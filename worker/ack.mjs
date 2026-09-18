/**
 * THE FIRST LINE — what the guest sees inside a second, before any brain has
 * answered.
 *
 * 17 Sep 2026, measured: a turn took 4–40 s end to end and the thread showed
 * three dots the whole time. The dots say "working"; they do not say "heard
 * you", and a person reads a silent screen as a dropped message within a few
 * seconds. So /api/num can now answer in two lines (NDJSON, opt-in by
 * `Accept: application/x-ndjson`):
 *
 *   {"kind":"ack",  "ack":"Looking at Sukhumvit for you…", "place":"Bangkok"}
 *   {"kind":"final","status":200, …the answer exactly as before…}
 *
 * The first line costs NOTHING — no model, no lookup: it is a template in the
 * guest's language filled from grounding the server already has. It is
 * written the moment the brain chain is asked, so it lands after the early
 * paths (known answer, cache, guard) have had their chance to answer whole.
 *
 * Clients that do not send the Accept header get the single JSON they always
 * got. LINE, WhatsApp, the uptime probe and the MCP surfaces never see this.
 *
 * ── WHAT THE LINE MAY NOT SAY ──────────────────────────────────────────────
 *
 * Nothing that could be wrong. No place name the guest did not give us or we
 * did not resolve; no promise ("booking that now"); no number. "Looking at X
 * for you" is true the instant it is sent, whatever the brain then says.
 */

/** Two forms per language: with a resolved place, and without. */
const LINES = Object.freeze({
  en: { place: (p) => `Looking at ${p} for you…`, none: () => 'On it…' },
  th: { place: (p) => `กำลังดู${p}ให้อยู่…`, none: () => 'กำลังจัดการให้…' },
  zh: { place: (p) => `正在为你看${p}…`, none: () => '马上来…' },
  ja: { place: (p) => `${p}を調べています…`, none: () => '少々お待ちください…' },
  ko: { place: (p) => `${p}을(를) 확인하고 있어요…`, none: () => '확인 중이에요…' },
  es: { place: (p) => `Mirando ${p} para ti…`, none: () => 'Voy…' },
  fr: { place: (p) => `Je regarde ${p} pour vous…`, none: () => 'Je m’en occupe…' },
  de: { place: (p) => `Ich sehe mir ${p} für dich an…`, none: () => 'Bin dran…' },
  ar: { place: (p) => `أبحث لك في ${p}…`, none: () => 'جارٍ العمل عليه…' },
  mn: { place: (p) => `${p}-г танд харж байна…`, none: () => 'Хийж байна…' },
});

export const ACK_LANGS = Object.freeze(Object.keys(LINES));

const clipPlace = (p) => {
  const s = String(p ?? '').trim();
  // A place name is a word or three. Anything longer is not a place, it is a
  // sentence that leaked in, and it must not be echoed to the guest.
  return s && s.length <= 40 && !/[\n\r]/.test(s) ? s : null;
};

/**
 * The line for this turn. `lang` may be `en-GB` or unknown — falls back to
 * English. `place` is the resolved destination name, or nothing.
 */
export function ackLine({ lang = 'en', place = null } = {}) {
  const code = String(lang ?? 'en').toLowerCase().slice(0, 2);
  const t = LINES[code] ?? LINES.en;
  const p = clipPlace(place);
  return p ? t.place(p) : t.none();
}

/** Did this client ask for the two-line answer? */
export const wantsNdjson = (request) => /application\/x-ndjson/i.test(request?.headers?.get?.('Accept') ?? '');

/**
 * Run `handler(hooks)` — which returns an ordinary JSON Response — and
 * deliver it as NDJSON: anything the handler passes to `hooks.ack(...)` goes
 * out immediately as a line, and the handler's own body becomes the final
 * line, with its HTTP status inside it (the stream itself is always 200,
 * because the status byte is gone by the time a slow answer knows its own).
 *
 * The run is registered with `ctx.waitUntil` so the isolate does not put the
 * brain chain down the moment the response object has been returned.
 */
export function streamNdjson(ctx, handler, { headers = {} } = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const line = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});
  const hooks = { ack: (o) => { void line({ kind: 'ack', ...o }); } };
  const run = (async () => {
    try {
      const res = await handler(hooks);
      const text = await res.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 200) }; }
      await line({ kind: 'final', status: res.status, ...payload });
    } catch (e) {
      console.error('[num-ai] stream failed —', e?.message ?? e);
      await line({ kind: 'final', status: 500, error: 'stream failed' });
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  ctx?.waitUntil?.(run);
  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Cloudflare does not buffer, but a proxy in front of a dev preview might.
      'X-Accel-Buffering': 'no',
      ...headers,
    },
  });
}
