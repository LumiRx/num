/**
 * SKU numbers — how a business labels and organises what it sells.
 *
 * Every product on a shelf (a venue's menu in num_products, a host's shelf in
 * num_host_products) carries one SKU: digits only, 4 to 12 of them, unique
 * within that business. The owner can type their own — the number already on
 * their till or their packaging — or leave it blank and NUM assigns the next
 * free one. It is shown as a number and as a scannable barcode.
 *
 * A SKU is a label. It does not unlock, enter or order anything by itself.
 * (This replaces the retired Ghost Message code, 22 Sep 2026.)
 */

export const SKU_MIN = 4;
export const SKU_MAX = 12;
export const SKU_START = 1001;

/** Digits only, 4–12 of them, or null. Spaces and dashes typed by hand are dropped. */
export function cleanSku(raw) {
  const d = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
  return d.length >= SKU_MIN && d.length <= SKU_MAX ? d : null;
}

/** The next free SKU for a business, given the ones it already uses. */
export function nextSku(existing = []) {
  let max = SKU_START - 1;
  for (const s of existing) {
    const n = Number(cleanSku(s));
    if (Number.isFinite(n) && n > max && n < 1e12) max = n;
  }
  return String(max + 1);
}

/* ── Code 128 ──────────────────────────────────────────────────────────────
 * The barcode retail scanners read. Subset C packs two digits per symbol so
 * a numeric SKU stays short. An odd-length SKU encodes its pairs in C, then
 * switches to subset B for the last digit, so the bars read back exactly the
 * number printed under them — never a padded one.
 */
const PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];
const START_C = 105;
const STOP = 106;
const CODE_B = 100;

/** The symbol values for a digit string (C, with a B tail when odd), with checksum. */
export function code128c(digits) {
  const d = String(digits);
  const vals = [START_C];
  const even = d.length - (d.length % 2);
  for (let i = 0; i < even; i += 2) vals.push(Number(d.slice(i, i + 2)));
  if (d.length % 2) vals.push(CODE_B, d.charCodeAt(d.length - 1) - 32);
  let sum = vals[0];
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, STOP);
  return vals;
}

/**
 * An inline SVG barcode for a SKU, with the number printed underneath.
 * Built only from a cleaned digit string, so it is safe to drop into a page.
 * Returns '' for anything that is not a valid SKU.
 */
export function barcodeSvg(sku, { height = 42, module = 1.6, text = true } = {}) {
  const d = cleanSku(sku);
  if (!d) return '';
  // Code 128 needs ten modules of white either side or scanners miss the start.
  const quiet = 10 * module;
  let x = quiet;
  const bars = [];
  for (const v of code128c(d)) {
    const p = PATTERNS[v];
    for (let i = 0; i < p.length; i++) {
      const w = Number(p[i]) * module;
      if (i % 2 === 0) bars.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}"/>`);
      x += w;
    }
  }
  const width = x + quiet;
  const th = text ? 14 : 0;
  const label = text
    ? `<text x="${(width / 2).toFixed(2)}" y="${height + 12}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11" fill="#000">${d}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SKU ${d}" width="${width.toFixed(0)}" height="${height + th}" viewBox="0 0 ${width.toFixed(2)} ${height + th}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars.join('')}</g>${label}</svg>`;
}
