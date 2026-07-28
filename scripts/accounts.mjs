#!/usr/bin/env node
/**
 * NUM · accounts admin CLI (writes to D1 num-db "accounts"/"businesses")
 * Mirrors scripts/products.mjs. Run from the num-console folder:
 *   node scripts/accounts.mjs list
 *   node scripts/accounts.mjs create someone@company.com --name "Owner Name" --role merchant --business "OnWay Media"
 *   node scripts/accounts.mjs email <account-id-prefix> someone@company.com
 *   node scripts/accounts.mjs invite <account-id-prefix>        (sends the magic-link email now, via Resend)
 *   node scripts/accounts.mjs status <account-id-prefix> active|disabled|pending_contact|invited
 *
 * Needs .resend_key in this folder (same file send_wave1.mjs uses) to send invites.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DB = 'num-db';
const q = (sql) => JSON.parse(execFileSync('npx', ['wrangler@latest','d1','execute',DB,'--remote','--json','--command',sql], {encoding:'utf8', stdio:['ignore','pipe','pipe']}))[0].results;
const esc = s => String(s??'').replaceAll("'","''");

const [,,cmd,...rest] = process.argv;
const opt = (name, def='') => { const i = rest.indexOf('--'+name); return i>=0 ? rest[i+1] : def; };

if (cmd === 'list') {
  const rows = q(`SELECT id, email, display_name, role, status, business_id, last_login_at FROM accounts ORDER BY created_at DESC`);
  if (!rows.length) console.log('No accounts yet.');
  else rows.forEach(r=>console.log(`${r.id.slice(0,8)}  ${(r.status||'').padEnd(15)} ${(r.role||'').padEnd(10)} ${r.email||'(no email)'}  — ${r.display_name||''}`));

} else if (cmd === 'create') {
  const email = rest[0] && rest[0].includes('@') ? rest[0].toLowerCase() : null;
  const role = opt('role','merchant');
  const name = opt('name','');
  const bizName = opt('business','');
  let businessId = null;
  if (bizName) {
    const existing = q(`SELECT id FROM businesses WHERE name='${esc(bizName)}' LIMIT 1`);
    if (existing.length) businessId = existing[0].id;
    else { businessId = randomUUID(); q(`INSERT INTO businesses (id, name, status, onboarded_by) VALUES ('${businessId}','${esc(bizName)}','active','cli')`); }
  }
  const id = randomUUID();
  q(`INSERT INTO accounts (id, email, display_name, role, permissions, business_id, status, invited_by) VALUES ('${id}',${email?`'${esc(email)}'`:'NULL'},'${esc(name)}','${esc(role)}','${esc(JSON.stringify([role]))}',${businessId?`'${businessId}'`:'NULL'},'pending_contact','cli')`);
  console.log(`✓ account created: ${id}${email?` (${email})`:' — no email yet, set one with: node scripts/accounts.mjs email '+id+' someone@company.com'}`);

} else if (cmd === 'email') {
  const idPrefix = rest[0], email = rest[1];
  if (!idPrefix || !email || !email.includes('@')) { console.log('Usage: node scripts/accounts.mjs email <id-prefix> someone@company.com'); process.exit(1); }
  q(`UPDATE accounts SET email='${esc(email.toLowerCase())}' WHERE id='${esc(idPrefix)}' OR id LIKE '${esc(idPrefix)}%'`);
  console.log(`✓ email set for ${idPrefix}`);

} else if (cmd === 'status') {
  const idPrefix = rest[0], status = rest[1];
  if (!['pending_contact','invited','active','disabled'].includes(status)) { console.log('status must be one of pending_contact|invited|active|disabled'); process.exit(1); }
  q(`UPDATE accounts SET status='${esc(status)}' WHERE id='${esc(idPrefix)}' OR id LIKE '${esc(idPrefix)}%'`);
  console.log(`✓ ${idPrefix} → ${status}`);

} else if (cmd === 'invite') {
  const idPrefix = rest[0];
  const rows = q(`SELECT id, email, display_name FROM accounts WHERE id='${esc(idPrefix)}' OR id LIKE '${esc(idPrefix)}%'`);
  if (!rows.length) { console.log('No matching account.'); process.exit(1); }
  const acc = rows[0];
  if (!acc.email) { console.log(`This account has no email yet. Set one first:\n  node scripts/accounts.mjs email ${acc.id} someone@company.com`); process.exit(1); }
  const token = randomUUID();
  const expires = new Date(Date.now()+15*60*1000).toISOString();
  q(`INSERT INTO magic_links (token, account_id, expires_at) VALUES ('${token}','${acc.id}','${expires}')`);
  const KEY = readFileSync('.resend_key','utf8').replace(/\s+/g,'');
  const link = `https://itsnum.com/api/accounts/verify?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ 'Authorization':'Bearer '+KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({
      from: 'Num by 5arz <info@5arz.com>', to:[acc.email], reply_to:'info@5arz.com',
      subject: 'Your Num sign-in link',
      html: `<p>Hi ${acc.display_name||'there'},</p><p><a href="${link}">Click here to sign in to Num</a></p><p>This link works once and expires in 15 minutes.</p>`,
    }),
  });
  const j = await res.json().catch(()=>({}));
  if (!res.ok) { console.log(`✗ Resend error ${res.status}: ${j.message||JSON.stringify(j).slice(0,140)}`); process.exit(1); }
  q(`UPDATE accounts SET status='invited' WHERE id='${acc.id}'`);
  console.log(`✓ invite sent to ${acc.email} (id ${j.id})`);

} else {
  console.log('Usage: node scripts/accounts.mjs list | create <email> --name X --role merchant --business "Name" | email <id> <addr> | invite <id> | status <id> <status>');
}
