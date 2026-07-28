#!/usr/bin/env node
/**
 * NUM · affiliate product deals — ground team's tool (writes to D1 num-db "products")
 * Deals appear automatically in chat when a guest asks for a matching product.
 * Run from the num-console folder:
 *   node scripts/products.mjs list
 *   node scripts/products.mjs add "Reef-safe sunscreen SPF50" --kw "sunscreen,sun cream,spf,ครีมกันแดด" \
 *        --partner "Patong Beach Pharmacy" --code NUM10 --discount "10% off" --link "https://…" --kick "15%"
 *   node scripts/products.mjs off 3        (deactivate deal #3)
 */
import { execFileSync } from 'node:child_process';
const DB = 'num-db';
const q = (sql) => JSON.parse(execFileSync('npx', ['wrangler@latest','d1','execute',DB,'--remote','--json','--command',sql], {encoding:'utf8', stdio:['ignore','pipe','pipe']}))[0].results;
const esc = s => String(s??'').replaceAll("'","''");

const [,,cmd,...rest] = process.argv;
const opt = (name, def='') => { const i = rest.indexOf('--'+name); return i>=0 ? rest[i+1] : def; };

if (cmd === 'add') {
  const name = rest[0];
  if (!name || !opt('kw') || !opt('partner')) { console.log('Need: add "Name" --kw "k1,k2" --partner "Shop" [--code X --discount "10% off" --link url --kick "15%"]'); process.exit(1); }
  q(`INSERT INTO products (name, keywords, partner, link, promo_code, discount, kickback) VALUES ('${esc(name)}','${esc(opt('kw'))}','${esc(opt('partner'))}','${esc(opt('link'))}','${esc(opt('code'))}','${esc(opt('discount'))}','${esc(opt('kick'))}')`);
  console.log(`✓ deal added: ${name} @ ${opt('partner')} — live in chat immediately`);
} else if (cmd === 'off') {
  q(`UPDATE products SET active=0 WHERE id=${parseInt(rest[0])}`); console.log(`✓ deal #${rest[0]} deactivated`);
} else {
  const rows = q(`SELECT id, name, partner, promo_code, discount, kickback, active FROM products ORDER BY id`);
  if (!rows.length) console.log('No deals yet. Add one with: node scripts/products.mjs add …');
  else rows.forEach(r=>console.log(`#${r.id} ${r.active? '🟢':'⚫'} ${r.name} @ ${r.partner} · code ${r.promo_code||'—'} · ${r.discount||''} · our cut ${r.kickback||'—'}`));
}
