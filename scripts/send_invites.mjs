#!/usr/bin/env node
/**
 * NUM — daily invite runner
 * =========================
 * Picks the day's batch out of D1, generates a personalised invite for each
 * business, and (only with --send) posts them through Resend.
 *
 * Nothing is sent unless you type --send. Default is --preview.
 *
 *   node scripts/send_invites.mjs --preview                 # 5 drafts to read, no D1 writes
 *   node scripts/send_invites.mjs --dry-run --limit=80      # full batch, still nothing sent
 *   node scripts/send_invites.mjs --send    --limit=80      # for real
 *
 * Filters:
 *   --country=GB[,IE]    --dest=phuket     --category=Restaurant
 *   --tier=ok|care|hold  jurisdiction tier ceiling (default: ok)
 *   --limit=N            hard cap for the run (default: 80)
 *
 * Safety rails, all of them on by default:
 *   · one row in num_invites per recipient, written BEFORE the send
 *   · never emails an address already in num_invites or num_suppressions
 *   · never emails an address in campaign/sent_log.csv (wave 1's ~150)
 *   · one address per domain per run — no blasting 12 inboxes at one hotel group
 *   · never emails the wrong audience — churches, hospitals, banks, town halls
 *   · stops the whole run on the first 429 / quota error, progress kept
 *   · --tier=ok excludes DE/AT/IT until counsel signs the copy off
 *
 * Requires: .resend_key (chmod 600, never printed) and wrangler auth.
 *   read -rs "T?Paste Resend API key, then Enter: " && printf '%s' "$T" > .resend_key && chmod 600 .resend_key && echo "" && echo saved
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { generateInvite, riskOf, excludeReason, normaliseCategory } from './invite_gen.mjs';

/* ── config ─────────────────────────────────────────────────────────────── */

const FROM      = 'Num by 5arz <info@5arz.com>';
const REPLY_TO  = 'info@5arz.com';
const DB        = 'num-db';
const TEMPLATE  = 'campaign/invite_v2.html';
const SENT_LOG  = 'campaign/sent_log.csv';   // wave 1, pre-ledger
const OUT_DIR   = 'campaign/previews';
const SHEET     = 'campaign/invite_approval_sheet.html';
const DELAY_MS  = 1300;
const TIER_RANK = { ok: 0, care: 1, hold: 2 };

/* One-address-per-domain stops us mailing twelve inboxes at one hotel group.
   It must NOT apply to freemail: 3,287 of the businesses on this list run on
   gmail alone, and treating those as one organisation would send exactly one
   of them and silently skip the rest — forever, since the skipped ones never
   enter the ledger and so come back unchanged on every future run. */
const FREEMAIL = new Set([
  // global
  'gmail','googlemail','hotmail','outlook','live','msn','yahoo','ymail','rocketmail',
  'aol','icloud','me','mac','protonmail','proton','tutanota','zoho','fastmail','mail','email','gmx',
  // DE / AT / CH
  'web','t-online','freenet','arcor','bluewin','sunrise','hispeed','aon','utanet','chello','a1',
  // FR
  'orange','wanadoo','free','laposte','sfr','neuf','bbox',
  // IT
  'libero','virgilio','alice','tiscali','tin','fastwebnet','inwind',
  // CZ / HU / HR
  'seznam','centrum','volny','atlas','email','freemail','citromail','net','vip',
  // PT / ES
  'sapo','clix','netcabo','iol','telefonica','terra',
  // NL / BE
  'ziggo','kpnmail','hetnet','planet','telenet','skynet','home',
  // SE / DK / IS / NO
  'telia','bredband','comhem','spray','bahnhof','simnet','internet',
  // GB / IE
  'btinternet','sky','virginmedia','talktalk','ntlworld','blueyonder','eircom',
  // APAC
  'naver','daum','hanmail','qq','163','126','sina','foxmail','bigpond','xtra',
]);

/** gmail.com, hotmail.co.uk, t-online.de → true. accor.com, auchan.pt → false. */
const isFreemail = d => FREEMAIL.has(String(d || '').toLowerCase().split('.')[0]);

/* ── args ───────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const has  = f => argv.includes(f);
const val  = (f, d) => { const a = argv.find(x => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : d; };

const MODE  = has('--send') ? 'send' : has('--dry-run') ? 'dry' : 'preview';
const LIMIT = Math.max(1, parseInt(val('--limit', MODE === 'preview' ? '5' : '80'), 10));
const TIER  = val('--tier', 'ok');
const BATCH = val('--batch', `${new Date().toISOString().slice(0, 10)}-${TIER}`);

if (!(TIER in TIER_RANK)) { console.error(`--tier must be ok|care|hold`); process.exit(1); }
if (has('--spread') && has('--send')) {
  console.error(`--spread is a sampler for approval runs, not a send list. Drop one of them.`);
  process.exit(1);
}
const tierCeiling = TIER_RANK[TIER];

/* ── D1 helpers (wrangler shells out; no API token needed) ──────────────── */

function d1(sql) {
  const out = execFileSync('npx', [
    'wrangler@latest', 'd1', 'execute', DB, '--remote', '--json', '--command', sql,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

function d1File(sql, label) {
  const path = `.invite_write_${label}.sql`;
  writeFileSync(path, sql);
  execFileSync('npx', [
    'wrangler@latest', 'd1', 'execute', DB, '--remote', '--file', path, '-y',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

const q = s => `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;

/* ── candidate selection ────────────────────────────────────────────────── */

const where = [`l.email IS NOT NULL`, `l.email <> ''`, `l.email LIKE '%@%'`];

const countries = (val('--country', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (countries.length) where.push(`upper(l.country) IN (${countries.map(q).join(',')})`);

const dest = val('--dest', '');
if (dest) where.push(`lower(l.dest) = ${q(dest.toLowerCase())}`);

const category = val('--category', '');
if (category) where.push(`l.category = ${q(category)}`);

/* --spread takes one business per category instead of the next N in priority
   order. Useless for a real send; the point of an approval run is to show the
   generator's range, and priority order clusters hard — eight London cafés
   proves nothing about what a museum or a takeaway receives. */
const SPREAD = has('--spread');

const SQL = SPREAD ? `
SELECT id, name, category, dest, area, country, email, website, address FROM (
  SELECT l.id, l.name, l.category, l.dest, l.area, l.country, l.email, l.website, l.address,
         ROW_NUMBER() OVER (PARTITION BY l.category
                            ORDER BY (l.priority IS NULL), l.priority, l.name) AS rn
  FROM leads l
  LEFT JOIN num_invites     i ON lower(i.email) = lower(l.email)
  LEFT JOIN num_suppressions s ON lower(s.email) = lower(l.email)
  WHERE ${where.join(' AND ')} AND i.token IS NULL AND s.email IS NULL
) WHERE rn <= 2 ORDER BY category, rn`.replace(/\s+/g, ' ').trim() : `
SELECT l.id, l.name, l.category, l.dest, l.area, l.country, l.email, l.website, l.address
FROM leads l
LEFT JOIN num_invites     i ON lower(i.email) = lower(l.email)
LEFT JOIN num_suppressions s ON lower(s.email) = lower(l.email)
WHERE ${where.join(' AND ')}
  AND i.token IS NULL
  AND s.email IS NULL
ORDER BY (l.priority IS NULL), l.priority, l.name
LIMIT ${LIMIT * 12}`.replace(/\s+/g, ' ').trim();

console.log(`\nNUM invite runner — mode: ${MODE.toUpperCase()}  tier: ${TIER}  limit: ${LIMIT}  batch: ${BATCH}\n`);
console.log('Selecting candidates from D1…');

let rows = d1(SQL);
console.log(`  ${rows.length} rows back from D1 (before local filters)`);

/* ── local filters ──────────────────────────────────────────────────────── */

// wave 1 (pre-ledger) — belt and braces
const wave1 = new Set();
if (existsSync(SENT_LOG)) {
  for (const line of readFileSync(SENT_LOG, 'utf8').split('\n')) {
    const e = line.split(',')[0]?.trim().toLowerCase();
    if (e && e.includes('@')) wave1.add(e);
  }
}

const seenEmail = new Set();
const seenDomain = new Set();
const seenCat = new Set();
const batch = [];
const skipped = { tier: 0, wave1: 0, dupe: 0, domain: 0, bad: 0, excluded: 0 };
const excludedWhy = {};

for (const r of rows) {
  /* A spread run must see every category before it decides which to show,
     so it collects the lot and ranks afterwards. Breaking at LIMIT here
     hands the sheet to whatever the SQL sorted first — which is the
     alphabet, and the alphabet gives Bath's antique shops, not its hotels. */
  if (!SPREAD && batch.length >= LIMIT) break;
  const email = String(r.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) { skipped.bad++; continue; }

  // Wrong audience entirely — churches, hospitals, banks, town halls. A pitch
  // about booking commission does not belong in those inboxes, and complaints
  // from them would cost us the sending domain.
  const why = excludeReason(r);
  if (why) { skipped.excluded++; excludedWhy[why] = (excludedWhy[why] || 0) + 1; continue; }

  const risk = riskOf(r.country);
  if (TIER_RANK[risk] > tierCeiling) { skipped.tier++; continue; }
  if (wave1.has(email))              { skipped.wave1++; continue; }
  if (seenEmail.has(email))          { skipped.dupe++; continue; }

  const domain = email.split('@')[1];
  if (!isFreemail(domain) && seenDomain.has(domain)) { skipped.domain++; continue; }

  /* Dedupe on the NORMALISED category, not the raw D1 string. "Restaurant",
     "Italian Restaurant" and "Asian Fusion Restaurant" are three labels for one
     piece of copy, and a sheet showing all three proves nothing. What marketing
     needs to see is the range of what the generator WRITES. */
  if (SPREAD) {
    const key = normaliseCategory(r.category) || `raw:${String(r.category || '').toLowerCase()}`;
    if (seenCat.has(key)) continue;
    seenCat.add(key);
  }

  seenEmail.add(email); seenDomain.add(domain);
  batch.push({ ...r, email, risk });
}

/* Lead the sheet with the categories the business actually lives on, then let
   the long tail follow, and cut at LIMIT only once that ranking exists. A
   reviewer who opens this and sees an antique shop and a badminton court
   before a single restaurant will close it. */
if (SPREAD) {
  const SHOWCASE = ['Restaurant','Hotel','Café','Bar','Street food','Beauty & spa','Attraction',
    'Museum','Tours & travel','Bakery','Guesthouse','Apartment','Shopping','Market','Theatre',
    'Gym & fitness','Transport','Bike rental','Deli','Dessert','Gallery','Pharmacy','Vehicle rental'];
  const rank = l => { const i = SHOWCASE.indexOf(normaliseCategory(l.category)); return i < 0 ? 99 : i; };
  batch.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
  batch.length = Math.min(batch.length, LIMIT);
}

console.log(`  ${batch.length} selected · skipped: ${skipped.tier} above tier, ${skipped.wave1} in wave 1, ` +
            `${skipped.dupe} duplicate, ${skipped.domain} same domain, ${skipped.bad} malformed, ` +
            `${skipped.excluded} wrong audience`);
if (skipped.excluded) {
  console.log(`    wrong audience breakdown: ` +
    Object.entries(excludedWhy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
}
console.log('');

if (!batch.length) { console.log('Nothing to send. Try a wider --tier or different --country.\n'); process.exit(0); }


/* ── generate ───────────────────────────────────────────────────────────── */

const template = readFileSync(TEMPLATE, 'utf8');
const drafts = batch.map(lead => {
  const token = randomUUID();
  return { lead, token, draft: generateInvite(lead, { template, token }) };
});

/* ── preview mode: write drafts to disk, stop ───────────────────────────── */

if (MODE === 'preview') {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const index = [];
  for (const { lead, draft } of drafts) {
    const slug = String(lead.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44);
    writeFileSync(`${OUT_DIR}/${slug}.html`, draft.html);
    index.push(`${slug}.html`);
    console.log('─'.repeat(74));
    console.log(`TO      ${lead.email}   (${lead.name} · ${lead.category} · ${lead.country} · ${lead.risk})`);
    console.log(`SUBJECT ${draft.subject}`);
    console.log(`OPEN    ${draft.personal_open}`);
    console.log(`ASK     "${draft.traveller_ask}"`);
    console.log(`REPLY   "${draft.num_reply}"`);
  }
  console.log('─'.repeat(74));
  console.log(`\n${index.length} drafts written to ${OUT_DIR}/ — open them in a browser.`);

  /* One file marketing can actually sign off. Every draft rendered exactly as it
     would land, side by side, with the machine-written lines called out above
     each — because what marketing is approving is not one email, it is the
     generator's range across categories. A single good sample proves nothing. */
  writeFileSync(SHEET, approvalSheet(drafts));
  console.log(`Approval sheet: ${SHEET}`);
  console.log(`Nothing was sent and nothing was written to D1.\n`);
  process.exit(0);
}

/* ── claim the batch in D1 before sending anything ──────────────────────── */

const claimSql = drafts.map(({ lead, token, draft }) =>
  `INSERT INTO num_invites (token, lead_id, email, business_name, category, dest, country, risk, subject, batch, status) VALUES (` +
  [token, lead.id, lead.email, lead.name, lead.category, lead.dest, lead.country, lead.risk, draft.subject, BATCH, 'queued']
    .map(q).join(',') + `);`
).join('\n');

if (MODE === 'dry') {
  writeFileSync('.invite_dryrun.sql', claimSql);
  console.log(`DRY RUN — ${drafts.length} invites generated.`);
  console.log(`The exact D1 rows that would be written are in .invite_dryrun.sql`);
  console.log(`Sample subject: ${drafts[0].draft.subject}`);
  console.log(`No email sent, no D1 write.\n`);
  process.exit(0);
}

/* ── send ───────────────────────────────────────────────────────────────── */

const KEY = readFileSync('.resend_key', 'utf8').replace(/\s+/g, '');
if (!KEY) { console.error('.resend_key is empty'); process.exit(1); }

console.log('Claiming batch in D1…');
d1File(claimSql, 'claim');
console.log(`  ${drafts.length} rows queued.\n`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let stop = false, ok = 0, bad = 0;

for (const { lead, token, draft } of drafts) {
  if (stop) break;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: lead.email,
        reply_to: REPLY_TO,
        subject: draft.subject,
        html: draft.html,
        text: draft.text,
        headers: {
          'List-Unsubscribe': `<${draft.fields.unsub_url}>, <mailto:info@5arz.com?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${body?.message || JSON.stringify(body).slice(0, 160)}`);

    results.push(`UPDATE num_invites SET status='sent', sent_at=datetime('now'), provider_id=${q(body.id || '')} WHERE token=${q(token)};`);
    ok++;
    console.log(`  ✓ ${lead.email.padEnd(38)} ${lead.name.slice(0, 30)}`);
  } catch (e) {
    const msg = e.message || String(e);
    results.push(`UPDATE num_invites SET status='failed', error=${q(msg.slice(0, 300))} WHERE token=${q(token)};`);
    bad++;
    console.log(`  ✗ ${lead.email.padEnd(38)} ${msg.slice(0, 70)}`);
    if (/429|quota|limit|rate/i.test(msg)) {
      console.log(`\n⏸  Daily/rate limit hit. Stopping here — everything already sent is recorded.`);
      console.log(`   Un-sent rows stay 'queued'; re-run tomorrow and they are picked up first.`);
      stop = true;
    }
  }
  if (!stop) await sleep(DELAY_MS);
}

console.log('\nWriting results back to D1…');
if (results.length) d1File(results.join('\n'), 'result');

console.log(`\nDone. ${ok} sent, ${bad} failed, ${drafts.length - ok - bad} left queued.`);
console.log(`Batch: ${BATCH}\n`);

/* ── approval sheet ─────────────────────────────────────────────────────── */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Marketing's sign-off artefact: every draft in this run, rendered live in an
 * iframe exactly as the recipient's mail client will draw it, with the four
 * machine-written sentences printed above it so a reviewer can read the copy
 * without squinting at a 600px email. Self-contained — no network, no assets.
 */
function approvalSheet(drafts) {
  const cards = drafts.map(({ lead, draft }, i) => `
  <section class="card">
    <header class="hd">
      <div class="n">${esc(lead.name)}</div>
      <div class="tags">
        <span class="t">${esc(lead.category || 'uncategorised')}</span>
        <span class="t">${esc(lead.dest || '')}</span>
        <span class="t">${esc(lead.country || '')}</span>
        <span class="t tier-${esc(lead.risk)}">${esc(lead.risk)}</span>
      </div>
    </header>
    <div class="copy">
      <div class="row"><span class="k">Subject</span><span class="v strong">${esc(draft.subject)}</span></div>
      <div class="row"><span class="k">Opening</span><span class="v">${esc(draft.personal_open)}</span></div>
      <div class="row"><span class="k">Ask</span><span class="v q">“${esc(draft.traveller_ask)}”</span></div>
      <div class="row"><span class="k">NUM reply</span><span class="v q">“${esc(draft.num_reply)}”</span></div>
      <div class="row"><span class="k">Sign-off</span><span class="v">${esc(draft.sign_off)}</span></div>
    </div>
    <div class="frame"><iframe loading="lazy" title="${esc(lead.name)} — rendered invite"
      srcdoc="${esc(draft.html)}"></iframe></div>
  </section>`).join('\n');

  const tierCount = drafts.reduce((a, d) => (a[d.lead.risk] = (a[d.lead.risk] || 0) + 1, a), {});
  const tiers = Object.entries(tierCount).map(([k, v]) => `${v} ${k}`).join(' · ');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NUM business invite — for marketing approval</title>
<style>
  :root{--ink:#181B3C;--mut:#5E6485;--line:#E2E5F3;--bg:#F5F6FC;--ind:#6366F1}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);padding:32px 20px 64px;
       font-family:'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
  .wrap{max-width:1080px;margin:0 auto}
  .top{background:#fff;border:1px solid var(--line);border-radius:18px;padding:28px 30px;margin-bottom:26px}
  .m{font-family:Georgia,serif;font-style:italic;font-weight:700;font-size:22px;color:#4A4F86}
  h1{margin:12px 0 8px;font-size:26px;letter-spacing:-.02em}
  p{margin:0 0 12px;font-size:15px;line-height:1.65;color:var(--mut);max-width:74ch}
  .meta{font-size:13px;color:var(--mut);border-top:1px solid var(--line);margin-top:18px;padding-top:14px}
  .card{background:#fff;border:1px solid var(--line);border-radius:18px;margin-bottom:26px;overflow:hidden}
  .hd{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;
      padding:18px 22px;border-bottom:1px solid var(--line)}
  .n{font-size:18px;font-weight:800;letter-spacing:-.01em}
  .tags{display:flex;gap:6px;flex-wrap:wrap}
  .t{font-size:11.5px;font-weight:600;color:var(--mut);background:#EEF0FA;border-radius:999px;padding:4px 11px}
  .tier-ok{background:#E4F7EC;color:#1B7A46}
  .tier-care{background:#FFF3DC;color:#8A5B00}
  .tier-hold{background:#FDE7E7;color:#A32020}
  .copy{padding:18px 22px;border-bottom:1px solid var(--line);background:#FCFCFF}
  .row{display:flex;gap:14px;padding:6px 0;font-size:14px;line-height:1.6}
  .k{flex:0 0 92px;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
     color:#9AA0C4;padding-top:3px}
  .v{flex:1;color:#3C4166}
  .v.strong{font-weight:700;color:var(--ink)}
  .v.q{font-style:italic;color:#4A4F86}
  .frame{background:#EEF0FA;padding:20px}
  iframe{width:100%;height:1180px;border:0;border-radius:12px;background:#EEF0FA;display:block}
  @media(max-width:640px){.k{flex-basis:74px}.row{flex-direction:column;gap:2px}}
</style></head><body><div class="wrap">
  <div class="top">
    <div class="m">NuM</div>
    <h1>Business invite — for marketing approval</h1>
    <p>Every email below was written by the generator, not by hand. Each business gets its
       own subject line, opening, sample traveller question and sample NUM reply, chosen
       from the category it trades in and fixed to its record — so regenerating a draft
       tomorrow produces the same words you approve today.</p>
    <p>What is being approved is the <strong>range</strong>, not one sample: whether the machine
       writes something a restaurant, a hotel, a takeaway and a museum would each recognise
       as being about them. Read the five lines above each render, then the render itself.</p>
    <div class="meta">${drafts.length} drafts · ${esc(tiers)} · generated from live records ·
      nothing sent, nothing written to the database</div>
  </div>
${cards}
</div></body></html>`;
}
