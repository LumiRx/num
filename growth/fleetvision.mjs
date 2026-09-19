// Looking at a photograph and saying what it is.
//
// WHY THIS EXISTS. A host with eight cars and two boats does not type ten
// forms. They have a camera roll. The fleet card asked them for make, model,
// year, guests, crew, base, rate and a description before a single thing was
// listed — which is why num_assets holds zero rows and the CHARTER tile had to
// be rewritten to promise nothing. The photographs already contain most of
// those answers. This module reads them out.
//
// WHAT IT IS NOT. It is not a decision. Everything this file produces is a
// DRAFT: num_assets.draft = 1, listable = 0, and a human opens it, corrects it
// and says yes. A model that is confidently wrong about a boat's model year
// costs a host their credibility with a client, so the model never gets the
// last word — it gets the first one, which is the one nobody wants to type.
//
// THREE RULES THIS FILE ENFORCES, not documents:
//
//   1. A REGISTRATION NEVER REACHES CLIENT COPY. A number plate or a tail
//      number is often the sharpest thing in a photograph, and a model asked
//      to describe a car will happily put it in the first line. A hull or tail
//      number identifies the owner, the insurer and what is owed on it.
//      `scrub()` takes it out of every client-facing string, and
//      assetintegrity.mjs raises `registration_in_client_copy` as a BREACH if
//      one ever gets past. We keep it in the private column instead.
//   2. NO PRICE IS EVER INVENTED. The model is not asked what something is
//      worth and is told so in the prompt. A guessed day rate is a number a
//      client holds a host to.
//   3. NO PHOTOGRAPH IS SILENTLY DROPPED. Grouping decides which pictures show
//      the same individual vehicle. Anything the model failed to place lands in
//      a group of its own rather than disappearing — a host who uploaded twelve
//      photos and got eleven back has lost one and has no way to know which.

export const KINDS = ['yacht', 'boat', 'jet', 'helicopter', 'car', 'villa', 'other'];

// Haiku, for the same reason the concierge's everyday turns are Haiku: this
// runs once per upload batch, a host is waiting on it, and the job is reading
// what is plainly in a picture rather than reasoning about it.
export const VISION_MODEL = 'claude-haiku-4-5-20251001';

// Twelve photographs in one call. The number is a product decision, not a
// technical ceiling: grouping only works when every candidate is in front of
// the model at once, and a host who drags in forty pictures should get four
// fast batches rather than one slow one that times out and loses the lot.
export const MAX_IMAGES = 12;

export const visionReady = (env) => !!(env && (env.ANTHROPIC_API_KEY || env.AI));

/* ── THE SECOND BRAIN ─────────────────────────────────────────────────────
   Workers AI, used when no Anthropic key is set on this worker. Dre's call on
   19 Sep 2026: num-app already holds the only key we pay for and there is no
   reason to mint a second one, so num-growth gets the AI binding instead —
   nothing to rotate, nothing to leak, no per-call invoice.

   IT IS NOT THE SAME THING AND THE CODE DOES NOT PRETEND IT IS.

   Haiku sees the whole batch at once, which is what lets it say "photographs
   1, 3 and 7 are the same boat". These models take ONE image per call, so the
   grouping has to be earned afterwards from what each answer has in common —
   see groupByLikeness, which merges only on a strong match and leaves anything
   doubtful apart. A host merging two drafts is one click. A draft that
   silently merged two different cars is a listing showing somebody else's
   vehicle, and they would not know to look.

   The model list is a preference order, not a fallback chain for errors alone:
   llama-3.2-vision follows instructions well enough to return JSON, and llava
   is there because it needs no licence acceptance on a fresh account. First
   one that answers wins, and which one answered is recorded on the draft. */
export const WORKERS_AI_MODELS = [
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/llava-hf/llava-1.5-7b-hf',
];

/* ── WHAT THE SMALL MODEL IS ALLOWED TO CLAIM ─────────────────────────────
   Measured, not assumed. On 19 Sep 2026 the first version of this path was
   given two real photographs from NUM's own stock and asked the same question
   the Haiku prompt asks. It answered:

     · a beach cove with NO BOAT IN IT  →  "boat", "a blue yacht on the water"
     · a Lisbon tram numbered 559       →  "volvo", model "b555"

   Both are confident fiction, and the second is worse than it looks: 559 is
   the fleet number painted on the tram, so the model had read an identifier
   off the vehicle and put it in a field a client sees. A host who uploads
   twenty photographs and gets back a yacht that does not exist learns that
   this feature invents things, and they are right.

   So this tier no longer answers the question Haiku answers. It answers two
   narrow ones it can actually do:

     1. Is there a vehicle, vessel, aircraft or property here AT ALL?
     2. If so, what KIND, what COLOUR, and describe what you see.

   Make, model, year, guests, crew and a client-facing name are NOT accepted
   from this tier at any confidence. Those are the fields that were invented,
   they are the fields a client reads, and an empty box a host fills in ten
   seconds is better than a filled one they have to notice is wrong. */

/** Step one, and the whole reason the cove is no longer a yacht. */
export function buildPresencePrompt() {
  return [
    'Look at this photograph.',
    'Is there a vehicle, boat, aircraft, or a building available to rent in it?',
    'A beach, a view, a street, food or people alone are NOT.',
    'Answer with one word: yes or no.',
  ].join('\n');
}

/** Step two. Three fields, and not one of them is a name a client reads. */
export function buildSmallPrompt() {
  return [
    'This photograph shows a vehicle, vessel, aircraft or property.',
    'Answer with JSON only, no other words:',
    `{"kind":"one of ${KINDS.join('|')}","colour":"","seen":"one sentence describing only what is visible"}`,
    'Use "other" for kind if it is none of those.',
    'Do not name a make, a model or a year. Do not guess a price.',
    'Never write a number, a number plate or a name painted on it.',
  ].join('\n');
}

/* A model handed a schema sometimes hands it straight back. "what a client
 * would read" arrived as an actual value in the 19 Sep test, and without this
 * it would have been saved as the name of somebody's boat. */
const PLACEHOLDERS = [
  'what a client would read', 'one sentence', 'one of ', 'describing only what',
  'your answer', 'string', 'e.g.', 'example',
];
export function isPlaceholder(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return false;
  return PLACEHOLDERS.some((p) => t === p.trim() || t.startsWith(p));
}

/** One image, two questions. Returns a group-shaped object or null.
 *
 *  The presence check runs first and costs a call. It is worth it: it is the
 *  difference between "we could not tell what this is" and a yacht that does
 *  not exist. */
export async function identifyOne(env, image, model) {
  const ask = async (prompt, maxTokens) => {
    let out;
    try {
      const isLlava = model.includes('llava');
      /* BUILDING THE INPUT IS INSIDE THE TRY, and that is not tidiness.
       * llava wants raw bytes, so the base64 has to be decoded — and atob
       * THROWS on anything malformed. Built outside, one unreadable
       * photograph took down every other draft in the same upload. */
      const input = isLlava
        ? { image: Array.from(b64ToBytes(image.data)), prompt, max_tokens: maxTokens }
        : {
          messages: [
            { role: 'system', content: 'You answer exactly what is asked and nothing more.' },
            { role: 'user', content: prompt },
          ],
          image: `data:${image.media_type};base64,${image.data}`,
          max_tokens: maxTokens,
        };
      out = await env.AI.run(model, input);
    } catch (e) {
      console.warn('[fleetvision] workers-ai', model, e?.message ?? e);
      return null;
    }
    const text = String(out?.response ?? out?.description ?? out?.result ?? '');
    return text || null;
  };

  // 1. Is there anything here to let out at all?
  const presence = await ask(buildPresencePrompt(), 10);
  if (presence === null) return null;                     // the model is not answering
  if (!/\byes\b/i.test(presence)) return { absent: true }; // it answered, and the answer is no

  // 2. What kind, what colour, what can be seen.
  const text = await ask(buildSmallPrompt(), 300);
  if (!text) return null;

  const one = parseVision(`{"groups":[${jsonBody(text)}]}`, 1)[0];
  if (!one || !one.identified) return null;

  /* WHAT SURVIVES THE TRIP. Make, model, year, guests, crew and the name are
   * dropped on the floor, because those are the fields this tier invented. The
   * host gets a kind, a colour and a sentence saying what we saw — and empty
   * boxes for everything that would go in front of their client. */
  const colour = isPlaceholder(one.colour) ? null : one.colour;
  const seen = isPlaceholder(one.listing) ? '' : one.listing;
  /* "White other" is not a name. When the kind itself is the could-not-tell
   * bucket, joining it to a colour produces a label that looks like a reading
   * and is actually an admission — so it says the admission instead. */
  const name = one.kind === 'other'
    ? 'Not yet named'
    : [colour, one.kind].filter(Boolean).join(' ').replace(/^./, (c) => c.toUpperCase());

  return {
    photos: one.photos,
    kind: one.kind,
    name,
    make: null, model: null, year: null, guests: null, crew: null,
    spec: null, registration: null,
    colour,
    listing: '',
    seen,
    confidence: 'low',
    unsure: 'We only read the kind and the colour off this. The name and the details are yours.',
    identified: true,
  };
}

/** The body of the first JSON object in a blob of text, or '' if there is
 *  none. Small models wrap their answer in prose more often than not. */
export function jsonBody(text) {
  const t = String(text ?? '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return '';
  // photos is ours to set, not the model's: it saw one image, which is index 1.
  // parseVision reads `listing`; this tier's field is called `seen`, because
  // what it produces is an observation, not copy for a client.
  return t.slice(a, b + 1)
    .replace(/"seen"\s*:/, '"listing":')
    .replace(/^\{/, '{"photos":[1],');
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 ?? ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const key = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Photographs answered one at a time, grouped by what the answers have in
 * common. DELIBERATELY RELUCTANT.
 *
 * Two photographs merge only when the kind matches AND both name the same make
 * and model AND their colours do not contradict each other. Everything else
 * stays its own draft. That means a host who photographs one car from six
 * angles may get two drafts to merge by hand — annoying, and the right way
 * round, because the opposite error puts one client's car in another's
 * listing and nothing in the interface would say so.
 *
 * 'other' never merges: it is the bucket for "could not tell", and merging on
 * ignorance is how six unrelated things become one.
 */
export function groupByLikeness(answers) {
  const groups = [];
  for (const a of answers) {
    if (!a) continue;
    const mk = key(a.make);
    const md = key(a.model);
    const mergeable = a.kind !== 'other' && mk && md;

    const into = !mergeable ? null : groups.find((g) => {
      if (g.kind !== a.kind) return false;
      if (key(g.make) !== mk || key(g.model) !== md) return false;
      const c1 = key(g.colour);
      const c2 = key(a.colour);
      return !c1 || !c2 || c1 === c2;
    });

    if (into) {
      into.photos.push(...a.photos);
      // Keep the fullest answer rather than the first: a second photograph
      // that read the year off the transom should not be thrown away.
      into.year = into.year ?? a.year;
      into.guests = into.guests ?? a.guests;
      into.crew = into.crew ?? a.crew;
      if (!into.listing && a.listing) into.listing = a.listing;
      if (!into.registration && a.registration) into.registration = a.registration;
    } else {
      groups.push({ ...a, photos: [...a.photos] });
    }
  }
  return groups;
}

/* ── THE PROMPT ──────────────────────────────────────────────────────────
   Written as instructions to someone cataloguing a fleet, not as a riddle.
   Every field it may return is a column we already have; nothing here invents
   a shape the database cannot hold. */
export function buildPrompt(n) {
  return [
    `You are cataloguing ${n} photograph${n === 1 ? '' : 's'} for a private travel host's fleet.`,
    'The photographs are numbered in the order given, starting at 1.',
    '',
    'First decide which photographs show THE SAME INDIVIDUAL vehicle, vessel, aircraft or property.',
    'Two photographs of the same car from different angles are one group. Two different cars of the',
    'same model are two groups. If you cannot tell, keep them apart — a host merging two groups is',
    'one click; splitting a group they did not notice is a listing that shows another client\'s car.',
    '',
    'Then, for each group, report only what you can actually SEE. Leave a field out rather than',
    'guessing it. Do not estimate a price, a rate or a value of any kind: you are not asked for one',
    'and a wrong one is worse than none.',
    '',
    'Answer with JSON only, no prose, in exactly this shape:',
    '{"groups":[{',
    '  "photos":[1,2],',
    `  "kind":"one of ${KINDS.join('|')}",`,
    '  "name":"what a client would read, e.g. Ferrari 296 GTB or M/Y Serenity",',
    '  "make":"", "model":"", "year":0, "colour":"",',
    '  "guests":0, "crew":0,',
    '  "spec":{"any":"visible specifics — doors, berths, cabins, engines, rotors, storeys"},',
    '  "registration":"a number plate, tail number or hull number if one is legible, else omit",',
    '  "listing":"two or three sentences a host could send a client, describing the thing itself",',
    '  "confidence":"high|medium|low",',
    '  "unsure":"what you could not tell, in a few words"',
    '}]}',
    '',
    'The "listing" text is read by a client. Never put a registration, number plate, tail number or',
    'hull number in it, and never name a person, a company or a location you think you recognise.',
  ].join('\n');
}

/** Media type as the API wants it. HEIC is not accepted by the vision API, so
 *  it is refused here rather than sent and rejected 800ms later. */
export const VISION_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

/* ── SCRUBBING ───────────────────────────────────────────────────────────
   THE FIRST VERSION OF THIS FUNCTION DID NOT WORK, and the way it failed is
   worth keeping written down. It compared whole whitespace-separated words
   against the plate, so "AB12CDE" was caught and "AB12 CDE" — the way a plate
   is actually written, and the way a model actually returns it — sailed
   through into the client copy. A guard that only catches the spelling nobody
   uses is worse than none, because it reads like protection.

   So the plate is turned into a pattern that tolerates ANY punctuation or
   spacing between its characters, and the label in front of it ("plate",
   "reg", "tail number") goes with it — otherwise the sentence is left saying
   "a red Ferrari, plate , low mileage", which tells a reader there was
   something there and invites them to ask. */
const squash = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const RX_ESC = /[.*+?^${}()|[\]\\]/g;

export function scrub(text, registration) {
  let t = String(text ?? '');
  const reg = squash(registration);
  // Under four characters it is not a registration, it is a word, and removing
  // every occurrence of it would eat the sentence.
  if (!t || reg.length < 4) return t.trim();

  const loose = reg.split('').map((c) => c.replace(RX_ESC, '\\$&')).join('[^A-Za-z0-9]{0,2}');
  const label = '(?:number\\s+plate|licen[cs]e\\s+plate|plate|registration|reg(?:istered)?\\.?|tail\\s*(?:number|no\\.?)?|hull\\s*(?:number|no\\.?)?)?';
  const rx = new RegExp('\\b' + label + '[\\s:#-]*' + loose + '\\b', 'gi');

  t = t.replace(rx, '');
  // Tidy what removal left behind: doubled spaces, a comma with nothing before
  // it, a dangling separator at the end of a sentence.
  t = t
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .replace(/([,;])\s*([.,;])/g, '$2')
    .replace(/,\s*\./g, '.')
    // "Tail number N550GX, seats 13." must not come back as ", seats 13." —
    // a sentence that starts with a comma is a visible hole where something
    // was taken out, which is exactly what the removal was for.
    .replace(/^[\s,;.]+/, '')
    .trim();
  return t && /^[a-z]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const str = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/**
 * Turn whatever came back into groups we are willing to write to the database.
 *
 * `count` is how many photographs went in. It is not decoration: it is what
 * makes "no photograph is silently dropped" checkable, and the reason this
 * function takes it rather than trusting the answer to be complete.
 */
export function parseVision(raw, count) {
  let body = null;
  const text = String(raw ?? '');
  // Models wrap JSON in prose or a fence more often than they should. Take the
  // outermost braces rather than failing the whole batch over a stray sentence.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { body = JSON.parse(text.slice(start, end + 1)); } catch { body = null; }
  }

  const groups = [];
  const claimed = new Set();

  for (const g of (body && Array.isArray(body.groups) ? body.groups : [])) {
    if (!g || typeof g !== 'object') continue;
    // Indices are 1-based in the prompt because that is how the photographs
    // were numbered to the model. They are stored 0-based.
    const photos = (Array.isArray(g.photos) ? g.photos : [])
      .map((i) => int(i, 1, count))
      .filter((i) => i !== null)
      .map((i) => i - 1)
      .filter((i) => !claimed.has(i));
    if (!photos.length) continue;
    photos.forEach((i) => claimed.add(i));

    const registration = str(g.registration, 40);
    const kind = KINDS.includes(String(g.kind || '')) ? String(g.kind) : 'other';
    // Name and listing are both client copy. Both are scrubbed, and the name
    // falls back to something plain rather than to the plate.
    const name = scrub(str(g.name, 120) || '', registration)
      || [str(g.make, 40), str(g.model, 40)].filter(Boolean).join(' ')
      || kind.charAt(0).toUpperCase() + kind.slice(1);

    groups.push({
      photos,
      kind,
      name: name.slice(0, 120),
      make: str(g.make, 80),
      model: str(g.model, 80),
      year: int(g.year, 1900, new Date().getUTCFullYear() + 2),
      colour: str(g.colour, 40),
      guests: int(g.guests, 0, 500),
      crew: int(g.crew, 0, 200),
      spec: g.spec && typeof g.spec === 'object' ? g.spec : null,
      registration,
      listing: scrub(str(g.listing, 900) || '', registration),
      confidence: ['high', 'medium', 'low'].includes(String(g.confidence)) ? String(g.confidence) : 'low',
      unsure: str(g.unsure, 200),
      identified: true,
    });
  }

  // Whatever the model did not place. One group each, marked honestly as
  // unidentified so the console can say so instead of showing an empty card
  // that looks like a failed guess.
  for (let i = 0; i < count; i += 1) {
    if (claimed.has(i)) continue;
    groups.push({
      photos: [i], kind: 'other', name: 'Not yet identified',
      make: null, model: null, year: null, colour: null, guests: null, crew: null,
      spec: null, registration: null, listing: '', confidence: 'low',
      unsure: 'We could not tell what this is. Tell us and it is listed in a moment.',
      identified: false,
    });
  }

  return groups;
}

/**
 * Ask the model. Returns groups, always — a batch that cannot reach Anthropic
 * still comes back as one unidentified group per photograph, because the
 * upload has already happened and the host's pictures are not lost over an
 * API that was busy. `reason` says which of those two happened.
 */
export async function identify(env, images, { fetchImpl = fetch } = {}) {
  const count = images.length;
  if (!count) return { groups: [], identified: false, reason: 'no_images' };
  if (!visionReady(env)) {
    return { groups: parseVision(null, count), identified: false, reason: 'no_brain' };
  }

  /* TWO BRAINS, ONE DOOR.
   *
   * A key means Haiku, which sees the batch together and groups it itself.
   * No key but an AI binding means Workers AI, one photograph at a time,
   * grouped afterwards by likeness. The caller gets the same shape either way
   * and never branches on which answered — but `by` is recorded on every draft,
   * so the console can tell a host that a rougher reader looked at their
   * photographs, rather than leaving them to wonder why it did worse today. */
  if (!env.ANTHROPIC_API_KEY && env.AI) return identifyWithWorkersAi(env, images);

  const content = [];
  images.forEach((im, i) => {
    content.push({ type: 'text', text: `Photograph ${i + 1}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: im.media_type, data: im.data },
    });
  });
  content.push({ type: 'text', text: buildPrompt(count) });

  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.NUM_VISION_MODEL || VISION_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (e) {
    console.warn('[fleetvision] unreachable', e?.message ?? e);
    return { groups: parseVision(null, count), identified: false, reason: 'unreachable' };
  }

  if (!res.ok) {
    console.warn('[fleetvision] http', res.status);
    return { groups: parseVision(null, count), identified: false, reason: 'http_' + res.status };
  }

  let text = '';
  try {
    const j = await res.json();
    text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  } catch {
    return { groups: parseVision(null, count), identified: false, reason: 'bad_json' };
  }

  const groups = parseVision(text, count);
  return { groups, identified: groups.some((g) => g.identified), reason: 'ok' };
}

/**
 * The Workers AI path: every photograph asked separately, then grouped.
 *
 * Sequential, not parallel. These models are not fast and a Worker has a CPU
 * budget — twelve at once is how this ends as a timeout with nothing saved,
 * which is worse than twelve drafts a host has to merge.
 */
export async function identifyWithWorkersAi(env, images) {
  const count = images.length;
  let model = null;
  const answers = [];

  /* A photograph the model looked at and found nothing in is NOT the same as
   * one it failed to read, and they must not land as the same draft.
   *
   * "We could not make this out" invites a host to type the name of a boat.
   * "There is no vehicle in this one" tells them they dragged in a photograph
   * of the beach, which is what actually happened. The cove test on 19 Sep is
   * the reason this distinction exists at all. */
  const place = (got, i) => {
    if (!got) return null;
    if (got.absent) {
      return {
        photos: [i], kind: 'other', name: 'No vehicle in this one',
        make: null, model: null, year: null, colour: null, guests: null, crew: null,
        spec: null, registration: null, listing: '', confidence: 'low', identified: false,
        unsure: 'We could not see anything here to let out — a view, a room or a meal rather than a car or a boat. Name it yourself if we are wrong.',
      };
    }
    return { ...got, photos: [i] };
  };

  for (let i = 0; i < count; i += 1) {
    // The model is chosen once, by whichever answers first, and then kept.
    // Switching mid-batch would mean two readers of differing quality
    // grouped against each other.
    if (!model) {
      for (const candidate of WORKERS_AI_MODELS) {
        const got = await identifyOne(env, images[i], candidate);
        // `absent` means the model ANSWERED and the answer was "nothing here"
        // — which is a working model, not a silent one, so stop looking.
        if (got) { model = candidate; answers.push(place(got, i)); break; }
      }
      if (!model) answers.push(null);
      continue;
    }
    answers.push(place(await identifyOne(env, images[i], model), i));
  }

  const grouped = groupByLikeness(answers).map((g) => ({ ...g, by: model }));

  // Whatever came back empty is still a photograph the host uploaded. Same
  // rule as everywhere else here: nothing is silently dropped.
  const placed = new Set(grouped.flatMap((g) => g.photos));
  for (let i = 0; i < count; i += 1) {
    if (placed.has(i)) continue;
    grouped.push({
      photos: [i], kind: 'other', name: 'Not yet identified',
      make: null, model: null, year: null, colour: null, guests: null, crew: null,
      spec: null, registration: null, listing: '', confidence: 'low', identified: false,
      unsure: 'We could not make this one out. Tell us what it is.',
    });
  }

  return {
    groups: grouped,
    identified: grouped.some((g) => g.identified),
    reason: model ? 'workers_ai' : 'workers_ai_silent',
    model,
  };
}
