/**
 * REPLY_SCHEMA, translated into OpenAI strict structured outputs.
 *
 * ── Why this file buys a whole capability ─────────────────────────────────
 *
 * Every brain below the two Anthropic ones has been `structured: false`, which
 * means prose. On 7 Sep they gained `picks`, so a backup answer arrives as
 * tappable place cards — but it still cannot produce a booking card or an
 * action, because DeepSeek's JSON mode only promises "some JSON", and a
 * booking state we merely HOPE is well formed is not a booking state.
 *
 * OpenAI's strict mode promises something different: the response is
 * guaranteed to match a schema we supply. That is the difference between
 * hoping and knowing, and it is what lets a non-Anthropic brain carry the full
 * REPLY_SCHEMA — the same shape, the same fields, the same guarantees the app
 * already knows how to render.
 *
 * ── The four rules strict mode imposes, and what each one costs us ────────
 *
 *   1. `additionalProperties: false` on EVERY object. REPLY_SCHEMA already
 *      does this, because it was written against Anthropic's tool schema,
 *      which wanted the same discipline.
 *   2. EVERY property must appear in `required`. This is the one that bites.
 *      REPLY_SCHEMA marks `id` optional on a pick — a pick can be named
 *      without an id — and strict mode has no concept of optional.
 *   3. Optionality is expressed as NULLABILITY instead: a field that may be
 *      absent becomes `anyOf: [<type>, {type:'null'}]` and is listed as
 *      required. So "you may omit this" becomes "you must send this, and null
 *      is an acceptable value", which is the same promise in the other
 *      direction.
 *   4. Five levels of nesting, maximum.
 *
 * So this is a translation, not a second schema. There is exactly one
 * REPLY_SCHEMA in the codebase and this derives from it at call time — because
 * a hand-maintained copy would drift, and the day it drifted would be the day
 * a booking came back in a shape nothing could read.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────
 *
 * It does not relax anything. If the source schema cannot be expressed in
 * strict mode, `problems()` says so and the caller does not send it — an
 * honest refusal beats a silently loosened contract on the one code path that
 * produces bookings.
 */

const MAX_DEPTH = 5;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Make a subschema nullable without disturbing what it already says. */
function nullable(sub) {
  if (isObj(sub) && Array.isArray(sub.anyOf)) {
    return sub.anyOf.some((s) => s?.type === 'null') ? sub : { ...sub, anyOf: [...sub.anyOf, { type: 'null' }] };
  }
  // An enum with no type is legal JSON Schema and confuses strict mode, which
  // wants to know what it is looking at. Say so, and allow null alongside.
  if (isObj(sub) && Array.isArray(sub.enum) && !sub.type) {
    return { anyOf: [{ type: 'string', enum: sub.enum }, { type: 'null' }] };
  }
  return { anyOf: [sub, { type: 'null' }] };
}

/**
 * Translate a schema into strict form.
 *
 * Pure, and it never mutates its input — the source REPLY_SCHEMA is frozen and
 * shared with the Anthropic path, which has different rules and must keep
 * seeing the original.
 */
export function toStrict(schema, depth = 1) {
  if (!isObj(schema)) return schema;

  if (Array.isArray(schema.anyOf)) {
    return { ...schema, anyOf: schema.anyOf.map((s) => toStrict(s, depth)) };
  }

  if (schema.type === 'array') {
    return { ...schema, ...(schema.items ? { items: toStrict(schema.items, depth + 1) } : {}) };
  }

  if (schema.type === 'object' || isObj(schema.properties)) {
    const props = schema.properties ?? {};
    const wasRequired = new Set(schema.required ?? []);
    const out = {};
    for (const [key, sub] of Object.entries(props)) {
      const child = toStrict(sub, depth + 1);
      // Rule 2 and rule 3 together: everything is required, and anything that
      // was optional becomes nullable so the model can still decline to
      // answer it. "You may omit this" and "you must send this, and null is
      // allowed" are the same promise from opposite ends.
      out[key] = wasRequired.has(key) ? child : nullable(child);
    }
    return {
      ...schema,
      type: 'object',
      additionalProperties: false,
      properties: out,
      required: Object.keys(props),
    };
  }

  // A bare enum at a leaf: give it a type, which strict mode wants.
  if (Array.isArray(schema.enum) && !schema.type) return { ...schema, type: 'string' };
  return schema;
}

/**
 * Everything about this schema that strict mode would reject.
 *
 * Run against the TRANSLATED schema, not the source — it is the check that the
 * translation actually worked, and it is the reason we can add a vendor
 * without finding out in production whether the shape was acceptable.
 *
 * @returns {string[]} empty when the schema is safe to send
 */
export function problems(schema, path = '$', depth = 1) {
  const out = [];
  if (!isObj(schema)) return out;
  if (depth > MAX_DEPTH) out.push(`${path}: nested ${depth} deep, strict mode allows ${MAX_DEPTH}`);

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((s, i) => out.push(...problems(s, `${path}.anyOf[${i}]`, depth)));
    return out;
  }
  if (schema.type === 'array') {
    if (schema.items) out.push(...problems(schema.items, `${path}[]`, depth + 1));
    return out;
  }
  if (schema.type === 'object' || isObj(schema.properties)) {
    const props = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const req = new Set(schema.required ?? []);
    for (const k of props) if (!req.has(k)) out.push(`${path}.${k}: every property must be required in strict mode`);
    for (const k of (schema.required ?? [])) if (!props.includes(k)) out.push(`${path}.${k}: required but not a property`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) out.push(...problems(sub, `${path}.${k}`, depth + 1));
  }
  return out;
}

/**
 * The whole `response_format` value, ready to send — or null when the schema
 * would not survive the translation.
 *
 * Returning null rather than throwing is deliberate: a brain that cannot take
 * the strict schema should fall down the chain like any other unavailable
 * brain, not take the turn down with it.
 */
export function responseFormat(schema, name = 'num_reply') {
  const strict = toStrict(schema);
  const bad = problems(strict);
  if (bad.length) {
    console.warn(`[strictschema] REPLY_SCHEMA cannot be sent strict: ${bad.slice(0, 3).join('; ')}`);
    return null;
  }
  return { type: 'json_schema', json_schema: { name, strict: true, schema: strict } };
}
