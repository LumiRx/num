#!/usr/bin/env node
/**
 * NUM · wave-1 invite sender — via Resend (api.resend.com)
 * Setup (once):
 *   1. resend.com → sign up → Domains → Add "5arz.com" → add the DNS records it shows
 *      into Cloudflare (zone 5arz.com) → wait for "Verified".
 *   2. API Keys → Create → copy, then save it without it touching chat/history:
 *        cd ~/Downloads/num-console
 *        read -rs "T?Paste Resend API key, then Enter: " && printf '%s' "$T" > .resend_key && chmod 600 .resend_key && echo "" && echo saved
 * Test:  node scripts/send_wave1.mjs --test          → one email to TEST_TO
 * Send:  node scripts/send_wave1.mjs --send          → all 153, resumable
 *        (Resend free tier = 100/day → script stops cleanly at the limit; re-run
 *         tomorrow and it continues where it left off, or upgrade and re-run now.)
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const FROM     = 'Num by 5arz <info@5arz.com>';   // domain must be Verified in Resend
const REPLY_TO = 'info@5arz.com';
const TEST_TO  = 'andre@thatislumi.com';          // where the --test email goes
const DELAY_MS = 1200;

const mode = process.argv[2];
if (!['--test','--send'].includes(mode)) { console.log('Usage: node scripts/send_wave1.mjs --test | --send'); process.exit(1); }
const KEY = readFileSync('.resend_key','utf8').replace(/\s+/g,'');

const template = readFileSync('campaign/invite_email.html','utf8');
const fill = r => template.replaceAll('{{business_name}}', r.business_name).replaceAll('{{personal_open}}', r.personal_open);

function parseCSV(text){
  const rows=[]; let cur=[''], inQ=false, out=[];
  for (let i=0;i<text.length;i++){ const c=text[i];
    if (inQ){ if (c==='"'){ if (text[i+1]==='"'){ cur[cur.length-1]+='"'; i++; } else inQ=false; } else cur[cur.length-1]+=c; }
    else if (c==='"') inQ=true;
    else if (c===',') cur.push('');
    else if (c==='\n'){ rows.push(cur); cur=['']; }
    else if (c!=='\r') cur[cur.length-1]+=c;
  }
  if (cur.length>1||cur[0]) rows.push(cur);
  const head = rows[0].map(h=>h.replace(/^﻿/,'').trim());
  for (let r=1;r<rows.length;r++){ const o={}; head.forEach((h,i)=>o[h]=rows[r][i]??''); out.push(o); }
  return out;
}
const rows = parseCSV(readFileSync('campaign/email_campaign_wave1.csv','utf8')).filter(r=>r.email&&r.email.includes('@'));

const LOG = 'campaign/sent_log.csv';
const sent = new Set(existsSync(LOG) ? readFileSync(LOG,'utf8').split('\n').map(l=>l.split(',')[0]) : []);
if (!existsSync(LOG)) writeFileSync(LOG,'');

async function sendOne(to, row){
  const res = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ 'Authorization':'Bearer '+KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({
      from: FROM, to: [to], reply_to: REPLY_TO,
      subject: `${row.business_name} — travelers are already asking about you 🌺`,
      html: fill(row),
    }),
  });
  const j = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(`${res.status} ${j.name||''}: ${j.message||JSON.stringify(j).slice(0,140)}`);
  return j.id;
}

if (mode === '--test') {
  const id = await sendOne(TEST_TO, rows[0]);
  console.log(`✓ TEST sent to ${TEST_TO} (id ${id}) using "${rows[0].business_name}" — check inbox AND spam, then run --send`);
} else {
  const todo = rows.filter(r=>!sent.has(r.email));
  console.log(`Sending to ${todo.length} businesses (${rows.length-todo.length} already sent)`);
  let n=0, stop=false;
  for (const row of todo){
    if (stop) break;
    try {
      await sendOne(row.email, row);
      appendFileSync(LOG, `${row.email},${row.business_name.replaceAll(',',' ')},${new Date().toISOString()}\n`);
      console.log(`  ✓ ${++n}/${todo.length}  ${row.business_name} <${row.email}>`);
    } catch(e){
      const msg = String(e.message||e);
      if (/429|quota|limit/i.test(msg)) { console.log(`\n⏸  Rate/daily limit hit (${msg.slice(0,100)}) — progress saved. Re-run --send later to continue.`); stop=true; }
      else console.log(`  ✗ FAILED ${row.email}: ${msg.slice(0,120)}`);
    }
    if (!stop && n<todo.length) await new Promise(r=>setTimeout(r, DELAY_MS));
  }
  console.log(`\n✅ session done — ${n} sent this run · log: ${LOG}`);
}
