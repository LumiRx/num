// make-icons.mjs — rasterize the Num mark (same geometry as app-public/icon.svg)
// into PWA PNGs with zero dependencies: hand-built RGBA buffer + hand-written
// PNG chunks (IHDR/IDAT/IEND) using node:zlib deflateSync and CRC32.
//
//   node scripts/make-icons.mjs
//
// Outputs: app-public/icon-192.png, app-public/icon-512.png,
//          app-public/apple-touch-icon.png (180×180)

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app-public');

// ---------------------------------------------------------------------------
// The mark, in the icon.svg 512×512 coordinate space.
// ---------------------------------------------------------------------------
const INK = [0x20, 0x1e, 0x1d]; // #201e1d square
const PAPER = [0xff, 0xff, 0xff]; // white N
const ACCENT = [0xec, 0x30, 0x13]; // #ec3013 corner square

const N_TOP = 120;
const N_BOTTOM = 392;
const N_BAR = 72; // stroke width of each bar
const N_LEFT = 120; // left vertical: x 120..192
const N_RIGHT = 320; // right vertical: x 320..392
const ACCENT_MIN = 440; // accent square: 440..512, flush bottom-right

// Color of the mark at point (u, v) in 512-space.
function colorAt(u, v) {
  if (u >= ACCENT_MIN && v >= ACCENT_MIN) return ACCENT;
  if (v >= N_TOP && v < N_BOTTOM) {
    // Verticals.
    if ((u >= N_LEFT && u < N_LEFT + N_BAR) || (u >= N_RIGHT && u < N_RIGHT + N_BAR)) {
      return PAPER;
    }
    // Diagonal: parallelogram from (120,120)-(192,120) down to (320,392)-(392,392).
    const edge = N_LEFT + ((N_RIGHT - N_LEFT) * (v - N_TOP)) / (N_BOTTOM - N_TOP);
    if (u >= edge && u < edge + N_BAR) return PAPER;
  }
  return INK;
}

// ---------------------------------------------------------------------------
// PNG encoding.
// ---------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data: each scanline prefixed with filter byte 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * scale;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = colorAt((x + 0.5) * scale, v);
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 0xff;
    }
  }
  return encodePng(size, rgba);
}

const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];

for (const [name, size] of targets) {
  const png = renderIcon(size);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`wrote app-public/${name} (${size}x${size}, ${png.length} bytes)`);
}
