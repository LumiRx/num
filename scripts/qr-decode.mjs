// The real test: render our own matrix as a bitmap and decode it with jsQR, a
// scanner implementation. Matching the reference encoder byte-for-byte is
// reassuring; being READ correctly is the thing that actually matters, and it
// covers the cases where we legitimately pick a different mask.
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const jsQR = require('jsqr').default ?? require('jsqr');
await build({ entryPoints: ['src/lib/qr.ts'], outfile: '/tmp/qr-dec.mjs', format: 'esm', bundle: true, logLevel: 'silent' });
const { qrMatrix } = await import('/tmp/qr-dec.mjs?v=' + Date.now());

const SCALE = 4, QUIET = 4;
function bitmap(text) {
  const { size, modules } = qrMatrix(text);
  const dim = (size + QUIET * 2) * SCALE;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (modules(r, c))
        for (let dy = 0; dy < SCALE; dy++)
          for (let dx = 0; dx < SCALE; dx++) {
            const y = (r + QUIET) * SCALE + dy, x = (c + QUIET) * SCALE + dx;
            const i = (y * dim + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
  return { data, dim };
}

const payloads = [
  'HELLO',
  'https://num-app.thatislumi.workers.dev/?ref=9P8NFG',
  'https://num-app.thatislumi.workers.dev/?p=mem_abc123def456&a=250',
  'https://num-app.thatislumi.workers.dev/?i=xk5clmle9t&ref=BZNPB6',
  'https://num-app.thatislumi.workers.dev/e/bahipm42?g=7s3egn7wag',
  'https://num-app.thatislumi.workers.dev/?p=mem_0123456789abcdef0123&a=1200&n=' + encodeURIComponent('Tuk-tuk to Patong'),
  'x'.repeat(14), 'y'.repeat(26), 'z'.repeat(42), 'q'.repeat(62), 'w'.repeat(84), 'e'.repeat(106),
  'ก'.repeat(20),
  'https://num-app.thatislumi.workers.dev/?p=mem_zzzz&a=99999&n=' + encodeURIComponent('Sunset Beach Club — table for six'),
];

let fail = 0;
for (const text of payloads) {
  const { data, dim } = bitmap(text);
  const got = jsQR(data, dim, dim);
  const ok = got && got.data === text;
  if (!ok) { fail++; console.log(`FAIL  «${text.slice(0, 50)}»  →  ${got ? '«' + got.data.slice(0, 50) + '»' : 'not detected'}`); }
  else console.log(`read  ${String(dim).padStart(4)}px  «${text.slice(0, 52)}${text.length > 52 ? '…' : ''}»`);
}
console.log(fail ? `\n${fail} FAILED TO DECODE` : `\nall ${payloads.length} decoded back to the exact payload`);
process.exit(fail ? 1 : 0);
