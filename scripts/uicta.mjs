/**
 * What the public CTA buttons actually compute to, read out of a real browser.
 *
 * Run: node scripts/uicta.mjs
 *
 * Named ui*.mjs like scripts/uilang.mjs rather than *.test.mjs on purpose —
 * it needs a browser, and the npm test glob must stay runnable without one.
 *
 * It asserts on getComputedStyle rather than on a screenshot, because the
 * claim worth holding is exact: on /my-host/ the confirm screen puts
 *
 *     <button class="btn danger">Yes, remove them</button>
 *     <button class="btn">Keep my host</button>
 *
 * side by side, and until 20 Sep 2026 `.danger` was used in the markup and
 * defined nowhere in site.css — so both rendered identically and the
 * destructive choice looked exactly like the safe one. A screenshot would
 * have shown that; only a comparison proves it stays fixed.
 */
/* global document, getComputedStyle */
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The repo pins an older playwright than the browsers sitting in this machine's
// shared cache, so the bundled revision it looks for is simply absent. Rather
// than make every run pay a 200MB download, fall back to any headless shell
// already on disk — newest first. CHROME_PATH overrides.
function localBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of shells) {
    for (const rel of ['chrome-headless-shell-mac-arm64/chrome-headless-shell',
                       'chrome-mac/headless_shell']) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const css = readFileSync(new URL('../public/assets/site.css', import.meta.url), 'utf8');

const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>
<button class="btn danger" id="danger">Yes, remove them</button>
<button class="btn" id="plain">Keep my host</button>
<button class="btn pri" id="pri">Get NUM</button>
<button class="btn sm" id="sm">Copy link</button>
<button class="btn pri" id="busy" aria-busy="true">Listing&hellip;</button>
<button class="btn danger" id="leaving" aria-busy="true" disabled>Yes, remove them</button>`;

const browser = await chromium.launch({ executablePath: localBrowser() });
const page = await browser.newPage();
await page.setContent(html);

const read = (id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  const s = getComputedStyle(el);
  const after = getComputedStyle(el, '::after');
  return {
    bg: s.backgroundColor,
    color: s.color,
    fontSize: s.fontSize,
    height: Math.round(el.getBoundingClientRect().height),
    afterAnim: after.animationName,
    opacity: s.opacity,
  };
}, id);

const danger = await read('danger');
const plain = await read('plain');
const pri = await read('pri');
const sm = await read('sm');
const busy = await read('busy');
// The real one: /my-host/ sets disabled AND aria-busy on the same click, and
// `.btn:disabled{opacity:.5}` has identical specificity to the busy rule — so
// which of the two wins is decided by source order, which is the kind of thing
// that silently reverts the day someone tidies the file.
const leaving = await read('leaving');

let fails = 0;
const check = (name, ok, got) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  → ${got}`}`);
  if (!ok) fails++;
};

console.log('\nCTA states, computed in a real browser:\n');
check('a destructive button no longer matches the safe one beside it',
  danger.bg !== plain.bg, `both ${danger.bg}`);
check('danger is red', danger.bg === 'rgb(217, 45, 32)', danger.bg);
check('danger carries white text', danger.color === 'rgb(255, 255, 255)', danger.color);
check('primary is still NUM teal, untouched',
  pri.bg === 'rgb(14, 164, 131)', pri.bg);
check('a small button is actually smaller',
  parseFloat(sm.fontSize) < parseFloat(plain.fontSize) && sm.height < plain.height,
  `sm ${sm.fontSize}/${sm.height}px vs default ${plain.fontSize}/${plain.height}px`);
check('a busy button grows a spinner',
  busy.afterAnim === 'btn-spin', busy.afterAnim);
check('a button that is disabled while it works still shows it is working',
  leaving.afterAnim === 'btn-spin' && leaving.opacity === '0.85',
  `anim ${leaving.afterAnim}, opacity ${leaving.opacity}`);
check('and is still red while it does',
  leaving.bg === 'rgb(217, 45, 32)', leaving.bg);
check('every full-size button clears the 44px touch target',
  [danger, plain, pri].every((b) => b.height >= 44),
  [danger, plain, pri].map((b) => `${b.height}px`).join(', '));

console.log(`\n  danger ${danger.bg}   neutral ${plain.bg}   primary ${pri.bg}`);
console.log(`  heights: default ${plain.height}px · small ${sm.height}px\n`);

await browser.close();
process.exit(fails ? 1 : 0);
