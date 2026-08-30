#!/usr/bin/env node
/**
 * MCP integrity — the check that makes a silently-drifted MCP surface impossible.
 *
 * WHY THIS EXISTS
 *
 * An MCP server is four artefacts that are edited at four different times by
 * four different reflexes:
 *
 *   1. SOURCE   the tool array in the Worker — changed when you build something
 *   2. LIVE     what the deployed server actually answers to tools/list
 *   3. LISTING  the machine-readable manifest / index / registry entry an agent
 *               discovers you through — changed when you remember
 *   4. DOCS     the human page an engineer reads before integrating — changed
 *               when marketing gets to it
 *
 * They drift apart in that order, and every one of the drifts is invisible from
 * inside the thing that drifted. On 5arz a paid tool pointed at a dead endpoint
 * for a week: source and listing agreed, so every check anyone had was green.
 * The invariant this file enforces is the only one that would have caught it:
 *
 *      SOURCE, LIVE, LISTING and DOCS agree — always — and every tool a
 *      surface advertises can actually be called.
 *
 * The last clause is not decoration. Set membership is cheap to keep true and
 * catches the honest mistakes; a LIVE SMOKE CALL is what catches the tool that
 * is listed everywhere and answers 522.
 *
 * HOW TO RUN
 *
 *   node scripts/mcp-integrity.mjs            everything: source ↔ live ↔ listing ↔ docs ↔ smoke
 *   node scripts/mcp-integrity.mjs --offline  source ↔ local listing/doc files only, no network
 *   node scripts/mcp-integrity.mjs --surface=num-partners
 *   node scripts/mcp-integrity.mjs --json     machine-readable, same exit code
 *
 * No arguments, no credentials, no dependencies. The public surfaces are public;
 * needing a secret to verify them would mean the check could not run from a CI
 * job, and a check that cannot run is a check that does not exist.
 *
 * EXIT CODE IS THE PRODUCT. 0 = every surface agrees. 1 = at least one does not.
 * Nothing here has an allowlist, a "known failure" file, or a soft mode. The
 * moment a red result can be made green by editing a list rather than fixing
 * the drift, this file stops working and nobody notices that either.
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const TIMEOUT_MS = 20_000;

/* ── the four surfaces, declared once ─────────────────────────────────────
 * Adding a surface means adding an entry here. Adding a TOOL means adding it
 * to `source` and to every artefact named below — which is the whole point:
 * this table is the list of places you are about to forget.
 *
 * `retired` is the reverse direction. Docs are prose and cannot be scanned for
 * "names that should not be here" without knowing what a name looks like, so
 * when a tool is REMOVED its name goes in `retired` and the check fails while
 * any listing or doc still mentions it. It is a two-line chore that replaces
 * the class of bug where a deleted tool keeps being advertised for a year.
 * ---------------------------------------------------------------------- */
const SURFACES = [
  {
    id: 'num',
    owner: 'Num · agents worker (agents/worker.js)',
    serverName: 'num',
    url: 'https://itsnum.com/mcp',
    // Bearer numa_live_… from POST /api/agent/signup. tools/list is open;
    // tools/call is not, which is why smoke here asserts the REFUSAL rather
    // than a result — an unauthenticated 200 with data would be the bug.
    auth: 'bearer-required',
    source: { file: 'agents/worker.js', array: 'MCP_TOOLS' },
    listings: [
      { kind: 'manifest', url: 'https://itsnum.com/.well-known/mcp.json', path: 'tools[].name' },
      { kind: 'registry', name: 'com.itsnum/num' },
    ],
    docs: [
      { local: 'public/agents/index.html', url: 'https://itsnum.com/agents/' },
      { local: 'public/llms-full.txt', url: 'https://itsnum.com/llms-full.txt' },
    ],
    smoke: [
      // Unauthenticated: the correct answer is a refusal that names the signup
      // route. A tool that 500s and a tool that politely refuses look identical
      // to a set-membership check and completely different to an agent.
      { tool: 'num_search_places', args: { city: 'Phuket', limit: 1 }, expect: 'refusal', match: /api\/agent\/signup/ },
    ],
    retired: [],
  },
  {
    id: 'num-partners',
    owner: 'Num · partnerships (worker/partnermcp.mjs)',
    serverName: 'num-partners',
    url: 'https://app.itsnum.com/api/partner/mcp',
    // Deliberately open. See PUBLIC-BY-DECISION in worker/partnermcp.mjs.
    auth: 'public',
    source: { file: 'worker/partnermcp.mjs', array: 'TOOLS' },
    listings: [
      { kind: 'index', url: 'https://app.itsnum.com/api/partner', path: 'tools[].name' },
    ],
    docs: [
      { local: 'public/partners/index.html', url: 'https://itsnum.com/partners/' },
    ],
    smoke: [
      { tool: 'list_destinations', args: {}, expect: 'ok', match: /"destinations"/ },
      { tool: 'search_places', args: { destination: 'phuket', limit: 1 }, expect: 'ok', match: /"places"/ },
      // The tool worth the whole integration, and the one that broke. Until
      // 29 Aug 2026 it forwarded to /api/num over its own public hostname; a
      // same-zone self-fetch loops back through the Cloudflare edge, which
      // answered 522 in under a second, every time — the exact failure
      // .github/workflows/uptime.yml:6 already documented. Set membership
      // said green for a week while this returned an error to every caller.
      //
      // Fixed by importing and calling the /api/num handler directly
      // (worker/index.mjs's handleNum, worker/partnermcp.mjs's
      // concierge_answer) instead of fetch()-ing it. That means this call
      // now runs the SAME full pipeline a guest's question does — grounding,
      // the real model chain, the guard/quality retry passes — not a
      // near-instant DB read like every other tool on this surface. Measured
      // at 29.9s on 29 Aug 2026 with zero retries needed; a guard or quality
      // retry adds another full model call each. The other tools here are
      // pure D1 reads and stay on the default TIMEOUT_MS on purpose — this
      // override is scoped to the one tool whose honest latency is
      // structurally different, not a blanket loosening of the check.
      { tool: 'concierge_answer', args: { question: 'where should we eat tonight?', destination: 'phuket' }, expect: 'ok', match: /"answer"/, timeoutMs: 60_000 },
      { tool: 'open_places', args: { destination: 'phuket', limit: 1 }, expect: 'ok', match: /"timezone"|"count"/ },
    ],
    retired: [],
  },
  {
    id: 'num-business',
    owner: 'Num · business platform (worker/bizmcp.mjs)',
    serverName: 'num-business',
    url: 'https://app.itsnum.com/api/biz/mcp',
    auth: 'mixed',
    source: { file: 'worker/bizmcp.mjs', array: 'TOOLS' },
    listings: [
      { kind: 'index', url: 'https://app.itsnum.com/api/biz', path: 'mcp_tools[].name' },
    ],
    docs: [
      { local: 'public/business/index.html', url: 'https://itsnum.com/business/' },
    ],
    smoke: [
      { tool: 'find_listing', args: { name: 'cafe', destination: 'phuket' }, expect: 'ok', match: /"places"/ },
    ],
    retired: [],
  },
  {
    id: 'num-concierge',
    owner: 'Num · bookings (worker/conciergemcp.mjs)',
    serverName: 'num-concierge',
    url: 'https://app.itsnum.com/api/concierge/mcp',
    // Keyed, always. This is the surface that can cause a restaurant's phone
    // to ring, so unlike num-partners there is no evaluate-without-a-key path.
    auth: 'partner-key-required',
    // Written, tested and routed; not yet shipped. Flip to true in the SAME
    // change that deploys it — the release script refuses to ship a surface
    // whose source moved while this is still false, so it cannot be forgotten,
    // and until it flips the live/listing/smoke checks would otherwise report
    // a hundred false failures and teach everyone to ignore this tool.
    deployed: false,
    source: { file: 'worker/conciergemcp.mjs', array: 'TOOLS' },
    listings: [
      { kind: 'index', url: 'https://app.itsnum.com/api/concierge', path: 'tools[].name' },
    ],
    docs: [
      { local: 'public/partners/index.html', url: 'https://itsnum.com/partners/' },
    ],
    smoke: [
      // Unkeyed, so the correct answer is a refusal. Asserting the refusal is
      // the only automated proof that the key requirement has not been removed
      // by a refactor — a surface that silently opened would otherwise look
      // exactly as healthy as one that did not.
      { tool: 'request_table', args: {}, expect: 'refusal', match: /X-Partner-Key/i },
    ],
    retired: [],
  },
];

/* ── source extraction ─────────────────────────────────────────────────────
 * Read the tool names straight out of the file rather than importing it.
 *
 * Importing would be more precise and is the wrong trade here: these modules
 * are Cloudflare Workers, and the day one of them touches a Worker global at
 * module scope the integrity check starts failing for a reason that has
 * nothing to do with integrity. A check that breaks for unrelated reasons gets
 * disabled. This parse is deliberately dumb, and any disagreement it has with
 * reality is caught immediately by the LIVE comparison two functions down.
 * ---------------------------------------------------------------------- */
export function toolNamesFromSource(text, arrayName) {
  const open = new RegExp(`(?:const|let|var)\\s+${arrayName}\\s*=\\s*\\[`).exec(text);
  if (!open) throw new Error(`array ${arrayName} not found in source`);
  let i = open.index + open[0].length;
  let depth = 1;
  const start = i;
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    // Skip string bodies so a bracket inside a description cannot end the array.
    else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
    }
  }
  if (depth !== 0) throw new Error(`array ${arrayName} is not closed`);
  const body = text.slice(start, i - 1);
  // Only `name:` at the top level of a tool object. inputSchema properties are
  // nested two braces deeper and never carry a `name:` key of their own.
  return [...body.matchAll(/(?:^|[\s{,])name\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g)].map((m) => m[1]);
}

export function readSource(surface) {
  const path = join(ROOT, surface.source.file);
  if (!existsSync(path)) throw new Error(`source file missing: ${surface.source.file}`);
  return toolNamesFromSource(readFileSync(path, 'utf8'), surface.source.array);
}

/* ── transport ──────────────────────────────────────────────────────────── */
const withTimeout = async (fn, ms = TIMEOUT_MS) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fn(ac.signal); } finally { clearTimeout(t); }
};

async function rpc(url, method, params = {}, headers = {}, timeoutMs) {
  const res = await withTimeout((signal) =>
    fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }), timeoutMs);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${method}: not JSON (HTTP ${res.status}) ${text.slice(0, 120)}`); }
  return { status: res.status, json };
}

const getJson = (url) => withTimeout(async (signal) => {
  const r = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

const getText = (url) => withTimeout(async (signal) => {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
});

/** `tools[].name` / `mcp_tools[].name` → the names, or [] if the key is absent. */
function pluck(obj, path) {
  const key = path.replace(/\[\]\.name$/, '');
  const arr = obj?.[key];
  return Array.isArray(arr) ? arr.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean) : null;
}

async function registryTools(name) {
  const q = `${REGISTRY}?search=${encodeURIComponent(name.split('/').pop())}`;
  const j = await getJson(q);
  const hit = (j.servers ?? []).find((s) => s.server?.name === name);
  if (!hit) return { found: false };
  return {
    found: true,
    version: hit.server.version,
    status: hit._meta?.['io.modelcontextprotocol.registry/official']?.status,
    remotes: (hit.server.remotes ?? []).map((r) => r.url),
    // The registry stores no tool list. What it CAN be checked against is the
    // endpoint it points an agent at — a registry entry aimed at a URL that is
    // not the live server is a whole audience routed nowhere.
  };
}

/* ── the comparison ─────────────────────────────────────────────────────── */
const setDiff = (a, b) => a.filter((x) => !b.includes(x));

function compare(label, expected, actual, problems, surfaceId) {
  const missing = setDiff(expected, actual);
  const extra = setDiff(actual, expected);
  for (const m of missing) {
    problems.push({ surface: surfaceId, kind: 'missing', where: label, tool: m,
      detail: `in source but not in ${label}` });
  }
  for (const e of extra) {
    problems.push({ surface: surfaceId, kind: 'extra', where: label, tool: e,
      detail: `advertised by ${label} but not in source` });
  }
}

async function checkSurface(surface, { offline }) {
  const problems = [];
  const facts = { id: surface.id, owner: surface.owner, url: surface.url };

  // 1. SOURCE — the only artefact that is always available.
  let source;
  try {
    source = readSource(surface);
    facts.source = source;
  } catch (e) {
    problems.push({ surface: surface.id, kind: 'source', where: surface.source.file, detail: e.message });
    return { facts, problems };
  }
  if (source.length === 0) {
    problems.push({ surface: surface.id, kind: 'source', where: surface.source.file, detail: 'zero tools parsed' });
    return { facts, problems };
  }

  // 2. DOCS — offline against the file in this repo, which is what makes the
  //    check runnable in a test suite and therefore what actually blocks a
  //    deploy. Every tool name must appear literally on the page an engineer
  //    reads; a retired name must appear nowhere.
  facts.docs = [];
  for (const doc of surface.docs) {
    const path = join(ROOT, doc.local);
    if (!existsSync(path)) {
      problems.push({ surface: surface.id, kind: 'docs', where: doc.local, detail: 'documentation page does not exist' });
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const undocumented = source.filter((n) => !text.includes(n));
    const zombie = surface.retired.filter((n) => text.includes(n));
    facts.docs.push({ file: doc.local, documented: source.length - undocumented.length, of: source.length });
    for (const n of undocumented) {
      problems.push({ surface: surface.id, kind: 'undocumented', where: doc.local, tool: n,
        detail: `live tool absent from ${doc.local} — an integrator cannot discover it` });
    }
    for (const n of zombie) {
      problems.push({ surface: surface.id, kind: 'zombie', where: doc.local, tool: n,
        detail: `retired tool still advertised in ${doc.local}` });
    }
  }

  // A surface that has not shipped yet still has to keep the source ↔ docs
  // half of the invariant — that is the half that gets forgotten — but it has
  // no live server to compare against and pretending otherwise would fill the
  // report with noise. PENDING is not PASS, and it is printed as loudly.
  if (surface.deployed === false) {
    facts.pending = true;
    return { facts, problems };
  }

  if (offline) return { facts, problems };

  // 3. LIVE — what the deployed server answers right now.
  let live = null;
  try {
    const { json } = await rpc(surface.url, 'tools/list');
    if (json.error) throw new Error(`tools/list returned ${json.error.code}: ${json.error.message}`);
    live = (json.result?.tools ?? []).map((t) => t.name);
    facts.live = live;
    compare('live', source, live, problems, surface.id);
  } catch (e) {
    problems.push({ surface: surface.id, kind: 'unreachable', where: surface.url, detail: `live tools/list failed: ${e.message}` });
  }

  // initialize: the server's own account of what it is. A name or a protocol
  // version that disagrees with the source is drift with a longer fuse — every
  // client caches the handshake.
  try {
    const { json } = await rpc(surface.url, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-integrity', version: '1' },
    });
    const info = json.result?.serverInfo ?? {};
    facts.serverInfo = { ...info, protocolVersion: json.result?.protocolVersion };
    if (info.name !== surface.serverName) {
      problems.push({ surface: surface.id, kind: 'identity', where: 'initialize',
        detail: `serverInfo.name is "${info.name}", expected "${surface.serverName}"` });
    }
  } catch (e) {
    problems.push({ surface: surface.id, kind: 'unreachable', where: surface.url, detail: `initialize failed: ${e.message}` });
  }

  // 4. LISTING — the machine-readable thing an agent discovers you through.
  facts.listings = [];
  for (const l of surface.listings) {
    if (l.kind === 'registry') {
      try {
        const r = await registryTools(l.name);
        facts.listings.push({ kind: 'registry', name: l.name, ...r });
        if (!r.found) {
          problems.push({ surface: surface.id, kind: 'registry', where: l.name,
            detail: 'no active entry in registry.modelcontextprotocol.io — agents cannot discover this surface' });
        } else if (r.status !== 'active') {
          problems.push({ surface: surface.id, kind: 'registry', where: l.name, detail: `registry status is "${r.status}"` });
        } else if (!r.remotes.includes(surface.url)) {
          problems.push({ surface: surface.id, kind: 'registry', where: l.name,
            detail: `registry points at ${r.remotes.join(', ') || '(nothing)'} — the live endpoint is ${surface.url}` });
        }
      } catch (e) {
        problems.push({ surface: surface.id, kind: 'registry', where: l.name, detail: `registry lookup failed: ${e.message}` });
      }
      continue;
    }
    try {
      const j = await getJson(l.url);
      const names = pluck(j, l.path);
      if (names === null) {
        problems.push({ surface: surface.id, kind: 'listing', where: l.url,
          detail: `${l.path} is absent — this listing publishes no tool list, so nothing can be diffed against it` });
        continue;
      }
      facts.listings.push({ kind: l.kind, url: l.url, tools: names });
      compare(`listing ${l.url}`, source, names, problems, surface.id);
      for (const n of surface.retired.filter((x) => names.includes(x))) {
        problems.push({ surface: surface.id, kind: 'zombie', where: l.url, tool: n, detail: 'retired tool still listed' });
      }
    } catch (e) {
      problems.push({ surface: surface.id, kind: 'listing', where: l.url, detail: `listing fetch failed: ${e.message}` });
    }
  }

  // 5. DOCS, live. The repo file and the served page are different objects and
  //    the gap between them is a deploy nobody ran.
  for (const doc of surface.docs.filter((d) => d.url)) {
    try {
      const text = await getText(doc.url);
      for (const n of source.filter((x) => !text.includes(x))) {
        problems.push({ surface: surface.id, kind: 'undocumented', where: doc.url, tool: n,
          detail: `published page ${doc.url} does not mention ${n}` });
      }
    } catch (e) {
      problems.push({ surface: surface.id, kind: 'docs', where: doc.url, detail: `docs fetch failed: ${e.message}` });
    }
  }

  // 6. SMOKE — the clause the other five cannot express. A tool can be in the
  //    source, served by the live server, present in the listing and written
  //    up in the docs, and still answer 522 to everyone who calls it.
  facts.smoke = [];
  for (const s of surface.smoke) {
    if (live && !live.includes(s.tool)) continue; // already reported as missing
    try {
      const { json } = await rpc(surface.url, 'tools/call', { name: s.tool, arguments: s.args }, {}, s.timeoutMs);
      const rpcError = !!json.error;
      // Unwrap the tool payload before judging it. MCP nests the result as a
      // JSON string inside content[].text, so `JSON.stringify(result)` gives
      // you doubly-escaped quotes and every pattern silently fails to match —
      // which would make this smoke test report healthy tools as broken and
      // get itself switched off within a week.
      const inner = json.result?.content?.map((c) => c?.text ?? '').join('\n') ?? '';
      let payload = null;
      try { payload = JSON.parse(inner); } catch { /* a tool may return prose */ }
      const text = inner || JSON.stringify(json.error ?? json.result ?? {});
      // "Broken" is the tool's own verdict, not a substring search: isError from
      // the transport, or an `error` key at the top level of its payload.
      const looksBroken = json.result?.isError === true
        || (payload !== null && typeof payload === 'object' && 'error' in payload);
      const matched = s.match ? s.match.test(text) : true;

      if (s.expect === 'refusal') {
        // A refusal is the pass. Serving data here would mean auth was removed.
        const refused = rpcError || looksBroken;
        facts.smoke.push({ tool: s.tool, expect: s.expect, ok: refused && matched });
        if (!refused) {
          problems.push({ surface: surface.id, kind: 'smoke', where: s.tool,
            detail: `expected an auth refusal and got a result — ${surface.auth} is no longer enforced` });
        } else if (!matched) {
          problems.push({ surface: surface.id, kind: 'smoke', where: s.tool,
            detail: `refused, but not in the documented way (${s.match}): ${text.slice(0, 200)}` });
        }
        continue;
      }

      const ok = !rpcError && !looksBroken && matched;
      facts.smoke.push({ tool: s.tool, expect: s.expect, ok });
      if (!ok) {
        problems.push({ surface: surface.id, kind: 'smoke', where: s.tool,
          detail: `advertised tool does not work: ${text.slice(0, 240)}` });
      }
    } catch (e) {
      facts.smoke.push({ tool: s.tool, expect: s.expect, ok: false });
      problems.push({ surface: surface.id, kind: 'smoke', where: s.tool, detail: `call threw: ${e.message}` });
    }
  }

  return { facts, problems };
}

/* ── report ─────────────────────────────────────────────────────────────── */
const KIND_LABEL = {
  source: 'SOURCE UNREADABLE',
  missing: 'MISSING FROM',
  extra: 'ADVERTISED, NOT IN SOURCE',
  undocumented: 'UNDOCUMENTED',
  zombie: 'RETIRED TOOL STILL ADVERTISED',
  listing: 'LISTING',
  registry: 'REGISTRY',
  docs: 'DOCS',
  identity: 'IDENTITY',
  unreachable: 'UNREACHABLE',
  smoke: 'ADVERTISED BUT BROKEN',
};

export async function run({ offline = false, only = null } = {}) {
  const surfaces = SURFACES.filter((s) => !only || s.id === only);
  if (!surfaces.length) throw new Error(`no surface named "${only}". Known: ${SURFACES.map((s) => s.id).join(', ')}`);
  const results = [];
  for (const s of surfaces) results.push(await checkSurface(s, { offline }));
  return results;
}

function print(results, { offline }) {
  const all = results.flatMap((r) => r.problems);
  console.log(`\nMCP integrity — ${offline ? 'offline (source ↔ repo docs)' : 'full (source ↔ live ↔ listing ↔ docs ↔ smoke)'}\n`);
  for (const { facts, problems } of results) {
    const bad = problems.length;
    console.log(`${bad ? '✘' : facts.pending ? '◌' : '✔'} ${facts.id}  ${facts.url}`);
    if (facts.pending) console.log('    PENDING DEPLOY — source and docs checked; live, listing and smoke cannot be.');
    console.log(`    owner   ${facts.owner}`);
    console.log(`    source  ${facts.source ? facts.source.length : '?'} tools: ${(facts.source ?? []).join(', ')}`);
    if (facts.live) console.log(`    live    ${facts.live.length} tools`);
    if (facts.serverInfo) {
      console.log(`    serves  name="${facts.serverInfo.name}" version="${facts.serverInfo.version}" protocol="${facts.serverInfo.protocolVersion}"`);
    }
    for (const l of facts.listings ?? []) {
      console.log(l.kind === 'registry'
        ? `    listing registry ${l.name} — ${l.found ? `${l.status} v${l.version} → ${l.remotes.join(', ')}` : 'NOT FOUND'}`
        : `    listing ${l.url} — ${l.tools.length} tools`);
    }
    for (const d of facts.docs ?? []) console.log(`    docs    ${d.file} — ${d.documented}/${d.of} tools named`);
    for (const s of facts.smoke ?? []) console.log(`    smoke   ${s.ok ? 'pass' : 'FAIL'}  ${s.tool} (expect ${s.expect})`);
    for (const p of problems) {
      console.log(`      → ${KIND_LABEL[p.kind] ?? p.kind}${p.tool ? ` [${p.tool}]` : ''}: ${p.detail}`);
      if (p.where && !p.detail.includes(p.where)) console.log(`        at ${p.where}`);
    }
    console.log('');
  }
  if (all.length) {
    console.log(`✘ ${all.length} integrity problem${all.length === 1 ? '' : 's'} across ${new Set(all.map((p) => p.surface)).size} surface(s).`);
    console.log('  Source, live, listing and docs must agree, and every advertised tool must answer.');
    console.log('  Procedure for fixing each failure mode: HQ/divisions/num/MCP_INTEGRITY.md\n');
  } else {
    console.log('✔ every surface agrees: source = live = listing = docs, and every advertised tool answered.\n');
  }
}

/**
 * Run only when invoked directly — and get this right, because the naive form
 * is a trap.
 *
 * `import.meta.url === \`file://${process.argv[1]}\`` is the idiom everyone
 * writes, and it is WRONG for any path containing a space: import.meta.url
 * percent-encodes the space as %20, argv[1] does not, the comparison fails,
 * and the script exits 0 having done absolutely nothing. Silent success — a
 * drift checker reporting "all clear" because it never ran. The sibling copy
 * of this file in the 5arz repo hit exactly that: it lives under
 * "Agents -  5arz" and the check was a no-op from the deploy gate, from CI,
 * and from every operator who typed the command and saw no complaint.
 *
 * app-main has no spaces in its path today. It is one `git worktree add` away
 * from having them.
 *
 * pathToFileURL alone is still not enough, and this is the second half of the
 * same trap. import.meta.url is always the REAL path — Node resolves symlinks
 * when it loads a module — while process.argv[1] is whatever was typed. On
 * macOS /tmp is a symlink to /private/tmp, so running the checker from /tmp
 * compared "file:///private/tmp/..." against "file:///tmp/..." and lost. Same
 * silent no-op, different cause. Resolve argv[1] before comparing.
 */
function invokedDirectly() {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    // argv[1] does not exist on disk (a loader shim, a bundled entry point).
    // Fall back to the unresolved comparison rather than refusing to run.
    return import.meta.url === pathToFileURL(argv).href;
  }
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const asJson = argv.includes('--json');
  const only = argv.find((a) => a.startsWith('--surface='))?.split('=')[1] ?? null;
  run({ offline, only })
    .then((results) => {
      const problems = results.flatMap((r) => r.problems);
      if (asJson) console.log(JSON.stringify({ offline, problems, surfaces: results.map((r) => r.facts) }, null, 2));
      else print(results, { offline });
      process.exit(problems.length ? 1 : 0);
    })
    .catch((e) => {
      // A checker that cannot run must never look like a checker that passed.
      console.error(`✘ mcp-integrity could not complete: ${e.message}`);
      process.exit(1);
    });
}

export { SURFACES, TIMEOUT_MS };
