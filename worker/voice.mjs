// Talking to Num, in whatever language you talk in.
//
// The split that matters, because the two halves have very different costs:
//
//   LISTENING  Whisper, already running on Cloudflare's edge through the AI
//              binding this Worker has. No account, no key, no new vendor, and
//              it transcribes ~99 languages — including working out WHICH
//              language it heard, which is the part that makes "speak to it in
//              anything" real rather than a setting somebody has to find.
//
//   SPEAKING   A separate problem with a separate bill. Whisper does not do
//              it. See docs/voice.md for the Fish Audio option.
//
// This file is the listening half, and it is the half that unlocks the
// feature: a concierge that understands you is useful even if it answers in
// text. A concierge that talks but mishears you is worse than one that stays
// quiet.
//
// The transcript goes STRAIGHT into the normal turn. There is no separate
// voice brain, no different prompt, no reduced capability — speaking to Num is
// typing to Num with a different keyboard, which is why the language rule in
// VOICE already covers it and needed no second implementation.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/**
 * Whisper large v3 turbo: the accuracy of large with most of the speed.
 *
 * The plain `@cf/openai/whisper` is smaller and faster and noticeably worse at
 * accented English and at code-switching mid-sentence — which is exactly the
 * traffic a travel concierge gets. It is the wrong saving.
 */
const TURBO = '@cf/openai/whisper-large-v3-turbo';
const BASE = '@cf/openai/whisper';

export const voiceReady = (env) => !!env.AI;

/**
 * Transcribe a clip.
 *
 * Takes raw audio bytes, because that is what a MediaRecorder produces and
 * base64 would inflate every upload by a third for no gain. `?lang=` forces a
 * language when the caller genuinely knows it; left off, Whisper detects it,
 * which is the normal case and the better one — a traveller switching between
 * Thai and English mid-trip should not have to tell the app twice.
 */
export async function transcribe(env, bytes, { language } = {}) {
  const u8 = new Uint8Array(bytes);

  // The two Whisper models on Workers AI take DIFFERENT input shapes, which is
  // not obvious and fails identically either way — an empty transcript rather
  // than an error. turbo wants base64; the original wants an array of bytes.
  // Try the better model first, fall back rather than leaving somebody unable
  // to speak to their concierge because of a serialisation detail.
  const b64 = (() => {
    let out = '';
    for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(out);
  })();

  const attempts = [
    { model: TURBO, input: { audio: b64, task: 'transcribe', ...(language ? { language } : {}) } },
    { model: BASE, input: { audio: [...u8], ...(language ? { language } : {}) } },
  ];

  let last = null;
  for (const a of attempts) {
    try {
      const out = await env.AI.run(a.model, a.input);
      const text = String(out?.text ?? '').trim();
      if (text) {
        return {
          text,
          // Whisper reports what it heard, so the reply can stay in the same
          // language without a second guess.
          language: out?.language ?? language ?? null,
          model: a.model,
          duration: out?.duration ?? null,
        };
      }
      last = `${a.model} returned nothing`;
    } catch (err) {
      last = `${a.model}: ${String(err?.message ?? err).slice(0, 120)}`;
      console.warn('[voice]', last);
    }
  }
  const err = new Error(last ?? 'no transcript');
  err.transcribeFailed = true;
  throw err;
}

export async function handleVoice(request, env, path) {
  if (path === '/status' || path === '/' || path === '') {
    return json({
      listening: voiceReady(env),
      models: [TURBO, BASE],
      // Said plainly because the two halves get confused constantly.
      speaking: false,
      note: voiceReady(env)
        ? 'Speech-to-text is live and detects the language on its own. Text-to-speech is not connected — see docs/voice.md.'
        : 'The Workers AI binding is missing, so nothing can be transcribed.',
    });
  }

  if (path === '/transcribe' && request.method === 'POST') {
    if (!voiceReady(env)) return json({ error: 'Voice is not available on this deployment.' }, 503);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ error: 'No audio arrived.' }, 400);
    // A minute of speech is a long request to a concierge; beyond that it is
    // almost always a stuck recorder, and transcribing it wastes real money.
    if (bytes.byteLength > 8_000_000) return json({ error: 'That clip is too long — keep it under a minute.' }, 413);

    try {
      const lang = new URL(request.url).searchParams.get('lang');
      const out = await transcribe(env, bytes, { language: lang || undefined });
      if (!out.text) return json({ error: 'I couldn’t make that out — try again somewhere quieter.' }, 422);
      return json(out);
    } catch (err) {
      console.error('[voice]', err?.message ?? err);
      return json({ error: 'That didn’t come through — say it again?' }, 502);
    }
  }

  return json({ error: 'not found' }, 404);
}
