// Every link NUM hands to another person points at the branded host — from a
// browser, from a preview deploy, and from inside the installed app, whose own
// origin is "localhost" and must never leak into a QR code.
// Run: node --test src/lib/links.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(spec)) {
      const base = ctx.parentURL ? dirname(fileURLToPath(ctx.parentURL)) : process.cwd();
      for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
        const p = resolvePath(base, spec + ext);
        if (existsSync(p)) return next(pathToFileURL(p).href, ctx);
      }
    }
    return next(spec, ctx);
  },
});

// The module reads window.location once at import, so each origin is its own
// import with a cache-busting query.
async function linksAt(href) {
  const u = new URL(href);
  globalThis.window = { location: { href, hostname: u.hostname, protocol: u.protocol, port: u.port, origin: u.origin } };
  return import(`./links.ts?origin=${encodeURIComponent(href)}`);
}

test('from the installed iOS app (capacitor://localhost) every link is the branded host', async () => {
  const L = await linksAt('capacitor://localhost/');
  assert.equal(L.connectLink('mem_1'), 'https://app.itsnum.com/c/mem_1');
  assert.equal(L.referralLink('ABC2'), 'https://app.itsnum.com/r/ABC2');
  assert.equal(L.inviteLink('tok'), 'https://app.itsnum.com/i/tok');
  assert.doesNotMatch(L.payLink('mem_1', 5), /localhost/);
});

test('from the installed Android app (http://localhost, no port) likewise', async () => {
  const L = await linksAt('http://localhost/');
  assert.equal(L.connectLink('mem_1'), 'https://app.itsnum.com/c/mem_1');
});

test('from a preview deploy the link is still the branded host, not workers.dev', async () => {
  const L = await linksAt('https://abc123-num-app.thatislumi.workers.dev/');
  assert.equal(L.referralLink('X'), 'https://app.itsnum.com/r/X');
});

test('only a developer’s laptop — localhost with a port over http — keeps its own origin', async () => {
  const L = await linksAt('http://localhost:5173/');
  assert.equal(L.connectLink('mem_1'), 'http://localhost:5173/c/mem_1');
});
