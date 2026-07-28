#!/usr/bin/env node
/**
 * NUM · corrections desk — review guest/field reports stored in D1 (num-db)
 * Run from the num-console folder:
 *   node scripts/corrections.mjs               → list pending reports (also saves corrections_pending.csv)
 *   node scripts/corrections.mjs approve 12    → mark #12 approved
 *   node scripts/corrections.mjs reject 12     → mark #12 rejected
 *   node scripts/corrections.mjs stats         → referral & stars overview
 * After approving, make the actual field edits in the console (HQ → Changes) or
 * hand the list to the ground team — publishing to directory.json stays via apply_edits.mjs.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const DB = 'num-db';
const q = (sql) => JSON.parse(execFileSync('npx', ['wrangler@latest','d1','execute',DB,'--remote','--json','--command',sql], {encoding:'utf8', stdio:['ignore','pipe','pipe']}))[0].results;

const [,,cmd,arg] = process.argv;

if (cmd === 'approve' || cmd === 'reject') {
  if (!/^\d+$/.test(arg||'')) { console.log(`Usage: node scripts/corrections.mjs ${cmd} <id>`); process.exit(1); }
  q(`UPDATE corrections SET state='${cmd==='approve'?'approved':'rejected'}', reviewed_at=datetime('now') WHERE id=${arg}`);
  console.log(`✓ #${arg} ${cmd}d`);
} else if (cmd === 'stats') {
  const [u] = q(`SELECT count(*) AS users FROM users`);
  const [r] = q(`SELECT count(*) AS refs FROM referrals`);
  const drv = q(`SELECT code, name, stars, (SELECT count(*) FROM referrals WHERE referrals.code=drivers.code) AS referred FROM drivers WHERE activated_at IS NOT NULL OR stars>0 ORDER BY stars DESC`);
  const [c] = q(`SELECT count(*) AS pending FROM corrections WHERE state='pending'`);
  console.log(`👥 users: ${u.users} · 🔗 referrals: ${r.refs} · 📝 pending corrections: ${c.pending}\n`);
  if (drv.length) { console.log('Top drivers:'); drv.forEach(d=>console.log(`  ${d.code}${d.name?' ('+d.name+')':''} — ⭐${d.stars} · ${d.referred} referred`)); }
  else console.log('No active drivers yet.');
} else {
  const rows = q(`SELECT id, COALESCE(biz_name,'') AS biz, detail, source, reporter, created_at FROM corrections WHERE state='pending' ORDER BY id`);
  if (!rows.length) { console.log('✨ No pending corrections.'); process.exit(0); }
  console.log(`${rows.length} pending report(s):\n`);
  rows.forEach(r=>console.log(`#${r.id} [${r.source}] ${r.created_at}\n   ${r.detail}\n`));
  const esc = v => /[",\n]/.test(String(v)) ? '"'+String(v).replace(/"/g,'""')+'"' : String(v);
  writeFileSync('corrections_pending.csv', 'id,biz,detail,source,reporter,created_at\n' +
    rows.map(r=>[r.id,r.biz,r.detail,r.source,r.reporter,r.created_at].map(esc).join(',')).join('\n'));
  console.log('Saved corrections_pending.csv · approve with: node scripts/corrections.mjs approve <id>');
}
