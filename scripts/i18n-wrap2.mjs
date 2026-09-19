// Codemod, second sweep (19 Sep 2026): wrap copy that lives in EXPRESSIONS.
//
// The first sweep (i18n-wrap.mjs) caught JSX text nodes. What it could not see
// is the copy that decides at runtime — `{sending ? 'Your name' : 'What should
// I call you?'}`, `setNote('Number verified.')`, the feature registry's titles,
// NUM's own fallback lines. Same detector as i18n-audit.mjs; wraps a literal in
// t('…') when it sits in a function (evaluated when the map is loaded) and in
// T('…') at module level (a marker: the catalogue collects it, the render site
// translates with t()). Review the diff, fix what tsc flags.
//   node scripts/i18n-wrap2.mjs --dry [File]   # list what would change
//   node scripts/i18n-wrap2.mjs [File]          # write
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = [join(ROOT, 'src/components/app'), join(ROOT, 'src/lib')];
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.find((a) => !a.startsWith('--'));
// --mark: every wrap is T('…') — for a registry file whose entries carry arrow
// functions (the body heuristic would say t) but are evaluated once at import.
const forceMark = args.includes('--mark');
const SKIP_FILES = /^(i18n|i18nmark|store|apibase|track|types|AdminView|native|push|themes|textsize|a11y|icons|data|ThreadView|concierge|outage)\.tsx?$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?)$/.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

// Comments are blanked (same length) so positions survive.
const blank = (m) => m.replace(/[^\n]/g, ' ');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
  .replace(/`(?:[^`\\]|\\.)*`/g, blank);

const SENTENCE = /\p{L}[\p{L}’'.,!?…-]*\s+\p{L}/u;
const CAPS = /^[A-Z0-9][A-Z0-9 ·&’'+\-—/…?!]{2,}$/;
const NOISE = /^(x (mandatory|proximity)|\d[\d.]*(px|\s)|ADT|CHD|INF|NUM|var\(|--|#|\.|\/|https?:|mailto:|tel:|sms:|whatsapp:|[a-z-]+:[^ ]|application\/|image\/|audio\/|text\/|[0-9.]+(px|em|rem|%|ms|s)$|\d+px|rgba?\(|linear-gradient|radial-gradient|noopener|Content-Type|Bearer )/;
const CSSY = /^(flex|none|auto|center|inherit|pointer|wait|nowrap|hidden|absolute|relative|fixed|sticky|column|row|ellipsis|uppercase|capitalize|numeric|tel|email|decimal|search|off|on|true|false|ltr|rtl|button|dialog|polite|assertive|status|alert|img|presentation|contain|cover|smooth|instant|start|end|nearest|block|inline|grid|both|manipulation|pan-y|pan-x|transparent|currentColor|bold|normal|italic|solid|dashed|dotted|wrap|scroll|touch|default|middle|baseline|top|bottom|left|right|USD|EUR|GBP|THB|JPY|KRW|CNY|MNT|AED|SGD)$/i;
const CALLERS = /\b(t|T|console\.(log|warn|error|info|debug)|webEvent|webEventOnce|track|Error|addEventListener|removeEventListener|getItem|setItem|removeItem|createElement|querySelector|querySelectorAll|getAttribute|setAttribute|matchMedia|localeCompare|startsWith|endsWith|includes|indexOf|split|join|replace|replaceAll|test|match|matchAll|padStart|padEnd|toLocaleDateString|toLocaleString|toLocaleTimeString|DateTimeFormat|NumberFormat|RelativeTimeFormat|DisplayNames|fetch|apiUrl|import|require|encodeURIComponent|URLSearchParams|URL|RegExp|classList\.(add|remove|toggle|contains)|has|get|delete|new Set|new Map|Symbol|describe|it|assert(\.\w+)?)\s*\($/;
const KEYISH = /(className|style|key|id|href|src|type|role|inputMode|autoComplete|autoCapitalize|enterKeyHint|fontFamily|background|color|border|font|grid\w*|transition|animation|transform|filter|cursor|display|position|overflow\w*|textAlign|alignItems|justifyContent|flexDirection|whiteSpace|textTransform|letterSpacing|boxShadow|content|mask|kind|status|view|mode|variant|intent|source|who|grp|dir|lang|method|headers|Accept|by_id|by|verdict|channel|platform|provider|op|action|event|ref|path|url|route|scheme|hash|code|token|sku|tier|currency|iso|tz|region|country|locale|engine|model|format|ext|mime|encoding|cover|icon|emoji|feature|featureId|segment|surface|tab|sheet|page|target|rel|download|rail|slot|column|field|prop|param|query|q|sort|order|dur|time|day|mo|date|from|to|at|via|glyph|shape|weight|size|aria-(live|haspopup|current|sort|pressed|expanded|controls|describedby|labelledby|hidden))\s*[:=]\s*$/;
const BRANDS = new Set(['NUM','Num','Apple','Google','Stripe','Viator','Ticketmaster','Duffel','Uber','Grab','Bolt','Safari','Chrome','Whisper','Claude','Anthropic','Twilio','Resend','Cloudflare','Pexels','Privy','Revolut','PayPal','Link','Visa','Mastercard','Amex','Alipay','WeChat','LINE','WhatsApp','Telegram','Instagram','TikTok','Facebook','YouTube','Gmail','Outlook','Android','iPhone','iPad','Mac','Windows','Linux','Delta','Marriott','Hyatt','Hilton','Bangkok','Phuket','Lisbon','London','Edinburgh','Singapore','Tokyo','Paris','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','January','February','March','April','June','July','August','September','October','November','December','Content','Bearer','Basic','Accept','Authorization','Error','TypeError','Promise','Object','Array','String','Number','Boolean','Date','Map','Set','Symbol','Enter','Escape','Tab','Space','Shift','Meta','Control','Alt','Backspace','Delete','Home','End','PageUp','PageDown','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Anonymous','Stars','Star']);
const COMPARE = /(===|!==|==|!=|\bcase|\bin|\?\?|\|\||&&)\s*$/;

let total = 0;
const report = [];
for (const dir of DIRS) for (const file of walk(dir)) {
  if (only && !file.includes(only)) continue;
  if (SKIP_FILES.test(basename(file))) continue;
  const rel = relative(ROOT, file);
  const orig = readFileSync(file, 'utf8');
  const src = stripComments(orig);
  // t(…)/T(…) spans — anything inside is already handled.
  const spans = [];
  const tRe = /\b[tT]\(/g;
  let m;
  while ((m = tRe.exec(src))) {
    let depth = 0; let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { const c = src[i]; if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) break; } }
    spans.push([m.index, i]);
  }
  const inSpan = (pos) => spans.some(([a, b]) => pos > a && pos < b);
  // Top-level statement starts: a line beginning at column 0 with export/const/let/function/class/type/interface.
  const tops = [];
  const topRe = /^(export\s+)?(default\s+)?(async\s+)?(const|let|var|function|class|type|interface|enum)\b/gm;
  while ((m = topRe.exec(src))) tops.push(m.index);
  const statementStart = (pos) => { let s = 0; for (const tp of tops) { if (tp <= pos) s = tp; else break; } return s; };

  const edits = [];
  const STR = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  while ((m = STR.exec(src))) {
    const raw = m[1] ?? m[2] ?? '';
    const s = raw.replace(/\\(['"])/g, '$1');
    if (s.length < 3 || s.length > 400) continue;
    if (inSpan(m.index)) continue;
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const bt = before.trimEnd();
    if (/\b(from|import|export)\s*$/.test(bt)) continue;
    if (CALLERS.test(bt)) continue;
    if (KEYISH.test(before)) continue;
    if (COMPARE.test(bt)) continue;
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(bt)) continue; // a quoted key ('a': v), not a ternary branch (? 'a' : b)
    if (/^\s*[=!]==?/.test(after)) continue;           // compared after
    if (/\[\s*$/.test(bt)) { /* index or array element */ if (/\]\s*$/.test(src.slice(m.index + m[0].length, m.index + m[0].length + 2))) continue; }
    if (NOISE.test(s) || CSSY.test(s)) continue;
    if (/^[a-z0-9_.-]+$/.test(s)) continue;
    if (/^[\w.-]+@[\w.-]+$/.test(s)) continue;
    if (/^\{.*\}$/.test(s) || /^<.*>$/.test(s)) continue;
    if (/\\[dws]|\^|\$$/.test(s)) continue;
    const caps = CAPS.test(s) && /[A-Z]{2}/.test(s);
    const sentence = SENTENCE.test(s);
    // One Capitalised word is a label (Earning, Dietary, Cancel); one lowercase
    // word is a key (plan, hold). Brands and codes stay as they are.
    const word = /^\p{Lu}\p{Ll}{2,}$/u.test(s) && !BRANDS.has(s);
    if (/^\p{L}+$/u.test(s) && !caps && !word) continue;
    if (!caps && !sentence && !word) continue;
    // Module level or inside a function? Look at the top-level statement
    // this literal belongs to: a `function`/`=>` before the literal means a body.
    const stmt = src.slice(statementStart(m.index), m.index);
    const inBody = /\bfunction\b|=>/.test(stmt);
    const fn = forceMark || !inBody ? 'T' : 't';
    // JSX attribute: placeholder="…" → placeholder={t('…')}. Everything else: 'x' → t('x').
    const attr = /\b([\w-]+)=$/.exec(bt);
    const lit = `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const isJsxAttr = attr && m[2] !== undefined && /[\w-]+=$/.test(before.trimEnd()) && m[0][0] === '"';
    const replacement = isJsxAttr ? `{${fn}(${lit})}` : `${fn}(${lit})`;
    edits.push({ start: m.index, end: m.index + m[0].length, replacement, fn, s });
  }
  if (!edits.length) continue;
  let out = orig;
  for (const e of edits.slice().reverse()) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  const needT = edits.some((e) => e.fn === 't') && !/\bt\b[^]*from '(\.\.\/\.\.\/lib\/i18n|\.\/i18n)'/.test(out.match(/^import[^\n]*i18n'/gm)?.join('\n') ?? '');
  const needTT = edits.some((e) => e.fn === 'T') && !/\bT\b[^]*from '(\.\.\/\.\.\/lib\/(i18n|i18nmark)|\.\/(i18n|i18nmark))'/.test(out.match(/^import[^\n]*i18n(mark)?'/gm)?.join('\n') ?? '');
  const isLib = rel.startsWith('src/lib/');
  const modPath = isLib ? './i18n' : '../../lib/i18n';
  const markPath = isLib ? './i18nmark' : '../../lib/i18nmark';
  const lines = out.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^import .* from '.*';$/.test(lines[i])) last = i;
  const adds = [];
  // data.ts must not import the store (i18n.ts does); every T() goes through i18nmark.
  if (needT && !/^data\.ts$/.test(basename(file))) adds.push(`import { t } from '${modPath}';`);
  if (needTT || (needT && /^data\.ts$/.test(basename(file)))) adds.push(`import { T } from '${markPath}';`);
  if (adds.length) lines.splice(last + 1, 0, ...adds);
  out = lines.join('\n');
  total += edits.length;
  report.push(`${rel}: ${edits.length}` + (dry ? '\n' + edits.map((e) => `   ${e.fn}  ${e.s.length > 80 ? e.s.slice(0, 77) + '…' : e.s}`).join('\n') : ''));
  if (!dry) writeFileSync(file, out);
}
console.log(report.join('\n'));
console.log(`\n${dry ? 'would wrap' : 'wrapped'} ${total} strings`);
