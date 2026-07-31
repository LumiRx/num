// Cross-check src/lib/qr.ts against the reference `qrcode` package, module for
// module. A payment QR that scans wrong is worse than no QR, so this compares
// the full matrix — which also means it compares the chosen mask.
import { createRequire } from 'node:module';
import { unlinkSync } from 'node:fs';
const require = createRequire(import.meta.url);
const ref = require('qrcode');

// Transpile the real implementation with esbuild rather than regex-stripping
// types — this is the same file the app ships, not a copy of it.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/lib/qr.ts'],
  outfile: '/tmp/qr-check-build.mjs',
  format: 'esm',
  bundle: true,
  logLevel: 'silent',
});
const mine = await import('/tmp/qr-check-build.mjs?v=' + Date.now());

const payloads = [
  'HELLO',
  'https://num-app.thatislumi.workers.dev/?ref=9P8NFG',
  'https://num-app.thatislumi.workers.dev/?p=mem_abc123def456&a=250',
  'https://num-app.thatislumi.workers.dev/?i=xk5clmle9t&ref=BZNPB6',
  'https://num-app.thatislumi.workers.dev/e/bahipm42?g=7s3egn7wag',
  'x'.repeat(14), 'y'.repeat(26), 'z'.repeat(42), 'q'.repeat(62), 'w'.repeat(84),
  'https://num-app.thatislumi.workers.dev/?p=mem_0123456789abcdef0123&a=1200&n=' + encodeURIComponent('Tuk-tuk to Patong'),
  'ก'.repeat(20), // multi-byte UTF-8
];

let fails = 0;
for (const text of payloads) {
  const r = ref.create(text, { errorCorrectionLevel: 'M' });
  const m = mine.qrMatrix(text);
  let diff = 0;
  if (r.modules.size !== m.size) { console.log(`SIZE  ${r.modules.size} vs ${m.size}  «${text.slice(0,40)}»`); fails++; continue; }
  for (let row = 0; row < m.size; row++)
    for (let col = 0; col < m.size; col++)
      if ((r.modules.get(row, col) ? 1 : 0) !== m.modules(row, col)) diff++;
  const label = `v${r.version} ${m.size}×${m.size}`;
  if (diff) { console.log(`DIFF  ${diff} modules  ${label}  «${text.slice(0,40)}»`); fails++; }
  else console.log(`ok    ${label}  «${text.slice(0, 44)}${text.length > 44 ? '…' : ''}»`);
}
unlinkSync('/tmp/qr-check-build.mjs');
console.log(fails ? `\n${fails} MISMATCH` : `\nall ${payloads.length} payloads match the reference exactly`);
process.exit(fails ? 1 : 0);
