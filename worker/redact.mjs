/**
 * What a model is allowed to see.
 *
 * `contextBlock` prints every entry of `profile` into the prompt as KNOWN
 * FACTS, and `askNum` stringifies the whole trip `state` on the line below it.
 * Both are shaped by the client, so whatever a guest's device puts in there
 * leaves our infrastructure on every single turn — name, phone, email, hotel,
 * room number. Nobody decided that; it is what "pass the state through" means
 * when nothing stands in the way.
 *
 * A vendor's no-training policy is a promise about data they have received.
 * This is the layer that decides what they receive at all, and it holds no
 * matter which brain answers — Claude, a hosted model, or the box under the
 * desk. It is the only part of the chain a change of provider cannot weaken.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * Deny by pattern, not allow by list. An allowlist looks safer and fails
 * silently the first time someone adds a field: the new key is simply absent
 * from the list, so it flows straight through. A denylist that matches on the
 * SHAPE of an identifier catches `phone`, `phone_number`, `guestPhone` and
 * `contact_no` without anyone remembering to update it.
 *
 * What survives is what actually improves an answer: where they are, how many
 * of them, what they like, what they have already booked. A concierge does not
 * need your surname to find you a table.
 */

/** Key names that identify a person rather than describe a preference. */
const IDENTIFYING = /(phone|mobile|tel\b|whatsapp|email|e-?mail|passport|surname|last_?name|full_?name|first_?name|\bname\b|dob|birth|address|room|card|payment|ssn|nric|nationality|license|licence)/i;

/** Values that look like an identifier no matter what the key is called. */
const LOOKS_IDENTIFYING = [
  /[\w.+-]+@[\w-]+\.[\w.]+/,          // email
  /\+?\d[\d\s().-]{7,}\d/,             // phone, in any of the ways people type one
  /\b\d{13,19}\b/,                     // card-length digit runs
];

/** True when this key/value pair should never reach a model. */
export function isIdentifying(key, value) {
  if (IDENTIFYING.test(String(key))) return true;
  const v = String(value ?? '');
  return LOOKS_IDENTIFYING.some((re) => re.test(v));
}

/**
 * Strip identifying entries from a profile before it is printed as KNOWN FACTS.
 *
 * Returns a new object — never mutates. The count of what was removed is
 * returned alongside so the caller can log that redaction happened without
 * logging what was redacted, which would defeat the point entirely.
 */
export function redactProfile(profile) {
  const out = {};
  let removed = 0;
  for (const [k, v] of Object.entries(profile ?? {})) {
    if (isIdentifying(k, v)) { removed += 1; continue; }
    out[k] = v;
  }
  return { profile: out, removed };
}

/**
 * Strip identifying values from anywhere in the trip state, at any depth.
 *
 * The state is stringified whole into the prompt, so a phone number nested
 * three levels down inside a booking is just as exposed as one at the top.
 * Redacted values become the literal string '[redacted]' rather than being
 * deleted: a model that sees a key with no value asks for it, and re-asking a
 * guest for their number is exactly the behaviour KNOWN FACTS exists to stop.
 */
export function redactState(state) {
  let removed = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === 'object') { out[k] = walk(v); continue; }
        if (isIdentifying(k, v)) { out[k] = '[redacted]'; removed += 1; continue; }
        out[k] = v;
      }
      return out;
    }
    return node;
  };
  const state_ = walk(state ?? {});
  return { state: state_, removed };
}
