// An in-page link that points at nothing.
//
// `<a href="#apply">` is the cheapest possible call to action: no JavaScript,
// no route, no handler. It is also the easiest to break, because the anchor
// and its target live hundreds of lines apart and nothing connects them.
// Rename the section, delete it, move it to another page, and the button
// still renders, still looks clickable, and does nothing at all when tapped.
//
// Nothing else catches this. It is valid HTML, it passes every build, and the
// only symptom is a visitor who taps "Create my host account" and stays
// exactly where they are.
//
// A sticky header adds the second failure. `.nv` is position:sticky at 66px
// tall, so a jump that works still parks the target's heading underneath the
// bar — the reader arrives mid-form with no title and no idea what happened.
// Any target reached from a hero CTA therefore needs scroll-margin-top.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function pages(dir = 'public', out = []) {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (e.startsWith('.') || e === 'node_modules') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) pages(rel, out);
    else if (e.endsWith('.html')) out.push(rel);
  }
  return out;
}

/** Anchors that mean "top of page" or "do nothing", not a target. */
const NOT_A_TARGET = new Set(['#', '#!', '#top']);

describe('in-page anchors', () => {
  test('every href="#target" has a matching id on the same page', () => {
    const broken = [];
    for (const f of pages()) {
      const html = readFileSync(join(ROOT, f), 'utf8');
      const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
      // <a name="x"> still counts as a target in every browser.
      for (const m of html.matchAll(/\bname=["']([^"']+)["']/g)) ids.add(m[1]);
      for (const m of html.matchAll(/\bhref=["'](#[^"']*)["']/g)) {
        const href = m[1];
        if (NOT_A_TARGET.has(href)) continue;
        const target = decodeURIComponent(href.slice(1));
        if (!ids.has(target)) broken.push(`${f} → ${href}`);
      }
    }
    assert.deepEqual(broken, [], `these links point at an id that does not exist on the page:\n  ${broken.join('\n  ')}`);
  });

  test('the hosts hero CTA reaches the join form, clear of the sticky nav', () => {
    // The specific button this test was written for, kept honest by name:
    // somebody who arrived already convinced must be able to act without
    // reading 300 lines of pricing first.
    const html = readFileSync(join(ROOT, 'public/hosts/index.html'), 'utf8');
    const cta = html.match(/<a[^>]*data-cta=["']hero-create-host["'][^>]*>/);
    assert.ok(cta, 'the hosts page lost its hero CTA');
    assert.match(cta[0], /href=["']#apply["']/, 'the hero CTA must point at the join form');

    const section = html.match(/<section[^>]*id=["']apply["'][^>]*>/);
    assert.ok(section, 'the join form section lost its id');
    assert.match(
      section[0],
      /scroll-margin-top/,
      'without scroll-margin-top the jump parks the form heading under the sticky nav',
    );

    // One form, one source of truth. A duplicated hero form is how two
    // versions of the same fields start drifting apart.
    const forms = [...html.matchAll(/<form\b/g)].length;
    assert.equal(forms, 1, `expected exactly one form on the hosts page, found ${forms}`);
  });

  test('the check can fail', () => {
    const html = '<a href="#ghost">go</a><section id="real"></section>';
    const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
    assert.ok(!ids.has('ghost'), 'a missing target must be detectable');
    assert.ok(ids.has('real'));
  });
});
