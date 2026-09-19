// Strings a person can read that do NOT go through t('…').
//
// Heuristic, read by a person, kept for the next sweep. It walks the app's
// components and the libs that write copy into the thread, strips comments,
// and lists string literals that look like copy — a sentence (letters and a
// space), or a LABEL IN CAPS — unless they sit inside t(…)/T(…), a console
// line, a style/className/URL/key position, or a test.
//   node scripts/i18n-audit.mjs            # everything
//   node scripts/i18n-audit.mjs --caps     # labels only
//   node scripts/i18n-audit.mjs InviteSheet # one file
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = [join(ROOT, 'src/components/app'), join(ROOT, 'src/lib')];
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?)$/.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

const SENTENCE = /\p{L}[\p{L}’'.,!?…-]*\s+\p{L}/u;
const CAPS = /^[A-Z0-9][A-Z0-9 ·&’'+\-—/…?!]{2,}$/;
const NOISE = /^(var\(|--|#|\.|\/|https?:|mailto:|tel:|[a-z-]+:[^ ]|application\/|image\/|audio\/|text\/|[0-9.]+(px|em|rem|%|ms|s)$)/;
const CSSY = /^(flex|none|auto|center|inherit|pointer|wait|nowrap|hidden|absolute|relative|fixed|sticky|column|row|ellipsis|uppercase|capitalize|numeric|tel|email|decimal|search|off|on|true|false|ltr|rtl|button|dialog|polite|assertive|status|alert|img|presentation|contain|cover|smooth|instant|start|end|nearest|block|inline|grid|both|manipulation|pan-y|pan-x|transparent|currentColor|bold|normal|italic|solid|dashed|dotted|wrap|scroll|touch|default|middle|baseline|top|bottom|left|right)$/i;
const CALLERS = /\b(t|T|console\.(log|warn|error|info|debug)|webEvent|webEventOnce|track|Error|new Error|addEventListener|removeEventListener|getItem|setItem|removeItem|createElement|querySelector|querySelectorAll|getAttribute|setAttribute|matchMedia|localeCompare|startsWith|endsWith|includes|indexOf|split|join|replace|test|match|matchAll|padStart|padEnd|toLocaleDateString|toLocaleString|toLocaleTimeString|DateTimeFormat|NumberFormat|RelativeTimeFormat|DisplayNames|fetch|apiUrl|import|require|from|encodeURIComponent|URLSearchParams|classList\.(add|remove|toggle|contains)|assert(\.\w+)?|describe|it)\s*\($/;
const KEYISH = /(className|style|key|id|href|src|type|role|inputMode|autoComplete|autoCapitalize|enterKeyHint|fontFamily|background|color|border|font|grid\w*|transition|animation|transform|filter|cursor|display|position|overflow\w*|textAlign|alignItems|justifyContent|flexDirection|whiteSpace|textTransform|letterSpacing|boxShadow|content|mask|kind|status|view|mode|variant|intent|source|tag|who|grp|dir|lang|method|headers|'Content-Type'|Accept|by_id|by|verdict|channel|platform|provider|op|action|event|name|ref|path|url|route|scheme|hash|code|token|sku|plan|tier|currency|iso|tz|region|country|locale|engine|model|voice|format|ext|mime|encoding|aria-(live|haspopup|current|sort))\s*[:=]\s*$/;

const out = [];
for (const dir of DIRS) for (const file of walk(dir)) {
  if (only && !file.includes(only)) continue;
  const rel = relative(ROOT, file);
  const src = stripComments(readFileSync(file, 'utf8'));
  const lines = src.split('\n');
  // Find t(…) spans so anything inside them is skipped, including nested strings.
  const tSpans = [];
  const tRe = /\b[tT]\(/g;
  let m;
  while ((m = tRe.exec(src))) {
    let depth = 0; let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { const c = src[i]; if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) break; } }
    tSpans.push([m.index, i]);
  }
  const inT = (pos) => tSpans.some(([a, b]) => pos > a && pos < b);
  const STR = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  while ((m = STR.exec(src))) {
    const s = (m[1] ?? m[2] ?? '').replace(/\\(['"])/g, '$1');
    if (s.length < 3 || s.length > 400) continue;
    if (inT(m.index)) continue;
    const before = src.slice(Math.max(0, m.index - 60), m.index);
    if (CALLERS.test(before.trimEnd()) ) continue;
    if (KEYISH.test(before)) continue;
    if (NOISE.test(s) || CSSY.test(s)) continue;
    if (/^[a-z0-9_-]+$/.test(s)) continue;          // identifiers, ids, css tokens
    if (/^[\w.-]+@[\w.-]+$/.test(s)) continue;       // emails
    if (/^\{.*\}$/.test(s) || /^<.*>$/.test(s)) continue;
    if (/^\p{L}+$/u.test(s) && !/^[A-Z]{3,}$/.test(s)) continue; // one lowercase word: a key or a kind
    const caps = CAPS.test(s) && /[A-Z]{2}/.test(s);
    const sentence = SENTENCE.test(s);
    if (!caps && !sentence) continue;
    if (args.includes('--caps') && !caps) continue;
    // Skip regex-looking things and template keys.
    if (/\\[dws]|\^|\$$/.test(s)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push(`${rel}:${line}: ${s.length > 90 ? s.slice(0, 87) + '…' : s}`);
  }
}
console.log(out.join('\n'));
console.log(`\n${out.length} candidate strings`);
