#!/usr/bin/env node
/**
 * NUM · publish ground-team corrections into the master dataset
 * Inputs (place in the num-console folder):
 *   directory_edits.json        — downloaded from HQ → Changes (only "approved" entries publish)
 *   verification_report.json    — optional, from Field team → Reports (statuses)
 * Applies to: public/console/directory.json  → then deploy.
 * Run:  node scripts/apply_edits.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const dir = JSON.parse(readFileSync('public/console/directory.json','utf8'));
const map = new Map(dir.businesses.map(b => [b.name, b]));
const FIELDS = { name:'name', name_th:'name_th', address:'address', phone:'phone',
                 email:'email', website:'website', hours:'hours', cuisine:'cuisine' };

let applied = 0, skipped = 0;
if (existsSync('directory_edits.json')) {
  const ed = JSON.parse(readFileSync('directory_edits.json','utf8'));
  for (const e of (ed.edits||[]).slice().reverse()) {           // oldest first
    if (e.state !== 'approved') { skipped++; continue; }
    const b = map.get(e.biz); const f = FIELDS[e.field];
    if (!b || !f) { skipped++; continue; }
    if (e.field === 'name') {                                    // renames re-key the map
      map.delete(b.name); b.name = e.val; map.set(b.name, b);
    } else { b[f] = e.val || null; }
    b.last_corrected = e.when || new Date().toISOString();
    applied++;
  }
  console.log(`✓ corrections: ${applied} approved applied · ${skipped} skipped (pending/rejected/unknown)`);
} else console.log('no directory_edits.json — skipping corrections');

if (existsSync('verification_report.json')) {
  const vr = JSON.parse(readFileSync('verification_report.json','utf8'));
  let v = 0;
  for (const [name, r] of Object.entries(vr.reports||{})) {
    const b = map.get(name); if (!b) continue;
    if (r.open === 'gone') b.status = 'closed';
    else if (r.join === 'yes') b.status = 'invited';
    if (r.open === 'open' && r.addr === 'ok') b.verified = true;
    if (r.notes) b.field_notes = r.notes;
    b.field_checked = (r.when||'').slice(0,10) || true;
    v++;
  }
  console.log(`✓ field verification merged for ${v} businesses`);
} else console.log('no verification_report.json — skipping status merge');

dir.generated = new Date().toISOString();
dir.businesses = [...map.values()];
writeFileSync('public/console/directory.json', JSON.stringify(dir, null, 1));
console.log(`\n✅ master dataset updated (${dir.businesses.length} businesses)`);
console.log('Next: npx wrangler@latest deploy');
