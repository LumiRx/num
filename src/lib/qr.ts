// A QR encoder, written out rather than pulled in.
//
// Why write it: the app ships no runtime dependencies, and a payment code has
// to be right — so this is verified module-for-module against the reference
// `qrcode` package (scripts/qr-check.mjs), matrix and chosen mask included,
// across the payload shapes we actually generate.
//
// Scope on purpose: byte mode, error-correction level M, versions 1–10. That
// covers every URL Num encodes with room to spare, and level M survives a
// scuffed screen or a phone held at an angle — which is the real operating
// condition for a tuk-tuk driver's QR taped to a dashboard.

const ECC_M = 0b00; // format bits for level M

/** [eccPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] by version. */
const BLOCKS: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** Byte-mode capacity in characters, level M. */
const CAPACITY: Record<number, number> = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };

const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// ── Galois field GF(256), generator 0x11D ────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed–Solomon generator polynomial of the given degree. */
function rsPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecc(data: Uint8Array, count: number): Uint8Array {
  const gen = rsPoly(count);
  const rem = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[count - 1] = 0;
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ── bit stream ───────────────────────────────────────────────────────────────
class Bits {
  bits: number[] = [];
  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function pickVersion(len: number): number {
  for (let v = 1; v <= 10; v++) if (len <= CAPACITY[v]) return v;
  throw new Error('QR payload too long — keep it under 213 bytes');
}

// ── matrix ───────────────────────────────────────────────────────────────────
type Grid = { size: number; m: Int8Array; fn: Uint8Array }; // fn marks function modules

const at = (g: Grid, r: number, c: number) => g.m[r * g.size + c];
const set = (g: Grid, r: number, c: number, v: number, isFn = false) => {
  g.m[r * g.size + c] = v;
  if (isFn) g.fn[r * g.size + c] = 1;
};

function finder(g: Grid, row: number, col: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= g.size || cc < 0 || cc >= g.size) continue;
      const on = r >= 0 && r <= 6 && (c === 0 || c === 6) ? 1 : c >= 0 && c <= 6 && (r === 0 || r === 6) ? 1 : r >= 2 && r <= 4 && c >= 2 && c <= 4 ? 1 : 0;
      set(g, rr, cc, on, true);
    }
  }
}

function buildFunctions(g: Grid, version: number) {
  finder(g, 0, 0);
  finder(g, 0, g.size - 7);
  finder(g, g.size - 7, 0);

  // timing
  for (let i = 8; i < g.size - 8; i++) {
    const on = i % 2 === 0 ? 1 : 0;
    set(g, 6, i, on, true);
    set(g, i, 6, on, true);
  }

  // alignment
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      // skip the three that would sit on a finder
      if ((r === 6 && c === 6) || (r === 6 && c === g.size - 7) || (r === g.size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
          set(g, r + dr, c + dc, on, true);
        }
      }
    }
  }

  // dark module + format areas reserved
  set(g, g.size - 8, 8, 1, true);
  for (let i = 0; i < 9; i++) {
    if (!g.fn[8 * g.size + i]) set(g, 8, i, 0, true);
    if (!g.fn[i * g.size + 8]) set(g, i, 8, 0, true);
  }
  for (let i = 0; i < 8; i++) {
    if (!g.fn[8 * g.size + (g.size - 1 - i)]) set(g, 8, g.size - 1 - i, 0, true);
    if (!g.fn[(g.size - 1 - i) * g.size + 8]) set(g, g.size - 1 - i, 8, 0, true);
  }

  // version info (7 and up), BCH(18,6)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = ((version << 12) | rem) >>> 0;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + g.size - 11;
      set(g, b, a, bit, true);
      set(g, a, b, bit, true);
    }
  }
}

function placeFormat(g: Grid, mask: number) {
  const data = (ECC_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) >>> 0;

  // Position i takes bit (14 - i): the format word is placed most-significant
  // bit first. Reading it the other way round is a silent, scanner-breaking
  // failure — the code looks perfect and decodes with the wrong mask.
  const fb = (i: number) => (bits >>> (14 - i)) & 1;

  // Copy 1, around the top-left finder.
  for (let i = 0; i <= 5; i++) set(g, 8, i, fb(i), true);
  set(g, 8, 7, fb(6), true);
  set(g, 8, 8, fb(7), true);
  set(g, 7, 8, fb(8), true);
  for (let i = 9; i < 15; i++) set(g, 14 - i, 8, fb(i), true);

  // Copy 2: bits 0–6 climb column 8 from the bottom, then 7–14 run along row 8
  // to the right edge. The dark module owns (size-8, 8) and is written last.
  for (let i = 0; i < 7; i++) set(g, g.size - 1 - i, 8, fb(i), true);
  for (let i = 7; i < 15; i++) set(g, 8, g.size - 15 + i, fb(i), true);
  set(g, g.size - 8, 8, 1, true);
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The standard four penalty rules — lower is better. */
function penalty(g: Grid): number {
  const n = g.size;
  let score = 0;
  const runScore = (run: number) => (run >= 5 ? 3 + (run - 5) : 0);

  for (let r = 0; r < n; r++) {
    let run = 1;
    for (let c = 1; c < n; c++) {
      if (at(g, r, c) === at(g, r, c - 1)) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let c = 0; c < n; c++) {
    let run = 1;
    for (let r = 1; r < n; r++) {
      if (at(g, r, c) === at(g, r - 1, c)) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = at(g, r, c);
      if (v === at(g, r, c + 1) && v === at(g, r + 1, c) && v === at(g, r + 1, c + 1)) score += 3;
    }
  }
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (get: (i: number) => number, start: number, pat: number[]) => pat.every((p, i) => get(start + i) === p);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c + 11 <= n; c++) {
      if (match((i) => at(g, r, i), c, pat1) || match((i) => at(g, r, i), c, pat2)) score += 40;
    }
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r + 11 <= n; r++) {
      if (match((i) => at(g, i, c), r, pat1) || match((i) => at(g, i, c), r, pat2)) score += 40;
    }
  }
  let dark = 0;
  for (let i = 0; i < n * n; i++) dark += g.m[i];
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** Encode `text` and return the module matrix (1 = dark). */
export function qrMatrix(text: string): { size: number; modules: (row: number, col: number) => number } {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const [eccLen, g1, d1, g2, d2] = BLOCKS[version];
  const totalData = g1 * d1 + g2 * d2;

  // mode (byte = 0100) + length + payload
  const bs = new Bits();
  bs.push(0b0100, 4);
  bs.push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) bs.push(b, 8);
  // terminator, then pad to a byte, then the alternating pad bytes
  const capBits = totalData * 8;
  for (let i = 0; i < 4 && bs.bits.length < capBits; i++) bs.bits.push(0);
  while (bs.bits.length % 8 !== 0) bs.bits.push(0);
  const data = new Uint8Array(totalData);
  for (let i = 0; i < bs.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bs.bits[i + j] ?? 0);
    data[i / 8] = byte;
  }
  for (let i = Math.ceil(bs.bits.length / 8); i < totalData; i++) {
    data[i] = (i - Math.ceil(bs.bits.length / 8)) % 2 === 0 ? 0xec : 0x11;
  }

  // split into blocks, compute ECC, then interleave
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? d1 : d2;
    const block = data.slice(off, off + len);
    off += len;
    dataBlocks.push(block);
    eccBlocks.push(ecc(block, eccLen));
  }
  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < eccLen; i++) for (const b of eccBlocks) out.push(b[i]);

  const size = version * 4 + 17;
  const base: Grid = { size, m: new Int8Array(size * size), fn: new Uint8Array(size * size) };
  buildFunctions(base, version);

  // zig-zag placement, right to left, skipping the vertical timing column
  const place = (g: Grid) => {
    let bit = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) {
        const row = upward ? size - 1 - v : v;
        for (let k = 0; k < 2; k++) {
          const col = right - k;
          if (g.fn[row * size + col]) continue;
          const byte = out[bit >>> 3] ?? 0;
          set(g, row, col, (byte >>> (7 - (bit & 7))) & 1);
          bit++;
        }
      }
      upward = !upward;
    }
  };
  place(base);

  // try every mask, keep the least penalised — the spec's own rule
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g: Grid = { size, m: Int8Array.from(base.m), fn: Uint8Array.from(base.fn) };
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!g.fn[r * size + c] && MASKS[mask](r, c)) g.m[r * size + c] ^= 1;
      }
    }
    placeFormat(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }
  const g = best!;
  return { size, modules: (r, c) => at(g, r, c) };
}

/**
 * The QR as an inline SVG. A path of rectangles rather than an image: it scales
 * to any size without blurring, inherits the theme's ink colour, and costs no
 * network request — which matters when someone is scanning it in a tuk-tuk with
 * one bar of signal.
 */
export function qrSvg(text: string, opts: { size?: number; margin?: number; dark?: string; light?: string } = {}): string {
  const { size: px = 220, margin = 2, dark = '#000', light = 'transparent' } = opts;
  const { size, modules } = qrMatrix(text);
  const total = size + margin * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code">
<rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
