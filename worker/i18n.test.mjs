import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mask, unmask, isTranslatable, hashOf, bundleFor, handleI18n, APP_LANGS } from './i18n.mjs';

test('brand words and placeholders are masked, and come back intact', () => {
  const { masked, kept } = mask('Watching {flight}. NUM pings you on WhatsApp.');
  assert.doesNotMatch(masked, /NUM|WhatsApp|\{flight\}/);
  assert.deepEqual(kept, ['{flight}', 'NUM', 'WhatsApp']);
  const back = unmask(masked, kept);
  assert.equal(back, 'Watching {flight}. NUM pings you on WhatsApp.');
});

test('a translation that lost a placeholder is refused', () => {
  const { masked, kept } = mask('Doors in {n}');
  assert.equal(unmask(masked.replace(/QQ0QQ/, ''), kept), null);
});

test('money and percentages are never translated', () => {
  assert.equal(isTranslatable('$9.99 a month'), false);
  assert.equal(isTranslatable('10% off'), false);
  assert.equal(isTranslatable('NUM'), false);
  assert.equal(isTranslatable('Nothing booked yet'), true);
});

test('hash is stable and short', async () => {
  assert.equal(await hashOf('Nothing booked yet'), await hashOf('Nothing booked yet'));
  assert.equal((await hashOf('a')).length, 24);
});

/** A D1 stand-in: one table, the three statements this module uses. */
function fakeDb(seed = []) {
  const rows = new Map(seed.map((r) => [r.id, r]));
  return {
    prepare(sql) {
      const s = { args: [], bind(...a) { s.args = a; return s; } };
      s.run = async () => {
        if (/CREATE TABLE/.test(sql)) return {};
        const [id, entity_id, locale, text] = s.args;
        if (!rows.has(id)) rows.set(id, { id, entity_id, locale, text, status: 'machine' });
        return {};
      };
      s.all = async () => {
        const [locale, ...ids] = s.args;
        return { results: [...rows.values()].filter((r) => r.locale === locale && ids.includes(r.entity_id)) };
      };
      return s;
    },
    rows,
  };
}

test('stored lines are served without the engine; new ones are translated once and saved', async () => {
  const id = await hashOf('Nothing booked yet');
  const db = fakeDb([{ id: `ls_th_${id}`, entity_id: id, locale: 'th', text: 'ยังไม่ได้จองอะไร', status: 'approved' }]);
  let calls = 0;
  const env = { DB: db, AI: { run: async (_m, { text }) => { calls++; return { translated_text: `[th] ${text}` }; } } };
  const map = await bundleFor(env, 'th', ['Nothing booked yet', 'Ask NUM', '$9.99 a month']);
  assert.equal(map['Nothing booked yet'], 'ยังไม่ได้จองอะไร', 'the human line wins, no engine call');
  assert.equal(map['Ask NUM'], '[th] Ask NUM', 'brand word survives the round trip');
  assert.equal('$9.99 a month' in map, false, 'money stays English');
  assert.equal(calls, 1);
  assert.equal(db.rows.size, 2, 'the new line is saved');
  const again = await bundleFor(env, 'th', ['Ask NUM']);
  assert.equal(calls, 1, 'second time is from the table');
  assert.equal(again['Ask NUM'], '[th] Ask NUM');
});

test('english asks for nothing; unknown languages are refused; GET lists the nine', async () => {
  const env = { DB: fakeDb(), AI: { run: async () => { throw new Error('should not run'); } } };
  const en = await handleI18n(new Request('https://x/api/i18n', { method: 'POST', body: JSON.stringify({ lang: 'en', strings: ['Hi'] }) }), env);
  assert.deepEqual((await en.json()).map, {});
  const bad = await handleI18n(new Request('https://x/api/i18n', { method: 'POST', body: JSON.stringify({ lang: 'xx', strings: ['Hi'] }) }), env);
  assert.equal(bad.status, 400);
  const list = await (await handleI18n(new Request('https://x/api/i18n'), env)).json();
  assert.equal(Object.keys(list.langs).length, Object.keys(APP_LANGS).length);
  assert.equal(list.langs.ar.dir, 'rtl');
});
