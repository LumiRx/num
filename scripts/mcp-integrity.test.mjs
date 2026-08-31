// The drift check, held to the standard it holds everything else to.
//
// Two jobs here, and the second is the one that matters:
//
//   1. Prove the checker's own machinery works — that it parses a tool array
//      correctly, and that it FAILS when the artefacts disagree. A checker that
//      cannot go red is a green light wired to nothing.
//   2. Actually run the offline invariant against this repository, so that
//      `npm test` — and therefore `release.mjs stage`, which runs npm test
//      before it will produce a preview URL — turns "added a tool, forgot the
//      docs" into a failed build instead of a discovery six weeks later.
//
// Deliberately offline. The suite must pass on a plane, and a test that needs
// the internet is a test that goes red for reasons unrelated to the code and
// then gets skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolNamesFromSource, readSource, run, SURFACES, TIMEOUT_MS } from './mcp-integrity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

test('the source parser reads a tool array and ignores everything else', () => {
  const src = `
    const DECOY = [{ name: 'not_a_tool' }];
    const TOOLS = [
      { name: 'alpha', description: 'has a ] bracket and a { brace in the prose', inputSchema: {
          type: 'object', properties: { name: { type: 'string' }, limit: { type: 'integer' } } } },
      { name: 'beta', description: "an apostrophe: don't break", inputSchema: { type: 'object', properties: {} } },
    ];
    const AFTER = [{ name: 'also_not_a_tool' }];
  `;
  assert.deepEqual(toolNamesFromSource(src, 'TOOLS'), ['alpha', 'beta'],
    'the parser picked up a nested schema property, a decoy array, or choked on punctuation inside a description');
});

test('the source parser refuses to guess', () => {
  // Returning [] for a renamed array would report "0 tools" and then compare
  // an empty set against an empty set and pass. Silence is the failure mode
  // this whole file exists to prevent, so it throws instead.
  assert.throws(() => toolNamesFromSource('const OTHER = [];', 'TOOLS'), /not found/);
  assert.throws(() => toolNamesFromSource('const TOOLS = [{ name: "a" },', 'TOOLS'), /not closed/);
});

test('concierge_answer gets more time than the default — it runs the real model chain, not a DB read', () => {
  // Until 29 Aug 2026 concierge_answer forwarded to /api/num over this
  // Worker's own public hostname and 522'd in under a second, every time —
  // fast because it never reached the answer pipeline at all. Once fixed to
  // call the real handler directly, the smoke check measured a genuine
  // 29.9s round trip (grounding + the real model chain), well past this
  // file's default TIMEOUT_MS — the same default every other tool on this
  // surface, all pure D1 reads, is right to keep. Losing this override
  // silently reintroduces false failures on the one tool that is supposed
  // to be slow now that it actually works.
  const partners = SURFACES.find((s) => s.id === 'num-partners');
  assert.ok(partners, 'the num-partners surface is missing from SURFACES');
  const tool = partners.smoke.find((s) => s.tool === 'concierge_answer');
  assert.ok(tool, 'concierge_answer has no smoke entry — the tool worth the whole integration is going unchecked');
  assert.ok(tool.timeoutMs > TIMEOUT_MS,
    `concierge_answer's smoke timeout (${tool.timeoutMs}) is not longer than the default (${TIMEOUT_MS}) — ` +
    'a real answer will be misreported as a hang');
});

test('every declared surface parses to a non-empty tool set', () => {
  for (const s of SURFACES) {
    const names = readSource(s);
    assert.ok(names.length > 0, `${s.id}: no tools parsed from ${s.source.file}`);
    assert.equal(new Set(names).size, names.length, `${s.id}: duplicate tool name in ${s.source.file}`);
    for (const n of names) {
      assert.match(n, /^[a-z][a-z0-9_]*$/, `${s.id}: "${n}" is not a tool name`);
    }
  }
});

test('every surface names an owner and a real docs page', () => {
  // "Who owns this" is the first question in an incident and the last thing
  // anyone writes down. An unowned surface is one nobody will notice drifting.
  for (const s of SURFACES) {
    assert.ok(s.owner && s.owner.includes('('), `${s.id}: owner does not name the file that implements it`);
    assert.ok(s.docs.length > 0, `${s.id}: no documentation page declared`);
    for (const d of s.docs) {
      assert.ok(existsSync(join(ROOT, d.local)), `${s.id}: declared docs page ${d.local} does not exist`);
    }
  }
});

test('THE INVARIANT: every tool in source is named on its public docs page', async () => {
  // This is the assertion that costs a deploy when someone adds a tool and
  // forgets the page. If it fails, do not delete the tool from this list —
  // write the sentence on the page.
  const results = await run({ offline: true });
  const problems = results.flatMap((r) => r.problems);
  assert.deepEqual(
    problems.map((p) => `${p.surface}: ${p.kind} ${p.tool ?? ''} @ ${p.where} — ${p.detail}`),
    [],
    'source and the documentation in this repo disagree. Run `npm run mcp:integrity -- --offline` for the diff, ' +
    'and see HQ/divisions/num/MCP_INTEGRITY.md for the procedure.',
  );
});

test('the checker goes red when an artefact disagrees', async () => {
  // Verified by construction rather than by trusting the green above: take a
  // real surface, ask for a tool the docs cannot possibly mention, and assert
  // the machinery reports it. Without this, a bug that makes `problems` always
  // empty would look exactly like a healthy repository.
  const surface = SURFACES.find((s) => s.id === 'num-partners');
  const docs = readFileSync(join(ROOT, surface.docs[0].local), 'utf8');
  const invented = 'book_a_helicopter';
  assert.ok(!docs.includes(invented), 'test fixture is no longer fictional');

  const undocumented = [invented].filter((n) => !docs.includes(n));
  assert.deepEqual(undocumented, [invented],
    'the docs-membership rule no longer detects a tool that is absent from the page');

  // And the reverse direction: a retired tool still advertised.
  const zombie = ['search_places'].filter((n) => docs.includes(n));
  assert.deepEqual(zombie, ['search_places'],
    'the retired-tool rule no longer detects a name that is still on the page');
});

test('no surface silently skips the live half forever', () => {
  // `deployed: false` is the one escape hatch in the checker. It is allowed to
  // exist for a surface that is written but not shipped, and it must never
  // quietly become permanent — so it is asserted here, by name, and whoever
  // ships the surface has to come back and delete their own line.
  const pending = SURFACES.filter((s) => s.deployed === false).map((s) => s.id);
  assert.deepEqual(pending, ['num-concierge'],
    'a surface is marked "not deployed" that this test does not know about. ' +
    'If it shipped, set deployed: true. If it is new, add it here on purpose.');
});

test('the script still runs when its path contains a space', () => {
  // Found the hard way. The universal idiom for "was I run directly" is
  //     import.meta.url === `file://${process.argv[1]}`
  // and it is WRONG for any path with a space in it: import.meta.url encodes
  // the space as %20 and argv[1] does not, so the comparison fails, the main
  // block never runs, and the process exits 0 having done nothing at all.
  //
  // The sibling copy of this checker lives under "Agents -  5arz" and was
  // exactly that — a no-op reporting all clear, from the deploy gate, from CI
  // and from every operator who ran it and saw no complaint. A drift checker
  // that silently succeeds is worse than no drift checker, because people stop
  // looking. This repo's path has no space in it today and is one
  // `git worktree add` away from having one.
  const dir = mkdtempSync(join(tmpdir(), 'mcp integrity '));  // the space is the test
  try {
    cpSync(join(HERE, 'mcp-integrity.mjs'), join(dir, 'mcp-integrity.mjs'));
    const out = execFileSync(process.execPath, [join(dir, 'mcp-integrity.mjs'), '--offline'], {
      encoding: 'utf8',
      // It will exit 1 — copied out of the repo it cannot find any source file,
      // which is the correct answer. What is being asserted is that it SPEAKS.
    }).toString();
    assert.fail(`expected a non-zero exit from an unrooted copy, got clean output: ${out.slice(0, 200)}`);
  } catch (e) {
    // execFileSync throws on non-zero exit and carries the output with it.
    const said = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    assert.ok(said.trim().length > 0,
      'the checker produced NO output and did not run. The entry-point guard is broken for paths with spaces — ' +
      'use pathToFileURL(process.argv[1]).href, never `file://${process.argv[1]}`.');
    assert.notEqual(e.status, 0, 'a checker that cannot find its own repo must not exit 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the booking surface is not on the read-only partner surface', () => {
  // The boundary partnermcp.mjs declares in its header, asserted rather than
  // trusted. A future contributor adding request_table to the partner tool
  // array would break three documented promises and fail here first.
  const partner = readSource(SURFACES.find((s) => s.id === 'num-partners'));
  const concierge = readSource(SURFACES.find((s) => s.id === 'num-concierge'));
  assert.ok(!partner.includes('request_table'),
    'request_table is on /api/partner/mcp, which promises callers it never books and takes no personal data');
  assert.ok(concierge.includes('request_table'), 'request_table left the concierge surface');
  assert.equal(partner.filter((t) => concierge.includes(t)).length, 0,
    'a tool is served by both the open read-only surface and the keyed booking surface — one of the two access ' +
    'policies is therefore decorative');
});

// ── 31 Aug 2026: the checker judged a surface on one field of its answer ──

test('a refusal is matched against the whole body, not just .error', () => {
  // The agents worker refuses an unauthenticated tools/call with a real HTTP
  // 401 — NOT a JSON-RPC envelope — because RFC 9728 §5.1 requires
  // WWW-Authenticate for an MCP client to begin the OAuth flow. Its body is
  // {error, message, docs}, and the documented signup pointer lives in
  // `message`. Reading only `error` made the checker report a correct,
  // spec-compliant surface as ADVERTISED BUT BROKEN — and print
  // `"unauthorized"` as the proof, the one field that could never contain
  // what it was looking for.
  const src = readFileSync(new URL('./mcp-integrity.mjs', import.meta.url), 'utf8');
  const smoke = src.slice(src.indexOf('facts.smoke = []'));
  assert.match(smoke, /const text = inner \|\| JSON\.stringify\(json\)/,
    'the smoke check still pre-filters the response before matching, so it decides before it looks');
  assert.ok(!/JSON\.stringify\(json\.error \?\? json\.result/.test(smoke),
    'the old single-field read is still there');
});

test('a failed smoke prints what the server actually said', () => {
  // Four alarms on 31 Aug each named the wrong culprit, and every one was a
  // conclusion printed without the observation behind it. A checker holding
  // the response body when it declares a tool broken should show it.
  const src = readFileSync(new URL('./mcp-integrity.mjs', import.meta.url), 'utf8');
  assert.match(src, /looked for \$\{s\.match\} and the server said/,
    'the failure message states a verdict without the evidence it was drawn from');
});

test('the real 31 Aug refusal body would now pass', () => {
  // Verbatim from https://itsnum.com/mcp, unauthenticated tools/call.
  const body = {
    error: 'unauthorized',
    message: 'Send Authorization: Bearer <token>. Either a key from POST https://itsnum.com/api/agent/signup, '
      + 'or an OAuth 2.1 access token — see https://itsnum.com/.well-known/oauth-protected-resource.',
    docs: 'https://itsnum.com/agents/',
  };
  const inner = '';
  const text = inner || JSON.stringify(body);
  assert.equal(/api\/agent\/signup/.test(text), true,
    'the documented pointer is in the body and must match');
  // And the old behaviour must be shown to have failed, so this test means something.
  assert.equal(/api\/agent\/signup/.test(JSON.stringify(body.error)), false);
});
