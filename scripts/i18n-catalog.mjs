// Every t('…') in src/, collected into src/i18n/catalog.json.
//
// The app sends this list to /api/i18n and gets a map back, so a string that
// is not in here is a string that stays English on a Thai phone. The catalog
// is generated, never edited: `node scripts/i18n-catalog.mjs` writes it,
// `--check` fails when it is stale, and i18n-catalog.test.mjs runs the check
// so a new t() cannot ship without its entry.
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'src/i18n/catalog.json');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'i18n') yield* walk(p); }
    else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}

// t('…') / t("…") with the usual escapes. Template literals are not
// collected on purpose: a string built at runtime has no fixed English.
const CALL = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');

export function collect() {
  const found = new Set();
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const s = unescape(m[1] ?? m[2] ?? '');
      if (s.trim()) found.add(s);
    }
  }
  const strings = [...found].sort();
  const hash = createHash('sha256').update(strings.join('\u0000')).digest('hex').slice(0, 12);
  return { hash, strings };
}

export function current() {
  try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fresh = collect();
  if (process.argv.includes('--check')) {
    const have = current();
    if (!have || have.hash !== fresh.hash) {
      console.error(`src/i18n/catalog.json is stale (${have?.strings?.length ?? 0} → ${fresh.strings.length} strings). Run: node scripts/i18n-catalog.mjs`);
      process.exit(1);
    }
    console.log(`catalog ok: ${fresh.strings.length} strings`);
  } else {
    mkdirSync(join(ROOT, 'src/i18n'), { recursive: true });
    writeFileSync(OUT, JSON.stringify(fresh, null, 1) + '\n');
    console.log(`wrote ${fresh.strings.length} strings → src/i18n/catalog.json`);
  }
}
