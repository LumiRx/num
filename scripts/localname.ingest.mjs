// Which `name:*` tag is the LOCAL name — the one on the sign.
//
// ── THE BUG THIS REPLACES ────────────────────────────────────────────────
//
// ingest_global.mjs picked the first `name:*` key that was not `name:en`:
//
//     Object.keys(t).filter(k => k.startsWith('name:') && k !== 'name:en')
//       .map(k => t[k]).find(v => v && v !== name) || null
//
// Object key order is insertion order, which for an Overpass response is
// whatever order the OSM contributor happened to add the tags in. So a Dubai
// restaurant tagged `name:ru` before `name:ar` stored the RUSSIAN name as its
// local name.
//
// Measured in production, 30 Aug 2026, across the seven UAE destinations:
// 735 rows carried a name_local, and only 508 of them were Arabic. 42 were
// Cyrillic, 15 were CJK, 170 were Latin or something else. Thirty-one per
// cent of our "local names" in the Gulf were in a language nobody there
// reads.
//
// That is not a cosmetic problem. Num's own house rules say to give the name
// they will SAY and the name they will SHOW, "because a taxi driver in
// Bangkok needs Yaowarat, not Chinatown Road". Handing a Dubai driver a
// Russian name is worse than handing him nothing: it looks like help.
//
// ── THE RULE ─────────────────────────────────────────────────────────────
//
// Ask for the destination's own language by name, and verify the answer is
// actually written in that language's script. Anything else is discarded.
// A missing local name costs a little convenience; a wrong-script one costs
// trust, and Num would print it with total confidence.
//
// Same principle as scripts/pseo/localname.mjs, which refuses to print an
// alternate name for a Latin-script destination. This is that rule applied
// one layer earlier, at ingest, where it is cheaper to enforce.

/** ISO-3166 alpha-2 → the OSM language codes worth reading there, best first. */
export const LANGS = Object.freeze({
  AE: ['ar'], SA: ['ar'], QA: ['ar'], KW: ['ar'], BH: ['ar'], OM: ['ar'],
  JO: ['ar'], EG: ['ar'], MA: ['ar', 'ber'], TN: ['ar'], DZ: ['ar'], LB: ['ar'],
  TH: ['th'], JP: ['ja'], KR: ['ko'], CN: ['zh'], TW: ['zh'], HK: ['zh'], MO: ['zh'],
  VN: ['vi'], KH: ['km'], LA: ['lo'], MM: ['my'], LK: ['si', 'ta'],
  IN: ['hi'], NP: ['ne'], BD: ['bn'], PK: ['ur'], IR: ['fa'], IL: ['he'],
  GR: ['el'], BG: ['bg'], RS: ['sr'], MK: ['mk'], UA: ['uk'], RU: ['ru'],
  GE: ['ka'], AM: ['hy'], AZ: ['az'], KZ: ['kk'], IL_: ['he'],
  ET: ['am'], TR: ['tr'], MV: ['dv'],
});

/**
 * Unicode ranges per language. A tag can be mislabelled — `name:ar` holding a
 * Latin transliteration is common — so the script is checked, not trusted.
 */
const SCRIPTS = Object.freeze({
  ar: /[؀-ۿݐ-ݿ]/, fa: /[؀-ۿ]/, ur: /[؀-ۿ]/,
  he: /[֐-׿]/, th: /[฀-๿]/, lo: /[຀-໿]/,
  my: /[က-႟]/, km: /[ក-៿]/, si: /[඀-෿]/,
  ta: /[஀-௿]/, hi: /[ऀ-ॿ]/, ne: /[ऀ-ॿ]/,
  bn: /[ঀ-৿]/, dv: /[ހ-޿]/, am: /[ሀ-፿]/,
  ja: /[぀-ヿ一-鿿]/, ko: /[가-힯]/, zh: /[一-鿿]/,
  el: /[Ͱ-Ͽ]/, ka: /[Ⴀ-ჿ]/, hy: /[԰-֏]/,
  ru: /[Ѐ-ӿ]/, uk: /[Ѐ-ӿ]/, bg: /[Ѐ-ӿ]/,
  sr: /[Ѐ-ӿ]/, mk: /[Ѐ-ӿ]/, kk: /[Ѐ-ӿ]/,
  // Latin-script languages: no script test can distinguish them from English,
  // so they are deliberately absent. See localName() — those destinations get
  // no local name at all, which is the correct answer.
});

/**
 * @param {object} tags   OSM tags for the element
 * @param {string} country ISO-3166 alpha-2 of the destination
 * @param {string} name    the primary name already chosen, so we never repeat it
 * @returns {string|null}
 */
export function localName(tags, country, name) {
  const langs = LANGS[String(country || '').toUpperCase()];
  if (!langs) return null; // Latin-script market — the sign already says it

  for (const lang of langs) {
    const v = tags?.[`name:${lang}`];
    if (!v || typeof v !== 'string') continue;
    const val = v.trim();
    if (!val || val === name) continue;
    const script = SCRIPTS[lang];
    // A `name:ar` holding "Al Hadheerah" is a transliteration, not the sign.
    if (script && !script.test(val)) continue;
    return val;
  }

  // Last resort: `int_name` or a bare `name` that is itself in the local
  // script, which happens when the English name arrived via `name:en`.
  const script = SCRIPTS[langs[0]];
  if (script) {
    for (const key of ['int_name', 'name', 'alt_name', 'old_name']) {
      const v = tags?.[key];
      if (typeof v === 'string' && v.trim() && v.trim() !== name && script.test(v)) return v.trim();
    }
  }
  return null;
}

/** True when a stored value is plausible as the local name for that country. */
export function isRightScript(value, country) {
  const langs = LANGS[String(country || '').toUpperCase()];
  if (!langs) return false;
  const script = SCRIPTS[langs[0]];
  return script ? script.test(String(value ?? '')) : false;
}
