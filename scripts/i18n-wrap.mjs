// One-off codemod: wrap JSX text and a few attributes in t('…').
// Run once, review the diff, fix what tsc flags. Kept for the next sweep.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = join(ROOT, 'src/components/app');
const dry = process.argv.includes('--dry');

const files = readdirSync(DIR).filter((f) => f.endsWith('.tsx')).map((f) => join(DIR, f)).filter((p) => statSync(p).isFile());

const LETTERS = /\p{L}.*\p{L}/su;
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
const clean = (s) => s.replace(/\s+/g, ' ').trim();

// Skip: entities, pure brand, code-ish, template braces, and anything that
// looks like a comparison rather than a tag boundary.
const skip = (txt) => !LETTERS.test(txt) || /&[a-z#0-9]+;/i.test(txt) || /^[A-Z0-9 ·•.]*$/.test(txt) && !/[A-Z]{2}/.test(txt) && false;

let total = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let n = 0;
  // 1. JSX text nodes: tag-end `>` (preceded by a non-space) … `<` opening a tag or closing tag.
  let out = src.replace(/([\w"'}\]/])>([^<>{}]+)<(?=\/|[A-Za-z])/g, (m, pre, txt) => {
    const c = clean(txt);
    if (skip(c) || c.length < 2 || c.length > 400) return m;
    const lead = /^[ \t]/.test(txt) && !/^\s*\n/.test(txt) ? "{' '}" : '';
    const tail = /[ \t]$/.test(txt) && !/\n\s*$/.test(txt) ? "{' '}" : '';
    n++;
    return `${pre}>${lead}{t('${esc(c)}')}${tail}<`;
  });
  // 2. Attributes people read.
  out = out.replace(/\b(placeholder|aria-label|title|alt)="([^"{}<>]+)"/g, (m, k, v) => {
    if (!LETTERS.test(v)) return m;
    n++;
    return `${k}={t('${esc(v)}')}`;
  });
  if (n && !/from '\.\.\/\.\.\/lib\/i18n'/.test(out)) {
    const lines = out.split('\n');
    let last = -1;
    for (let i = 0; i < lines.length; i++) if (/^import .* from '.*';$/.test(lines[i])) last = i;
    lines.splice(last + 1, 0, "import { t } from '../../lib/i18n';");
    out = lines.join('\n');
  }
  total += n;
  if (n) console.log(`${file.split('/').pop()}: ${n}`);
  if (!dry && out !== src) writeFileSync(file, out);
}
console.log(`total ${total}${dry ? ' (dry run)' : ''}`);
