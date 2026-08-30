/**
 * When `places.name_local` may be printed, and when it must not be.
 *
 * The plan for these pages assumed name_local held the local-language spelling
 * — the thing a traveller shows a taxi driver. It does not. It holds whatever
 * alternate name the crawler happened to pick up, and a sample of the
 * directory shows what that means in practice:
 *
 *   หาดกมลา          → "Пляж Камала"                       (Russian)
 *   หาดกระทิง        → "끄라팅 해수욕장"                    (Korean)
 *   หาดกะรน          → "ساحل كارون"                        (Arabic)
 *   46階展望スペース  → "Mirador Careta Shiodome Piso 46"   (Spanish)
 *   a.testoni        → "A.Testoni"                         (just re-cased)
 *
 * Printing that field next to a Thai beach name gives an English-speaking
 * reader a Korean transliteration and calls it the local name. Across 2,906
 * pages it would be thousands of small confident lies, which is precisely the
 * failure mode this whole strategy is supposed to avoid.
 *
 * So: a name_local is printed only when it is written in the script the
 * destination's country actually uses, and only when it says something the
 * name does not already say.
 */

/** Unicode ranges, by script. Deliberately coarse — this is a gate, not an NLP. */
const SCRIPTS = Object.freeze({
  thai:     /[฀-๿]/,
  japanese: /[぀-ヿㇰ-ㇿ]/,
  korean:   /[가-힯ᄀ-ᇿ]/,
  han:      /[一-鿿㐀-䶿]/,
  arabic:   /[؀-ۿݐ-ݿ]/,
  cyrillic: /[Ѐ-ӿ]/,
  greek:    /[Ͱ-Ͽἀ-῿]/,
  hebrew:   /[֐-׿]/,
  devanagari: /[ऀ-ॿ]/,
  khmer:    /[ក-៿]/,
  lao:      /[຀-໿]/,
  myanmar:  /[က-႟]/,
  georgian: /[Ⴀ-ჿ]/,
  armenian: /[԰-֏]/,
  latin:    /[A-Za-zÀ-ɏ]/,
});

/**
 * The script a destination's country writes in.
 *
 * Only countries NUM actually holds destinations for. An unlisted country
 * falls through to `latin`, which is the safe default: it means a non-Latin
 * alternate is suppressed rather than printed as if it belonged.
 */
const COUNTRY_SCRIPT = Object.freeze({
  TH: 'thai', JP: 'japanese', KR: 'korean',
  CN: 'han', TW: 'han', HK: 'han', MO: 'han', SG: 'han',
  AE: 'arabic', SA: 'arabic', QA: 'arabic', BH: 'arabic', OM: 'arabic',
  KW: 'arabic', EG: 'arabic', MA: 'arabic', JO: 'arabic', LB: 'arabic',
  IL: 'hebrew', GR: 'greek', RU: 'cyrillic', UA: 'cyrillic', RS: 'cyrillic',
  BG: 'cyrillic', IN: 'devanagari', NP: 'devanagari', KH: 'khmer',
  LA: 'lao', MM: 'myanmar', GE: 'georgian', AM: 'armenian',
});

export const scriptFor = (country) => COUNTRY_SCRIPT[String(country || '').toUpperCase()] || 'latin';

/** Which of the known scripts a string is written in, or null. */
export function detectScript(s) {
  const str = String(s || '');
  if (!str) return null;
  // Order matters: Japanese kana before han, because Japanese text mixes both
  // and a kana hit is the stronger signal.
  for (const name of ['thai', 'japanese', 'korean', 'khmer', 'lao', 'myanmar',
    'hebrew', 'arabic', 'greek', 'cyrillic', 'devanagari', 'georgian', 'armenian', 'han']) {
    if (SCRIPTS[name].test(str)) return name;
  }
  return SCRIPTS.latin.test(str) ? 'latin' : null;
}

/** Same letters once case, spacing and punctuation stop mattering. */
const normalise = (s) => String(s || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The alternate name to print beside `name`, or null.
 *
 * @param {{name:string, name_local:string|null}} place
 * @param {string} country  ISO-2 of the destination
 */
export function localNameFor(place, country) {
  const alt = String(place?.name_local || '').trim();
  if (!alt) return null;

  // "a.testoni" → "A.Testoni" is not a translation, it is the same name with
  // different punctuation, and printing it makes the page look automated.
  if (normalise(alt) === normalise(place?.name)) return null;

  const want = scriptFor(country);

  // A LATIN-SCRIPT DESTINATION NEVER PRINTS AN ALTERNATE.
  //
  // The script check can tell Korean from Thai, but it cannot tell Italian
  // from German — and the directory is full of exactly that confusion. Rome's
  // fountains carry name_local values of "Vierströmebrunnen" (German) and
  // "Trevi-fontænen" (Danish); both are Latin script, both differ from the
  // Italian name in every word, and both would sail through any similarity
  // test. There is no signal here that separates "the local name" from "a
  // translation into a language nobody on this page reads", so the honest
  // answer is to print nothing and lose the handful of real ones.
  if (want === 'latin') return null;

  return detectScript(alt) === want ? alt : null;
}
