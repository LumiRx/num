#!/usr/bin/env node
// design-check — versioned change tracking for imported Claude Design files.
//
// Every design file submitted from the design project lives in
// design-source/<category>/<name>/v<N>/<file>, described by
// design-source/registry.json. This tool:
//
//   status                  verify every stored version's hash (tamper check),
//                           check vendored copies for drift, list open alerts.
//                           Exit 1 if anything needs attention.
//   ingest <id> <file>      compare a freshly fetched design file against the
//                           latest stored version. If changed: create v<N+1>,
//                           record it, and raise an alert naming the design
//                           sections that changed and the src files to review.
//   diff <id> [vA vB]       unified diff between two stored versions
//                           (defaults: latest-1 vs latest).
//   resolve <alertId>       mark an alert handled after the app is updated.
//   seal                    fill in hashes for version entries that lack them
//                           (run once after hand-adding a version folder).
//
// JSON files are compared canonically (parsed + stable-stringified), so
// whitespace/layout differences never raise false alerts.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DS = path.join(ROOT, 'design-source');
const REGISTRY = path.join(DS, 'registry.json');
const MAPPING = path.join(DS, 'mapping.json');
const ALERTS_MD = path.join(ROOT, 'ALERTS.md');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Stable stringify: sorted object keys at every level, so two JSON documents
// with the same content always hash identically.
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// Canonical content for comparison: JSON files compare by parsed content,
// everything else by exact text.
function canonical(file, text) {
  if (file.endsWith('.json')) {
    try {
      return stableStringify(JSON.parse(text));
    } catch {
      return text; // not valid JSON — fall back to raw
    }
  }
  return text;
}

const versionPath = (d, v) => path.join(DS, d.dir, 'v' + v, d.file);
const latest = (d) => d.versions[d.versions.length - 1];

function loadRegistry() {
  const reg = readJson(REGISTRY);
  const map = fs.existsSync(MAPPING) ? readJson(MAPPING) : { sections: {}, vendored: [], noImpact: {} };
  return { reg, map };
}

// ── section analysis ────────────────────────────────────────────────────────
// Slice a design file by its ordered section markers; a section spans from its
// marker to the next section's marker. Returns { name -> slice } plus any
// markers that no longer exist (a structural change worth a whole-file look).
function sliceSections(text, sections) {
  const found = [];
  for (const s of sections) {
    const idx = s.marker ? text.indexOf(s.marker) : 0;
    found.push({ ...s, idx });
  }
  const missing = found.filter((s) => s.idx < 0).map((s) => s.name);
  const present = found.filter((s) => s.idx >= 0).sort((a, b) => a.idx - b.idx);
  const slices = {};
  present.forEach((s, i) => {
    const end = i + 1 < present.length ? present[i + 1].idx : text.length;
    slices[s.name] = text.slice(s.idx, end);
  });
  return { slices, missing };
}

function changedSections(oldText, newText, sections) {
  if (!sections || sections.length === 0) return { changed: [], missing: [] };
  const a = sliceSections(oldText, sections);
  const b = sliceSections(newText, sections);
  const missing = [...new Set([...a.missing, ...b.missing])];
  const changed = sections
    .filter((s) => a.slices[s.name] !== undefined || b.slices[s.name] !== undefined)
    .filter((s) => a.slices[s.name] !== b.slices[s.name])
    .map((s) => ({ name: s.name, src: s.src }));
  return { changed, missing };
}

// Cheap diffstat: multiset difference of lines.
function diffstat(oldText, newText) {
  const count = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const a = count(oldText.split('\n'));
  const b = count(newText.split('\n'));
  let added = 0;
  let removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) || 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0));
  return { added, removed };
}

// ── ALERTS.md ───────────────────────────────────────────────────────────────
function writeAlertsMd(reg, map) {
  const open = reg.alerts.filter((a) => a.status === 'open');
  if (open.length === 0) {
    if (fs.existsSync(ALERTS_MD)) fs.unlinkSync(ALERTS_MD);
    return;
  }
  const lines = [
    '# Design change alerts',
    '',
    'The design project changed. Each alert lists what moved and which app files',
    'implement it. After updating the app, run:',
    '`node scripts/design-check.mjs resolve <id>`',
    '',
  ];
  for (const a of open) {
    lines.push(`## Alert #${a.id} — ${a.design} v${a.fromV} → v${a.toV}`);
    lines.push('');
    lines.push(`- Detected: ${a.at}`);
    lines.push(`- Change size: +${a.added} / −${a.removed} lines`);
    if (a.noImpact) {
      lines.push(`- Impact: none expected — ${a.noImpact}`);
    } else if (a.sections.length > 0) {
      lines.push('- Sections that changed → files to review:');
      for (const s of a.sections) {
        lines.push(`  - **${s.name}** → ${s.src.map((f) => '`' + f + '`').join(', ')}`);
      }
    } else {
      lines.push('- Sections: could not be narrowed — review the full diff.');
    }
    if (a.missingMarkers?.length) {
      lines.push(`- ⚠ Section markers no longer found (structural change): ${a.missingMarkers.join(', ')}`);
    }
    const d = reg.designs.find((x) => x.id === a.design);
    if (d) lines.push(`- Diff: \`node scripts/design-check.mjs diff ${a.design} ${a.fromV} ${a.toV}\``);
    lines.push('');
  }
  fs.writeFileSync(ALERTS_MD, lines.join('\n'));
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdSeal() {
  const { reg } = loadRegistry();
  let sealed = 0;
  for (const d of reg.designs) {
    for (const ver of d.versions) {
      const p = versionPath(d, ver.v);
      if (!fs.existsSync(p)) {
        console.error(`MISSING FILE: ${p}`);
        process.exitCode = 1;
        continue;
      }
      if (!ver.sha256) {
        const text = fs.readFileSync(p, 'utf8');
        ver.sha256 = sha256(Buffer.from(canonical(d.file, text)));
        ver.bytes = Buffer.byteLength(text);
        ver.lines = text.split('\n').length;
        sealed++;
      }
    }
  }
  writeJson(REGISTRY, reg);
  console.log(`Sealed ${sealed} version(s).`);
}

function cmdStatus() {
  const { reg, map } = loadRegistry();
  let problems = 0;

  console.log('DESIGN REGISTRY — ' + reg.designs.length + ' tracked designs\n');
  for (const d of reg.designs) {
    const l = latest(d);
    let ok = true;
    for (const ver of d.versions) {
      const p = versionPath(d, ver.v);
      if (!fs.existsSync(p)) {
        console.log(`  ✗ ${d.id} v${ver.v}: file missing (${path.relative(ROOT, p)})`);
        ok = false;
        problems++;
        continue;
      }
      if (ver.sha256) {
        const h = sha256(Buffer.from(canonical(d.file, fs.readFileSync(p, 'utf8'))));
        if (h !== ver.sha256) {
          console.log(`  ✗ ${d.id} v${ver.v}: HASH MISMATCH — stored snapshot was edited locally. Snapshots are immutable; restore it or re-seal deliberately.`);
          ok = false;
          problems++;
        }
      } else {
        console.log(`  ~ ${d.id} v${ver.v}: unsealed (run: node scripts/design-check.mjs seal)`);
        problems++;
      }
    }
    if (ok) console.log(`  ✓ ${d.id} — latest v${l.v} (${l.importedAt.slice(0, 10)})`);
  }

  // vendored-copy drift
  for (const v of map.vendored ?? []) {
    const d = reg.designs.find((x) => x.id === v.designId);
    if (!d) continue;
    const src = versionPath(d, latest(d).v);
    const dst = path.join(ROOT, v.to);
    if (!fs.existsSync(dst)) {
      console.log(`\n  ✗ vendored copy missing: ${v.to}`);
      problems++;
      continue;
    }
    const a = canonical(d.file, fs.readFileSync(src, 'utf8'));
    const b = canonical(d.file, fs.readFileSync(dst, 'utf8'));
    if (a !== b) {
      console.log(`\n  ⚠ vendored drift: ${v.to} differs from ${d.id} v${latest(d).v} — ${v.note}`);
      problems++;
    }
  }

  const open = reg.alerts.filter((a) => a.status === 'open');
  if (open.length > 0) {
    console.log(`\nOPEN ALERTS: ${open.length} (see ALERTS.md)`);
    for (const a of open) console.log(`  #${a.id} ${a.design} v${a.fromV}→v${a.toV} (+${a.added}/−${a.removed})`);
    problems += open.length;
  }

  writeAlertsMd(reg, map);
  console.log(problems === 0 ? '\nAll clean — nothing needs changes.' : `\n${problems} item(s) need attention.`);
  process.exitCode = problems === 0 ? 0 : 1;
}

function cmdIngest(id, file, note) {
  const { reg, map } = loadRegistry();
  const d = reg.designs.find((x) => x.id === id);
  if (!d) {
    console.error(`Unknown design id: ${id}. Known: ${reg.designs.map((x) => x.id).join(', ')}`);
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }
  const newText = fs.readFileSync(file, 'utf8');

  if (d.versions.length === 0) {
    // first import — baseline, no alert
    const dir = path.join(DS, d.dir, 'v1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, d.file), newText);
    d.versions.push({
      v: 1,
      sha256: sha256(Buffer.from(canonical(d.file, newText))),
      bytes: Buffer.byteLength(newText),
      lines: newText.split('\n').length,
      importedAt: new Date().toISOString(),
      note: note || 'initial import',
    });
    writeJson(REGISTRY, reg);
    console.log(`${id}: baseline v1 recorded.`);
    return;
  }

  const l = latest(d);
  const oldText = fs.readFileSync(versionPath(d, l.v), 'utf8');
  if (canonical(d.file, oldText) === canonical(d.file, newText)) {
    console.log(`${id}: up to date (matches v${l.v}) — no changes.`);
    return;
  }

  const v = l.v + 1;
  const dir = path.join(DS, d.dir, 'v' + v);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, d.file), newText);
  d.versions.push({
    v,
    sha256: sha256(Buffer.from(canonical(d.file, newText))),
    bytes: Buffer.byteLength(newText),
    lines: newText.split('\n').length,
    importedAt: new Date().toISOString(),
    note: note || 'design changed upstream',
  });

  const { added, removed } = diffstat(oldText, newText);
  const secDef = map.sections?.[d.id];
  const { changed, missing } = changedSections(oldText, newText, secDef);
  const alert = {
    id: reg.nextAlertId++,
    design: d.id,
    fromV: l.v,
    toV: v,
    at: new Date().toISOString(),
    added,
    removed,
    sections: changed,
    missingMarkers: missing,
    noImpact: map.noImpact?.[d.id] ?? null,
    status: 'open',
  };
  reg.alerts.push(alert);
  writeJson(REGISTRY, reg);
  writeAlertsMd(reg, map);

  console.log(`${id}: CHANGED — recorded v${v} (+${added}/−${removed} lines). Alert #${alert.id} raised.`);
  if (alert.noImpact) {
    console.log(`  impact: none expected — ${alert.noImpact}`);
  } else if (changed.length) {
    for (const s of changed) console.log(`  section "${s.name}" → review ${s.src.join(', ')}`);
  }
  if (missing.length) console.log(`  ⚠ markers missing: ${missing.join(', ')} — structural change, review whole diff`);
  process.exitCode = 1; // alert = attention needed
}

function cmdDiff(id, va, vb) {
  const { reg } = loadRegistry();
  const d = reg.designs.find((x) => x.id === id);
  if (!d) {
    console.error(`Unknown design id: ${id}`);
    process.exit(2);
  }
  const l = latest(d);
  const b = vb ? Number(vb) : l.v;
  const a = va ? Number(va) : Math.max(1, b - 1);
  try {
    execFileSync('diff', ['-u', versionPath(d, a), versionPath(d, b)], { stdio: 'inherit' });
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = differences found, which is the point
  }
}

function cmdResolve(alertId) {
  const { reg, map } = loadRegistry();
  const a = reg.alerts.find((x) => x.id === Number(alertId));
  if (!a) {
    console.error(`No alert #${alertId}`);
    process.exit(2);
  }
  if (a.status === 'resolved') {
    console.log(`Alert #${alertId} already resolved.`);
    return;
  }
  a.status = 'resolved';
  a.resolvedAt = new Date().toISOString();
  writeJson(REGISTRY, reg);
  writeAlertsMd(reg, map);
  console.log(`Alert #${alertId} resolved.`);
}

// ── main ────────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'status':
    cmdStatus();
    break;
  case 'ingest':
    cmdIngest(args[0], args[1], args.slice(2).join(' ') || undefined);
    break;
  case 'diff':
    cmdDiff(args[0], args[1], args[2]);
    break;
  case 'resolve':
    cmdResolve(args[0]);
    break;
  case 'seal':
    cmdSeal();
    break;
  default:
    console.log('Usage: design-check.mjs <status|ingest <id> <file> [note]|diff <id> [vA vB]|resolve <alertId>|seal>');
    process.exit(2);
}
