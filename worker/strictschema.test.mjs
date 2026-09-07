/**
 * The translation that lets a non-Anthropic brain carry a booking.
 *
 * The whole value of strict mode is that the vendor GUARANTEES the shape. So
 * the tests here are about the translation being faithful — a schema that
 * quietly loosened on the way through would hand back exactly the confidence
 * we are paying for and none of the safety.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toStrict, problems, responseFormat } from './strictschema.mjs';
import { REPLY_SCHEMA } from './prompt.mjs';

describe('the real REPLY_SCHEMA survives the translation', () => {
  const strict = toStrict(REPLY_SCHEMA);

  test('it comes out with nothing strict mode would reject', () => {
    assert.deepEqual(problems(strict), []);
  });

  test('every property of every object is required', () => {
    const walk = (s, path = '$') => {
      if (!s || typeof s !== 'object') return;
      if (Array.isArray(s.anyOf)) return s.anyOf.forEach((x, i) => walk(x, `${path}.anyOf[${i}]`));
      if (s.type === 'array') return walk(s.items, `${path}[]`);
      if (s.properties) {
        assert.deepEqual(
          [...(s.required ?? [])].sort(), Object.keys(s.properties).sort(),
          `${path}: required does not list every property`,
        );
        assert.equal(s.additionalProperties, false, path);
        for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
      }
    };
    walk(strict);
  });

  test('an OPTIONAL field became a NULLABLE one, not a dropped one', () => {
    // `id` on a pick is optional in the source: a place can be named without
    // one. Strict mode has no optional, so it becomes "required, and null is
    // an acceptable answer" — the same promise from the other end.
    const item = strict.properties.picks.anyOf.find((a) => a.type === 'array').items;
    assert.ok(item.required.includes('id'));
    assert.ok(item.properties.id.anyOf.some((a) => a.type === 'null'));
    // And a field that was ALREADY required is left exactly alone.
    assert.equal(item.properties.name.type, 'string');
    assert.equal(item.properties.name.anyOf, undefined);
  });

  test('the card tag keeps its enum — the booking states are the point', () => {
    const card = strict.properties.card.anyOf.find((a) => a.type === 'object');
    const tag = card.properties.tag;
    const values = tag.enum ?? tag.anyOf?.find((a) => a.enum)?.enum;
    assert.ok(values.includes('confirmed'));
    assert.ok(values.includes('deposit'));
  });

  test('it never mutates the source — the Anthropic lane still sees the original', () => {
    const before = JSON.stringify(REPLY_SCHEMA);
    toStrict(REPLY_SCHEMA);
    assert.equal(JSON.stringify(REPLY_SCHEMA), before);
    // And the source really is still the looser one, not a copy of the strict.
    const src = REPLY_SCHEMA.properties.picks.anyOf.find((a) => a.type === 'array').items;
    assert.deepEqual(src.required, ['name', 'why']);
  });

  test('there is ONE schema in the codebase and this derives from it', () => {
    // A hand-maintained strict copy would drift, and the day it drifted would
    // be the day a booking came back in a shape nothing could read.
    const fmt = responseFormat(REPLY_SCHEMA);
    assert.equal(fmt.type, 'json_schema');
    assert.equal(fmt.json_schema.strict, true);
    assert.equal(fmt.json_schema.schema.properties.reply.type, 'string');
  });
});

describe('it refuses rather than loosens', () => {
  test('a schema that cannot go strict returns null instead of going anyway', () => {
    const tooDeep = { type: 'object', additionalProperties: false, required: ['a'], properties: { a:
      { type: 'object', additionalProperties: false, required: ['b'], properties: { b:
        { type: 'object', additionalProperties: false, required: ['c'], properties: { c:
          { type: 'object', additionalProperties: false, required: ['d'], properties: { d:
            { type: 'object', additionalProperties: false, required: ['e'], properties: { e:
              { type: 'object', additionalProperties: false, required: ['f'], properties: { f: { type: 'string' } } } } } } } } } } } } };
    assert.ok(problems(toStrict(tooDeep)).some((p) => /nested/.test(p)));
    assert.equal(responseFormat(tooDeep), null);
  });

  test('an object that forgot additionalProperties is caught, not fixed silently at the edge', () => {
    // toStrict adds it; problems() is the check that it actually happened, so
    // that a future translation bug fails here rather than at a vendor.
    assert.equal(toStrict({ type: 'object', properties: { a: { type: 'string' } } }).additionalProperties, false);
    assert.ok(problems({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }).length);
  });

  test('a bare enum is given a type, because strict mode wants to know what it is', () => {
    assert.equal(toStrict({ enum: ['a', 'b'] }).type, 'string');
  });
});
