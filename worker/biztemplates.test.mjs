/**
 * A business must see its own trade in the form it is asked to fill in.
 *
 * 6 Sep 2026, from Dre: "lay out templates for business based on their
 * services… add products, price, menu, services etc based on their company."
 *
 * The form asked a dispensary, a spa, a hotel and a sailing charter the same
 * four questions. A business that cannot see itself in a form fills in two
 * items and leaves — and a listing with two items answers nobody's question.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEMPLATES, GENERAL, templateFor, templateById, templateChoices } from './biztemplates.mjs';
import { UNITS } from './bizoffer.mjs';

test('a real trade is recognised from the words a business already gave us', () => {
  const cases = {
    'Cannabis Delivery': 'cannabis',
    'cannabis dispensary': 'cannabis',
    'Thai restaurant': 'restaurant',
    'coffee shop': 'cafe',
    'rooftop bar': 'bar',
    'day spa': 'spa',
    'Boutique Hotel': 'stay',
    'sunset sailing tours': 'tour',
    'boutique': 'shop',
  };
  for (const [category, id] of Object.entries(cases)) {
    assert.equal(templateFor(category).id, id, `"${category}" should be ${id}`);
  }
});

test('an unrecognised trade gets a real form, never an empty one', () => {
  for (const odd of ['locksmith', 'barbecue joint', '', null, undefined, '   ']) {
    const t = templateFor(odd);
    assert.equal(t.id, 'general', `"${odd}" should fall through to general`);
    assert.ok(t.sections.length, 'the fallback must still suggest sections');
    assert.ok(t.example && t.label && t.noun, 'the fallback must be a usable form');
  }
});

test('a word only matches whole — "bar" must not claim a barbecue', () => {
  assert.equal(templateFor('barbecue joint').id, 'general');
  assert.equal(templateFor('Barcelona tapas').id, 'general');
  assert.equal(templateFor('pharmacy').id, 'shop', 'a real whole-word match still works');
});

test('ties are broken by declaration order, not by word length', () => {
  // "Boutique Hotel" matches shop (boutique) and stay (hotel), one each. The
  // first version preferred the LONGER word and called a hotel a shop.
  assert.equal(templateFor('Boutique Hotel').id, 'stay');
  const src = readFileSync(new URL('./biztemplates.mjs', import.meta.url), 'utf8');
  assert.match(src, /b\.n - a\.n \|\| a\.i - b\.i/, 'ranking must be signals-then-order');
  assert.doesNotMatch(src, /b\.long - a\.long/, 'the word-length tiebreak is back');
});

test('every template is usable by the form and the database it writes to', () => {
  for (const t of [...TEMPLATES, GENERAL]) {
    assert.ok(t.id && t.label && t.noun && t.example && t.price_hint, `${t.id} is missing a form field`);
    assert.ok(t.sections.length >= 2, `${t.id} should suggest at least two sections`);
    assert.ok(UNITS.includes(t.unit), `${t.id} defaults to unit "${t.unit}", which bizoffer would reject`);
    assert.equal(typeof t.delivery, 'boolean');
    assert.equal(typeof t.licence, 'boolean');
  }
});

test('cannabis is the one trade that demands a licence and an age, and says why', () => {
  const c = templateById('cannabis');
  assert.equal(c.licence, true);
  assert.equal(c.age_min, 21);
  assert.equal(c.delivery, true);
  assert.match(c.licence_label, /licence/i);
  assert.match(c.note, /licence is valid/, 'the business must be told the rule, not discover it');
  // Nobody else may quietly demand one.
  for (const t of TEMPLATES.filter((x) => x.id !== 'cannabis')) {
    assert.equal(t.licence, false, `${t.id} should not require a licence`);
    assert.equal(t.age_min, undefined, `${t.id} should not set an age gate`);
  }
});

test('the console asks the question the template names, not a generic one', () => {
  const src = readFileSync(new URL('./bizconsole.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ templateFor \} from '\.\/biztemplates\.mjs'/);
  assert.match(src, /const tpl = templateFor\(place\?\.category\)/, 'the template comes from their own listing — no new question');
  assert.match(src, /<h2>\$\{H\(tpl\.label\)\}<\/h2>/);
  assert.match(src, /placeholder="\$\{H\(tpl\.example\)\}"/);
  assert.match(src, /placeholder="\$\{H\(tpl\.price_hint\)\}"/);
  assert.match(src, /u === tpl\.unit \? ' selected' : ''/, 'the unit should default to the trade’s own');
  assert.match(src, /<datalist id="o_sections">/, 'sections should be offered, not demanded');
});

test('choices are offerable in a dropdown, with general included', () => {
  const ids = templateChoices().map((c) => c.id);
  assert.ok(ids.includes('general'));
  assert.equal(new Set(ids).size, ids.length, 'duplicate template ids');
  assert.equal(templateById('nonsense').id, 'general');
});
