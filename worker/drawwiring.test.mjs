// A FUNCTION IS NOT A BUTTON, AND A HANDLER IS NOT A ROUTE.
//
// On 13 Sep the Friday draw was a tested module with no caller anywhere in the
// repo. `grep runDraw` returned the module and its own test. Ten packs had been
// bought, itsnum.com/friday-rules was live promising a draw every Friday, SMS
// entries were accumulating — and there was no way to run it. Every unit test
// passed the whole time, because a unit test asks whether a function works, not
// whether anything calls it.
//
// The same shape has now cost this project four times: /api/pay/* and /p/* each
// shipped with a handler and no route pattern, /friday-rules shipped the same
// way, and the draw shipped with neither route nor button. So the wiring itself
// is asserted here, from the outside, by reading the files that would have to
// change for it to come undone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/* Comments stripped, because these files DOCUMENT the bug they no longer have —
   and a check that fires on its own explanation is a check somebody deletes. */
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const consoleSrc = read('worker', 'console.mjs');
const indexSrc = read('worker', 'index.mjs');
const ops = read('app-public', 'ops', 'index.html');
const smsSrc = read('worker', 'sms.mjs');

describe('the draw can actually be run', () => {
  test('runDraw has a caller that is not a test', () => {
    assert.match(consoleSrc, /runDraw\(/, 'nothing calls runDraw — it is a function with no button again');
  });

  test('the caller is behind a route', () => {
    assert.match(consoleSrc, /path === '\/admin\/draw'/, 'the handler exists but no path reaches it');
  });

  test('the route is behind the admin guard, not merely near it', () => {
    const guard = consoleSrc.indexOf('if (!(await isAdmin(env, request))) return json');
    const route = consoleSrc.indexOf("path === '/admin/draw'");
    assert.ok(guard > 0 && route > 0, 'guard or route missing');
    assert.ok(route > guard, 'the draw route sits AHEAD of the admin guard — anyone could run the draw');
  });

  test('num-app forwards /api/admin to the console router', () => {
    assert.match(indexSrc, /startsWith\('\/api\/admin'\)/,
      'a path prefix must reach handleConsole or the route is a 404');
  });

  test('the ops page has a control that calls it', () => {
    assert.match(ops, /\/api\/admin\/draw/, 'the console cannot reach the draw');
    assert.match(ops, /drawRun/, 'there is no button, only an endpoint');
    assert.match(ops, /draw: \['Friday draw'/, 'the tab is not registered, so the button is unreachable');
  });

  test('drawing asks first, because a draw cannot be undone', () => {
    assert.match(ops, /confirm\(/, 'an irreversible write with no confirmation');
  });
});

describe('both entry doors write the same table', () => {
  test('the SMS webhook and the app path share one writer', () => {
    assert.match(smsSrc, /from '\.\/giveaway\.mjs'/, 'SMS has stopped using the shared entry writer');
    assert.match(read('worker', 'packdraw.mjs'), /from '\.\/giveaway\.mjs'/,
      'packdraw has grown its own writer again — that is the 13 Sep bug exactly');
  });

  test('no module carries its own CREATE TABLE for the giveaway', () => {
    // This is how the split happened: three files each created the shape they
    // wanted, and CREATE TABLE IF NOT EXISTS on an existing table is a silent
    // no-op, so two of them were wrong and nothing said so.
    for (const f of [['worker', 'packdraw.mjs'], ['worker', 'giveaway.mjs'], ['worker', 'fridaydraw.mjs']]) {
      assert.doesNotMatch(code(...f), /CREATE TABLE[^\n]*num_giveaway/i,
        `${f.join('/')} creates a giveaway table — the migration owns the schema`);
    }
  });

  test('nothing reads the columns the old split used', () => {
    for (const f of [['worker', 'packdraw.mjs'], ['worker', 'giveaway.mjs'], ['worker', 'fridaydraw.mjs'],
      ['worker', 'console.mjs']]) {
      assert.doesNotMatch(code(...f), /week_key\s*=/,
        `${f.join('/')} still queries week_key, which production does not have`);
    }
  });
});

describe('the draw never reads a broken query as an empty week', () => {
  test('the draw module does not swallow read failures', () => {
    const src = code('worker', 'fridaydraw.mjs');
    assert.doesNotMatch(src, /catch\(\(\) => \(\{ results: \[\] \}\)\)/,
      'a failed read would come back as "nobody entered" — the worst failure a promotion has');
  });

  test('the endpoint answers 503 on a read failure, not 200 with a zero', () => {
    assert.match(consoleSrc, /draw_read_failed/, 'a broken read must be visibly broken');
  });
});

/*
 * THE DEFAULT PERIOD MUST BE A PERIOD THAT HAS ENDED — 18 SEP 2026.
 *
 * `/ops` posts `{action:'run'}` with no `week`, so the server's default IS the
 * button's whole behaviour. That default was `weekStart(now)`, commented as
 * "the period that is closing now" — true only if somebody draws on a Thursday.
 * On Friday, the day the Official Rules promise a draw, it returned the period
 * that had opened that morning.
 *
 * Caught before the first draw ever ran, with two entrants sitting in the
 * closed period and one in the open one. `runDraw` is idempotent on the period
 * and irreversible, so one click would have spent the open week's draw id and
 * left the two real entrants permanently undrawn.
 *
 * Asserted across every hour of a week rather than at one instant, because the
 * old bug was invisible on six days out of seven.
 */
describe('the draw defaults to a period that has closed', () => {
  test('the source no longer defaults to the period containing now', () => {
    assert.doesNotMatch(
      code('worker', 'console.mjs'),
      /:\s*weekStart\(Math\.floor\(Date\.now\(\) \/ 1000\)\)/,
      'adminDraw defaults to the CURRENT period again — on a Friday that is a week still taking entries',
    );
  });

  test('for every hour of a week, the default period has already ended', async () => {
    const { weekStart, weekEnd } = await import('./giveaway.mjs');
    // The expression adminDraw uses when no week is passed.
    const defaultWeek = (now) => weekStart(weekStart(now) - 1);
    const start = weekStart(Math.floor(Date.UTC(2026, 8, 18) / 1000));
    for (let h = 0; h < 24 * 7; h += 1) {
      const now = start + h * 3600;
      const week = defaultWeek(now);
      assert.ok(
        weekEnd(week) < now,
        `at +${h}h the default period ends ${new Date(weekEnd(week) * 1000).toISOString()}, which is not in the past`,
      );
      assert.equal(week, weekStart(now) - 7 * 24 * 3600,
        `at +${h}h the default is not the period immediately before the current one`);
    }
  });

  test('the preview says whether the period has closed', () => {
    assert.match(consoleSrc, /closed: weekEnd\(week\) < nowSec/,
      'without this the operator cannot tell a finished week from one still running');
  });

  test('the ops button is disabled while the period is open', () => {
    assert.match(ops, /d\.closed === false/, 'the page never reads the closed flag');
    assert.match(ops, /\|\| open \? 'disabled'/, 'an open period can still be drawn with one click');
  });
});
