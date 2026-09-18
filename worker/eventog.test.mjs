// A shared invite unfurls as something, not as a bare URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./events.mjs', import.meta.url), 'utf8');
const page = SRC.slice(SRC.indexOf('async function eventPage'), SRC.indexOf('export async function handleEvents'));

test('the event page carries Open Graph and Twitter cards', () => {
  for (const tag of ['og:title', 'og:description', 'og:url', 'og:image', 'twitter:card', 'twitter:title', 'twitter:image']) {
    assert.ok(page.includes(`"${tag}"`), `${tag} is missing from the event page head`);
  }
  assert.match(page, /content="summary_large_image"/);
});

test('every value in a meta tag is escaped — a title with a quote must not close the attribute', () => {
  for (const line of page.split('\n').filter((l) => l.includes('<meta property="og:') || l.includes('<meta name="twitter:'))) {
    if (!line.includes('${')) continue;
    assert.match(line, /\$\{esc\(/, `unescaped interpolation in a meta tag: ${line.trim()}`);
  }
});

test('the description is the host’s facts, never a promise', () => {
  const desc = page.slice(page.indexOf('og:description'), page.indexOf('og:url'));
  assert.doesNotMatch(desc, /booked|confirmed|guaranteed|free entry/i);
  assert.match(desc, /when\(e\)/, 'the day and time, from the event itself');
});
