// Parse-checks every inline <script> block in an HTML file.
// A syntax error in a single-file app blanks the whole page, and the browser
// reports it only in the console — so this runs before any deploy.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const html = readFileSync(file, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, n = 0, bad = 0;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/i.test(attrs)) continue;          // external, nothing to parse
  if (/type\s*=\s*["']?(application\/json|text\/)/i.test(attrs)) continue;
  n++;
  const body = m[2];
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(body, { filename: `${file}:script#${n}@line${line}` });
    console.log(`  script#${n} at line ${line}: OK  (${body.split('\n').length} lines)`);
  } catch (e) {
    bad++;
    console.log(`  script#${n} at line ${line}: SYNTAX ERROR`);
    console.log(`    ${e.message}`);
  }
}
console.log(`${bad ? 'FAIL' : 'PASS'} — ${n} inline script block(s), ${bad} with errors`);
process.exit(bad ? 1 : 0);
