/**
 * Render /agents/<client>/ — one page per MCP client, plus the index.
 *
 *   node scripts/pseo/genclients.mjs
 *
 * These pages are built to be READ BY A MACHINE as much as by a developer,
 * because the machine is increasingly the one doing the searching: somebody
 * asks Claude or ChatGPT "is there a travel places API I can plug in", and the
 * answer comes from whatever page states the endpoint plainly enough to quote.
 *
 * So each page carries SoftwareApplication and HowTo schema, states the URL,
 * the token prefix and the five tool names in visible text rather than only in
 * a code block, and says when it was last checked against the vendor's docs.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLIENTS, MCP_URL, SIGNUP, CHECKED } from './clients.mjs';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonld = (o) => JSON.stringify(o)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/** Steps carry a little trusted HTML (<code>, <b>) written in clients.mjs. */
const stepHtml = (s) => s;
const stepText = (s) => String(s).replace(/<[^>]*>/g, '');

const TOOLS = [
  ['num_search_places', 'search 2.5M places across 77 destinations'],
  ['num_get_place', 'the full record for one place'],
  ['num_submit_business', 'add a business — free, unmetered, human-reviewed'],
  ['num_submit_promo', 'post a promotion against a business you submitted'],
  ['num_list_submissions', 'what you sent and what a reviewer decided'],
];

const nav = `<nav class="nav"><div class="wrap row">
  <a class="brand" href="/"><span class="dot"></span>NUM <small>travel concierge</small></a>
  <div class="navlinks">
    <a href="/what-we-do/">What we do</a><a href="/how-it-works/">How it works</a>
    <a href="/agents/">For AI agents</a><a href="/business/">For business</a>
    <a class="btn pri" href="${SIGNUP}" style="padding:10px 18px;font-size:14px">Get a key</a>
  </div>
  <button class="menu-btn" aria-label="Menu">&#9776;</button>
</div></nav>`;

const CSS = `<style>.prose{max-width:74ch}.prose h2{margin-top:40px}
pre.code{background:#0d1b24;color:#d8e6ee;border-radius:14px;padding:18px;overflow-x:auto;
  font-size:13px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code.inl{background:var(--pri-xl,#f2f0ea);border:1px solid var(--line,#e0ddd4);border-radius:6px;
  padding:1px 6px;font-size:.92em;font-family:ui-monospace,Menlo,monospace}
.file{font-size:13px;color:var(--ink2);font-family:ui-monospace,Menlo,monospace;margin:0 0 6px}
ol.steps{padding-left:20px}ol.steps li{margin:10px 0;line-height:1.65}
table.tbl{width:100%;border-collapse:collapse;margin-top:18px;font-size:15px}
table.tbl td{padding:9px 10px;border-bottom:1px solid var(--line,#e0ddd4);vertical-align:top}
table.tbl td:first-child{font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:nowrap}
.also{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0;padding:0;list-style:none}
.also a{font-size:14px;text-decoration:none;border:1px solid var(--line,#e0ddd4);border-radius:999px;padding:6px 14px}
.checked{font-size:13px;color:var(--ink2);border-left:3px solid var(--line,#e0ddd4);padding-left:12px;margin-top:26px}</style>`;

function clientPage(c, others) {
  const title = `Connect NUM to ${c.name} — MCP server for travel places`;
  const path = `/agents/${c.slug}/`;
  const desc = `Add NUM's travel places MCP server to ${c.name}: ${MCP_URL}, bearer token, five tools over 2,529,721 places in 77 destinations.`;

  const graph = [
    {
      '@type': 'HowTo',
      name: `Connect NUM's MCP server to ${c.name}`,
      description: desc,
      tool: [{ '@type': 'HowToTool', name: c.name }],
      step: c.steps.map((s, i) => ({
        '@type': 'HowToStep', position: i + 1, name: stepText(s).slice(0, 90), text: stepText(s),
      })),
    },
    {
      '@type': 'SoftwareApplication',
      name: 'NUM MCP server',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any',
      url: MCP_URL,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': 'https://itsnum.com/#organization' },
    },
    {
      '@type': 'WebPage',
      '@id': `https://itsnum.com${path}#webpage`,
      url: `https://itsnum.com${path}`,
      name: title, description: desc,
      isPartOf: { '@id': 'https://itsnum.com/#website' },
      inLanguage: 'en', datePublished: CHECKED, dateModified: CHECKED,
    },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — NUM</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://itsnum.com${path}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta property="og:type" content="article"><meta property="og:site_name" content="NUM">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://itsnum.com${path}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">${jsonld({ '@context': 'https://schema.org', '@graph': graph })}</script>
<script src="/num-capture.js" data-page="agents-${esc(c.slug)}" defer></script>
${CSS}
</head>
<body>
${nav}
<header class="wrap" style="padding-top:56px;padding-bottom:8px">
  <span class="pill">&#10022; ${esc(c.vendor)} &middot; checked ${esc(CHECKED)}</span>
  <h1 class="h1" style="margin-top:18px;max-width:20ch">NUM in ${esc(c.name)}.</h1>
  <p class="sub" style="max-width:64ch">${c.lede}</p>
</header>
<section class="wrap prose">

<h2>What you are connecting to</h2>
<p>NUM is a directory of <b>2,529,721 real places across 77 destinations in 38 countries</b> —
restaurants, bars, hotels, spas, tours, shops — run by 5arz. The MCP server is at
<code class="inl">${MCP_URL}</code>. It speaks streamable HTTP and authenticates with a bearer
token that starts <code class="inl">numa_live_</code>. Reads are metered against a daily quota;
writes are free.</p>

<table class="tbl"><tbody>
${TOOLS.map(([t, d]) => `  <tr><td>${esc(t)}</td><td>${esc(d)}</td></tr>`).join('\n')}
</tbody></table>

<h2>Get a token first</h2>
<p>An agent signs itself up — there is no sales call and no waiting list.
POST to <code class="inl">${SIGNUP}</code>, or read the
<a href="/agents/">full contract</a> and the <a href="/openapi.json">OpenAPI spec</a>.</p>

<h2>Then, in ${esc(c.name)}</h2>
${c.file ? `<p class="file">${esc(c.file)}</p>` : ''}
${c.config ? `<pre class="code">${esc(c.config)}</pre>` : ''}
<ol class="steps">
${c.steps.map((s) => `  <li>${stepHtml(s)}</li>`).join('\n')}
</ol>
${c.note ? `<p>${c.note}</p>` : ''}

<h2>What an agent may and may not do</h2>
<p>Anything an agent submits — a business, a promotion — is <b>stored and held</b>, and a person at
5arz reviews it before a traveller sees any of it. Nothing goes live automatically. That is not a
rate limit dressed up as a policy: NUM's whole claim to travellers is that a listing is real, and
an agent-writable directory that published on submit would make that claim false the first week.</p>
<p>Placement cannot be bought, by an agent or by anyone. Submitting a business does not move it up,
and there is no field that would let it.</p>

<div class="checked">Written for ${esc(c.name)} and checked against
<a href="${esc(c.docs)}" rel="noopener">${esc(c.vendor)}'s own documentation</a> on ${esc(CHECKED)}.
Clients move their config files; if this path has changed, the two things that have not are the
server address and the bearer token. Tell us at
<a href="mailto:info@itsnum.com">info@itsnum.com</a> and we will fix the page.</div>

<h2>Other clients</h2>
<ul class="also">
${others.map((o) => `  <li><a href="/agents/${esc(o.slug)}/">${esc(o.name)}</a></li>`).join('\n')}
  <li><a href="/agents/">All of it, in one page</a></li>
</ul>
</section>
<footer class="wrap" style="padding:48px 0;color:var(--ink2);font-size:14px">
  &copy; 2026 NUM &middot; by 5arz &nbsp;&middot;&nbsp;
  <a href="/agents/">For AI agents</a> &nbsp;&middot;&nbsp;
  <a href="/for-ai/">Facts for answer engines</a> &nbsp;&middot;&nbsp;
  <a href="/llms.txt">llms.txt</a>
</footer>
</body>
</html>
`;
}

function main() {
  let n = 0;
  for (const c of CLIENTS) {
    const others = CLIENTS.filter((o) => o.slug !== c.slug);
    const dir = `${PUBLIC}agents/${c.slug}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/index.html`, clientPage(c, others));
    console.log(`  built  /agents/${c.slug}/`);
    n++;
  }
  console.log(`\n${n} client pages`);
}

if (process.argv[1] && process.argv[1].endsWith('genclients.mjs')) main();
export { clientPage };
