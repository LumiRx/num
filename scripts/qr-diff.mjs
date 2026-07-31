import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const ref = require('qrcode');
await build({ entryPoints: ['src/lib/qr.ts'], outfile: '/tmp/qrb.mjs', format: 'esm', bundle: true, logLevel: 'silent' });
const mine = await import('/tmp/qrb.mjs?v=' + Date.now());

const text = process.argv[2] || 'https://num-app.thatislumi.workers.dev/e/bahipm42?g=7s3egn7wag';
const r = ref.create(text, { errorCorrectionLevel: 'M' });
const m = mine.qrMatrix(text);
const n = m.size;
console.log(`version ${r.version}  size ${n}`);
const pts = [];
for (let row = 0; row < n; row++) {
  let line = '';
  for (let col = 0; col < n; col++) {
    const a = r.modules.get(row, col) ? 1 : 0;
    const b = m.modules(row, col);
    if (a !== b) { line += 'X'; pts.push([row, col, a, b]); }
    else line += a ? '#' : '.';
  }
  console.log(line);
}
console.log('\ndiffs (row,col ref->mine):', pts.map(p => `(${p[0]},${p[1]}) ${p[2]}->${p[3]}`).join('  '));
